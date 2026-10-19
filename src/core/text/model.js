// Текстовая модель документа (версия 0.3, Ц3; docs/concept-0.3.md «Как это устроено», п. 3): блоки текста (из PDF —
// core/pdf/layout.js) становятся обычной DocModel с потоками-абзацами, поэтому analyze(), база знаний сторон, поиск,
// вкладка «Текст» и маппинг работают без изменений. Отличия от DOCX: `kind: 'text'`, нет ZIP-частей и XML
// (`parts` пуст, `entries` пуст), есть `blocks` (для сериализации в Markdown/текст, core/text/serialize.js)
// и `tables` (pid ячеек — для зоны реквизитов в kb.js).
import { detectLanguage, partRank } from '../docx/model.js';

export const TEXT_MAIN_PART = 'word/document.xml';
/** Колонтитулы PDF — в своих «частях»: сущности в них находятся (FR-25), но в результат они не попадают. */
export const TEXT_HEADER_PART = 'word/header1.xml';
export const TEXT_FOOTER_PART = 'word/footer1.xml';

/**
 * @typedef {import('../pdf/layout.js').Block & {pid?: string}} TextBlock
 */

/**
 * Блоки → DocModel (`kind: 'text'`). Один live-поток на блок (кроме `hr`): `p<N>:live`, часть — основной текст,
 * верхний или нижний колонтитул. Ячейки таблиц — отдельные абзацы (`depth: 1`), их pid собраны в `doc.tables`.
 * @param {import('../pdf/layout.js').Block[]} blocks
 * @param {{name?: string, size?: number, format?: 'pdf'|'text'}} [meta]
 */
export function fromText(blocks, meta = {}) {
  /** @type {import('../docx/model.js').Stream[]} */
  const streams = [];
  /** @type {import('../docx/model.js').Paragraph[]} */
  const paragraphs = [];
  /** @type {TextBlock[]} */
  const out = [];
  /** @type {Map<number, {index: number, cols: number, pids: string[]}>} */
  const tables = new Map();
  let n = 0;
  blocks.forEach((b, i) => {
    /** @type {TextBlock} */
    const blk = { ...b, text: String(b.text ?? '') };
    if (b.kind !== 'hr') {
      const pid = `p${n++}`;
      const part = b.kind === 'header' ? TEXT_HEADER_PART : b.kind === 'footer' ? TEXT_FOOTER_PART : TEXT_MAIN_PART;
      const id = `${pid}:live`;
      streams.push({ id, part, pid, type: 'live', text: blk.text, pos: i, order: 0 });
      paragraphs.push({ pid, part, depth: b.kind === 'cell' ? 1 : 0, pos: i, streams: { live: id } });
      blk.pid = pid;
      if (b.table) {
        let t = tables.get(b.table.index);
        if (!t) tables.set(b.table.index, (t = { index: b.table.index, cols: b.table.cols, pids: [] }));
        t.pids.push(pid);
      }
    }
    out.push(blk);
  });
  // порядок обхода FR-25: основной текст → верхние → нижние колонтитулы
  const byRank = (a, b) => partRank(a.part) - partRank(b.part) || a.pos - b.pos;
  streams.sort(byRank);
  streams.forEach((s, k) => (s.order = k));
  paragraphs.sort(byRank);
  return {
    kind: 'text',
    format: meta.format || 'pdf',
    name: meta.name,
    entries: [],
    parts: new Map(),
    streams,
    streamById: new Map(streams.map((s) => [s.id, s])),
    paragraphs,
    blocks: out,
    tables: [...tables.values()],
    /** @type {{code: string, count?: number, details?: object}[]} */
    warnings: [],
    language: detectLanguage(streams),
    size: meta.size || 0,
  };
}
