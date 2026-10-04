// COMPANY по правилам: ОПФ + название в кавычках любого типа («», “”, „“, "", '', ‘’), ОПФ + название без
// кавычек (1–2 слова), латинские «Name LLC/Ltd/Inc/GmbH…», «ИП Фамилия И.О.» (FR-21) и название в кавычках
// после лейбла стороны («Поставщик: «Ромашка»»). ОПФ и кавычки уходят в keepPrefix/keepSuffix.

import { B, E, SP, labelBeforeRe, hasLabelBefore, pickNonOverlapping } from './text.js';
import { PREFIX_FORMS, FULL_FORMS_RE_SRC, IP_FORM_RE_SRC, SUFFIX_FORMS_RE_SRC, GOV_ENTITIES, ROLE_WORDS, isStopWord, lowerE } from './lexicon.js';

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
const NOT_FORM = `(?!(?:${SUFFIX_FORMS_RE_SRC})(?![\\p{L}\\p{N}]))`;
const LATIN_RE = new RegExp(
  `${B}((?:${NOT_FORM}[A-Z][\\w&'.-]*)(?:${SP}(?:${NOT_FORM}[A-Z][\\w&'.-]*|&|and|of|de|du|der|und)){0,4}),?${SP}+(${SUFFIX_FORMS_RE_SRC})(?![\\p{L}\\p{N}])`,
  'gu',
);

// prettier-ignore
export const COMPANY_QUOTE_LABELS = [
  'поставщик:', 'покупатель:', 'исполнитель:', 'заказчик:', 'продавец:', 'подрядчик:', 'арендатор:', 'арендодатель:', 'лицензиар:',
  'лицензиат:', 'наименование:', 'полное наименование:', 'сокращенное наименование:', 'сокращённое наименование:', 'организация:',
  'банк получателя:', 'банк получателя', 'банк:', 'supplier:', 'buyer:', 'seller:', 'customer:', 'contractor:', 'company:',
  'company name:', 'beneficiary bank:', 'beneficiary bank',
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
  // 2. ИП Фамилия И.О. / ИП Фамилия Имя Отчество — COMPANY целиком (FR-21)
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
  return pickNonOverlapping(spans, (s) => (s.kind === 'ip' ? 1 : 0));
}
