// Логика страницы «Восстановить» без DOM: разбор файла карты, подготовка текста с подсветкой нераспознанного и склонённого (FR-36, FR-37).
import { mergeMappings } from '../../core/mapping.js';

/**
 * Разбирает содержимое .mapping.json (или нескольких файлов) в один маппинг.
 * @param {string[]} texts
 * @returns {{mapping?: any, error?: 'json'|'shape'}}
 */
export function parseMappingFiles(texts) {
  const list = [];
  for (const t of texts) {
    let j;
    try {
      j = JSON.parse(t);
    } catch {
      return { error: 'json' };
    }
    if (
      !j ||
      typeof j !== 'object' ||
      !Array.isArray(j.entries) ||
      !j.entries.every((e) => e && typeof e.token === 'string' && typeof (e.value ?? e.original) === 'string')
    ) {
      return { error: 'shape' };
    }
    list.push({ ...j, entries: j.entries.map((e) => ({ variants: [], parts: [], occurrences: 0, ...e })), documents: j.documents || [] });
  }
  if (!list.length) return { error: 'shape' };
  return { mapping: list.length === 1 ? list[0] : mergeMappings(list) };
}

/**
 * Режет текст на сегменты для подсветки нераспознанных меток и склонённых подстановок (FR-36, FR-37).
 * Диапазоны не пересекаются; при пересечении побеждает начавшийся раньше.
 * @param {string} text
 * @param {{start: number, end: number}[]} unresolved позиции в text
 * @param {{start: number, end: number}[]} [declined] позиции склонённых подстановок в text
 * @returns {{text: string, unresolved: boolean, declined: boolean, item?: any}[]} item — исходная запись declined
 */
export function toSegments(text, unresolved, declined = []) {
  const marks = [
    ...unresolved.map((u) => ({ start: u.start, end: u.end, kind: 'unresolved', item: u })),
    ...declined.map((d) => ({ start: d.start, end: d.end, kind: 'declined', item: d })),
  ].sort((a, b) => a.start - b.start);
  const out = [];
  let pos = 0;
  for (const u of marks) {
    if (u.start < pos) continue;
    if (u.start > pos) out.push({ text: text.slice(pos, u.start), unresolved: false, declined: false });
    out.push(
      u.kind === 'declined'
        ? { text: text.slice(u.start, u.end), unresolved: false, declined: true, item: u.item }
        : { text: text.slice(u.start, u.end), unresolved: true, declined: false },
    );
    pos = u.end;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), unresolved: false, declined: false });
  return out;
}

/** Уникальные нераспознанные метки с числом повторов. */
export function countUnresolved(unresolved) {
  const m = new Map();
  for (const u of unresolved) m.set(u.text, (m.get(u.text) || 0) + 1);
  return [...m].map(([text, count]) => ({ text, count }));
}
