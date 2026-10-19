// Сериализация текстовой модели (версия 0.3; docs/concept-0.3.md «Как это устроено», п. 3): правки в координатах
// потоков (как у serializeDocx) → Markdown или plain text в UTF-8 без BOM. Колонтитулы в результат не попадают.
// Markdown: h1 → «# », h2 → «## », li → «- », ячейки одной таблицы → «| a | b |» с «| --- |» после первой строки,
// разрыв страницы → «---». Экранирование минимальное и обратимое: «|» в ячейках → «\|», в начале абзаца
// «#», «>», «- », «* », «+ », «N. » → с обратной косой; «*», «_», «[», «]» не трогаются — плейсхолдеры «[ФИО_1]»
// остаются как есть (их восстанавливает deanonymize, FR-36).
// Plain text: блоки через пустую строку, ячейки строки таблицы — через табуляцию.
import { CoreError } from '../errors.js';

export const TEXT_MIME = Object.freeze({ md: 'text/markdown', txt: 'text/plain' });

/**
 * @param {{streamById: Map<string, any>, blocks: import('./model.js').TextBlock[]}} doc  текстовая модель (fromText)
 * @param {import('../docx/replace.js').TextEdit[]} [edits]
 * @param {{format?: 'md'|'txt'}} [opts]
 * @returns {{bytes: Uint8Array, text: string, changedParts: string[], removedParts: string[]}}
 */
export function serializeText(doc, edits = [], opts = {}) {
  const format = opts.format === 'txt' ? 'txt' : 'md';
  /** @type {Map<string, import('../docx/replace.js').TextEdit[]>} */
  const byStream = new Map();
  for (const e of edits) {
    const s = doc.streamById.get(e.streamId);
    if (!s) throw new CoreError('INTERNAL', `Неизвестный поток ${e.streamId}`);
    if (e.start < 0 || e.end > s.text.length || e.start > e.end) throw new CoreError('INTERNAL', `Диапазон вне потока ${e.streamId}`);
    let arr = byStream.get(e.streamId);
    if (!arr) byStream.set(e.streamId, (arr = []));
    arr.push(e);
  }
  const changed = new Set();
  /** @type {Map<string, string>} */
  const texts = new Map();
  for (const [id, list] of byStream) {
    list.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < list.length; i++) {
      if (list[i].start < list[i - 1].end) throw new CoreError('INTERNAL', `Пересекающиеся правки в потоке ${id}`);
    }
    const s = doc.streamById.get(id);
    let t = s.text;
    for (let i = list.length - 1; i >= 0; i--) t = t.slice(0, list[i].start) + list[i].newText + t.slice(list[i].end);
    texts.set(id, t);
    if (list.length) changed.add(s.part);
  }
  const textOf = (b) => (b.pid ? (texts.get(`${b.pid}:live`) ?? doc.streamById.get(`${b.pid}:live`)?.text ?? b.text) : b.text);

  /** @type {string[]} */
  const chunks = [];
  const blocks = doc.blocks || [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind === 'header' || b.kind === 'footer') continue;
    if (b.kind === 'hr') {
      chunks.push('---');
      continue;
    }
    if (b.kind === 'cell' && b.table) {
      // вся таблица — подряд идущие ячейки с одним index
      const idx = b.table.index;
      const cols = b.table.cols;
      /** @type {string[][]} */
      const rows = [];
      let j = i;
      while (j < blocks.length && blocks[j].kind === 'cell' && blocks[j].table?.index === idx) {
        const c = blocks[j];
        const t = /** @type {any} */ (c.table);
        (rows[t.row] ||= Array(cols).fill(''))[t.col] = textOf(c);
        j++;
      }
      i = j - 1;
      const filled = rows.filter(Boolean);
      if (format === 'md') {
        const line = (r) => `| ${r.map((x) => escapeCell(x)).join(' | ')} |`;
        const out = [];
        filled.forEach((r, k) => {
          out.push(line(r));
          if (k === 0) out.push(`|${' --- |'.repeat(cols)}`);
        });
        chunks.push(out.join('\n'));
      } else chunks.push(filled.map((r) => r.join('\t')).join('\n'));
      continue;
    }
    const t = textOf(b);
    if (format === 'txt') {
      chunks.push(t);
      continue;
    }
    if (b.kind === 'h1') chunks.push(`# ${t}`);
    else if (b.kind === 'h2') chunks.push(`## ${t}`);
    else if (b.kind === 'li') chunks.push(`- ${t}`);
    else chunks.push(escapeLineStart(t));
  }
  const text = chunks.length ? chunks.join('\n\n') + '\n' : '';
  return { bytes: new TextEncoder().encode(text), text, changedParts: [...changed].sort(), removedParts: [] };
}

/** «|» и перевод строки в ячейке Markdown-таблицы. */
export function escapeCell(t) {
  return String(t)
    .replace(/\\\|/g, '\\\\|')
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, ' ');
}

/** Начало абзаца, которое Markdown принял бы за разметку: заголовок, цитата, пункт списка, нумерация. */
export function escapeLineStart(t) {
  return String(t)
    .replace(/^(#|>)/, '\\$1')
    .replace(/^([-*+])(?=\s)/, '\\$1')
    .replace(/^(\d{1,9})([.)])(?=\s)/, '$1\\$2');
}
