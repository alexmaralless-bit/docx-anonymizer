// Восстановление файла от ИИ (FR-36а, FR-37): .docx с плейсхолдерами + карта замен → .docx с настоящими значениями.
// Обратная замена идёт по тем же потокам, что и анонимизация (ТЗ §6.1–6.3): форматирование ранов сохраняется,
// плейсхолдер, разбитый на раны, восстанавливается в первом ране (как прямая замена §6.3 п.2–4).
import { parseDocx } from './docx/model.js';
import { serializeDocx } from './docx/replace.js';
import { deanonymize, deanonymizeSpans, findUnresolved } from './deanon.js';

/** FR-13: внешняя ссылка после анонимизации (core/apply.js) — восстанавливается исходный URL целиком. */
const ANON_URL_RE = /^https:\/\/anonymized\.invalid\/(.+)$/;

/**
 * @typedef {object} RestoreDocxResult
 * @property {Uint8Array} bytes
 * @property {number} replaced                         число восстановленных меток
 * @property {{text: string, streamId: string, part: string}[]} unresolved   метки [X_n], которых нет в карте
 * @property {{streamId: string, part: string, start: number, end: number, case: string, original: string, text: string}[]} declined
 *   склонённые ФИО (FR-37): координаты — в тексте потока до восстановления
 * @property {{streamId: string, part: string, reason: 'container'}[]} skipped  метки, пересекающие встроенный объект (не трогаются)
 * @property {string[]} changedParts
 */

/**
 * Обратная замена во всех потоках DOCX: тело, таблицы, колонтитулы, сноски, комментарии, авторы правок,
 * поля, alt-тексты, внешние ссылки и docProps (метаданные сохраняются: keepMetadata).
 * Склонение ФИО (decline) — только в тексте документа (live/deleted); в атрибутах и метаданных — исходная форма.
 * @param {Uint8Array} bytes  .docx / .docm
 * @param {import('./mapping.js').Mapping} mapping
 * @param {{decline?: boolean}} [opts]
 * @returns {RestoreDocxResult}
 */
export function restoreDocx(bytes, mapping, { decline = false } = {}) {
  const doc = parseDocx(bytes);
  /** @type {import('./docx/replace.js').TextEdit[]} */
  const edits = [];
  /** @type {RestoreDocxResult['unresolved']} */
  const unresolved = [];
  /** @type {RestoreDocxResult['declined']} */
  const declined = [];
  /** @type {RestoreDocxResult['skipped']} */
  const skipped = [];

  for (const s of doc.streams) {
    if (s.attrKind === 'rel-target') {
      const url = restoreAnonUrl(s.text, mapping);
      if (url !== null) {
        edits.push({ streamId: s.id, start: 0, end: s.text.length, newText: url });
        continue;
      }
    }
    const spans = deanonymizeSpans(s.text, mapping, { decline: decline && (s.type === 'live' || s.type === 'deleted') });
    const kept = [];
    for (const sp of spans) {
      if (crossesContainer(s, sp.start, sp.end)) {
        skipped.push({ streamId: s.id, part: s.part, reason: 'container' });
        continue;
      }
      kept.push(sp);
      edits.push({ streamId: s.id, start: sp.start, end: sp.end, newText: sp.newText });
      if (sp.declined) {
        declined.push({ streamId: s.id, part: s.part, start: sp.start, end: sp.end, case: sp.declined.case, original: sp.declined.original, text: sp.newText });
      }
    }
    for (const u of findUnresolved(s.text, kept)) unresolved.push({ text: u.text, streamId: s.id, part: s.part });
  }

  const { bytes: out, changedParts } = serializeDocx(doc, edits, { keepMetadata: true, stripEmbedded: false });
  return { bytes: out, replaced: edits.length, unresolved, declined, skipped, changedParts };
}

/** Восстановление текста (.md/.txt и вставленный ответ) — то же, что deanonymize (FR-36). */
export const restoreText = deanonymize;

/**
 * `https://anonymized.invalid/[URL_1]` → исходный URL, если хвост — ровно одна известная метка (в т.ч. в %-кодировке).
 * @returns {string|null}
 */
function restoreAnonUrl(text, mapping) {
  const m = ANON_URL_RE.exec(text);
  if (!m) return null;
  const tails = [m[1]];
  try {
    const dec = decodeURIComponent(m[1]);
    if (dec !== m[1]) tails.push(dec);
  } catch {
    /* битая %-последовательность — только как есть */
  }
  for (const tail of tails) {
    const spans = deanonymizeSpans(tail, mapping);
    if (spans.length === 1 && spans[0].start === 0 && spans[0].end === tail.length) return spans[0].newText;
  }
  return null;
}

/** Правка не должна задевать встроенный объект (w:drawing и т.п.): serializeDocx такие правки отвергает целиком. */
function crossesContainer(s, start, end) {
  if (!s.segments || !s.segIndex || end <= start) return false;
  const first = s.segIndex[start];
  const last = s.segIndex[end - 1];
  for (let i = first; i <= last; i++) if (s.segments[i].container) return true;
  return false;
}
