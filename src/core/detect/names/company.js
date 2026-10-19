// COMPANY по правилам: ОПФ + название в кавычках любого типа («», “”, „“, "", '', ‘’), ОПФ + название без
// кавычек (1–2 слова), латинские «Name LLC/Ltd/Inc/GmbH…», название в кавычках после лейбла стороны
// («Поставщик: «Ромашка»») и родовое слово + название («Студия Ромашка», «Группа компаний «Альфа»», политика 0.4).
// ОПФ, родовое слово и кавычки уходят в keepPrefix/keepSuffix.
// «ИП Фамилия И.О.» (FR-21) тоже размечается здесь (kind: 'ip'), но это имя человека (решение владельца 0.4, п. 1):
// kb.js выдаёт его как PERSON с формой «ИП » в keepPrefix, а не как COMPANY.

import { B, E, SP, labelBeforeRe, hasLabelBefore, pickNonOverlapping } from './text.js';
import {
  PREFIX_FORMS,
  FULL_FORMS_RE_SRC,
  IP_FORM_RE_SRC,
  SUFFIX_FORMS_RE_SRC,
  GENERIC_ORG_RE_SRC,
  GOV_ENTITIES,
  ROLE_WORDS,
  isStopWord,
  isNeverMaskOrg,
  lowerE,
  wordList,
} from './lexicon.js';

/**
 * @typedef {object} CompanySpan
 * @property {number} start
 * @property {number} end
 * @property {number} keepPrefix
 * @property {number} keepSuffix
 * @property {string} core          название без ОПФ и кавычек
 * @property {'org'|'ip'} kind
 * @property {string} [form]
 * @property {{surname: string, initials?: string, first?: string, patronymic?: string, start: number, end: number}} [person]  для ИП
 * @property {boolean} [generic]   найдено по родовому слову («Студия Ромашка», политика 0.4)
 */

const OPEN_QUOTES = { '«': '»', '"': '"', '“': '”', '„': '“', "'": "'", '‘': '’', '”': '”' };

const RU_WORD = '[А-ЯЁ][а-яё]+(?:-[А-ЯЁ]?[а-яё]+)*';
const RU_CAPS = '[А-ЯЁ]{2,}(?:-[А-ЯЁ]{2,})*';
const RW = `(?:${RU_WORD}|${RU_CAPS})`;
const INIT2 = `[А-ЯЁ]\\.${SP}?[А-ЯЁ]\\.`;

const SHORT_FORMS = PREFIX_FORMS.slice()
  .sort((a, b) => b.length - a.length)
  .join('|');
const QUOTED_SHORT_RE = new RegExp(`${B}(${SHORT_FORMS})${SP}*(?=[«"“„'‘])`, 'gu');
const QUOTED_FULL_RE = new RegExp(`${B}(${FULL_FORMS_RE_SRC})${SP}*(?=[«"“„'‘])`, 'giu');
const UNQUOTED_RE = new RegExp(
  `${B}(${SHORT_FORMS})${SP}+([А-ЯЁA-Z][\\p{L}\\d]*(?:-[\\p{L}\\d]+)*(?:${SP}[А-ЯЁA-Z][\\p{L}\\d]*(?:-[\\p{L}\\d]+)*)?)${E}`,
  'gu',
);
const IP_RE = new RegExp(
  `${B}(${IP_FORM_RE_SRC.replace('индивидуальн', '[Ии]ндивидуальн')})${SP}+(?:(${RW})${SP}+(${INIT2})|(${RW})${SP}+(${RW})${SP}+(${RW})${E})`,
  'gu',
);
// Родовое слово + название (политика 0.4): 1–3 слова с заглавной или название в кавычках
const CAP_WORD = '[А-ЯЁA-Z][\\p{L}\\d]*(?:-[\\p{L}\\d]+)*';
// латинское название с «&»/«and» внутри («Smith & Co», «Brown and Partners») — одно название, не обрывается на союзе
const GENERIC_RE = new RegExp(`${B}(${GENERIC_ORG_RE_SRC})${SP}+(?:(?=[«"“„'‘])|(${CAP_WORD}(?:${SP}(?:(?:&|and)${SP})?${CAP_WORD}){0,2})${E})`, 'gu');
// после названия идут инициалы («Бюро Иванова И.И.») — это ФИО, а не название
const INITIALS_AFTER_RE = /^[ \u00A0]*[А-ЯЁA-Z]\./u;
const PREFIX_FORM_SET = new Set(PREFIX_FORMS);
const NOT_FORM = `(?!(?:${SUFFIX_FORMS_RE_SRC})(?![\\p{L}\\p{N}]))`;
const LATIN_RE = new RegExp(
  `${B}((?:${NOT_FORM}[A-Z][\\w&'.-]*)(?:${SP}(?:${NOT_FORM}[A-Z][\\w&'.-]*|&|and|of|de|du|der|und)){0,4}),?${SP}+(${SUFFIX_FORMS_RE_SRC})(?![\\p{L}\\p{N}])`,
  'gu',
);

// prettier-ignore
export const COMPANY_QUOTE_LABELS = [
  ...wordList(`поставщик:|покупатель:|исполнитель:|заказчик:|продавец:|подрядчик:|арендатор:|арендодатель:|лицензиар:|лицензиат:|наименование:|полное наименование:|сокращенное наименование:|сокращённое наименование:|организация:|банк получателя:|банк получателя|банк:|supplier:|buyer:|seller:|customer:|contractor:|company:|company name:|beneficiary bank:|beneficiary bank`),
];
const QUOTE_LABEL_RE = labelBeforeRe(COMPANY_QUOTE_LABELS);

/**
 * Разбор названия в кавычках с позиции открывающей кавычки; «ёлочки» — со вложенностью.
 * @returns {{contentStart: number, contentEnd: number, end: number} | null}
 */
export function readQuoted(text, pos) {
  const open = text[pos];
  const close = OPEN_QUOTES[open];
  if (!close) return null;
  const limit = Math.min(text.length, pos + 160);
  if (open === '«') {
    let depth = 0;
    for (let i = pos; i < limit; i++) {
      const ch = text[i];
      if (ch === '\n' || ch === '￼') return null;
      if (ch === '«') depth++;
      else if (ch === '»') {
        depth--;
        if (depth === 0) {
          // «Торговый дом «Ромашка»» — внешняя пара; содержимое включает вложенные кавычки
          return i - pos > 1 ? { contentStart: pos + 1, contentEnd: i, end: i + 1 } : null;
        }
      }
    }
    return null;
  }
  for (let i = pos + 1; i < limit; i++) {
    const ch = text[i];
    if (ch === '\n' || ch === '￼') return null;
    if (ch === close || (open === '"' && ch === '”')) {
      // апостроф внутри слова (O'Neil) — не закрывающая кавычка
      if (close === "'" && /\p{L}/u.test(text[i + 1] || '')) continue;
      return i - pos > 1 ? { contentStart: pos + 1, contentEnd: i, end: i + 1 } : null;
    }
  }
  return null;
}

// ОПФ в начале названия из списка компаний («ООО «Ромашка»», «Общество с ограниченной ответственностью Ромашка», «ИП …»)
const LEAD_FORM_RE = new RegExp(`^(?:(?:${SHORT_FORMS})(?![\\p{L}\\p{N}])|(?:${FULL_FORMS_RE_SRC}|${IP_FORM_RE_SRC})(?![\\p{L}\\p{N}]))[ \\u00A0]*`, 'iu');
// латинская ОПФ в конце названия («Romashka LLC», «Acme Trading Ltd.»)
const TAIL_FORM_RE = new RegExp(`,?[ \\u00A0]+(?:${SUFFIX_FORMS_RE_SRC})$`, 'u');
const QUOTE_CHARS = '«»"“”„\'‘’';

/**
 * Ядро названия из списка компаний (0.4, company-list.js и kb.js): без ОПФ в начале, латинской ОПФ в конце и внешних кавычек.
 * @param {string} name
 */
export function companyCore(name) {
  let c = String(name || '')
    .replace(/[\s\u00A0]+/g, ' ')
    .trim();
  for (let i = 0; i < 3; i++) {
    const before = c;
    c = c.replace(LEAD_FORM_RE, '').replace(TAIL_FORM_RE, '').trim();
    if (c.length >= 2 && QUOTE_CHARS.includes(c[0]) && QUOTE_CHARS.includes(c[c.length - 1])) c = c.slice(1, -1).trim();
    if (c === before) break;
  }
  return c;
}

const keyOf = (s) =>
  lowerE(
    s
      .replace(/[«»"“”„'‘’]/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  );

/** Госорган/банк из списка Q-1? */
export function isGovEntity(core, form = '') {
  const k = keyOf(core);
  return GOV_ENTITIES.has(k) || (form && GOV_ENTITIES.has(keyOf(`${form} ${core}`)));
}

const badCore = (core) => {
  const c = core.trim();
  if (!/\p{L}/u.test(c)) return true;
  if (ROLE_WORDS.has(keyOf(c))) return true;
  return false;
};

/**
 * @param {string} text
 * @param {{govEntities?: boolean}} [opts]  govEntities: true — не трогать госорганы/банки из списка
 * @returns {CompanySpan[]}
 */
export function findCompanies(text, opts = {}) {
  const skipGov = opts.govEntities !== false;
  /** @type {CompanySpan[]} */
  const spans = [];
  const add = (s) => {
    if (badCore(s.core)) return;
    // бренд владельца не маскируется никогда (решение владельца 6, концепция 0.4)
    if (s.kind === 'org' && isNeverMaskOrg(s.core)) return;
    if (skipGov && isGovEntity(s.core, s.form)) return;
    spans.push(s);
  };

  // 1. ОПФ + кавычки
  for (const re of [QUOTED_SHORT_RE, QUOTED_FULL_RE]) {
    for (const m of text.matchAll(re)) {
      const start = /** @type {number} */ (m.index);
      const q = readQuoted(text, start + m[0].length);
      if (!q) continue;
      const core = text.slice(q.contentStart, q.contentEnd);
      add({ start, end: q.end, keepPrefix: q.contentStart - start, keepSuffix: q.end - q.contentEnd, core, kind: 'org', form: m[1] });
    }
  }
  // 2. ИП Фамилия И.О. / ИП Фамилия Имя Отчество (FR-21) — имя человека: kb.js выдаёт PERSON с формой в keepPrefix
  for (const m of text.matchAll(IP_RE)) {
    const start = /** @type {number} */ (m.index);
    const ws = /^[ \u00A0]+/.exec(m[0].slice(m[1].length));
    const coreStart = start + m[1].length + (ws ? ws[0].length : 0);
    const end = start + m[0].length;
    const core = text.slice(coreStart, end);
    if (m[2] && isStopWord(m[2])) continue;
    if (m[4] && [m[4], m[5], m[6]].some(isStopWord)) continue;
    const person = m[2]
      ? { surname: m[2], initials: lowerE(m[3].replace(/[^А-ЯЁ]/g, '')), start: coreStart, end }
      : { surname: m[4], first: m[5], patronymic: m[6], start: coreStart, end };
    add({ start, end, keepPrefix: coreStart - start, keepSuffix: 0, core, kind: 'ip', form: m[1], person });
  }
  // 3. ОПФ + название без кавычек: «ПАО Сбербанк», «ООО Ромашка»
  for (const m of text.matchAll(UNQUOTED_RE)) {
    const start = /** @type {number} */ (m.index);
    if (m[1] === 'ИП') continue;
    const words = m[2].split(/[ \u00A0]/);
    while (words.length && isStopWord(words[words.length - 1])) words.pop();
    if (!words.length || isStopWord(words[0])) continue;
    const core = words.join(' ');
    const coreStart = start + m[0].indexOf(m[2], m[1].length);
    add({ start, end: coreStart + core.length, keepPrefix: coreStart - start, keepSuffix: 0, core, kind: 'org', form: m[1] });
  }
  // 4. Латиница: «Acme Trading Ltd.», «Romashka-Trade LLC»
  for (const m of text.matchAll(LATIN_RE)) {
    let start = /** @type {number} */ (m.index);
    const words = m[1].split(/[ \u00A0]/);
    while (words.length && (isStopWord(words[0]) || !/^[A-Z]/.test(words[0]))) {
      start += words[0].length + 1;
      words.shift();
    }
    if (!words.length) continue;
    const core = words.join(' ').replace(/[,.]$/, '');
    if (core.length < 2 || /^[A-Z]{1,3}$/.test(core)) continue;
    const end = /** @type {number} */ (m.index) + m[0].length;
    add({ start, end, keepPrefix: 0, keepSuffix: end - start - core.length, core, kind: 'org', form: m[2] });
  }
  // 5. Лейбл стороны + название в кавычках без ОПФ
  for (const m of text.matchAll(/[«"“„]/gu)) {
    const pos = /** @type {number} */ (m.index);
    if (!hasLabelBefore(text, pos, QUOTE_LABEL_RE)) continue;
    const q = readQuoted(text, pos);
    if (!q) continue;
    const core = text.slice(q.contentStart, q.contentEnd);
    if (!/^[\p{Lu}\d]/u.test(core)) continue;
    add({ start: pos, end: q.end, keepPrefix: 1, keepSuffix: q.end - q.contentEnd, core, kind: 'org' });
  }
  // 6. Родовое слово + название: «Студия Ромашка», «Агентства «Вектор»», «Группа компаний Альфа Плюс» (политика 0.4, §8.3)
  for (const m of text.matchAll(GENERIC_RE)) {
    const start = /** @type {number} */ (m.index);
    // строчное родовое слово в середине предложения («директор компании Сидоров И.П.», «в компании Петрова П.П.») —
    // не начало названия; строчное допускается только перед кавычками («агентство «Вектор»»)
    if (m[2] && /^\p{Ll}/u.test(m[1])) continue;
    if (!m[2]) {
      const q = readQuoted(text, start + m[0].length);
      if (!q) continue;
      const core = text.slice(q.contentStart, q.contentEnd);
      if (!/^[\p{Lu}\d]/u.test(core)) continue;
      add({ start, end: q.end, keepPrefix: q.contentStart - start, keepSuffix: q.end - q.contentEnd, core, kind: 'org', form: m[1], generic: true });
      continue;
    }
    const words = m[2].split(/[ \u00A0]+/);
    const isTail = (w) => isStopWord(w) || PREFIX_FORM_SET.has(w) || w === '&' || w === 'and';
    while (words.length && isTail(words[words.length - 1])) words.pop();
    if (!words.length || isStopWord(words[0]) || PREFIX_FORM_SET.has(words[0])) continue;
    // инициал в ядре или сразу после него — это ФИО («Бюро Иванова И.И.»): не название и не обрывок
    if (words.some((w) => /^[А-ЯЁA-Z]$/u.test(w))) continue;
    // ядро — исходный текст первых words.length слов m[2] (разделители как в тексте)
    const core = m[2]
      .split(/([ \u00A0]+)/)
      .slice(0, words.length * 2 - 1)
      .join('');
    // «Компания РТ», «Бюро ТЗ»: одиночная короткая аббревиатура — не название (сокращение уже найденной стороны ищет kb.js)
    if (words.length === 1 && (core.length < 3 || (core.length <= 3 && core === core.toUpperCase()))) continue;
    const coreStart = start + m[0].indexOf(m[2], m[1].length);
    const coreEnd = coreStart + core.length;
    if (INITIALS_AFTER_RE.test(text.slice(coreEnd, coreEnd + 4))) continue;
    add({ start, end: coreEnd, keepPrefix: coreStart - start, keepSuffix: 0, core, kind: 'org', form: m[1], generic: true });
  }
  return pickNonOverlapping(spans, (s) => (s.kind === 'ip' ? 1 : 0));
}
