// Склонение ФИО при обратной замене (FR-37 в редакции 0.2): падеж берётся из приклеенного к метке окончания
// («[ФИО_1]у») или из предлога перед меткой, лемма и род — из значения карты замен (`value`, `variants`).
// Карта замен не меняется: всё выводится при восстановлении. Чистый модуль — без DOM и chrome.*.
//
// Неуверенность всегда решается в пользу именительного падежа: незнакомое окончание, «в/на/за/под»,
// латиница, неоднозначная пара слов — значение подставляется как есть (или в именительном падеже,
// если в карте оно записано в косвенном).

import { declineSurname, declineFirstName, declinePatronymic, patronymicInfo, firstNameInfo, lemmaCandidates } from './detect/names/morph.js';
import { lowerE } from './detect/names/lexicon.js';

/** Падежи в порядке морфологии `morph.js`: 0 им, 1 род, 2 дат, 3 вин, 4 тв, 5 пр. */
export const CASES = /** @type {const} */ (['nom', 'gen', 'dat', 'acc', 'ins', 'prep']);

/** @typedef {'m'|'f'} Gender */
/** @typedef {'surname'|'first'|'patronymic'|'ini'} Role */
/**
 * @typedef {object} ParsedPerson
 * @property {'SFP'|'FPS'|'SF'|'FS'|'S_INI'|'INI_S'|'S'|'F'} form
 * @property {{text: string, sep: string, role: Role}[]} words  sep — разделитель ПОСЛЕ слова
 * @property {{surname?: string, first?: string, patronymic?: string}} lemmas  нижний регистр, «ё» → «е»
 * @property {Gender} gender
 */

const WORD_RE = /^[А-ЯЁа-яё]+(?:-[А-ЯЁа-яё]+)*$/u;
const INI_RE = /^[А-ЯЁ]\.(?:[А-ЯЁ]\.)?$/u;
/** Сильные фамильные суффиксы именительного падежа. */
const STRONG = { m: /(?:ов|ев|ин|ын|ский|цкий)$/, f: /(?:ова|ева|ина|ына|ская|цкая)$/ };
/** @type {Gender[]} */
const GENDERS = ['m', 'f'];

/** Фамилия в именительном падеже с сильным суффиксом → её род (для дефисных — по последней части). */
function nominativeSurnameGender(word) {
  const w = lowerE(word).split('-').pop();
  if (STRONG.f.test(w)) return 'f';
  if (STRONG.m.test(w)) return 'm';
  return null;
}

/** Лемма фамилии (каждая часть через дефис отдельно). */
function surnameLemma(word, g, cases) {
  return lowerE(word)
    .split('-')
    .map((p) => lemmaCandidates(p, 'surname', g, cases)[0] || p)
    .join('-');
}

/** Леммы фамилии с сильным суффиксом для рода g (именительный — сама форма). */
function strongSurnameLemmas(word, g) {
  const w = lowerE(word);
  const last = w.split('-').pop();
  const out = new Set();
  if (STRONG[g].test(last)) out.add(w);
  for (const c of lemmaCandidates(last, 'surname', g)) {
    if (STRONG[g].test(c)) out.add(w.split('-').length > 1 ? surnameLemma(w, g) : c);
  }
  return [...out];
}

/** Роды, в которых фамилия из варианта лемматизируется с сильным суффиксом. */
function variantGenders(variant) {
  const words = String(variant || '')
    .trim()
    .split(/\s+/)
    .filter((w) => WORD_RE.test(w) && !INI_RE.test(w));
  if (words.length !== 1) return [];
  const w = words[0];
  const nom = nominativeSurnameGender(w);
  if (nom) return [nom];
  return GENDERS.filter((g) => strongSurnameLemmas(w, g).length > 0);
}

/**
 * Голосование вариантов значения за род фамилии: учитываются только варианты, которые
 * лемматизируются в одном роде.
 */
function voteGender(variants) {
  const votes = { m: 0, f: 0 };
  for (const v of variants || []) {
    const gs = variantGenders(v);
    if (gs.length === 1) votes[gs[0]]++;
  }
  return votes;
}

/**
 * Одиночная фамилия (форма S, S_INI, INI_S): род и лемма по суффиксу, затем по вариантам.
 * @returns {{gender: Gender, lemma: string} | null}
 */
function resolveSurname(word, variants) {
  const votes = voteGender(variants);
  const nom = nominativeSurnameGender(word);
  if (nom) {
    // «именительный первым»: «Иванова» — женская фамилия, пока варианты не скажут обратное
    const other = nom === 'm' ? 'f' : 'm';
    if (votes[other] > votes[nom]) {
      const alt = strongSurnameLemmas(word, other);
      if (alt.length) return { gender: other, lemma: alt[0] };
    }
    return { gender: nom, lemma: lowerE(word) };
  }
  // Косвенная форма: принимаем, если сильная лемма ровно одна (или варианты решают спор)
  const byGender = GENDERS.map((g) => ({ g, lemmas: strongSurnameLemmas(word, g) })).filter((x) => x.lemmas.length);
  const all = byGender.flatMap((x) => x.lemmas.map((lemma) => ({ gender: x.g, lemma })));
  if (all.length === 1) return all[0];
  if (byGender.length === 2 && votes.m !== votes.f) {
    const pick = byGender.find((x) => x.g === (votes.m > votes.f ? 'm' : 'f'));
    if (pick.lemmas.length === 1) return { gender: pick.g, lemma: pick.lemmas[0] };
  }
  return null;
}

/** Имена с беглой гласной (исключения `morph.js`): лемматизатор ставит их ниже «правильных» кандидатов. */
const FIRST_IRREGULAR = new Set(['петр', 'павел', 'лев', 'любовь']);

/** Лемма имени из косвенной формы: словарное или исключение — первым, иначе лучший кандидат. */
function firstLemma(word, g, cases) {
  const cands = lemmaCandidates(word, 'first', g, cases);
  const known = (c) => FIRST_IRREGULAR.has(c) || firstNameInfo(c).some((i) => i.lemma === c && i.gender === g);
  return cands.find(known) || cands[0] || lowerE(word);
}

/** Словарное имя: предпочтительно в именительном падеже. */
function pickFirstInfo(word) {
  const infos = firstNameInfo(word);
  return infos.find((i) => i.cases.includes(0)) || infos[0] || null;
}

/**
 * Разбор значения PERSON из карты замен: форма записи, роли слов, леммы и род.
 * @param {string} value
 * @param {string[]} [variants]
 * @returns {ParsedPerson | null}
 */
export function parsePersonValue(value, variants = []) {
  if (typeof value !== 'string') return null;
  const parts = value.trim().split(/(\s+)/);
  /** @type {{text: string, sep: string, role: Role}[]} */
  const words = [];
  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i];
    if (!text) return null;
    const ini = INI_RE.test(text);
    if (!ini && !WORD_RE.test(text)) return null; // латиница, цифры, знаки
    words.push({ text, sep: parts[i + 1] || '', role: ini ? 'ini' : 'surname' });
  }
  const iniCount = words.filter((w) => w.role === 'ini').length;
  const names = words.filter((w) => w.role !== 'ini');
  if (!names.length) return null;

  // Инициалы: «Иванов П.С.», «П.С. Иванов», «П. С. Иванов» — склоняется только фамилия
  if (iniCount) {
    if (names.length !== 1 || iniCount > 2) return null;
    const sIdx = words.indexOf(names[0]);
    const form = sIdx === 0 ? 'S_INI' : sIdx === words.length - 1 ? 'INI_S' : null;
    if (!form) return null;
    const r = resolveSurname(names[0].text, variants);
    if (!r) return null;
    return { form, words, lemmas: { surname: r.lemma }, gender: r.gender };
  }

  if (words.length === 3) {
    const [a, b, c] = words;
    const sfp = patronymicInfo(c.text);
    const fps = !sfp && patronymicInfo(b.text);
    const pi = sfp || fps;
    if (!pi) return null;
    const [s, f, p] = sfp ? [a, b, c] : [c, a, b];
    s.role = 'surname';
    f.role = 'first';
    p.role = 'patronymic';
    const first = firstLemma(f.text, pi.gender, pi.cases);
    return {
      form: sfp ? 'SFP' : 'FPS',
      words,
      lemmas: { surname: surnameLemma(s.text, pi.gender, pi.cases), first, patronymic: pi.lemma },
      gender: pi.gender,
    };
  }

  if (words.length === 2) {
    const [a, b] = words;
    const ia = pickFirstInfo(a.text);
    const ib = pickFirstInfo(b.text);
    let s, f, gender, first;
    if (ia && !ib) [f, s, gender, first] = [a, b, ia.gender, ia.lemma];
    else if (ib && !ia) [s, f, gender, first] = [a, b, ib.gender, ib.lemma];
    else {
      // Имени нет в словаре (или оба слова — имена): решает сильный фамильный суффикс ровно у одного слова
      const ga = nominativeSurnameGender(a.text) || (resolveSurname(a.text, [])?.gender ?? null);
      const gb = nominativeSurnameGender(b.text) || (resolveSurname(b.text, [])?.gender ?? null);
      if (!!ga === !!gb) return null;
      [s, f, gender] = ga ? [a, b, ga] : [b, a, gb];
      // фамилия в именительном → имя тоже в именительном; иначе лемматизируем имя
      first = nominativeSurnameGender(s.text) ? lowerE(f.text) : firstLemma(f.text, gender);
    }
    s.role = 'surname';
    f.role = 'first';
    // ЛОВУШКА lemmatizeNamePair: падежи имени не ограничивают фамилию («Иванова Пётр» не даёт «иванова» для мужчины)
    const surname = nominativeSurnameGender(s.text) === gender ? lowerE(s.text) : surnameLemma(s.text, gender);
    return { form: s === a ? 'SF' : 'FS', words, lemmas: { surname, first }, gender };
  }

  if (words.length === 1) {
    const w = words[0];
    const fi = pickFirstInfo(w.text);
    if (fi) {
      w.role = 'first';
      return { form: 'F', words, lemmas: { first: fi.lemma }, gender: fi.gender };
    }
    const r = resolveSurname(w.text, variants);
    if (!r) return null;
    return { form: 'S', words, lemmas: { surname: r.lemma }, gender: r.gender };
  }
  return null;
}

// ─── Определение падежа по контексту ───────────────────────────────────────────

/** Приклеенные окончания: мужской род. Винительный одушевлённых = родительный. */
const SUFFIX_M = { а: 1, я: 1, у: 2, ю: 2, ым: 4, им: 4, ом: 4, ем: 4, е: 5, и: 5, ого: 1, его: 1, ому: 2, ему: 2 };
/** Женский род: значение — допустимые падежи, первый — выбор по умолчанию. */
const SUFFIX_F = { ой: [1, 2, 4, 5], ою: [4], ы: [1], и: [1], е: [2, 5], у: [3], ую: [3] };

const PREP = new Map([
  ...['у', 'от', 'для', 'без', 'до', 'из', 'после', 'кроме', 'около', 'вместо', 'против', 'ради', 'возле'].map((p) => [p, 1]),
  ...['к', 'ко', 'по', 'благодаря', 'согласно', 'вопреки'].map((p) => [p, 2]),
  ...['с', 'со', 'перед', 'передо', 'между', 'над'].map((p) => [p, 4]),
  ...['о', 'об', 'обо', 'при'].map((p) => [p, 5]),
  ...['про', 'через'].map((p) => [p, 3]),
  // падеж зависит от смысла (в суд / в лице, на имя / на совещании) — решения нет
  ...['в', 'во', 'на', 'за', 'под'].map((p) => [p, 0]),
]);
const PREP2 = new Map([
  ['от имени', 1],
  ['в адрес', 1],
  ['в лице', 1],
  ['со стороны', 1],
  ['на имя', 1],
]);
/**
 * Слова между предлогом и меткой, не меняющие падеж: обращения («к уважаемому [ФИО_1]», «от г-на [ФИО_1]»),
 * процессуальные роли и должности («в лице заместителя генерального директора [ФИО_1]», FR-37). Основы должностей —
 * те же, что в `POSITION_RE_SRC` (detect/names/lexicon.js); слова после должности («по доверенности», «по развитию»)
 * мостиком не являются — такие обороты остаются в именительном падеже.
 */
const BRIDGE = new RegExp(
  '^(?:г-н|г-ж|гражданин|гражданк|господин|госпож|уважаем|истц|истец|ответчик|заявител|' +
    'генеральн|исполнительн|коммерческ|финансов|техническ|главн|управляющ|первого|' +
    'директор|руководител|президент|председател|правления|бухгалтер|начальник|заместител|ректор|представител|' +
    'ип$|индивидуальн|предпринимател|учредител|участник|члена|партн[её]р|адвокат|нотариус|поверенн|доверител|арендодател|арендатор|заказчик|исполнител|поставщик|покупател|подрядчик)',
);
/** Окно поиска предлога: до 6 слов и 64 символов перед меткой (FR-37). */
const PREP_WINDOW_WORDS = 6;
export const PREP_WINDOW_CHARS = 64;

/**
 * Предлог (или управляющее сочетание) в окне ≤ 6 слов перед меткой; между предлогом и меткой — только мостики.
 * @returns {number | null} индекс падежа; 0 — неоднозначный предлог (решения нет); null — предлога нет
 */
function prepositionCase(before) {
  const tail = String(before || '')
    .slice(-PREP_WINDOW_CHARS)
    .replace(/[«»"“”„'`*_~]/g, ' ');
  if (!/(?:^|\s)$/u.test(tail) || !tail.trim()) return null; // метка приклеена к слову
  const tokens = tail
    .trim()
    .split(/\s+/)
    .slice(-(PREP_WINDOW_WORDS + 1));
  const words = [];
  for (let i = tokens.length - 1; i >= 0 && words.length < PREP_WINDOW_WORDS; i--) {
    // скобка допустима только в начале самого дальнего слова; запятая после слова рвёт связь,
    // точка — тоже, кроме сокращений-мостиков («г-н.»)
    const m = /^([([]?)([\p{L}-]+)(\.?)$/u.exec(tokens[i]);
    if (!m) break;
    const w = lowerE(m[2]);
    if (m[3] && !BRIDGE.test(w)) break;
    words.unshift(w);
    if (m[1]) break;
  }
  for (let k = words.length - 1; k >= 0; k--) {
    const w = words[k];
    if (k > 0 && PREP2.has(`${words[k - 1]} ${w}`)) return PREP2.get(`${words[k - 1]} ${w}`);
    if (PREP.has(w)) return PREP.get(w);
    if (!BRIDGE.test(w)) return null;
  }
  return null;
}

/**
 * Падеж метки по контексту.
 * @param {{before?: string, after?: string, gender: Gender, prevCase?: number, gap?: string}} ctx
 *   before — текст перед меткой, after — сразу после (≥ 4 символов, если есть), prevCase/gap — предыдущая
 *   склонённая метка и текст между ними (для сочинения «от [ФИО_1] и [ФИО_2]»)
 * @returns {{idx: number, consumed: number, source: 'suffix'|'prep'|'coord'} | null}
 */
export function detectCase({ before = '', after = '', gender, prevCase, gap }) {
  const prep = prepositionCase(before);
  // 1. Приклеенное окончание сильнее предлога
  const m = /^([а-яё]{1,3})(?![\p{L}])/iu.exec(after || '');
  if (m) {
    const end = m[1].toLowerCase().replace(/ё/g, 'е');
    if (gender === 'f') {
      const set = SUFFIX_F[end];
      if (set) return { idx: prep && set.includes(prep) ? prep : set[0], consumed: m[1].length, source: 'suffix' };
    } else if (SUFFIX_M[end]) {
      return { idx: SUFFIX_M[end], consumed: m[1].length, source: 'suffix' };
    }
    // незнакомое окончание не потребляется — смотрим дальше
  }
  // 2. Предлог перед меткой («в/на/за/под» → решения нет)
  if (prep !== null) return prep > 0 ? { idx: prep, consumed: 0, source: 'prep' } : null;
  // 3. Сочинение: «[ФИО_1] и [ФИО_2]», «[ФИО_1], [ФИО_2]» — падеж предыдущей метки
  if (prevCase && prevCase > 0 && typeof gap === 'string' && /^\s*(?:,|и)\s*$/u.test(gap)) {
    return { idx: prevCase, consumed: 0, source: 'coord' };
  }
  return null;
}

// ─── Порождение формы ─────────────────────────────────────────────────────────

/** Переносит вид исходного слова (регистр, «ё») на новую форму (нижний регистр, «е»). */
function restoreShape(original, form, { dropYo = false } = {}) {
  const lowOrig = original.toLowerCase();
  const lowE = lowerE(original);
  let out = '';
  for (let i = 0; i < form.length; i++) {
    const ch = form[i];
    // «ё» копируется только в общем с исходным словом префиксе (Королёва → Королёвой)
    const yo = !dropYo && ch === 'е' && lowE[i] === 'е' && lowOrig[i] === 'ё' && lowE.slice(0, i + 1) === form.slice(0, i + 1);
    out += yo ? 'ё' : ch;
  }
  const letters = original.replace(/[^\p{L}]/gu, '');
  if (letters.length > 1 && letters === letters.toUpperCase()) return out.toUpperCase();
  const origParts = original.split('-');
  return out
    .split('-')
    .map((p, i) => {
      const o = origParts[Math.min(i, origParts.length - 1)];
      return o && o[0] !== o[0].toLowerCase() ? p.charAt(0).toUpperCase() + p.slice(1) : p;
    })
    .join('-');
}

/**
 * Значение в нужном падеже с сохранением вида каждого слова.
 * @param {ParsedPerson} parsed
 * @param {number} idx 0..5
 * @returns {string}
 */
export function declineParsed(parsed, idx) {
  const g = parsed.gender;
  return parsed.words
    .map((w) => {
      let form;
      if (w.role === 'ini') return w.text + w.sep;
      if (w.role === 'surname')
        form = parsed.lemmas.surname
          .split('-')
          .map((p) => declineSurname(p, g)[idx])
          .join('-');
      else if (w.role === 'first') form = declineFirstName(parsed.lemmas.first, g)[idx];
      else form = declinePatronymic(parsed.lemmas.patronymic, g)[idx];
      // Пётр → Петра, Петру: беглая «ё» в косвенных падежах не сохраняется
      const dropYo = w.role === 'first' && parsed.lemmas.first === 'петр' && idx > 0;
      return restoreShape(w.text, form, { dropYo }) + w.sep;
    })
    .join('');
}

/**
 * Склонение значения PERSON по контексту метки.
 * @param {string} value значение из карты замен
 * @param {{before?: string, after?: string, variants?: string[], prevCase?: number, gap?: string}} ctx
 * @returns {{text: string, case: typeof CASES[number], consumed: number} | null} null — подставить значение как есть
 */
export function declineInContext(value, ctx = {}) {
  const parsed = parsePersonValue(value, ctx.variants || []);
  if (!parsed) return null;
  const det = detectCase({ before: ctx.before, after: ctx.after, gender: parsed.gender, prevCase: ctx.prevCase, gap: ctx.gap });
  const idx = det ? det.idx : 0; // при неуверенности — именительный
  const consumed = det ? det.consumed : 0;
  const text = declineParsed(parsed, idx);
  if (text === value && !consumed) return null;
  return { text, case: CASES[idx], consumed };
}
