// Публичный API ядра. Ядро чистое: никаких chrome.*, DOM, сети — тестируется в Node.
export { parseDocx, detectLanguage, partRank } from './docx/model.js';
export { serializeDocx } from './docx/replace.js';
export { readZip, writeZip, inflateEntry, crc32 } from './docx/zip.js';
export { analyze, groupEntities } from './detect/runner.js';
export { resolveOverlaps, compareStrength } from './detect/overlap.js';
export { registerBuiltinDetectors } from './detect/index.js';
export { applyDecisions } from './apply.js';
export { buildMapping, mergeMappings, MAPPING_SCHEMA_VERSION } from './mapping.js';
export { deanonymize } from './deanon.js';
export { findOccurrences } from './search.js';
export { getParagraphs, occurrenceContext } from './text-view.js';
export { PlaceholderAllocator, resolvePlaceholderLanguage, replacementFor, maskText } from './placeholders.js';
export { BUILTIN_CATEGORIES, BUILTIN_IDS, LEVEL_RANK, buildCatalog, isCategoryEnabled, normalizeValue } from './categories.js';
export { defaultSettings, migrateSettings, validateSettingsPatch, effectiveSettings, SETTINGS_KEY, SETTINGS_SCHEMA_VERSION } from './settings.js';
export { matchOrigin, isOriginAllowed, isInterceptActive } from './sites.js';
export { CoreError, ERROR_CODES } from './errors.js';
export {
  SOURCES,
  LEVELS,
  mergeDecisions,
  registerDetector,
  registerDocumentDetector,
  getDetectors,
  getDocumentDetectors,
  clearDetectors,
  NoopNerProvider,
  NER_LABEL_TO_CATEGORY,
  summarizeSession,
} from './contracts/index.js';
