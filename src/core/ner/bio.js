// Разбор меток модели NER и слияние BIO в спаны (WP9, ТЗ §5.2 NLP). Метка слова — по его первому субтокену;
// score спана — средняя вероятность его слов; спаны без букв и короче 2 символов отбрасываются.
// Границы спанов приводятся к соглашениям каталога (FR-18): COMPANY — с ОПФ и кавычками, PERSON — с точкой инициала.
import {
  PREFIX_FORMS,
  FULL_FORMS_RE_SRC,
  SUFFIX_FORMS_RE_SRC,
  ROLE_WORDS,
  POSITION_RE_SRC,
  COMMON_NOUNS,
  isStopWord,
  lowerE,
  wordList,
} from '../detect/names/lexicon.js';

/** Тип сущности по имени метки модели; прочие (MISC и т.п.) — вне контракта NerSpan, считаются O. */
const TYPE_ALIASES = Object.freeze({
  PER: 'PER',
  PERSON: 'PER',
  ORG: 'ORG',
  ORGANIZATION: 'ORG',
  ORGANISATION: 'ORG',
  LOC: 'LOC',
  LOCATION: 'LOC',
  GPE: 'LOC',
});

/** @typedef {{tag: 'B'|'I'|'O', type: 'PER'|'ORG'|'LOC'|null}} Tag */

/**
 * Метки модели (id2label по порядку) → теги BIO. Понимает `B-PER/I-PER` (а также `S-`/`E-` как B/I), голые `PER`
 * (схема IO — тег I) и синонимы типов `PERSON`, `ORG/ORGANIZATION`, `LOC/LOCATION/GPE`.
 * @param {string[]} labels @returns {Tag[]}
 */
export function labelsToTags(labels) {
  return labels.map((raw) => {
    const label = String(raw).trim().toUpperCase();
    const m = /^([BIES])[-_](.+)$/.exec(label);
    const prefix = m ? m[1] : 'I';
    const type = /** @type {'PER'|'ORG'|'LOC'|undefined} */ (TYPE_ALIASES[m ? m[2] : label]);
    if (!type) return { tag: 'O', type: null };
    return { tag: prefix === 'B' || prefix === 'S' ? 'B' : 'I', type };
  });
}

/**
 * Решение по слову из распределения меток (softmax первого субтокена). Тип — argmax маргинальных вероятностей
 * P(X) = P(B-X) + P(I-X) (и P(O) — сумма O и типов вне контракта), а не argmax отдельной метки: модель нередко
 * делит массу между B и I одного типа («Пятунину»: I-PER 0.41, B-PER 0.2, O 0.39 — это PER). Тег — B или I, что больше.
 * @param {ArrayLike<number>} probs  вероятности меток (сумма 1)
 * @param {Tag[]} tags               labelsToTags(labels)
 * @returns {{tag: 'B'|'I'|'O', type: 'PER'|'ORG'|'LOC'|null, prob: number}}
 */
export function decodeWord(probs, tags) {
  const m = { O: 0, PER: 0, ORG: 0, LOC: 0 };
  const b = { PER: 0, ORG: 0, LOC: 0 };
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    if (!t.type) m.O += probs[i];
    else {
      m[t.type] += probs[i];
      if (t.tag === 'B') b[t.type] += probs[i];
    }
  }
  /** @type {'O'|'PER'|'ORG'|'LOC'} */
  let best = 'O';
  for (const k of /** @type {const} */ (['PER', 'ORG', 'LOC'])) if (m[k] > m[best]) best = k;
  if (best === 'O') return { tag: 'O', type: null, prob: m.O };
  return { tag: b[best] * 2 >= m[best] ? 'B' : 'I', type: best, prob: m[best] };
}

/** Пунктуация, которая бывает внутри имени: дефис и апостроф без пробелов («Римский-Корсаков», «О'Коннор»), точка инициала. */
const JOINERS = new Set(['-', '‐', '‑', "'", '’']);
const INITIAL_RE = /^\p{Lu}$/u;

/**
 * «Мостики» через пунктуацию внутри сущности: слово-знак между двумя словами одного типа становится I этого типа,
 * а следующее слово — продолжением (I), даже если модель начала его с B. Дефис/апостроф — только без пробелов вокруг;
 * точка — только после однобуквенного инициала («И.С. Пятунину», «К. В. Ичетовкиной»). Меняет preds на месте.
 * @param {(WordPred & {text?: string})[]} preds  слова в порядке текста (text — слово)
 * @param {string} text
 */
export function bridgePunct(preds, text) {
  for (let i = 1; i + 1 < preds.length; i++) {
    const w = preds[i];
    if (w.type) continue;
    const prev = preds[i - 1];
    const next = preds[i + 1];
    if (!prev.type || prev.type !== next.type) continue;
    const ch = text.slice(w.start, w.end);
    const tight = prev.end === w.start && w.end === next.start;
    const ok = (JOINERS.has(ch) && tight) || (ch === '.' && prev.end === w.start && INITIAL_RE.test(text.slice(prev.start, prev.end)));
    if (!ok) continue;
    w.type = prev.type;
    w.tag = 'I';
    w.prob = (prev.prob + next.prob) / 2;
    next.tag = 'I';
  }
  return preds;
}

/**
 * @typedef {object} WordPred
 * @property {number} start
 * @property {number} end
 * @property {'PER'|'ORG'|'LOC'|null} type
 * @property {'B'|'I'|'O'} tag
 * @property {number} prob   вероятность предсказанной метки
 */

/** Граница абзаца/строки или объекта (U+FFFC — рисунок, поле) — сущность через неё не продолжается. */
const HARD_BREAK_RE = /[\n\r\u2028\u2029\uFFFC]/u;

/**
 * Слияние BIO по словам (в порядке текста): B открывает спан, I продолжает спан того же типа, I без B (или после
 * другого типа) начинает новый, O и смена типа закрывают. score — средняя prob слов спана. С `text` спан
 * закрывается и на переносе строки или U+FFFC между словами («Директор\nИванов» — два спана, не один).
 * @param {WordPred[]} wordPreds
 * @param {{withWords?: boolean, text?: string}} [opts]  withWords — добавить спанам число слов `words` (для joinAdjacent)
 * @returns {import('../contracts/ner.js').NerSpan[]}
 */
export function mergeBio(wordPreds, { withWords = false, text } = {}) {
  /** @type {import('../contracts/ner.js').NerSpan[]} */
  const out = [];
  /** @type {{start: number, end: number, label: 'PER'|'ORG'|'LOC', sum: number, n: number} | null} */
  let cur = null;
  const close = () => {
    if (cur) out.push({ start: cur.start, end: cur.end, label: cur.label, score: cur.sum / cur.n, ...(withWords ? { words: cur.n } : {}) });
    cur = null;
  };
  for (const w of wordPreds) {
    if (w.tag === 'O' || !w.type || (text !== undefined && HARD_BREAK_RE.test(text.slice(w.start, w.end)))) {
      close();
      continue;
    }
    if (cur && text !== undefined && HARD_BREAK_RE.test(text.slice(cur.end, w.start))) close();
    if (w.tag === 'I' && cur && cur.label === w.type) {
      cur.end = w.end;
      cur.sum += w.prob;
      cur.n++;
      continue;
    }
    close();
    cur = { start: w.start, end: w.end, label: w.type, sum: w.prob, n: 1 };
  }
  close();
  return out;
}

const EDGE_RE = /[\p{P}\p{S}\p{Z}\s]/u;
const LETTER_RE = /\p{L}/u;
const UPPER_RE = /\p{Lu}/u;
/** Закрывающая кавычка/скобка → открывающая. Прямые кавычки — сами себе пара. */
const CLOSE_TO_OPEN = Object.freeze({ '»': '«', '“': '„', '”': '“', ')': '(', ']': '[', '"': '"', "'": "'", '’': '‘' });
/** Открывающая → закрывающая; у „ закрывающая “ («„лапки“»), у “ — ”. */
const OPEN_TO_CLOSE = Object.freeze({ '«': '»', '„': '“', '“': '”', '(': ')', '[': ']', '"': '"', "'": "'", '‘': '’' });

const count = (s, ch) => s.split(ch).length - 1;
/** Перед точкой — инициал или сокращение, точка которого — часть имени/названия. */
const ABBR_DOT_RE = /(?:^|[^\p{L}])(?:\p{Lu}|Inc|Ltd|Corp|Co|Jr|Sr|Bros)$/u;
/** Слова должностей и обращений, которых нет в словарях WP2 (lexicon.js): спан только из них — не имя. */
const EXTRA_TEMPLATE_WORDS = new Set([
  ...wordList(`executive|officer|vice|deputy|head|senior|junior|financial|operating|legal|counsel`),
  // названия реквизитов (их значения ищут валидаторы WP1)
  ...wordList(`снилс|огрнип|оквэд|окпо|октмо|окато|iban|swift|bic|ssn|ein|tin|vat`),
]);

/**
 * Подрезка пунктуации и пробелов по краям; парные кавычки/скобки, у которых пара внутри спана, остаются
 * («ООО «Ромашка»»). Спаны короче 2 символов или без единой буквы выбрасываются.
 * @param {import('../contracts/ner.js').NerSpan[]} spans
 * @param {string} text
 * @returns {import('../contracts/ner.js').NerSpan[]}
 */
export function filterSpans(spans, text) {
  const out = [];
  for (const sp of spans) {
    let { start, end } = sp;
    let changed = true;
    while (changed && end > start) {
      changed = false;
      // объемлющие скобки снимаются всегда, объемлющие кавычки — у всех, кроме ORG («Вектор» — название с кавычками)
      const open = text[start];
      if (end - start > 2 && OPEN_TO_CLOSE[open] && closingQuote(text, start) === end - 1 && (BRACKETS.has(open) || sp.label !== 'ORG')) {
        start++;
        end--;
        changed = true;
        continue;
      }
      const first = text[start];
      if (EDGE_RE.test(first)) {
        const close = OPEN_TO_CLOSE[first];
        if (!(close && text.slice(start + 1, end).includes(close))) {
          start++;
          changed = true;
          continue;
        }
      }
      const last = text[end - 1];
      if (EDGE_RE.test(last)) {
        // точка инициала или сокращения ОПФ остаётся: «Иванов П. С.», «И.С.», «Acme Ltd.»
        if (last === '.' && ABBR_DOT_RE.test(text.slice(Math.max(start, end - 8), end - 1))) continue;
        const opener = CLOSE_TO_OPEN[last];
        if (opener) {
          const inner = text.slice(start, end - 1);
          const balanced = opener === last ? count(inner, last) % 2 === 1 : count(inner, opener) > count(inner, last);
          if (balanced) continue;
        }
        end--;
        changed = true;
      }
    }
    // колонтитулы и заголовки: «Стр. 1», «Лист 2», «Раздел 3. Порядок расчётов» — не ORG/LOC; название с ОПФ или
    // в кавычках после номера остаётся («Приложение № 2 ООО «Ромашка»» → «ООО «Ромашка»»)
    if (sp.label !== 'PER') {
      // «§» — знак, подрезка краёв его сняла: «§ 3. Предмет договора» проверяется целиком
      const para = /§\s*$/u.exec(text.slice(Math.max(0, start - 3), start));
      const from = para ? start - para[0].length : start;
      const cut = structuralCut(text.slice(from, end), text.slice(end, end + 16));
      if (cut >= 0) {
        const org = sp.label === 'ORG' ? orgStart(text.slice(from + cut, end)) : -1;
        if (org < 0) continue;
        start = from + cut + org;
      }
    }
    const value = text.slice(start, end);
    if (value.length < 2 || !LETTER_RE.test(value)) continue;
    // имена, названия и топонимы пишутся с заглавной: «в примечании» — не LOC
    if (!UPPER_RE.test(value)) continue;
    if ((sp.label === 'PER' || sp.label === 'ORG') && onlyTemplateWords(value)) continue;
    // короткое сокращение с точкой, за которым не начинается новое предложение: «Стр. 1», «Тел. +7», «Ул. Мира»
    if (/^\p{L}{1,4}$/u.test(value) && text[end] === '.' && /^\.\s*[^\p{Lu}\s]/u.test(text.slice(end, end + 4))) continue;
    out.push({ ...sp, start, end });
  }
  return out;
}

/**
 * Структурные слова колонтитулов и заголовков (нижний регистр, «ё» → «е»): за ними идёт номер страницы, раздела,
 * приложения. Русские — с падежными формами («согласно Приложению № 2», «в Разделе 3»).
 */
// prettier-ignore
export const STRUCT_WORDS = new Set([
  ...wordList(`стр|страница|страницы|странице|страницу|лист|листа|листе|раздел|раздела|разделу|разделом|разделе|статья|статьи|статье|статью|статьей|ст|глава|главы|главе|главу|главой|пункт|пункта|пункту|пунктом|пункте|п|подпункт|подпункта|подпункту|подпунктом|подпункте|пп|приложение|приложения|приложению|приложением|приложении|таблица|таблицы|таблице|таблицу|таблицей|табл|рис|рисунок|рисунка|рисунке|схема|схемы|схеме|форма|формы|форме|форму|часть|части|частью|том|тома|томе|книга|книги|книге|параграф|параграфа|параграфе|§|page|sheet|section|article|chapter|clause|item|appendix|annex|schedule|exhibit|table|figure|fig|part|volume`),
].map(lowerE));

/** Первое слово (или «§») с необязательной точкой и пробелами после. */
const STRUCT_HEAD_RE = /^(§|\p{L}+)\.?\s*/u;
/** Номер: «№ 2», «3», «4.1», «12/2025», «3а», римский «IV»; дальше не буква и не цифра. */
const STRUCT_NUM_RE = /^(?:№\s*)?(?:\d[\d./-]*(?:\p{Ll}(?!\p{L}))?|[IVXLCDM]+)(?![\p{L}\p{N}])/u;
/** Разделители между номером и заголовком: «Раздел 3. Порядок расчётов», «Статья 5 — Ответственность». */
const STRUCT_GAP_RE = /^[\s.:;,—–-]*/u;
/** Одно слово с заглавной и номер: «Лист 2», «Ромашка 2». */
const WORD_NUM_RE = /^(\p{Lu}[\p{L}-]*)\.?\s+(?:№\s*)?\d[\d./-]*$/u;

/**
 * Спан начинается со структурного слова и номера («Стр. 1», «Раздел 3. Порядок расчётов», «Section IV») или это
 * одно нарицательное слово с номером («Ромашка 2» — `COMMON_NOUNS` WP2). Спан из одного структурного слова — тоже,
 * если номер идёт сразу за ним в тексте (`after`: модель отдала ORG только «Лист» в «Лист 2 из 3»). Возвращает
 * смещение остатка после номера и разделителей (длина value — остатка нет); −1 — спан не структурный.
 * @param {string} value
 * @param {string} [after]  текст сразу за спаном
 */
export function structuralCut(value, after = '') {
  const head = STRUCT_HEAD_RE.exec(value);
  if (head && STRUCT_WORDS.has(lowerE(head[1]))) {
    if (head[0].length === value.length) {
      return STRUCT_NUM_RE.test(after.replace(/^\.?\s*/u, '')) && /^[.\s]/u.test(after) ? value.length : -1;
    }
    const num = STRUCT_NUM_RE.exec(value.slice(head[0].length));
    if (num) {
      const at = head[0].length + num[0].length;
      return at + STRUCT_GAP_RE.exec(value.slice(at))[0].length;
    }
  }
  const wn = WORD_NUM_RE.exec(value);
  if (wn && COMMON_NOUNS.has(lowerE(wn[1]))) return value.length;
  return -1;
}

/**
 * Начало названия организации в остатке после номера: ОПФ («ООО «Ромашка»», в т.ч. после слов заголовка — «Реквизиты
 * ООО «Ромашка»»), кавычки или латинская ОПФ после названия («Acme Ltd.»). −1 — признаков названия нет.
 * @param {string} rest
 */
function orgStart(rest) {
  if (!LETTER_RE.test(rest)) return -1;
  if (OPEN_QUOTES.has(rest[0]) || OPF_LEAD_SHORT_RE.test(rest) || OPF_LEAD_FULL_RE.test(rest)) return 0;
  const opf = OPF_INNER_RE.exec(rest);
  if (opf) return opf.index + opf[0].length - opf[1].length;
  for (let i = 0; i < rest.length; i++) if (OPEN_QUOTES.has(rest[i])) return i;
  return SUFFIX_ANY_RE.test(rest) ? 0 : -1;
}

/**
 * Спан из одних шаблонных слов договора («настоящего Договора», «Licensor», «Mr», «Арбитражном суде г») — не имя
 * и не название (словари WP2: names/lexicon.js). Однобуквенные слова не учитываются. Топонимы не проверяются:
 * в стоп-словах есть «Москва», «London».
 * @param {string} value
 */
function onlyTemplateWords(value) {
  const words = value.match(/\p{L}{2,}/gu);
  if (!words) return true;
  return words.every((w) => ROLE_WORDS.has(lowerE(w)) || EXTRA_TEMPLATE_WORDS.has(w.toLowerCase()) || isStopWord(w));
}

/**
 * Соседние спаны одного типа, разделённые только пробелами (без пунктуации и переноса строки), — одна сущность:
 * модель часто ставит B на каждое слово ФИО («Сибагатуллина/B-PER Наталия/B-PER Эдуардовна/I-PER»). score — среднее
 * по словам (взвешенное числом слов).
 * @param {(import('../contracts/ner.js').NerSpan & {words?: number})[]} spans  в порядке текста
 * @param {string} text
 */
export function joinAdjacent(spans, text) {
  const out = [];
  for (const sp of spans) {
    const last = out[out.length - 1];
    if (last && last.label === sp.label && /^[ \t\u00a0]+$/.test(text.slice(last.end, sp.start))) {
      const n1 = last.words || 1;
      const n2 = sp.words || 1;
      last.score = (last.score * n1 + sp.score * n2) / (n1 + n2);
      last.words = n1 + n2;
      last.end = sp.end;
      continue;
    }
    out.push({ ...sp });
  }
  return out.map(({ words, ...sp }) => sp);
}

// Короткие ОПФ — с учётом регистра («АО», не «ао»), полные — без («Общество с ограниченной ответственностью»)
const PREFIX_SHORT_RE = new RegExp(`(?:^|[\\s(,;:—–-])(${PREFIX_FORMS.join('|')})\\s+$`, 'u');
const PREFIX_FULL_RE = new RegExp(`(?:^|[\\s(,;:—–-])(${FULL_FORMS_RE_SRC})\\s+$`, 'iu');
const OPF_SHORT_ONLY_RE = new RegExp(`^(?:${PREFIX_FORMS.join('|')})$`, 'u');
const OPF_FULL_ONLY_RE = new RegExp(`^(?:${FULL_FORMS_RE_SRC})$`, 'iu');
const OPF_LEAD_SHORT_RE = new RegExp(`^(?:${PREFIX_FORMS.join('|')})\\s`, 'u');
const OPF_LEAD_FULL_RE = new RegExp(`^(?:${FULL_FORMS_RE_SRC})\\s`, 'iu');
const OPF_INNER_RE = new RegExp(`\\s((?:${PREFIX_FORMS.join('|')})\\s)`, 'u');
const SUFFIX_ANY_RE = new RegExp(`[\\s,](?:${SUFFIX_FORMS_RE_SRC})(?![\\p{L}\\p{N}])`, 'u');
const SUFFIX_RE = new RegExp(`^,?\\s(?:${SUFFIX_FORMS_RE_SRC})(?![\\p{L}\\p{N}])`, 'u');
const TITLE_RE = /^(?:Mr|Mrs|Ms|Miss|Dr|Prof|Sir|Mme|Herr|Frau|г-н|г-жа|господин|госпожа)\.?\s+/iu;
const OPEN_QUOTES = new Set(['«', '„', '“', '"']);
const BRACKETS = new Set(['(', '[']);

/**
 * Слова перед ФИО, которые модель нередко включает в PER: обращения, должности и роли сторон («Уважаемый Аркадий
 * Валентинович», «Директор Иванов Пётр Сергеевич», «экспедитор Кравчук»). Должности — POSITION_RE_SRC словарей WP2
 * (все падежи), роли — ROLE_WORDS; здесь — то, чего там нет.
 */
const PER_LEAD_WORDS = new Set(
  [
    ...[...ROLE_WORDS].filter((w) => !w.includes(' ')),
    'уважаемый',
    'уважаемая',
    'уважаемые',
    'дорогой',
    'дорогая',
    'г-н',
    'г-жа',
    'гн',
    'гжа',
    'господин',
    'госпожа',
    'господина',
    'госпожи',
    'гражданин',
    'гражданка',
    'менеджер',
    'юрист',
    'специалист',
    'инженер',
    'водитель',
    'курьер',
    'сотрудник',
    'нотариус',
    'адвокат',
    'dear',
    'mr',
    'mrs',
    'ms',
    'miss',
    'dr',
    'prof',
    'sir',
    'madam',
    ...EXTRA_TEMPLATE_WORDS,
  ].map(lowerE),
);
const POSITION_LEAD_RE = new RegExp(`^(?:${POSITION_RE_SRC})(?![\\p{L}\\p{N}-])`, 'iu');
const LEAD_WORD_RE = /^(\p{L}+(?:-\p{L}+)?)\.?(?![\p{L}\p{N}])/u;
const LEAD_GAP_RE = /^[\s,:;—–]+/u;

/**
 * Начало PER без ведущих обращений и должностей. Возвращает новый start; −1 — в спане одни такие слова.
 * @param {string} text @param {number} start @param {number} end
 */
function stripPersonLead(text, start, end) {
  for (;;) {
    const rest = text.slice(start, end);
    const m = TITLE_RE.exec(rest) || POSITION_LEAD_RE.exec(rest) || leadWord(rest);
    if (!m) return start;
    const gap = LEAD_GAP_RE.exec(rest.slice(m[0].length));
    const next = start + m[0].length + (gap ? gap[0].length : 0);
    if (!LETTER_RE.test(text.slice(next, end))) return -1;
    if (!gap && !/\s$/u.test(m[0])) return start; // слово не отделено от следующего («Директоров» — не «Директор»)
    start = next;
  }
}

function leadWord(rest) {
  const m = LEAD_WORD_RE.exec(rest);
  return m && PER_LEAD_WORDS.has(lowerE(m[1])) ? m : null;
}

/** Конец парной кавычки, открытой в позиции i (с учётом вложенных «…«…»…»), или −1. */
function closingQuote(text, i) {
  const open = text[i];
  const close = OPEN_TO_CLOSE[open];
  if (!close) return -1;
  let depth = 0;
  for (let j = i + 1; j < text.length && j < i + 200; j++) {
    const ch = text[j];
    if (ch === '\n') return -1;
    if (ch === close && depth === 0) return j;
    if (open !== close && ch === open) depth++;
    else if (open !== close && ch === close) depth--;
  }
  return -1;
}

/**
 * Границы по соглашениям каталога (FR-18, фикстура COMPANY): ORG включает кавычки вокруг названия, ОПФ перед ним
 * («ООО «Ромашка»», «Общество с ограниченной ответственностью «Сфера»») и латинскую ОПФ после («Acme Ltd.»);
 * спан из одной ОПФ («ПАО») дотягивается до названия в кавычках. PER: без обращения и должности впереди
 * («Mr.», «г-н», «Уважаемый», «Директор»), с точкой последнего инициала («Иванов П. С.»). Спаны, от которых ничего
 * не осталось, выбрасываются.
 * @param {import('../contracts/ner.js').NerSpan[]} spans
 * @param {string} text
 */
export function alignSpans(spans, text) {
  const out = [];
  for (const sp of spans) {
    let { start, end } = sp;
    if (sp.label === 'ORG') {
      // одна ОПФ → до закрывающей кавычки названия
      const value = text.slice(start, end);
      if (OPF_SHORT_ONLY_RE.test(value) || OPF_FULL_ONLY_RE.test(value)) {
        const m = /^\s+/.exec(text.slice(end));
        const q = m ? end + m[0].length : -1;
        const c = q >= 0 && OPEN_QUOTES.has(text[q]) ? closingQuote(text, q) : -1;
        if (c < 0) continue; // голая ОПФ — не сущность
        end = c + 1;
      }
      // незакрытая кавычка внутри спана — до её закрывающей («ПАО «Кедр» → «ПАО «Кедр-Сервис»»)
      for (let i = start; i < end; i++) {
        if (!OPEN_QUOTES.has(text[i])) continue;
        const c = closingQuote(text, i);
        if (c < 0) break;
        if (c >= end) {
          end = c + 1;
          break;
        }
        i = c;
      }
      // спан начинается сразу за открывающей кавычкой — всё название в кавычках («Атлант» → ««Атлант-Сервис»»)
      if (start > 0 && OPEN_QUOTES.has(text[start - 1])) {
        const c = closingQuote(text, start - 1);
        if (c >= end) {
          start--;
          end = c + 1;
        }
      }
      // ОПФ перед названием
      const head = text.slice(Math.max(0, start - 60), start);
      const before = PREFIX_SHORT_RE.exec(head) || PREFIX_FULL_RE.exec(head);
      if (before) start -= before[0].length - before[0].indexOf(before[1]);
      // латинская ОПФ после
      const after = SUFFIX_RE.exec(text.slice(end, end + 20));
      if (after) end += after[0].length;
    } else if (sp.label === 'PER') {
      // без обращения и должности впереди («Mr.», «г-н», «Уважаемый», «Директор»); спан из одних таких слов — не имя
      start = stripPersonLead(text, start, end);
      if (start < 0) continue;
    }
    // точка последнего инициала или сокращения ОПФ («Иванов П. С.», «Oakridge Partners Corp.»)
    if (sp.label !== 'LOC' && text[end] === '.' && ABBR_DOT_RE.test(text.slice(Math.max(start, end - 8), end))) end++;
    if (end - start < 2) continue;
    out.push({ ...sp, start, end });
  }
  return out;
}

/**
 * Дубликаты и пересечения после alignSpans (расширение ORG до ОПФ и кавычек сводит соседние спаны в один): вложенный
 * спан того же типа поглощается объемлющим (score — больший из двух); спан другого типа внутри кавычек названия ORG
 * («ПАО "Орион-Логистик"» и PER «Орион») — тоже: кавычки названия — признак сильнее score отдельного слова. Прочие
 * пересечения (другой тип или частичное перекрытие) решаются в пользу большего score; непересекающиеся спаны остаются
 * все. Результат — в порядке текста.
 * @param {import('../contracts/ner.js').NerSpan[]} spans
 * @param {string} [text]  без текста правило кавычек ORG не применяется
 * @returns {import('../contracts/ner.js').NerSpan[]}
 */
export function dedupeSpans(spans, text) {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  /** @type {import('../contracts/ner.js').NerSpan[]} */
  const out = [];
  for (const sp of sorted) {
    const cur = { ...sp };
    let drop = false;
    for (let i = out.length - 1; i >= 0; i--) {
      const k = out[i];
      if (k.end <= cur.start || cur.end <= k.start) continue;
      const nested = k.start <= cur.start && cur.end <= k.end;
      if (nested && (k.label === cur.label || (k.label === 'ORG' && text !== undefined && insideQuotes(text, k, cur)))) {
        k.score = Math.max(k.score, cur.score);
        drop = true;
        break;
      }
      if (k.score >= cur.score) {
        drop = true;
        break;
      }
      out.splice(i, 1);
    }
    if (!drop) out.push(cur);
  }
  return out.sort((a, b) => a.start - b.start);
}

/** inner лежит внутри парных кавычек, открытых в пределах outer и закрытых в нём же. */
function insideQuotes(text, outer, inner) {
  for (let q = outer.start; q < inner.start; q++) {
    if (!OPEN_QUOTES.has(text[q])) continue;
    const c = closingQuote(text, q);
    if (c >= inner.end && c < outer.end) return true;
  }
  return false;
}
