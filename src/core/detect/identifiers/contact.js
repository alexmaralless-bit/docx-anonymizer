// Контактные идентификаторы: EMAIL, URL, PHONE.
import { email, url, phone } from '../../validators.js';
import { labelState, scan } from './labels.js';

const cand = (start, end, confidence, validator) => (validator ? { start, end, confidence, validator } : { start, end, confidence });

/* ---------- EMAIL ---------- */
const EMAIL_RE = /(?<![\p{L}\p{N}._%+'-])[\p{L}\p{N}._%+'-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;

export function detectEmail(text) {
  const out = [];
  for (const c of scan(text, EMAIL_RE)) {
    // ведущая пунктуация («'info@…», «.a@…») к адресу не относится
    const lead = /^[._%+'-]+/.exec(c.text);
    const start = c.start + (lead ? lead[0].length : 0);
    let end = c.end;
    let value = text.slice(start, end);
    // хвостовой дефис/точка домена — не часть адреса
    while (value.length && /[.-]$/.test(value)) value = value.slice(0, -1);
    end = start + value.length;
    if (email(value)) out.push(cand(start, end, 'validated', 'email'));
  }
  return out;
}

/* ---------- URL ---------- */
const URL_STOP = '\\s<>"«»\\u00a0\\uFFFC';
const SCHEME_RE = new RegExp(`(?<![\\p{L}\\p{N}@._%+/-])(?:(?:https?|ftp):\\/\\/|www\\.)[^${URL_STOP}]+`, 'giu');
const BARE_RE = new RegExp(
  `(?<![\\p{L}\\p{N}@._%+/:-])(?:[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?\\.)+\\p{L}{2,}(?![\\p{L}\\p{N}@-])(?:[/?#][^${URL_STOP}]*)?`,
  'gu',
);

/** Срезает хвостовую пунктуацию и непарные скобки. */
function trimUrl(s) {
  for (;;) {
    const last = s[s.length - 1];
    if (!last) return s;
    if (/[.,;:!?»”'"…]/.test(last)) s = s.slice(0, -1);
    else if (last === ')' && (s.match(/\(/g) || []).length < (s.match(/\)/g) || []).length) s = s.slice(0, -1);
    else if (last === ']' && (s.match(/\[/g) || []).length < (s.match(/\]/g) || []).length) s = s.slice(0, -1);
    else return s;
  }
}

export function detectUrl(text) {
  const out = [];
  const taken = [];
  const overlaps = (a, b) => taken.some((t) => a < t[1] && t[0] < b);
  for (const re of [SCHEME_RE, BARE_RE]) {
    for (const c of scan(text, re)) {
      const value = trimUrl(c.text);
      const end = c.start + value.length;
      if (!value || overlaps(c.start, end) || !url(value)) continue;
      taken.push([c.start, end]);
      out.push(cand(c.start, end, 'validated', 'url'));
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/* ---------- PHONE ---------- */
const SEP = '[ \\u00a0.\\-–()]*';
const PRE = '(?<![\\p{L}\\p{N}+])(?<!\\d[-./])';
const POST = '(?![\\p{L}\\p{N}])(?![-/]\\d)';
// РФ: +7 / 8 / 7 и 10 цифр с любыми разделителями
const RU_RE = new RegExp(`${PRE}(?:\\+7|8|7)${SEP}\\(?\\d{3}\\)?${SEP}\\d{3}${SEP}\\d{2}${SEP}\\d{2}${POST}`, 'gu');
// международный: «+» и 7–15 цифр
const INTL_RE = new RegExp(`${PRE}\\+\\d(?:${SEP}\\d){6,14}`, 'gu');
// произвольный номер 7–15 цифр — только после лейбла
const GEN_RE = new RegExp(`${PRE}\\(?\\d(?:${SEP}\\d){6,14}`, 'gu');
const EXT_RE = /[ \u00a0,;]*(?:доб(?:авочный)?|ext|внутр)\.?[ \u00a0:]*\d{1,6}(?![\p{L}\p{N}])/iuy;
const countDigits = (s) => s.replace(/\D/g, '').length;

/** Отбрасывает хвостовые группы цифр, пока номер не уложится в 15 цифр. */
function fit(s) {
  let v = s;
  while (countDigits(v) > 15) {
    const m = /[ \u00a0.\-–()]+\d+[ \u00a0.\-–()]*$/.exec(v);
    if (!m) return null;
    v = v.slice(0, m.index);
  }
  return v.replace(/[ \u00a0.\-–(]+$/, '');
}

export function detectPhone(text, ctx) {
  const out = [];
  const taken = [];
  const overlaps = (a, b) => taken.some((t) => a < t[1] && t[0] < b);
  for (const re of [RU_RE, INTL_RE, GEN_RE]) {
    for (const c of scan(text, re)) {
      const main = fit(c.text);
      if (!main) continue;
      const digits = countDigits(main);
      if (digits < 7 || digits > 15) continue;
      let end = c.start + main.length;
      if (overlaps(c.start, end)) continue;
      const { mine, foreign } = labelState(text, c.start, ctx, 'PHONE');
      const valid = phone(main);
      let level = null;
      if (mine) level = valid ? 'validated' : 'labeled';
      else if (!foreign && valid) {
        const plus = main.startsWith('+');
        const dg = main.replace(/\D/g, '');
        const ruEight = dg.length === 11 && dg[0] === '8';
        const ruSeven = dg.length === 11 && dg[0] === '7' && /[ \u00a0.\-–()]/.test(main);
        if (plus || ruEight || ruSeven) level = 'validated';
      }
      if (!level) continue;
      // добавочный номер входит в сущность
      EXT_RE.lastIndex = end;
      const ext = EXT_RE.exec(text);
      if (ext) end += ext[0].length;
      taken.push([c.start, end]);
      out.push(cand(c.start, end, level, valid ? 'phone' : undefined));
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
