// Документные идентификаторы: PASSPORT, BIRTHDATE, CONTRACT, AMOUNT.
import { passport, birthdate } from '../../validators.js';
import { NB, NA, labelState, scan } from './labels.js';

const NBSP = '\\u00a0';
const cand = (start, end, confidence, validator, extra) => ({ start, end, confidence, ...(validator ? { validator } : {}), ...(extra || {}) });

const RU_MONTHS = 'январ[яь]|феврал[яь]|март[а]?|апрел[яь]|ма[яй]|июн[яь]|июл[яь]|август[а]?|сентябр[яь]|октябр[яь]|ноябр[яь]|декабр[яь]';
const EN_MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const MONTH = `(?:${RU_MONTHS}|${EN_MONTHS})\\.?`;

/* ---------- ПАСПОРТ ---------- */
const NUM_MARK = `(?:[ ${NBSP}]*(?:№|N|No\\.?|номер)[ ${NBSP}:]*|[ ${NBSP}]?)`;
// серия+номер РФ: 45 05 123456 | 4505 123456 | 4505123456 | 4505 № 123456
const PASSPORT_RU_RE = new RegExp(`${NB}\\d{2}[ ${NBSP}]?\\d{2}${NUM_MARK}\\d{6}${NA}`, 'giu');
// загранпаспорт РФ: 71 1234567
const PASSPORT_FOREIGN_RF_RE = new RegExp(`${NB}\\d{2}[ ${NBSP}]?\\d{7}${NA}`, 'gu');
// иностранный: буквы/цифры 6–12 с хотя бы одной цифрой
const PASSPORT_ALNUM_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?=[A-Z0-9]*\\d)[A-Z0-9]{6,12}(?![\\p{L}\\p{N}])`, 'gu');
const ISSUED_RE = new RegExp(`^[,;.)\\s]*(?:кем[ ${NBSP}]+выдан|выдан[аы]?|issued[ ${NBSP}]+by)[ ${NBSP}:]*`, 'iu');
const DATE_IN_TEXT_RE = new RegExp(`\\d{1,2}[./]\\d{1,2}[./]\\d{2,4}|\\d{1,2}[ ${NBSP}]+(?:${MONTH})[ ${NBSP}]+\\d{4}`, 'iu');
const DEPT_CODE_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:код[ ${NBSP}]+подразделения|код[ ${NBSP}]+подр\\.?|к\\/п)[ ${NBSP}:]*(\\d{3}[- ]\\d{3})(?!\\d)`, 'giu');

export function detectPassport(text, ctx) {
  const out = [];
  const nums = []; // {start, end, key}
  const taken = [];
  const free = (a, b) => !taken.some((t) => a < t[1] && t[0] < b);
  const add = (c, key) => {
    taken.push([c.start, c.end]);
    nums.push({ start: c.start, end: c.end, key });
    out.push(cand(c.start, c.end, 'labeled', 'passport'));
  };
  const keyOf = (s) => s.replace(/[^\p{L}\p{N}]/gu, '').toUpperCase();
  for (const c of scan(text, PASSPORT_RU_RE)) {
    if (labelState(text, c.start, ctx, 'PASSPORT').mine && passport(c.text.replace(/[^\d]/g, ''))) add(c, keyOf(c.text));
  }
  for (const c of scan(text, PASSPORT_FOREIGN_RF_RE)) {
    if (free(c.start, c.end) && labelState(text, c.start, ctx, 'PASSPORT').mine && passport(c.text)) add(c, keyOf(c.text));
  }
  for (const c of scan(text, PASSPORT_ALNUM_RE)) {
    if (free(c.start, c.end) && /[A-Z]/.test(c.text) && labelState(text, c.start, ctx, 'PASSPORT').mine && passport(c.text)) add(c, keyOf(c.text));
  }
  // орган выдачи после номера — вхождение той же сущности (canonical)
  for (const n of nums) {
    const m = ISSUED_RE.exec(text.slice(n.end, n.end + 60));
    if (!m) continue;
    const orgStart = n.end + m[0].length;
    const line = text.slice(orgStart, orgStart + 200).split('\n')[0];
    const d = DATE_IN_TEXT_RE.exec(line);
    let org;
    if (d && d.index > 0) org = line.slice(0, d.index);
    else {
      const cut = line.search(/[,;]/);
      org = cut >= 0 ? line.slice(0, cut) : line;
    }
    org = org.replace(/[\s,;]+$/, '');
    if (org.length >= 3 && free(orgStart, orgStart + org.length)) {
      taken.push([orgStart, orgStart + org.length]);
      out.push(cand(orgStart, orgStart + org.length, 'labeled', undefined, { canonical: n.key }));
    }
  }
  // код подразделения
  for (const c of scan(text, DEPT_CODE_RE)) {
    const start = c.end - c.m[1].length;
    const prev = [...nums].reverse().find((n) => n.end <= start);
    if (!free(start, c.end)) continue;
    taken.push([start, c.end]);
    out.push(cand(start, c.end, 'labeled', undefined, prev ? { canonical: prev.key } : undefined));
  }
  return out.sort((a, b) => a.start - b.start);
}

/* ---------- ДАТА РОЖДЕНИЯ ---------- */
const DATE_RE = new RegExp(
  `${NB}(?:\\d{1,2}[./-]\\d{1,2}[./-]\\d{4}|\\d{1,2}(?:st|nd|rd|th)?[ ${NBSP}]+${MONTH},?[ ${NBSP}]+\\d{4}|(?:${EN_MONTHS})\\.?[ ${NBSP}]+\\d{1,2}(?:st|nd|rd|th)?,?[ ${NBSP}]+\\d{4})(?![\\p{L}\\p{N}])(?![-./]\\d)`,
  'giu',
);
const AFTER_DOB_RE = new RegExp(`^[ ${NBSP}]*(?:г\\.?[ ${NBSP}]*р\\.?|года[ ${NBSP}]+рождения|г\\.[ ${NBSP}]+рождения|\\(д\\.?р\\.?\\))`, 'iu');

export function detectBirthdate(text, ctx) {
  const out = [];
  for (const c of scan(text, DATE_RE)) {
    if (!birthdate(c.text)) continue;
    const before = labelState(text, c.start, ctx, 'BIRTHDATE').mine;
    const after = AFTER_DOB_RE.test(text.slice(c.end, c.end + 30));
    if (before || after) out.push(cand(c.start, c.end, 'labeled', 'birthdate'));
  }
  return out;
}

/* ---------- НОМЕР ДОГОВОРА ---------- */
const CONTRACT_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:договор(?:а|у|ом|е)?|контракт(?:а|у|ом|е)?|соглашени(?:е|я|ю|ем|и)|agreement|contract)` +
    `(?:[ ${NBSP}]+[\\p{L}-]+){0,4}[ ${NBSP}]*(?:№|#|N[oо]\\.?|nr\\.?)[ ${NBSP}:]*` +
    `((?=[\\p{L}\\p{N}\\/._-]*\\d)[\\p{L}\\p{N}]+(?:[-/._][\\p{L}\\p{N}]+)*)`,
  'giu',
);

export function detectContract(text) {
  const out = [];
  for (const c of scan(text, CONTRACT_RE)) {
    const code = c.m[1];
    if (code.length > 40) continue;
    out.push(cand(c.end - code.length, c.end, 'labeled'));
  }
  return out;
}

/* ---------- СУММА ---------- */
const NUMBER = `(?:\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d{1,3}(?:[ ${NBSP}\\u202f]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)`;
const CUR_WORD = `(?:руб(?:\\.|л(?:ей|я|ь))?|₽|RUB|USD|EUR|GBP|CNY|долл(?:\\.|аров|ара|ар)?|евро|\\$|€|£|¥)`;
const CUR_AFTER = new RegExp(`^[ ${NBSP}]*${CUR_WORD}(?![\\p{L}])`, 'iu');
const CUR_BEFORE = new RegExp(`(?:\\$|€|£|¥|USD|EUR|GBP|RUB|CNY)[ ${NBSP}]*$`, 'iu');
const KOPECKS = new RegExp(`^[ ${NBSP}]*\\d{1,2}[ ${NBSP}]*коп(?:\\.|еек|ейки|ейка)?(?![\\p{L}])`, 'iu');
const WORDS_IN_PARENS = new RegExp(`^[ ${NBSP}]*\\(([^()\\n]{3,250})\\)`, 'u');
const AMOUNT_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?<!\\d[ ${NBSP}.,])${NUMBER}(?![\\p{L}\\p{N}])(?!\\d)`, 'gu');

export function detectAmount(text) {
  const out = [];
  for (const c of scan(text, AMOUNT_RE)) {
    let start = c.start;
    let end = c.end;
    // валюта: после числа или перед ним
    let cur = false;
    const after = CUR_AFTER.exec(text.slice(end, end + 30));
    if (after) {
      cur = true;
      end += after[0].length;
      // «руб.» — точка принадлежит сумме только перед скобкой/копейками
      if (text[end - 1] === '.' && !/^[ \u00a0]*(?:\(|\d)/.test(text.slice(end, end + 5))) end--;
      const kop = KOPECKS.exec(text.slice(end, end + 30));
      if (kop) end += kop[0].length;
    } else {
      const bm = CUR_BEFORE.exec(text.slice(Math.max(0, start - 8), start));
      if (bm) {
        cur = true;
        start -= bm[0].length;
      }
    }
    // расшифровка прописью — одна сущность с суммой
    if (cur) {
      const w = WORDS_IN_PARENS.exec(text.slice(end, end + 270));
      if (w && /\p{L}{3}/u.test(w[1])) end += w[0].length;
    }
    const hasLabel = amountLabel(text, c.start);
    const shaped = /[ \u00a0\u202f,]\d{3}|[.,]\d{1,2}$|\d{4,}/.test(c.text);
    if (cur && hasLabel) out.push(cand(start, end, 'labeled'));
    else if (cur) out.push(cand(start, end, 'weak'));
    else if (hasLabel && shaped) out.push(cand(start, end, 'labeled'));
  }
  return out;
}

// «цена», «стоимость», «сумма» (+ до трёх слов) / price, amount, fee
const AMOUNT_LABEL_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:цен[аыуе]|стоимост[ьи]|сумм[аыуе]|price|amount|fee|total)(?:[ ${NBSP}]+[\\p{L}.«»"'()-]+){0,3}[ ${NBSP}:–—-]*(?:составля[а-я]+[ ${NBSP}:]*)?$`,
  'iu',
);
function amountLabel(text, start) {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  return AMOUNT_LABEL_RE.test(text.slice(Math.max(lineStart, start - 40), start));
}
