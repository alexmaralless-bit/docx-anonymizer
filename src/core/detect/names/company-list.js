// Список компаний для маскирования (версия 0.4, docs/concept-0.4.md, решение владельца 4; Ц3, К3; contracts §8.2).
//
// Документный детектор: для каждой записи `settings.maskedCompanies` ({name, aliases}) строит «ядро» названия — без ОПФ
// и внешних кавычек — и ищет его во всех потоках (кроме полей и атрибутов-авторов, как kb.js):
//  - точное слово без учёта регистра; кириллическое слово ≥ 5 букв — основа + падежное окончание
//    («Ромашка» → «Ромашки», «Ромашке», «Ромашкой»; «Вектор» → «Вектора», «Вектором»), слова ≤ 4 букв и латиница — точно;
//  - границы слова как в person-dict.js (`glued`): не часть другого слова, адреса почты, домена и составного через дефис
//    («Ромашкаус» и «Ромашка-Трейд» — не «Ромашка»);
//  - другой алфавит: «Romashka» для «Ромашка» и наоборот (`crossScriptMatch`, вес скелета ≥ 3);
//  - ОПФ перед названием, латинская ОПФ после него и кавычки входят в спан и уходят в keepPrefix/keepSuffix
//    («ООО «[КОМПАНИЯ_1]»»), как у правил company.js.
// Выход: COMPANY, source 'list', confidence 'labeled', canonical — ядро названия из списка, поэтому все формы и псевдонимы
// одной записи получают одну метку (и совпадают с меткой правил коммерческого режима для того же названия).
// Срабатывает независимо от группы `commercial` (ядро принимает source 'list' и при выключенной COMPANY — runner.js);
// исключения пользователя (exclusions, FR-32) ядро применяет после.

import { scannable } from './kb.js';
import { tokenize, tokenSeq, escapeRe, pickNonOverlapping } from './text.js';
import { PREFIX_FORMS, FULL_FORMS_RE_SRC, SUFFIX_FORMS_RE_SRC, isNeverMaskOrg, lowerE, wordList } from './lexicon.js';
import { companyCore } from './company.js';
import { skeleton, skeletonWeight, isCyrillic, crossScriptMatch } from './translit.js';

const QUOTES = '«»"“”„\'‘’';
const QUOTE_CLASS = `[${QUOTES}]`;
const OPEN_TO_CLOSE = { '«': '»', '"': '"', '“': '”', '„': '“', "'": "'", '‘': '’', '”': '”' };

const SHORT_FORMS = [...PREFIX_FORMS].sort((a, b) => b.length - a.length).join('|');
// ОПФ перед найденным ядром в тексте
const BEFORE_SHORT_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${SHORT_FORMS})[ \\u00A0]*$`, 'u');
const BEFORE_FULL_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${FULL_FORMS_RE_SRC})[ \\u00A0]*$`, 'iu');
const AFTER_SUFFIX_RE = new RegExp(`^,?[ \\u00A0]+(?:${SUFFIX_FORMS_RE_SRC})(?![\\p{L}\\p{N}])`, 'u');

const VOWELS_TAIL_RE = /[аеёиоуыэюяйь]+$/;
// Падежные окончания существительных и прилагательных (до 3 букв): хвост после основы. Произвольный хвост
// «[а-яё]{0,3}» дал бы «Ромашкаус» → «Ромашк» + «аус» (К3: не совпадает), поэтому — только окончания.
// prettier-ignore
const ENDINGS = [
  ...wordList(`ами|ями|ыми|ими|ого|его|ому|ему|ием|иях|иям|ый|ой|ей|ою|ею|ом|ем|ём|ам|ям|ах|ях|ов|ев|ия|ии|ию|ие|ий|ым|им|ых|их|ую|юю|ая|яя|ое|ее|ые|ье|ья|ью|ьи|а|я|о|е|ё|и|ы|у|ю|ь|й`),
];
const ENDINGS_SRC = `(?:${ENDINGS.join('|')})?`;
const MIN_STEM = 4;

/** «е»/«ё» в шаблоне — одно и то же (регистр снимает флаг `i`). */
const yo = (src) => src.replace(/[её]/g, '[её]');

/**
 * Шаблон одного слова названия: кириллица ≥ 5 букв — основа без последней гласной группы + окончание
 * (у слова на согласную основа — всё слово); основа короче 4 букв, слова ≤ 4 букв и латиница — точное слово.
 * `inPhrase` — слово из названия в несколько слов («Цветочный дом», «Лунный свет»): короткое кириллическое слово
 * (3–4 буквы) тоже склоняется, ложных совпадений не даёт соседнее слово; одиночное короткое название — только точно.
 * @param {string} word
 * @param {boolean} [inPhrase]
 */
export function wordPattern(word, inPhrase = false) {
  const w = lowerE(word);
  if (!/^[а-яе]+$/.test(w)) return yo(escapeRe(w));
  const stem = w.replace(VOWELS_TAIL_RE, '');
  if (inPhrase && w.length >= 3 && w.length < 5 && stem.length >= 3) return `${yo(escapeRe(stem))}${ENDINGS_SRC}`;
  if (w.length < 5 || stem.length < MIN_STEM) return yo(escapeRe(w));
  return `${yo(escapeRe(stem))}${ENDINGS_SRC}`;
}

/**
 * Регэксп ядра: слова через пробелы, части через дефис, кавычки внутри — любые.
 * @param {string} core
 */
function coreRegExp(core) {
  const phrase = core.split(' ').length > 1;
  const words = core.split(' ').map((word) =>
    word
      .split('-')
      .map((part) => {
        // «Торговый дом «Ромашка»»: кавычки и знаки внутри слова — как есть (кавычки — любого вида)
        const m = /^([^\p{L}\p{N}]*)([\p{L}\p{N}]*)([^\p{L}\p{N}]*)$/u.exec(part);
        if (!m) return escapeRe(part).replace(new RegExp(QUOTE_CLASS, 'g'), QUOTE_CLASS);
        const lead = escapeRe(m[1]).replace(new RegExp(QUOTE_CLASS, 'g'), QUOTE_CLASS);
        const tail = escapeRe(m[3]).replace(new RegExp(QUOTE_CLASS, 'g'), QUOTE_CLASS);
        return `${lead}${m[2] ? wordPattern(m[2], phrase) : ''}${tail}`;
      })
      .join('-'),
  );
  return new RegExp(`(?<![\\p{L}\\p{N}@._/\\\\-])${words.join('[ \\u00A0]+')}(?![\\p{L}\\p{N}@_])(?!-[\\p{L}\\p{N}])(?![./][\\p{L}\\p{N}])`, 'giu');
}

/**
 * Матчеры записей списка.
 * @param {{name: string, aliases?: string[]}[]} list
 * Бренд владельца (решение 6, `NEVER_MASK_ORGS`) в списке игнорируется — и как название, и как псевдоним.
 * @returns {{canonical: string, cores: {core: string, re: RegExp, words: number, cross: boolean, upper: boolean}[]}[]}
 */
export function buildCompanyMatchers(list) {
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    if (!entry || typeof entry.name !== 'string') continue;
    const main = companyCore(entry.name);
    if (!/\p{L}/u.test(main) || isNeverMaskOrg(main)) continue;
    const names = [main, ...(Array.isArray(entry.aliases) ? entry.aliases : []).map(companyCore)].filter((c) => /\p{L}/u.test(c) && !isNeverMaskOrg(c));
    const cores = [...new Set(names)].map((core) => ({
      core,
      re: coreRegExp(core),
      words: core.split(' ').length,
      cross: skeletonWeight(skeleton(core)) >= 3,
      upper: /^\p{Lu}/u.test(core),
    }));
    out.push({ canonical: main, cores });
  }
  return out;
}

/** Расширение найденного ядра на кавычки и ОПФ вокруг: {start, end, keepPrefix, keepSuffix}. */
function wrap(text, start, end) {
  let s = start;
  let e = end;
  const open = text[s - 1];
  if (open && OPEN_TO_CLOSE[open] && (text[e] === OPEN_TO_CLOSE[open] || (open === '"' && text[e] === '”'))) {
    s -= 1;
    e += 1;
  }
  const before = text.slice(Math.max(0, s - 80), s);
  const m = BEFORE_SHORT_RE.exec(before) || BEFORE_FULL_RE.exec(before);
  if (m) s -= m[0].length;
  const after = AFTER_SUFFIX_RE.exec(text.slice(e, e + 30));
  if (after) e += after[0].length;
  return { start: s, end: e, keepPrefix: start - s, keepSuffix: e - end };
}

/**
 * Документный детектор списка компаний (contracts §2, §8.2).
 * @param {import('../../docx/model.js').DocModel} doc
 * @param {import('../../contracts/entity.js').Entity[]} _entities
 * @param {{settings?: any}} ctx
 * @returns {import('../../contracts/entity.js').Candidate[]}
 */
export function detectCompanyList(doc, _entities, ctx = {}) {
  const matchers = buildCompanyMatchers(ctx.settings?.maskedCompanies);
  if (!matchers.length) return [];
  const crossAny = matchers.some((m) => m.cores.some((c) => c.cross));
  /** @type {import('../../contracts/entity.js').Candidate[]} */
  const out = [];
  for (const s of doc.streams) {
    if (!scannable(s) || !s.text || !/\p{L}/u.test(s.text)) continue;
    const t = s.text;
    /** @type {{start: number, end: number, keepPrefix: number, keepSuffix: number, canonical: string}[]} */
    const cands = [];
    const toks = crossAny ? tokenize(t).filter((x) => x.t === 'W') : [];
    for (const m of matchers) {
      for (const c of m.cores) {
        const push = (start, end) => {
          // бренд владельца не маскируется никогда, даже если совпал по написанию в другом алфавите
          if (isNeverMaskOrg(t.slice(start, end))) return;
          const w = wrap(t, start, end);
          // Общее слово из списка («Старт», «Ромашка») маскируется везде, в т.ч. в начале предложения, после «:» и в ячейке:
          // пользователь явно попросил скрывать компанию, частичная утечка хуже ложного срабатывания (К3); о риске общих
          // слов предупреждают настройки (company-short), см. «Риски» концепции 0.4
          cands.push({ ...w, canonical: m.canonical });
        };
        for (const hit of t.matchAll(c.re)) {
          const start = /** @type {number} */ (hit.index);
          const end = start + hit[0].length;
          // название с заглавной не ищем в строчном написании («ромашка» в тексте — цветок, а не «Ромашка»)
          if (c.upper && /^\p{Ll}/u.test(hit[0])) continue;
          push(start, end);
        }
        if (!c.cross) continue;
        // другой алфавит: последовательность из стольких же слов с заглавной (1–3)
        const n = Math.min(3, c.words);
        const other = isCyrillic(c.core) ? 'lat' : 'cyr';
        for (let i = 0; i + n <= toks.length; i++) {
          if (toks[i].script !== other) continue;
          const a = tokenSeq(t, toks, i, n);
          if (!a) continue;
          const start = a[0].start;
          const end = a[n - 1].end;
          if (/[@./\\_]/.test(t[start - 1] || '') || /[@_]/.test(t[end] || '')) continue;
          if (crossScriptMatch(t.slice(start, end), c.core)) push(start, end);
        }
      }
    }
    for (const c of pickNonOverlapping(cands)) {
      out.push({
        streamId: s.id,
        category: 'COMPANY',
        start: c.start,
        end: c.end,
        ...(c.keepPrefix ? { keepPrefix: c.keepPrefix } : {}),
        ...(c.keepSuffix ? { keepSuffix: c.keepSuffix } : {}),
        confidence: 'labeled',
        source: 'list',
        canonical: c.canonical,
      });
    }
  }
  return out;
}

export { companyCore };
