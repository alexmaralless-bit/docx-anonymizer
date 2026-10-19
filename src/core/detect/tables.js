// Заголовки столбцов таблиц (версия 0.4, WP11-D; FR-18 — контекст идентификатора): число в ячейке под заголовком
// «Код ТН ВЭД», «Артикул» — код товара, а не ИНН. Раннер (`detect/runner.js`) передаёт текст заголовка столбца
// потоковым детекторам в `ctx.stream.columnHeader`.
// DOCX — по разметке w:tbl/w:tr/w:tc части (с учётом w:gridSpan; вложенная таблица — своя), текстовая модель PDF —
// по `doc.blocks[].table {index, row, col}` (core/pdf/layout.js). Заголовок — текст ячейки первой строки того же столбца.
// Чистый JS без chrome.* и DOM; значения документа в логи не попадают.

const TAG_RE = /<(\/?)w:(tbl|tr|tc|gridSpan)(?=[\s/>])([^>]*)>/g;

/**
 * Ячейки таблиц части DOCX: диапазоны `<w:tc>` с номером таблицы, строки и столбца сетки.
 * @param {string} xml
 * @returns {{start: number, end: number, table: number, row: number, col: number}[]}
 */
export function docxCells(xml) {
  const out = [];
  /** @type {{id: number, row: number, col: number, cell: any}[]} */
  const stack = [];
  let tables = 0;
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(xml))) {
    const close = m[1] === '/';
    const name = m[2];
    const top = stack[stack.length - 1];
    if (name === 'tbl') {
      if (close) stack.pop();
      else stack.push({ id: tables++, row: -1, col: 0, cell: null });
    } else if (!top) continue;
    else if (name === 'tr' && !close && !m[3].endsWith('/')) {
      top.row++;
      top.col = 0;
    } else if (name === 'tc') {
      if (!close) {
        top.cell = { start: m.index, end: xml.length, table: top.id, row: top.row, col: top.col, span: 1 };
        out.push(top.cell);
      } else if (top.cell) {
        top.cell.end = m.index;
        top.col += top.cell.span;
        top.cell = null;
      }
    } else if (name === 'gridSpan' && top.cell) {
      const v = /w:val="(\d+)"/.exec(m[3]);
      if (v) top.cell.span = Math.max(1, Number(v[1]));
    }
  }
  return out.map(({ start, end, table, row, col }) => ({ start, end, table, row, col }));
}

/**
 * Текст заголовка столбца для абзацев ячеек ниже первой строки таблицы.
 * @param {import('../docx/model.js').DocModel} doc
 * @returns {Map<string, string>} pid абзаца → текст ячейки первой строки того же столбца
 */
export function columnHeaders(doc) {
  /** @type {Map<string, string>} */
  const out = new Map();
  const textOf = (p) => (p?.streams?.live && doc.streamById?.get(p.streams.live)?.text) || '';
  /** @param {{pid: string, key: string, row: number, text: string}[]} cells */
  const assign = (cells) => {
    /** @type {Map<string, {row: number, texts: string[]}>} */
    const head = new Map();
    for (const c of cells) {
      const h = head.get(c.key);
      if (!h || c.row < h.row) head.set(c.key, { row: c.row, texts: [c.text] });
      else if (c.row === h.row) h.texts.push(c.text);
    }
    for (const c of cells) {
      const h = head.get(c.key);
      if (h && c.row > h.row) out.set(c.pid, h.texts.join(' ').trim());
    }
  };
  if (Array.isArray(doc?.blocks)) {
    const cells = [];
    for (const b of doc.blocks) if (b.table && b.pid) cells.push({ pid: b.pid, key: `${b.table.index}:${b.table.col}`, row: b.table.row, text: b.text });
    assign(cells);
    return out;
  }
  const byPart = new Map();
  for (const p of doc?.paragraphs || []) {
    if (!p.streams?.live) continue;
    let list = byPart.get(p.part);
    if (!list) byPart.set(p.part, (list = []));
    list.push(p);
  }
  for (const [name, paras] of byPart) {
    const xml = doc.parts?.get?.(name)?.xml;
    if (!xml || !xml.includes('<w:tbl')) continue;
    const tcs = docxCells(xml);
    if (!tcs.length) continue;
    const cells = [];
    for (const p of paras) {
      // самая вложенная ячейка, содержащая начало абзаца: последняя по началу ячейка до него, ещё не закрытая
      let lo = 0;
      let hi = tcs.length - 1;
      let k = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (tcs[mid].start <= p.pos) {
          k = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      while (k >= 0 && tcs[k].end <= p.pos) k--;
      const best = k >= 0 ? tcs[k] : null;
      if (best) cells.push({ pid: p.pid, key: `${best.table}:${best.col}`, row: best.row, text: textOf(p) });
    }
    assign(cells);
  }
  return out;
}
