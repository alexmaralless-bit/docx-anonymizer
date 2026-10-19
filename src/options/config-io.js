// Разбор файлов импорта настроек и категорий (FR-47, FR-53). Чистый JS, без DOM.
import { applyMigrations, validateSettingsPatch } from '../core/settings.js';
import { validateCustomCategory } from '../core/detect/custom/rules.js';

export const CONFIG_KIND = 'docx-anonymizer-config';
export const CATEGORIES_KIND = 'docx-anonymizer-categories';

/** Файл *.categories.json → список категорий или текст ошибки. */
export function parseCategoriesFile(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return { error: 'JSON' };
  }
  const arr = Array.isArray(j) ? j : j?.categories;
  if (!Array.isArray(arr) || !arr.length) return { error: 'categories' };
  for (const c of arr) {
    const errs = validateCustomCategory(c);
    if (errs.length) return { error: `${c?.id || '?'}: ${errs[0].field}` };
  }
  return { categories: arr };
}

// nerModel — id пакета модели в хранилище этого браузера (WP8): на другой машине пакета нет, поэтому не переносится.
// hintMappingShown — одноразовая подсказка о ключе восстановления (WP10-D): состояние этого браузера, не настройка.
// bundledModelSha — какой встроенный пакет модели этот профиль уже обработал (WP10-C): тоже состояние браузера;
// bundledModelError — код последней неудачной автоустановки этого пакета (WP10-C): тоже.
// orgPolicyHintPending — одноразовая подсказка о политике 0.4 (организации по желанию): состояние этого браузера.
export const NOT_EXPORTED = new Set([
  'schemaVersion',
  'panelPosition',
  'nerModel',
  'hintMappingShown',
  'bundledModelSha',
  'bundledModelError',
  'orgPolicyHintPending',
]);
/** «Сбросить настройки» не трогает установленную модель и состояние автоустановки встроенной (WP10-C). */
export const KEPT_ON_RESET = Object.freeze(['nerModel', 'bundledModelSha', 'bundledModelError']);

/**
 * Разбор файла настроек: {patch, skipped} или {error}. `version` файла — версия формата файла, `schemaVersion` —
 * версия схемы настроек (SETTINGS_SCHEMA_VERSION на момент экспорта). Файл без неё (0.1 и ранние сборки 0.2) или
 * с меньшей версией проходит те же миграции, что и хранилище (settings.js MIGRATIONS): порог NER 0.6 из 0.1 → 0.7.
 */
export function parseConfigFile(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return { error: 'JSON' };
  }
  if (!j || j.kind !== CONFIG_KIND || !j.settings || typeof j.settings !== 'object' || Array.isArray(j.settings)) return { error: 'kind' };
  const from = Number.isInteger(j.schemaVersion) ? j.schemaVersion : Number.isInteger(j.settings.schemaVersion) ? j.settings.schemaVersion : 0;
  const settings = applyMigrations(j.settings, from);
  const patch = {};
  const skipped = [];
  for (const [k, v] of Object.entries(settings)) {
    if (NOT_EXPORTED.has(k)) continue;
    if (validateSettingsPatch({ [k]: v }).length) skipped.push(k);
    else if (k === 'customCategories' && v.some((c) => validateCustomCategory(c).length)) skipped.push(k);
    else patch[k] = v;
  }
  return { patch, skipped };
}
