// Разбор файлов импорта настроек и категорий (FR-47, FR-53). Чистый JS, без DOM.
import { validateSettingsPatch } from '../core/settings.js';
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
export const NOT_EXPORTED = new Set(['schemaVersion', 'panelPosition', 'nerModel']);

/** Разбор файла настроек: {patch, skipped} или {error}. */
export function parseConfigFile(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return { error: 'JSON' };
  }
  if (!j || j.kind !== CONFIG_KIND || !j.settings || typeof j.settings !== 'object') return { error: 'kind' };
  const patch = {};
  const skipped = [];
  for (const [k, v] of Object.entries(j.settings)) {
    if (NOT_EXPORTED.has(k)) continue;
    if (validateSettingsPatch({ [k]: v }).length) skipped.push(k);
    else if (k === 'customCategories' && v.some((c) => validateCustomCategory(c).length)) skipped.push(k);
    else patch[k] = v;
  }
  return { patch, skipped };
}
