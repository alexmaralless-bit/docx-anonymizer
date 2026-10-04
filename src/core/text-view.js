// Данные для вкладки «Текст» (GET_TEXT → TEXT, FR-31): virtualText параграфов с подсветкой.

/**
 * @param {import('./docx/model.js').DocModel} doc
 * @param {import('./contracts/entity.js').EntityGroup[]} groups
 * @param {{part?: string, from?: number, count?: number}} [q]
 * @returns {{paragraphs: {pid: string, text: string, spans: {start: number, end: number, entityId: string, occurrenceId: string, category: string}[]}[], total: number}}
 */
export function getParagraphs(doc, groups, q = {}) {
  const part = q.part || 'word/document.xml';
  const from = q.from || 0;
  const count = q.count || 200;
  const paras = doc.paragraphs.filter((p) => p.part === part);
  /** @type {Map<string, any[]>} */
  const spansByStream = new Map();
  for (const g of groups) {
    for (const o of g.occurrences) {
      let arr = spansByStream.get(o.streamId);
      if (!arr) spansByStream.set(o.streamId, (arr = []));
      arr.push({ start: o.start, end: o.end, entityId: g.id, occurrenceId: o.id, category: g.category });
    }
  }
  const page = paras.slice(from, from + count).map((p) => {
    const sid = p.streams.live;
    const s = sid ? doc.streamById.get(sid) : null;
    return {
      pid: p.pid,
      text: s ? s.text : '',
      spans: sid ? (spansByStream.get(sid) || []).sort((a, b) => a.start - b.start) : [],
    };
  });
  return { paragraphs: page, total: paras.length };
}

/** Контекст вхождения для таблицы: «…в лице ⟦Иванова П.С.⟧, действующего…» (без логирования!). */
export function occurrenceContext(doc, o, radius = 40) {
  const s = doc.streamById.get(o.streamId);
  if (!s) return '';
  const a = Math.max(0, o.start - radius);
  const b = Math.min(s.text.length, o.end + radius);
  return `${a > 0 ? '…' : ''}${s.text.slice(a, o.start)}⟦${s.text.slice(o.start, o.end)}⟧${s.text.slice(o.end, b)}${b < s.text.length ? '…' : ''}`;
}
