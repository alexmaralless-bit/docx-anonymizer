// Контракты ядра — точка входа для рабочих пакетов. Описание: docs/contracts.md.
export { SOURCES, LEVELS, mergeDecisions } from './entity.js';
export { registerDetector, registerDocumentDetector, getDetectors, getDocumentDetectors, clearDetectors } from './detector.js';
export { NoopNerProvider, NER_LABEL_TO_CATEGORY } from './ner.js';
export { summarizeSession } from './session.js';
// Реализованные контракты живут рядом с ядром; здесь — для удобного импорта:
export { BUILTIN_CATEGORIES, buildCatalog, isCategoryEnabled, normalizeValue, LEVEL_RANK } from '../categories.js';
export { resolveOverlaps } from '../detect/overlap.js';
export { defaultSettings, migrateSettings, validateSettingsPatch, effectiveSettings } from '../settings.js';
