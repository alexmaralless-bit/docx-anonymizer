// Обратная замена в тексте ответа LLM (FR-36, FR-37).
import { CASES, declineInContext } from './deanon-morph.js';

/**
 * Правка обратной замены в координатах входного текста (FR-36, FR-37).
 * @typedef {object} DeanonSpan
 * @property {number} start   начало метки во входном тексте
 * @property {number} end     конец метки во входном тексте, включая поглощённое приклеенное окончание («[ФИО_1]у»)
 * @property {string} newText подставляемое значение (при склонении — склонённая форма)
 * @property {{case: string, original: string}} [declined] только для склонённых PERSON: падеж (CASES) и значение из карты
 */

/**
 * Находит распознанные метки и их замены, не собирая результат: основа и для текста, и для DOCX (core/restore-doc.js).
 * Спаны отсортированы и не пересекаются; координаты — во входном тексте.
 * @param {string} text
 * @param {import('./mapping.js').Mapping} mapping
 * @param {{decline?: boolean}} [opts] decline — склонять ФИО по контексту метки (FR-37, редакция 0.2)
 * @returns {DeanonSpan[]}
 */
export function deanonymizeSpans(text, mapping, { decline = false } = {}) {
  /** @type {Map<string, {value: string, category: string, variants: string[]}>} ключ: «префикс_номер» в нижнем регистре, префикс с '_' вместо пробелов/дефисов */
  const table = new Map();
  const prefixes = new Set();
  for (const e of mapping?.entries || []) {
    const m = /^\[(.+)_(\d+)\]$/u.exec(e.token || '');
    if (!m) continue; // режимы mask/delete не восстанавливаются
    const prefix = m[1].toLowerCase();
    prefixes.add(prefix);
    table.set(`${prefix}_${m[2]}`, { value: e.value ?? e.original, category: e.category, variants: e.variants || [] });
  }
  /** @type {DeanonSpan[]} */
  const spans = [];
  if (!prefixes.size) return spans;

  // Известные префиксы: [ФИО_1], ФИО_1, ФИО 1, ФИО-1, [фио_1] — внутри любых обёрток Markdown
  const alt = [...prefixes]
    .sort((a, b) => b.length - a.length)
    .map((p) => p.split(/_/).map(escapeRe).join('[ _\\-]'))
    .join('|');
  // [ ФИО_1 ] — пробелы допустимы только внутри скобок; без скобок — ФИО_1 / ФИО 1 / ФИО-1
  const re = new RegExp(`\\[\\s*(${alt})[ _\\-](\\d+)\\s*\\]|(?<![\\p{L}\\p{N}])(${alt})[ _\\-](\\d+)(?![\\p{N}])`, 'giu');
  /** предыдущая склонённая метка: падеж и конец во входном тексте (для сочинения «от [ФИО_1] и [ФИО_2]») */
  let prev = null;
  let m;
  while ((m = re.exec(text))) {
    const [whole, p1, n1, p2, n2] = m;
    const p = p1 ?? p2;
    const n = n1 ?? n2;
    const entry = table.get(`${p.toLowerCase().replace(/[ -]/g, '_')}_${n}`);
    if (entry === undefined) continue; // остаётся как есть, его найдёт поиск нераспознанных
    /** @type {DeanonSpan} */
    const span = { start: m.index, end: m.index + whole.length, newText: entry.value };
    // Склоняется только PERSON в форме [X_n]: голое ФИО_1 — скорее ссылка на метку, чем текст
    if (decline && p1 !== undefined && entry.category === 'PERSON') {
      const r = declineInContext(entry.value, {
        before: wordAlignedBefore(text, m.index),
        after: text.slice(span.end, span.end + 4),
        variants: entry.variants,
        prevCase: prev?.idx,
        gap: prev ? text.slice(prev.end, m.index) : undefined,
      });
      if (r) {
        span.end += r.consumed;
        span.newText = r.text;
        span.declined = { case: r.case, original: entry.value };
        prev = { idx: CASES.indexOf(r.case), end: span.end };
      }
    }
    spans.push(span);
    re.lastIndex = span.end;
  }
  return spans;
}

/** Нераспознанные конструкции вида [ПРЕФИКС_n]. */
const UNRESOLVED_RE = /\[([\p{L}][\p{L}_ -]*?)[ _-](\d+)\]/gu;

/**
 * Нераспознанные метки [X_n] во входном тексте вне спанов замены (координаты входа).
 * @param {string} text
 * @param {{start: number, end: number}[]} spans отсортированные спаны deanonymizeSpans
 * @returns {{text: string, start: number, end: number}[]}
 */
export function findUnresolved(text, spans) {
  const out = [];
  const re = new RegExp(UNRESOLVED_RE.source, UNRESOLVED_RE.flags);
  let k = 0;
  let m;
  while ((m = re.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    while (k < spans.length && spans[k].end <= start) k++;
    if (k < spans.length && spans[k].start < end) continue; // пересекается с распознанной меткой
    out.push({ text: m[0], start, end });
  }
  return out;
}

/**
 * @param {string} text
 * @param {import('./mapping.js').Mapping} mapping
 * @param {{decline?: boolean}} [opts] decline — склонять ФИО по контексту метки (FR-37, редакция 0.2)
 * @returns {{
 *   text: string,
 *   unresolved: {text: string, start: number, end: number}[],
 *   replaced: number,
 *   declined: {start: number, end: number, case: string, original: string, text: string}[],
 * }}
 *   unresolved — конструкции вида [ПРЕФИКС_n], которых нет в маппинге (позиции — в результирующем тексте);
 *   declined — подстановки PERSON не в исходной форме: позиции в результирующем тексте, падеж (CASES),
 *   значение из карты (original) и подставленный текст; при decline: false — пустой массив
 */
export function deanonymize(text, mapping, { decline = false } = {}) {
  const spans = deanonymizeSpans(text, mapping, { decline });
  /** @type {{start: number, end: number, case: string, original: string, text: string}[]} */
  const declined = [];
  let out = '';
  let last = 0;
  for (const s of spans) {
    out += text.slice(last, s.start);
    if (s.declined)
      declined.push({ start: out.length, end: out.length + s.newText.length, case: s.declined.case, original: s.declined.original, text: s.newText });
    out += s.newText;
    last = s.end;
  }
  out += text.slice(last);
  // Нераспознанные [ЧТО-ТО_n] — по результату, как и раньше (позиции в результирующем тексте)
  const unresolved = [];
  const re2 = new RegExp(UNRESOLVED_RE.source, UNRESOLVED_RE.flags);
  let m;
  while ((m = re2.exec(out))) unresolved.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return { text: out, unresolved, replaced: spans.length, declined };
}

/** До 40 символов перед меткой без обрезанного слова в начале окна (FR-37: предлог в окне ≤ 3 слов). */
function wordAlignedBefore(text, idx) {
  let from = Math.max(0, idx - 40);
  if (from > 0 && /[\p{L}\p{N}-]/u.test(text[from - 1])) {
    while (from < idx && /[\p{L}\p{N}-]/u.test(text[from])) from++;
  }
  return text.slice(from, idx);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
