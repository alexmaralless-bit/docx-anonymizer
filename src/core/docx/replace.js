// Замена в координатах virtualText с сохранением форматирования (ТЗ §6.3)
// и сборка результирующего ZIP (FR-12, FR-13, FR-15, FR-40).
import { applyRangeEdits, escapeAttr, escapeText, tokenize, parseAttrs } from './xml.js';
import { writeZip, inflateEntry } from './zip.js';
import { CoreError } from '../errors.js';

/**
 * Правка текста в координатах потока.
 * @typedef {object} TextEdit
 * @property {string} streamId
 * @property {number} start
 * @property {number} end
 * @property {string} newText   unescaped — экранирование делает ядро (FR-16)
 */

/**
 * @typedef {object} SerializeOptions
 * @property {boolean} [keepMetadata=false]  false → очистка docProps, удаление custom.xml и thumbnail (FR-12)
 * @property {boolean} [stripEmbedded=false] true → удаление embeddings/charts (FR-15)
 */

/**
 * Применяет правки к модели и возвращает байты нового .docx.
 * Исходная модель не меняется — её можно применять повторно с другими решениями.
 * @param {import('./model.js').DocModel} doc
 * @param {TextEdit[]} edits
 * @param {SerializeOptions} [options]
 * @returns {{bytes: Uint8Array, changedParts: string[], removedParts: string[]}}
 */
export function serializeDocx(doc, edits, options = {}) {
  const keepMetadata = !!options.keepMetadata;
  const stripEmbedded = !!options.stripEmbedded;

  /** @type {Map<string, {from: number, to: number, text: string}[]>} */
  const rawByPart = new Map();
  const pushRaw = (part, e) => {
    let arr = rawByPart.get(part);
    if (!arr) rawByPart.set(part, (arr = []));
    arr.push(e);
  };

  // 1. Группируем правки по потокам
  /** @type {Map<string, TextEdit[]>} */
  const byStream = new Map();
  for (const e of edits) {
    const s = doc.streamById.get(e.streamId);
    if (!s) throw new CoreError('INTERNAL', `Неизвестный поток ${e.streamId}`);
    if (e.start < 0 || e.end > s.text.length || e.start > e.end) throw new CoreError('INTERNAL', `Диапазон вне потока ${e.streamId}`);
    let arr = byStream.get(e.streamId);
    if (!arr) byStream.set(e.streamId, (arr = []));
    arr.push(e);
  }

  // 2. Метаданные: очистка всех meta-потоков (правки сущностей в них тогда не нужны)
  if (!keepMetadata) {
    for (const s of doc.streams) {
      if (s.type === 'meta') {
        byStream.delete(s.id);
        pushRaw(s.part, { from: /** @type {number} */ (s.valueStart), to: /** @type {number} */ (s.valueEnd), text: '' });
      }
    }
  }

  for (const [streamId, list] of byStream) {
    const s = /** @type {import('./model.js').Stream} */ (doc.streamById.get(streamId));
    list.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < list.length; i++) {
      if (list[i].start < list[i - 1].end) throw new CoreError('INTERNAL', `Пересекающиеся правки в потоке ${streamId}`);
    }
    if (s.segments) planRunEdits(doc, s, list, (e) => pushRaw(s.part, e));
    else planValueEdits(s, list, (e) => pushRaw(s.part, e));
  }

  // 3. Удаляемые части
  const removed = new Set();
  if (!keepMetadata) {
    for (const e of doc.entries) {
      if (e.name === 'docProps/custom.xml' || /^docProps\/thumbnail\.[^/]+$/.test(e.name)) removed.add(e.name);
    }
  }
  if (stripEmbedded) {
    for (const e of doc.entries) {
      if (/^word\/(embeddings|charts)\//.test(e.name)) removed.add(e.name);
    }
    // Раны с w:object / c:chart удаляются целиком; правки внутри них отбрасываются
    for (const part of doc.parts.values()) {
      if (!part.embeddedRuns.length) continue;
      const kept = (rawByPart.get(part.name) || []).filter((e) => !part.embeddedRuns.some((r) => e.from >= r.start && e.to <= r.end));
      for (const r of part.embeddedRuns) kept.push({ from: r.start, to: r.end, text: '' });
      rawByPart.set(part.name, kept);
    }
  }

  // 4. Сборка новых строк частей
  /** @type {Map<string, string>} */
  const newXml = new Map();
  for (const [name, list] of rawByPart) {
    const part = doc.parts.get(name);
    if (!part || !list.length) continue;
    const out = applyRangeEdits(part.xml, list);
    if (out !== part.xml) newXml.set(name, out);
  }
  if (removed.size) cleanupReferences(doc, removed, newXml);

  // 5. ZIP: порядок как в исходнике, нетронутые части — сжатые байты как есть
  const enc = new TextEncoder();
  const items = [];
  for (const e of doc.entries) {
    if (removed.has(e.name)) continue;
    const x = newXml.get(e.name);
    items.push(x !== undefined ? { name: e.name, data: enc.encode(x) } : { name: e.name, source: e });
  }
  return { bytes: writeZip(items), changedParts: [...newXml.keys()], removedParts: [...removed] };
}

/**
 * Правки в потоке из ранов (§6.3 п.2–4).
 * @param {import('./model.js').DocModel} doc
 * @param {import('./model.js').Stream} s
 * @param {TextEdit[]} list отсортированы, без пересечений
 * @param {(e: {from: number, to: number, text: string}) => void} push
 */
function planRunEdits(doc, s, list, push) {
  const segs = /** @type {import('./model.js').Segment[]} */ (s.segments);
  const segIndex = /** @type {Uint32Array} */ (s.segIndex);
  const xml = /** @type {any} */ (doc.parts.get(s.part)).xml;
  /** @type {Map<number, {from: number, to: number, insert: string}[]>} */
  const ops = new Map();
  const removeSeg = new Set();
  /** вставки на месте удаляемого спецэлемента, если в диапазоне нет текста */
  const replaceSeg = new Map();

  for (const e of list) {
    if (e.start === e.end) continue; // вставки без диапазона не поддерживаются
    const first = segIndex[e.start];
    const last = segIndex[e.end - 1];
    let inserted = false;
    for (let i = first; i <= last; i++) {
      const seg = segs[i];
      if (seg.kind === 'text') {
        const from = Math.max(e.start, seg.vStart) - seg.vStart;
        const to = Math.min(e.end, seg.vEnd) - seg.vStart;
        if (to < from) continue;
        let arr = ops.get(i);
        if (!arr) ops.set(i, (arr = []));
        arr.push({ from, to, insert: inserted ? '' : e.newText });
        inserted = true;
      } else {
        if (seg.container) throw new CoreError('INTERNAL', 'Правка пересекает встроенный объект');
        removeSeg.add(i);
      }
    }
    if (!inserted) {
      // Диапазон состоит только из спецэлементов: первый заменяем на w:t с новым текстом
      replaceSeg.set(first, e.newText);
    }
  }

  for (const [i, arr] of ops) {
    const seg = segs[i];
    arr.sort((a, b) => b.from - a.from);
    let t = seg.text;
    for (const o of arr) t = t.slice(0, o.from) + o.insert + t.slice(o.to);
    let open = xml.slice(seg.elStart, seg.openEnd);
    const needPreserve = t === '' || /^\s|\s$/.test(t);
    if (needPreserve && !/\sxml:space\s*=/.test(open)) open = open.slice(0, -1) + ' xml:space="preserve">';
    const close = `</${seg.elName}>`;
    push({ from: seg.elStart, to: seg.elEnd, text: open + escapeText(t) + close });
  }
  for (const i of removeSeg) {
    const seg = segs[i];
    const repl = replaceSeg.get(i);
    push({ from: seg.elStart, to: seg.elEnd, text: repl === undefined ? '' : `<w:t xml:space="preserve">${escapeText(repl)}</w:t>` });
  }
}

/** Правки атрибутов и метаданных: значение пересобирается целиком (§6.3 п.6). */
function planValueEdits(s, list, push) {
  let t = s.text;
  for (const e of [...list].sort((a, b) => b.start - a.start)) t = t.slice(0, e.start) + e.newText + t.slice(e.end);
  const text = s.type === 'meta' ? escapeText(t) : escapeAttr(t);
  push({ from: /** @type {number} */ (s.valueStart), to: /** @type {number} */ (s.valueEnd), text });
}

/**
 * Удаляет ссылки на удалённые части из [Content_Types].xml и всех *.rels (FR-12, FR-15).
 * @param {import('./model.js').DocModel} doc
 * @param {Set<string>} removed
 * @param {Map<string, string>} newXml
 */
function cleanupReferences(doc, removed, newXml) {
  const dec = new TextDecoder();
  const getXml = (name) => {
    if (newXml.has(name)) return newXml.get(name);
    if (doc.parts.has(name)) return /** @type {any} */ (doc.parts.get(name)).xml;
    const e = doc.entries.find((x) => x.name === name);
    if (!e) return null;
    return dec.decode(inflateEntry(e));
  };
  // [Content_Types].xml
  const ct = getXml('[Content_Types].xml');
  if (ct != null) {
    const out = removeElements(ct, 'Override', (attrs) => {
      const pn = attrs.PartName || '';
      return removed.has(pn.replace(/^\//, ''));
    });
    if (out !== ct) newXml.set('[Content_Types].xml', out);
  }
  // Все .rels: связи, указывающие на удалённые части
  for (const e of doc.entries) {
    if (!/\.rels$/.test(e.name) || removed.has(e.name)) continue;
    const base = relsBaseDir(e.name);
    const x = getXml(e.name);
    if (x == null) continue;
    const out = removeElements(x, 'Relationship', (attrs) => {
      if (attrs.TargetMode === 'External') return false;
      return removed.has(resolveTarget(base, attrs.Target || ''));
    });
    if (out !== x) newXml.set(e.name, out);
  }
}

/** 'word/_rels/document.xml.rels' → 'word/'; '_rels/.rels' → '' */
export function relsBaseDir(relsName) {
  const i = relsName.indexOf('_rels/');
  return relsName.slice(0, i);
}

/** Разрешает Target связи относительно каталога источника. */
export function resolveTarget(baseDir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const segs = (baseDir + target).split('/');
  const out = [];
  for (const s of segs) {
    if (s === '..') out.pop();
    else if (s !== '.' && s !== '') out.push(s);
  }
  return out.join('/');
}

/** Удаляет самозакрывающиеся/парные элементы с данным именем, для которых pred(attrs) истинно. */
function removeElements(xml, name, pred) {
  const edits = [];
  let open = null;
  tokenize(xml, (t) => {
    if (t.name !== name) return;
    if (t.type === 'selfclose' || t.type === 'open') {
      const attrs = Object.fromEntries(parseAttrs(xml, t.attrStart, t.attrEnd).map((a) => [a.name, a.raw]));
      if (t.type === 'selfclose') {
        if (pred(attrs)) edits.push({ from: t.start, to: t.end, text: '' });
      } else open = { start: t.start, hit: pred(attrs) };
    } else if (t.type === 'close' && open) {
      if (open.hit) edits.push({ from: open.start, to: t.end, text: '' });
      open = null;
    }
  });
  return applyRangeEdits(xml, edits);
}
