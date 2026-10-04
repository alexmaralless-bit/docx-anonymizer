// КОНТРАКТ: реестр детекторов. Подробности — docs/contracts.md §2.
//
// Потоковый детектор:   registerDetector('INN', (text, ctx) => Candidate[])
//   вызывается для КАЖДОГО потока (параграф live/deleted/field, атрибут alt/rel-target/field-instr,
//   метаданные) — кроме атрибутов-авторов, их ядро обрабатывает само (FR-11).
// Документный детектор: registerDocumentDetector('kb', (doc, entities, ctx) => Candidate[])
//   вызывается один раз после потоковых, видит все потоки и уже найденные сущности (KB, FR-22–23).
//
// Детекторы — чистые функции: без chrome.*, без сети, без глобального состояния между вызовами.

/**
 * @typedef {object} StreamInfo
 * @property {string} id
 * @property {string} part
 * @property {string|null} pid
 * @property {'live'|'deleted'|'field'|'attr'|'meta'} type
 * @property {string} [attrKind]
 */

/**
 * @typedef {object} DetectContext
 * @property {StreamInfo} stream
 * @property {'ru'|'en'|'both'} language          язык документа (FR-19, с учётом settings.language)
 * @property {import('../categories.js').CategoryDef} category   категория, под которую зарегистрирован детектор
 * @property {{list: import('../categories.js').CategoryDef[], byId: Map<string, import('../categories.js').CategoryDef>}} catalog
 * @property {object} settings                    эффективные настройки (только чтение)
 */

/**
 * @callback DetectFn
 * @param {string} virtualText
 * @param {DetectContext} ctx
 * @returns {import('./entity.js').Candidate[]}
 */

/**
 * @typedef {object} DocumentDetectContext
 * @property {'ru'|'en'|'both'} language
 * @property {{list: import('../categories.js').CategoryDef[], byId: Map<string, import('../categories.js').CategoryDef>}} catalog
 * @property {object} settings
 * @property {(categoryId: string) => boolean} isEnabled
 */

/**
 * @callback DocumentDetectFn
 * @param {import('../docx/model.js').DocModel} doc
 * @param {import('./entity.js').Entity[]} entities   найденные потоковыми детекторами (до разрешения пересечений)
 * @param {DocumentDetectContext} ctx
 * @returns {import('./entity.js').Candidate[]}       обязательно со streamId и category
 */

/** @type {Map<string, {name: string, fn: DetectFn}[]>} */
const streamDetectors = new Map();
/** @type {{name: string, fn: DocumentDetectFn}[]} */
const documentDetectors = [];

/**
 * Регистрирует потоковый детектор для категории. Несколько детекторов на категорию — допустимо.
 * @param {string} category
 * @param {DetectFn} fn
 * @param {{name?: string}} [opts]
 */
export function registerDetector(category, fn, opts = {}) {
  let arr = streamDetectors.get(category);
  if (!arr) streamDetectors.set(category, (arr = []));
  arr.push({ name: opts.name || fn.name || category, fn });
}

/**
 * @param {string} name
 * @param {DocumentDetectFn} fn
 */
export function registerDocumentDetector(name, fn) {
  documentDetectors.push({ name, fn });
}

/** @returns {Map<string, {name: string, fn: DetectFn}[]>} */
export function getDetectors() {
  return streamDetectors;
}

export function getDocumentDetectors() {
  return documentDetectors;
}

/** Только для тестов. */
export function clearDetectors() {
  streamDetectors.clear();
  documentDetectors.length = 0;
}
