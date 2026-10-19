// applyDecisions: группы с решениями → байты результата + маппинг (FR-25–FR-28).
// DOCX → .docx (serializeDocx); текстовая модель PDF (версия 0.3, doc.kind === 'text') → Markdown/текст (serializeText).
import { serializeDocx } from './docx/replace.js';
import { serializeText, TEXT_MIME } from './text/serialize.js';
import { replacementFor } from './placeholders.js';
import { buildMapping } from './mapping.js';

/**
 * @typedef {object} ApplyOptions
 * @property {'placeholder'|'mask'|'delete'} [mode='placeholder']
 * @property {'ru'|'en'} [placeholderLanguage='ru']   язык для «[удалено]/[redacted]»
 * @property {'ru'|'en'|'both'} [language]            язык документа — пишется в маппинг
 * @property {boolean} [keepMetadata=false]
 * @property {boolean} [stripEmbedded=false]
 * @property {{name: string, sha256?: string, resultName?: string}} [document]
 * @property {string} [createdAt]                     ISO-время (для детерминированных тестов)
 * @property {string} [toolVersion]
 * @property {'md'|'txt'} [textFormat='md']           формат результата текстовой модели (PDF, версия 0.3)
 */

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Правки по решениям (FR-26, FR-13) и сводка применённого для маппинга — общая часть DOCX и текста.
 * @param {{streamById: Map<string, any>}} doc
 * @param {import('./contracts/entity.js').EntityGroup[]} groups
 * @param {{mode?: string, placeholderLanguage?: string}} [opts]
 * @returns {{edits: import('./docx/replace.js').TextEdit[], applied: Map<string, {token: string, occurrences: number, parts: Set<string>, firstForm?: string}>}}
 */
export function planEdits(doc, groups, opts = {}) {
  const mode = opts.mode || 'placeholder';
  const lang = opts.placeholderLanguage || 'ru';
  /** @type {import('./docx/replace.js').TextEdit[]} */
  const edits = [];
  /** @type {Map<string, {token: string, occurrences: number, parts: Set<string>, firstForm?: string}>} */
  const applied = new Map();

  for (const g of groups) {
    if (!g.enabled) continue;
    const excluded = new Set(g.excludedOccurrences || []);
    for (const o of g.occurrences) {
      if (excluded.has(o.id)) continue;
      const s = doc.streamById.get(o.streamId);
      if (!s) continue;
      const core = o.text.slice(o.keepPrefix, o.text.length - o.keepSuffix);
      const token = replacementFor(g, core, /** @type {any} */ (mode), /** @type {any} */ (lang));
      let newText = o.text.slice(0, o.keepPrefix) + token + o.text.slice(o.text.length - o.keepSuffix);
      if (s.attrKind === 'rel-target' && g.category === 'URL') {
        // FR-13: внешняя ссылка остаётся кликабельной и никуда не ведёт
        newText = `https://anonymized.invalid/${token}`;
      }
      edits.push({ streamId: o.streamId, start: o.start, end: o.end, newText });
      let a = applied.get(g.id);
      if (!a) applied.set(g.id, (a = { token, occurrences: 0, parts: new Set() }));
      a.occurrences++;
      a.parts.add(o.part);
      if (!a.firstForm && core === g.value) a.firstForm = o.text.slice(0, o.keepPrefix) + token + o.text.slice(o.text.length - o.keepSuffix);
    }
  }
  return { edits, applied };
}

/**
 * @param {import('./docx/model.js').DocModel} doc
 * @param {import('./contracts/entity.js').EntityGroup[]} groups  с решениями (см. mergeDecisions)
 * @param {ApplyOptions} [options]
 * @returns {{bytes: Uint8Array, docxBytes: Uint8Array, mime: string, mapping: object, stats: {replacements: number, entities: number, changedParts: string[], removedParts: string[]}}}
 *   docxBytes — прежнее имя поля (= bytes) для совместимости
 */
export function applyDecisions(doc, groups, options = {}) {
  const mode = options.mode || 'placeholder';
  const { edits, applied } = planEdits(doc, groups, { mode, placeholderLanguage: options.placeholderLanguage || 'ru' });

  let out;
  let mime;
  if (/** @type {any} */ (doc).kind === 'text') {
    const format = options.textFormat === 'txt' ? 'txt' : 'md';
    out = serializeText(/** @type {any} */ (doc), edits, { format });
    mime = TEXT_MIME[format];
  } else {
    out = serializeDocx(doc, edits, { keepMetadata: options.keepMetadata, stripEmbedded: options.stripEmbedded });
    mime = DOCX_MIME;
  }
  const { bytes, changedParts, removedParts } = out;

  const mapping = buildMapping({
    groups,
    applied,
    mode,
    language: options.language || doc.language,
    documents: options.document ? [options.document] : [],
    createdAt: options.createdAt,
    toolVersion: options.toolVersion,
  });

  return {
    bytes,
    docxBytes: bytes,
    mime,
    mapping,
    stats: { replacements: edits.length, entities: applied.size, changedParts, removedParts },
  };
}
