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
  return tableHeaders(doc).column;
}

/**
 * Заголовки столбца и строки для абзацев ячеек: `column` — текст ячейки первой строки того же столбца (для ячеек ниже неё),
 * `row` — текст ближайшей непустой ячейки слева в той же строке («Дата рождения | 17.11.1993», WP11-E).
 * @param {import('../docx/model.js').DocModel} doc
 * @returns {{column: Map<string, string>, row: Map<string, string>}}
 */
export function tableHeaders(doc) {
  /** @type {Map<string, string>} */
  const out = new Map();
  /** @type {Map<string, string>} */
  const rowOut = new Map();
  const textOf = (p) => (p?.streams?.live && doc.streamById?.get(p.streams.live)?.text) || '';
  /** @param {{pid: string, key: string, row: number, text: string}[]} cells */
  const assign = (cells) => {
    // строки заголовка — все строки таблицы до первой, где есть цифра (заголовок PDF переносится на две строки:
    // «Код ТН» / «ВЭД», WP11-E); первая строка — заголовок всегда
    /** @type {Map<string, number>} */
    const firstData = new Map();
    const tableOf = (c) => c.key.split(':')[0];
    const top = new Map();
    for (const c of cells) top.set(tableOf(c), Math.min(top.get(tableOf(c)) ?? Infinity, c.row));
    for (const c of cells) {
      if (!/\d/.test(c.text)) continue;
      const t = tableOf(c);
      firstData.set(t, Math.min(firstData.get(t) ?? Infinity, c.row));
    }
    const headRows = (t) => Math.max((top.get(t) ?? 0) + 1, firstData.get(t) ?? (top.get(t) ?? 0) + 1);
    /** @type {Map<string, {row: number, text: string}[]>} */
    const head = new Map();
    for (const c of cells) {
      if (c.row >= headRows(tableOf(c))) continue;
      let h = head.get(c.key);
      if (!h) head.set(c.key, (h = []));
      h.push({ row: c.row, text: c.text });
    }
    for (const c of cells) {
      const h = head.get(c.key);
      if (h && c.row >= headRows(tableOf(c)))
        out.set(
          c.pid,
          h
            .sort((a, b) => a.row - b.row)
            .map((x) => x.text)
            .join(' ')
            .trim(),
        );
    }
    // ячейка слева в той же строке: ближайшая по номеру столбца, с текстом
    /** @type {Map<string, Map<number, string[]>>} */
    const rows = new Map();
    for (const c of cells) {
      const rk = `${c.key.split(':')[0]}:${c.row}`;
      let r = rows.get(rk);
      if (!r) rows.set(rk, (r = new Map()));
      const col = Number(c.key.split(':')[1]);
      if (!r.has(col)) r.set(col, []);
      /** @type {string[]} */ (r.get(col)).push(c.text);
    }
    for (const c of cells) {
      const r = rows.get(`${c.key.split(':')[0]}:${c.row}`);
      const col = Number(c.key.split(':')[1]);
      let best = -1;
      for (const [k, texts] of r || []) if (k < col && k > best && texts.join(' ').trim()) best = k;
      const left = best >= 0 ? r?.get(best) : undefined;
      if (left) rowOut.set(c.pid, left.join(' ').trim());
    }
  };
  if (Array.isArray(doc?.blocks)) {
    const cells = [];
    for (const b of doc.blocks) if (b.table && b.pid) cells.push({ pid: b.pid, key: `${b.table.index}:${b.table.col}`, row: b.table.row, text: b.text });
    assign(cells);
    return { column: out, row: rowOut };
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
  return { column: out, row: rowOut };
}
