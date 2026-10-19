// Разбор DOCX в модель потоков (ТЗ §2, §4.2, §6.1–6.2).
import { readZip, inflateEntry } from './zip.js';
import { tokenize, parseAttrs, getAttr, unescapeXml } from './xml.js';
import { CoreError } from '../errors.js';

/**
 * Сегмент потока — кусок virtualText, связанный с элементом XML.
 * @typedef {object} Segment
 * @property {'text'|'special'|'soft'} kind  text = w:t/w:delText/w:instrText; special = w:tab/w:br/… (1 символ); soft = w:softHyphen (0 символов)
 * @property {number} vStart  начало в virtualText
 * @property {number} vEnd    конец в virtualText
 * @property {string} text    unescaped-текст (для text) или символ спецэлемента
 * @property {number} elStart начало элемента в XML-строке части ('<' открывающего тега)
 * @property {number} elEnd   конец элемента (после '>' закрывающего тега)
 * @property {number} [openEnd]       конец открывающего тега (для text)
 * @property {number} [contentStart]  начало экранированного содержимого (для text)
 * @property {number} [contentEnd]    конец экранированного содержимого (для text)
 * @property {string} [elName]        имя элемента
 * @property {boolean} [container]    спецэлемент-контейнер (drawing/pict/…): никогда не удаляется
 */

/**
 * Поток — то, по чему ищут детекторы. Сущность не пересекает границу потока.
 * @typedef {object} Stream
 * @property {string} id          уникален в документе: 'p12:live', 'a3'
 * @property {string} part        имя части: 'word/document.xml'
 * @property {string|null} pid    id параграфа ('p12') или null для атрибутных/метаданных потоков
 * @property {'live'|'deleted'|'field'|'attr'|'meta'} type
 * @property {string} [attrKind]  для attr/meta: 'author'|'initials'|'author-id'|'alt'|'field-instr'|'rel-target'|'meta'
 * @property {string} [linkedTo]  id потока-автора (для initials/author-id)
 * @property {string} [xpath]     человекочитаемая подсказка: 'w:comment/@w:author'
 * @property {string} text        virtualText
 * @property {number} pos         позиция в XML части (для порядка обхода)
 * @property {number} order       глобальный порядок обхода (FR-25)
 * @property {Segment[]} [segments]   только для live/deleted/field
 * @property {Uint32Array} [segIndex] charMap: индекс символа → индекс сегмента
 * @property {Uint32Array} [segOffset] charMap: индекс символа → смещение в тексте сегмента
 * @property {number} [valueStart] для attr/meta: диапазон экранированного значения в XML
 * @property {number} [valueEnd]
 */

/**
 * @typedef {object} Paragraph
 * @property {string} pid
 * @property {string} part
 * @property {number} depth   вложенность (0 — верхний уровень, 1 — в текстовом поле и т.п.)
 * @property {number} pos
 * @property {{live?: string, deleted?: string, field?: string}} streams  id потоков
 * @property {'p'|'heading'|'li'|string} [kind]  вид абзаца (0.4, К10): 'heading' — стиль заголовка (w:pStyle Heading1, Title, «1»…«9»),
 *   'li' — пункт списка (w:numPr); у текстовой модели (PDF) — вид блока разметки (h1/h2/li/cell/…)
 */

/**
 * @typedef {object} Part
 * @property {string} name
 * @property {'text'|'people'|'rels'|'meta'} kind
 * @property {string} xml
 * @property {Stream[]} streams          в порядке позиции в XML
 * @property {{start: number, end: number}[]} embeddedRuns  раны с w:object / c:chart (FR-15)
 */

/**
 * @typedef {object} DocModel
 * @property {import('./zip.js').ZipEntry[]} entries  все записи ZIP в исходном порядке
 * @property {Map<string, Part>} parts                разобранные части
 * @property {Stream[]} streams                       все потоки в порядке обхода FR-25
 * @property {Map<string, Stream>} streamById
 * @property {Paragraph[]} paragraphs                 все параграфы в порядке обхода
 * @property {{code: string, count?: number, details?: object}[]} warnings
 * @property {string} language                       'ru'|'en'|'both' — авто-определение FR-19
 * @property {number} size                            размер исходного файла
 */

/** Идентификаторы стилей заголовков: английские Heading1/Title/Subtitle и русские «1»…«9» (Word даёт styleId цифрой). */
const HEADING_STYLE_RE = /^(heading\d*|title|subtitle|\d)$/i;

export const TEXT_PART_RE = /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments|commentsExtended|glossary\/document)\.xml$/;
export const PEOPLE_PART_RE = /^word\/people\.xml$/;
export const RELS_PART_RE = /^word\/(glossary\/)?_rels\/[^/]+\.rels$/;
export const META_PART_RE = /^docProps\/(core|app)\.xml$/;

const CORE_META = new Set(['dc:creator', 'cp:lastModifiedBy', 'dc:title', 'dc:subject', 'dc:description', 'cp:keywords', 'cp:category', 'dc:identifier']);
const APP_META = new Set(['Company', 'Manager', 'HyperlinkBase']);

const TEXT_ELEMENTS = { 'w:t': 'live', 'w:delText': 'deleted', 'w:instrText': 'field', 'w:delInstrText': 'field' };
const OBJ = '\uFFFC';
const SPECIALS = {
  'w:tab': '\t',
  'w:ptab': '\t',
  'w:br': '\n',
  'w:cr': '\n',
  'w:sym': OBJ,
  'w:noBreakHyphen': '\u2011',
  'w:footnoteReference': OBJ,
  'w:endnoteReference': OBJ,
  'w:commentReference': OBJ,
};
const CONTAINER_SPECIALS = new Set(['w:drawing', 'w:pict', 'w:object', 'mc:AlternateContent']);
const ALT_ATTRS = { 'wp:docPr': ['descr', 'title'], 'pic:cNvPr': ['descr', 'name'], 'v:shape': ['alt'] };
const AUTHOR_ATTRS = new Set(['w:author']);

/** Ранг части для порядка обхода FR-25. */
export function partRank(name) {
  if (name === 'word/document.xml') return 0;
  if (/^word\/header/.test(name)) return 1;
  if (/^word\/footer/.test(name)) return 2;
  if (name === 'word/footnotes.xml') return 3;
  if (name === 'word/endnotes.xml') return 4;
  if (/^word\/comments/.test(name)) return 5;
  if (/^word\/glossary\/document/.test(name)) return 6;
  if (name === 'word/people.xml') return 7;
  if (/_rels\//.test(name)) return 8;
  return 9; // метаданные
}

function naturalCompare(a, b) {
  return a.localeCompare(b, 'en', { numeric: true });
}

/**
 * Разбирает .docx. Бросает CoreError с кодами NOT_DOCX / ENCRYPTED / PARSE_FAILED.
 * @param {Uint8Array} bytes
 * @returns {DocModel}
 */
export function parseDocx(bytes) {
  const entries = readZip(bytes);
  if (!entries.some((e) => e.name === 'word/document.xml')) {
    throw new CoreError('NOT_DOCX', 'В архиве нет word/document.xml');
  }
  const dec = new TextDecoder('utf-8');
  /** @type {Map<string, Part>} */
  const parts = new Map();
  const ctx = { pidCounter: 0, attrCounter: 0, paragraphs: /** @type {Paragraph[]} */ ([]) };
  const counts = { embeddings: 0, charts: 0, media: 0 };

  const sortedNames = entries
    .map((e) => e.name)
    .filter((n) => TEXT_PART_RE.test(n) || PEOPLE_PART_RE.test(n) || RELS_PART_RE.test(n) || META_PART_RE.test(n))
    .sort((a, b) => partRank(a) - partRank(b) || naturalCompare(a, b));
  const byName = new Map(entries.map((e) => [e.name, e]));

  for (const e of entries) {
    if (/^word\/embeddings\//.test(e.name)) counts.embeddings++;
    else if (/^word\/charts\/[^/]+\.xml$/.test(e.name) && !/\/_rels\//.test(e.name)) counts.charts++;
    else if (/^word\/media\//.test(e.name)) counts.media++;
  }

  for (const name of sortedNames) {
    let xml;
    try {
      xml = dec.decode(inflateEntry(/** @type {any} */ (byName.get(name))));
    } catch (err) {
      throw new CoreError('PARSE_FAILED', `Не удалось распаковать часть ${name}`);
    }
    if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1); // BOM — убираем при чтении (запишется без него только если часть изменится)
    let part;
    if (TEXT_PART_RE.test(name)) part = parseTextPart(name, xml, ctx);
    else if (PEOPLE_PART_RE.test(name)) part = parsePeoplePart(name, xml, ctx);
    else if (RELS_PART_RE.test(name)) part = parseRelsPart(name, xml, ctx);
    else part = parseMetaPart(name, xml, ctx);
    parts.set(name, part);
  }

  const streams = [];
  for (const name of sortedNames) {
    const p = /** @type {Part} */ (parts.get(name));
    p.streams.sort((a, b) => a.pos - b.pos);
    for (const s of p.streams) {
      s.order = streams.length;
      streams.push(s);
    }
  }
  const warnings = [];
  const embeddedTotal = counts.embeddings + counts.charts + counts.media;
  if (embeddedTotal) warnings.push({ code: 'EMBEDDED_NOT_PROCESSED', count: embeddedTotal, details: counts });

  return {
    entries,
    parts,
    streams,
    streamById: new Map(streams.map((s) => [s.id, s])),
    paragraphs: ctx.paragraphs,
    warnings,
    language: detectLanguage(streams),
    size: bytes.length,
  };
}

/** FR-19: доля кириллицы среди букв live-потоков word/document.xml. */
export function detectLanguage(streams) {
  let cyr = 0;
  let lat = 0;
  for (const s of streams) {
    if (s.part !== 'word/document.xml' || s.type !== 'live') continue;
    for (const ch of s.text) {
      if (/[А-Яа-яЁё]/.test(ch)) cyr++;
      else if (/[A-Za-z]/.test(ch)) lat++;
    }
  }
  const total = cyr + lat;
  if (!total) return 'ru';
  const share = cyr / total;
  if (share >= 0.7) return 'ru';
  if (share <= 0.3) return 'en';
  return 'both';
}

/* ---------- Текстовые части ---------- */

function parseTextPart(name, xml, ctx) {
  /** @type {Part} */
  const part = { name, kind: 'text', xml, streams: [], embeddedRuns: [] };
  /** стек имён элементов */
  const stack = [];
  /** стек открытых параграфов */
  const pStack = [];
  /** стек открытых ранов: {start, embedded} */
  const rStack = [];
  let delDepth = 0;
  /** открытый текстовый элемент */
  let openText = null;
  /** открытые контейнеры-спецэлементы: depth → segment */
  const openContainers = [];
  const authorByElement = [];

  const newParagraph = (pos) => {
    const pid = `p${ctx.pidCounter++}`;
    const para = { pid, part: name, depth: pStack.length, pos, streams: {}, kind: 'p', _builders: {} };
    ctx.paragraphs.push(para);
    pStack.push(para);
  };
  const builder = (para, type) => {
    let b = para._builders[type];
    if (!b) {
      b = { segments: [], len: 0 };
      para._builders[type] = b;
    }
    return b;
  };
  const addSeg = (type, seg) => {
    const para = pStack[pStack.length - 1];
    if (!para) return;
    const b = builder(para, type);
    seg.vStart = b.len;
    seg.vEnd = b.len + seg.text.length;
    b.len = seg.vEnd;
    b.segments.push(seg);
  };
  const specialStreamType = () => (delDepth > 0 ? 'deleted' : 'live');

  tokenize(xml, (t) => {
    const parent = stack[stack.length - 1];
    if (t.type === 'open' || t.type === 'selfclose') {
      const nm = t.name;
      // Атрибуты-авторы, alt-тексты, w:instr у fldSimple — в любом месте
      if (t.attrEnd > t.attrStart + 1) scanAttrs(nm, t.attrStart, t.attrEnd);

      // Вид абзаца по свойствам (0.4, К10): стиль заголовка или нумерация списка
      if (parent === 'w:pPr' && pStack.length) {
        const para = pStack[pStack.length - 1];
        if (nm === 'w:pStyle' && HEADING_STYLE_RE.test(getAttr(xml, t.attrStart, t.attrEnd, 'w:val')?.raw || '')) para.kind = 'heading';
        else if (nm === 'w:numPr' && para.kind === 'p') para.kind = 'li';
      }

      if (t.type === 'open') {
        if (nm === 'w:p') newParagraph(t.start);
        else if (nm === 'w:r') rStack.push({ start: t.start, embedded: false });
        else if (nm === 'w:del' || nm === 'w:moveFrom') delDepth++;
        else if (nm in TEXT_ELEMENTS && parent === 'w:r') {
          openText = { type: TEXT_ELEMENTS[nm], elStart: t.start, openEnd: t.end, elName: nm };
        } else if (CONTAINER_SPECIALS.has(nm) && parent === 'w:r') {
          const seg = { kind: 'special', text: OBJ, elStart: t.start, elEnd: -1, elName: nm, container: true, vStart: 0, vEnd: 0 };
          addSeg(specialStreamType(), seg);
          openContainers.push({ depth: stack.length, seg });
        }
        if ((nm === 'w:object' || nm === 'c:chart') && rStack.length) rStack[0].embedded = true;
        stack.push(nm);
      } else {
        // selfclose
        if (nm === 'c:chart' && rStack.length) rStack[0].embedded = true;
        if (parent === 'w:r') {
          if (nm in SPECIALS) {
            addSeg(specialStreamType(), { kind: 'special', text: SPECIALS[nm], elStart: t.start, elEnd: t.end, elName: nm, vStart: 0, vEnd: 0 });
          } else if (nm === 'w:softHyphen') {
            addSeg(specialStreamType(), { kind: 'soft', text: '', elStart: t.start, elEnd: t.end, elName: nm, vStart: 0, vEnd: 0 });
          } else if (CONTAINER_SPECIALS.has(nm)) {
            addSeg(specialStreamType(), { kind: 'special', text: OBJ, elStart: t.start, elEnd: t.end, elName: nm, container: true, vStart: 0, vEnd: 0 });
          }
        }
      }
    } else if (t.type === 'close') {
      const nm = t.name;
      stack.pop();
      if (openText && nm === openText.elName) {
        const raw = xml.slice(openText.openEnd, t.start);
        addSeg(openText.type, {
          kind: 'text',
          text: unescapeXml(raw),
          elStart: openText.elStart,
          elEnd: t.end,
          openEnd: openText.openEnd,
          contentStart: openText.openEnd,
          contentEnd: t.start,
          elName: nm,
          vStart: 0,
          vEnd: 0,
        });
        openText = null;
      } else if (nm === 'w:p') {
        finishParagraph(/** @type {any} */ (pStack.pop()));
      } else if (nm === 'w:r') {
        const r = rStack.pop();
        if (r && r.embedded && rStack.length === 0) part.embeddedRuns.push({ start: r.start, end: t.end });
        else if (r && r.embedded && rStack.length) rStack[0].embedded = true;
      } else if (nm === 'w:del' || nm === 'w:moveFrom') delDepth--;
      const oc = openContainers[openContainers.length - 1];
      if (oc && oc.depth === stack.length) {
        oc.seg.elEnd = t.end;
        openContainers.pop();
      }
    }
  });
  while (pStack.length) finishParagraph(pStack.pop());
  linkInitials();
  return part;

  function finishParagraph(para) {
    for (const type of ['live', 'deleted', 'field']) {
      const b = para._builders[type];
      if (!b || !b.segments.length) continue;
      const text = b.segments.map((s) => s.text).join('');
      if (!text.length) continue;
      const segIndex = new Uint32Array(text.length);
      const segOffset = new Uint32Array(text.length);
      b.segments.forEach((s, i) => {
        for (let k = s.vStart; k < s.vEnd; k++) {
          segIndex[k] = i;
          segOffset[k] = k - s.vStart;
        }
      });
      /** @type {Stream} */
      const stream = { id: `${para.pid}:${type}`, part: name, pid: para.pid, type, text, pos: para.pos, order: 0, segments: b.segments, segIndex, segOffset };
      part.streams.push(stream);
      para.streams[type] = stream.id;
    }
    delete para._builders;
  }

  function scanAttrs(nm, from, to) {
    const altNames = ALT_ATTRS[nm];
    if (!altNames && nm !== 'w:fldSimple' && !xml.slice(from, to).includes('w:author')) return;
    const attrs = parseAttrs(xml, from, to);
    let authorStream = null;
    for (const a of attrs) {
      if (!a.raw) continue;
      if (AUTHOR_ATTRS.has(a.name)) {
        authorStream = addAttrStream(part, ctx, a, 'author', `${nm}/@${a.name}`);
      } else if (a.name === 'w:initials') {
        const s = addAttrStream(part, ctx, a, 'initials', `${nm}/@${a.name}`);
        authorByElement.push({ s, el: from });
      } else if (altNames && altNames.includes(a.name)) {
        addAttrStream(part, ctx, a, 'alt', `${nm}/@${a.name}`);
      } else if (nm === 'w:fldSimple' && a.name === 'w:instr') {
        addAttrStream(part, ctx, a, 'field-instr', `${nm}/@${a.name}`);
      }
    }
    if (authorStream) for (const x of authorByElement) if (x.el === from) x.s.linkedTo = authorStream.id;
  }
  function linkInitials() {
    for (const x of authorByElement) if (!x.s.linkedTo) x.s.attrKind = 'initials';
  }
}

function addAttrStream(part, ctx, a, attrKind, xpath, type = 'attr') {
  /** @type {Stream} */
  const s = {
    id: `a${ctx.attrCounter++}`,
    part: part.name,
    pid: null,
    type,
    attrKind,
    xpath,
    text: unescapeXml(a.raw),
    pos: a.valueStart,
    order: 0,
    valueStart: a.valueStart,
    valueEnd: a.valueEnd,
  };
  part.streams.push(s);
  return s;
}

/* ---------- people.xml (FR-11) ---------- */

function parsePeoplePart(name, xml, ctx) {
  /** @type {Part} */
  const part = { name, kind: 'people', xml, streams: [], embeddedRuns: [] };
  let currentAuthor = null;
  tokenize(xml, (t) => {
    if (t.type !== 'open' && t.type !== 'selfclose') return;
    if (t.name === 'w15:person') {
      const a = parseAttrs(xml, t.attrStart, t.attrEnd).find((x) => x.name === 'w15:author');
      currentAuthor = a && a.raw ? addAttrStream(part, ctx, a, 'author', 'w15:person/@w15:author') : null;
    } else if (t.name === 'w15:presenceInfo') {
      const a = parseAttrs(xml, t.attrStart, t.attrEnd).find((x) => x.name === 'w15:userId');
      if (a && a.raw) {
        const s = addAttrStream(part, ctx, a, 'author-id', 'w15:presenceInfo/@w15:userId');
        if (currentAuthor) s.linkedTo = currentAuthor.id;
      }
    }
  });
  return part;
}

/* ---------- word/_rels/*.rels (FR-13) ---------- */

function parseRelsPart(name, xml, ctx) {
  /** @type {Part} */
  const part = { name, kind: 'rels', xml, streams: [], embeddedRuns: [] };
  tokenize(xml, (t) => {
    if ((t.type !== 'open' && t.type !== 'selfclose') || t.name !== 'Relationship') return;
    const attrs = parseAttrs(xml, t.attrStart, t.attrEnd);
    const mode = attrs.find((x) => x.name === 'TargetMode');
    const target = attrs.find((x) => x.name === 'Target');
    if (mode && mode.raw === 'External' && target && target.raw) {
      addAttrStream(part, ctx, target, 'rel-target', 'Relationship/@Target');
    }
  });
  return part;
}

/* ---------- docProps (FR-12) ---------- */

function parseMetaPart(name, xml, ctx) {
  /** @type {Part} */
  const part = { name, kind: 'meta', xml, streams: [], embeddedRuns: [] };
  const isCore = name.endsWith('core.xml');
  const stack = [];
  let open = null;
  tokenize(xml, (t) => {
    if (t.type === 'open') {
      stack.push(t.name);
      const inTitles = stack.includes('TitlesOfParts');
      if ((isCore && CORE_META.has(t.name)) || (!isCore && (APP_META.has(t.name) || (inTitles && t.name === 'vt:lpstr')))) {
        open = { name: t.name, start: t.end };
      }
    } else if (t.type === 'close') {
      stack.pop();
      if (open && t.name === open.name) {
        const raw = xml.slice(open.start, t.start);
        if (raw.length) {
          addAttrStream(part, ctx, { raw, valueStart: open.start, valueEnd: t.start }, 'meta', `${t.name}`, 'meta');
        }
        open = null;
      }
    }
  });
  return part;
}
