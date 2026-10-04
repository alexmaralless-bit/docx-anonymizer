// КОНТРАКТ: сессия документа (ТЗ §2 «Сессия документа», FR-29).
// Живёт ТОЛЬКО в памяти Web Worker'а offscreen-документа. В chrome.storage.session попадает
// лишь индекс (SessionSummary) — без исходных значений.

/**
 * @typedef {object} Session
 * @property {string} docId
 * @property {string} name                 имя исходного файла
 * @property {string} sha256
 * @property {number} size
 * @property {string} [origin]             сайт, где перехвачен файл
 * @property {string} [batchId]            файлы одной отправки (§3.7) — общий PlaceholderAllocator
 * @property {import('../docx/model.js').DocModel} doc
 * @property {import('../detect/runner.js').AnalyzeResult} analysis
 * @property {import('./entity.js').EntityGroup[]} groups     текущие группы с решениями
 * @property {number} createdAt            Date.now()
 */

/**
 * Индекс сессии для LIST_SESSIONS / popup «Недавние» — без значений сущностей.
 * @typedef {object} SessionSummary
 * @property {string} docId
 * @property {string} name
 * @property {string} sha256
 * @property {number} createdAt
 * @property {string} [origin]
 * @property {number} entities
 * @property {number} [replacements]
 */

/** @param {Session} s @returns {SessionSummary} */
export function summarizeSession(s) {
  return {
    docId: s.docId,
    name: s.name,
    sha256: s.sha256,
    createdAt: s.createdAt,
    origin: s.origin,
    entities: s.groups.length,
  };
}
