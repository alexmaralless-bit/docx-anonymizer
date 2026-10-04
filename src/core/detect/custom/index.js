// Пользовательские категории (FR-44): словарь / лейбл+форма / шаблон.
// Категории динамические (settings.customCategories → ctx.catalog) — поэтому документный детектор.
// Контракт — docs/contracts.md §2. Уровни: словарь → labeled; лейбл+форма → labeled;
// шаблон → weak (labeled, если рядом найден один из labels).
import { getValidator } from '../../validators.js';
import { checkRegexSource, validateCustomCategory } from './rules.js';

const AUTHOR_KINDS = new Set(['author', 'initials', 'author-id']);
const BUDGET_MS = 2000; // R-8: категория, потратившая на документ больше, отключается для остатка документа
const LABEL_WINDOW = 60;
const SEP = '[ \\t\\u00A0:：№#=\\-–—.]{0,6}';
const SHAPE_CLASS = { digits: '\\d', letters: '\\p{L}', alnum: '[\\p{L}\\p{N}]', any: '[^\\s,;.:()«»"\']' };

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const WORD = '[\\p{L}\\p{N}_]';

/** Шаблон значения: пробелы гибкие, е/ё равноправны. */
function valueToSource(v) {
  let out = '';
  for (const ch of v.trim()) {
    if (/\s/.test(ch)) out += out.endsWith('[ \\t\\u00A0]+') ? '' : '[ \\t\\u00A0]+';
    else if (ch === 'е' || ch === 'ё') out += '[её]';
    else if (ch === 'Е' || ch === 'Ё') out += '[ЕЁ]';
    else out += escapeRe(ch);
  }
  return out;
}

function checkValidator(name, value) {
  if (!name || name === 'none') return { ok: true, name: undefined };
  const fn = getValidator(name);
  if (!fn) return { ok: true, name: undefined }; // валидатор ещё не подключён — не блокируем
  return fn(value) ? { ok: true, name } : { ok: false };
}

function labelRegex(labels) {
  const alt = labels
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((l) => l.trim().split(/\s+/).map(escapeRe).join('[ \\t\\u00A0]+'))
    .join('|');
  return alt;
}

/**
 * Находит вхождения пользовательской категории в тексте. Используется детектором и предпросмотром в настройках.
 * @param {any} cc CustomCategory
 * @param {string} text
 * @param {'ru'|'en'|'both'} [language]
 * @returns {{start: number, end: number, confidence: 'labeled'|'weak', validator?: string}[]}
 */
export function findCustomMatches(cc, text, language = 'both') {
  if (!text) return [];
  const out = [];
  if (cc.kind === 'dictionary') {
    const d = cc.dictionary || {};
    const vals = [...new Set((d.values || []).filter((v) => typeof v === 'string' && v.trim()))].sort((a, b) => b.length - a.length);
    if (!vals.length) return out;
    const body = vals.map(valueToSource).join('|');
    const src = d.wholeWord === false ? `(?:${body})` : `(?<!${WORD})(?:${body})(?!${WORD})`;
    const re = new RegExp(src, d.caseSensitive ? 'gu' : 'giu');
    for (const m of text.matchAll(re)) out.push({ start: m.index, end: m.index + m[0].length, confidence: 'labeled' });
  } else if (cc.kind === 'labeled') {
    const l = cc.labeled || {};
    const labels = [...(language !== 'en' ? l.labels?.ru || [] : []), ...(language !== 'ru' ? l.labels?.en || [] : [])];
    if (!labels.length) return out;
    const cls = SHAPE_CLASS[l.shape] || SHAPE_CLASS.any;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${labelRegex(labels)})${SEP}(${cls}+)`, 'giu');
    for (const m of text.matchAll(re)) {
      const value = m[1];
      if (value.length < (l.minLen || 1) || value.length > (l.maxLen || 64)) continue;
      const v = checkValidator(l.validator, value);
      if (!v.ok) continue;
      const start = m.index + m[0].length - value.length;
      out.push({ start, end: start + value.length, confidence: 'labeled', validator: v.name });
    }
  } else if (cc.kind === 'pattern') {
    const p = cc.pattern || {};
    if (!checkRegexSource(p.regex, p.flags || '').ok) return out;
    const re = new RegExp(p.regex, (p.flags || '') + 'g');
    const labels = [...(language !== 'en' ? p.labels?.ru || [] : []), ...(language !== 'ru' ? p.labels?.en || [] : [])];
    const labelRe = labels.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${labelRegex(labels)})`, 'iu') : null;
    for (const m of text.matchAll(re)) {
      if (!m[0]) continue;
      const v = checkValidator(p.validator, m[0]);
      if (!v.ok) continue;
      const before = text.slice(Math.max(0, m.index - LABEL_WINDOW), m.index);
      out.push({ start: m.index, end: m.index + m[0].length, confidence: labelRe && labelRe.test(before) ? 'labeled' : 'weak', validator: v.name });
    }
  }
  return out;
}

/** @param {{registerDetector: Function, registerDocumentDetector: Function}} api */
export function register(api) {
  api.registerDocumentDetector('custom', (doc, entities, ctx) => {
    const cats = ctx.catalog.list.filter((c) => !c.builtin && c.custom && ctx.isEnabled(c.id) && validateCustomCategory(c.custom).length === 0);
    if (!cats.length) return [];
    const spent = new Map(cats.map((c) => [c.id, 0]));
    const out = [];
    for (const s of doc.streams) {
      if (s.type === 'attr' && AUTHOR_KINDS.has(s.attrKind || '')) continue;
      if (!s.text) continue;
      for (const c of cats) {
        if (spent.get(c.id) > BUDGET_MS) continue;
        const t0 = Date.now();
        let found = [];
        try {
          found = findCustomMatches(c.custom, s.text, ctx.language);
        } catch (err) {
          spent.set(c.id, Infinity);
        }
        spent.set(c.id, spent.get(c.id) + (Date.now() - t0));
        for (const f of found)
          out.push({ streamId: s.id, category: c.id, start: f.start, end: f.end, confidence: f.confidence, source: 'rule', validator: f.validator });
      }
    }
    return out;
  });
}
