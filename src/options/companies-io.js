// Список компаний для маскирования на странице настроек (версия 0.4, docs/concept-0.4.md п. 2 и 7; Ц3, К1, К3):
// разбор файла импорта, слияние и предупреждение о коротких и общих названиях. Чистый JS, без DOM.
// Только lexicon.js: детектор company-list.js тянет словари ФИО, им место в worker.js (К15), а не в странице настроек.
import { validateSettingsPatch } from '../core/settings.js';
import { COMMON_NOUNS, PREFIX_FORMS, isNeverMaskOrg, lowerE } from '../core/detect/names/lexicon.js';

export const COMPANIES_KIND = 'docx-anonymizer-companies';
export const COMPANIES_FILE_VERSION = 1;

const QUOTES_RE = /^[«»"“”„'‘’]+|[«»"“”„'‘’]+$/g;
const LEAD_FORM_RE = new RegExp(`^(?:${[...PREFIX_FORMS].sort((a, b) => b.length - a.length).join('|')})(?![\\p{L}\\p{N}])[ \\u00A0]*`, 'u');
const key = (s) =>
  lowerE(String(s ?? ''))
    .replace(/[\s\u00A0]+/g, ' ')
    .trim();

/** Файл экспорта списка компаний (`companies-export`). */
export function companiesFile(companies) {
  return { kind: COMPANIES_KIND, version: COMPANIES_FILE_VERSION, companies: companies.map((c) => ({ name: c.name, aliases: [...(c.aliases || [])] })) };
}

/**
 * Разбор файла списка компаний: `{companies}` или `{error}`. Принимает формат экспорта, голый массив записей
 * и массив строк-названий; записи проверяются тем же валидатором, что и настройки (`maskedCompanies`).
 * @param {string} text
 * @returns {{companies: {name: string, aliases: string[]}[]} | {error: string}}
 */
export function parseCompaniesFile(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return { error: 'JSON' };
  }
  if (!Array.isArray(j) && j?.kind !== COMPANIES_KIND) return { error: 'kind' };
  const arr = Array.isArray(j) ? j : j.companies;
  if (!Array.isArray(arr) || !arr.length) return { error: 'companies' };
  const companies = arr.map((c) =>
    typeof c === 'string' ? { name: c.trim(), aliases: [] } : { name: String(c?.name ?? '').trim(), aliases: c?.aliases ?? [] },
  );
  if (validateSettingsPatch({ maskedCompanies: companies }).length) return { error: 'companies' };
  return { companies: companies.map((c) => ({ name: c.name, aliases: [...c.aliases] })) };
}

/**
 * Слияние списков: записи с тем же названием (регистр, «ё», пробелы не важны) объединяют псевдонимы, новые — в конец.
 * @param {{name: string, aliases?: string[]}[]} cur
 * @param {{name: string, aliases?: string[]}[]} add
 */
export function mergeCompanies(cur, add) {
  const out = cur.map((c) => ({ name: c.name, aliases: [...(c.aliases || [])] }));
  for (const c of add) {
    const ex = out.find((x) => key(x.name) === key(c.name));
    if (!ex) out.push({ name: c.name, aliases: [...(c.aliases || [])] });
    else for (const a of c.aliases || []) if (!ex.aliases.some((x) => key(x) === key(a))) ex.aliases.push(a);
  }
  return out;
}

/** Псевдонимы из поля ввода: через запятую или точку с запятой, без пустых и повторов. */
export function parseAliases(text) {
  const out = [];
  for (const a of String(text ?? '').split(/[,;]/)) {
    const v = a.replace(/[\s\u00A0]+/g, ' ').trim();
    if (v && !out.some((x) => key(x) === key(v))) out.push(v);
  }
  return out;
}

/**
 * Предупреждение `company-short` (риски концепции 0.4): название без ОПФ и кавычек короче 4 символов или общее слово
 * из частотного словаря («Старт», «Вектор») — будет маскироваться и в обычном тексте.
 * @param {string} name
 */
export function isRiskyCompanyName(name) {
  const core = String(name ?? '')
    .trim()
    .replace(LEAD_FORM_RE, '')
    .replace(QUOTES_RE, '')
    .trim();
  if (!core) return false;
  return core.length < 4 || COMMON_NOUNS.has(key(core));
}

/**
 * Предупреждение `company-brand`: бренд владельца (решение 6, `NEVER_MASK_ORGS`) не маскируется никогда —
 * запись в списке сохранится, но детектор её не ищет.
 * @param {string} name
 */
export function isOwnerBrand(name) {
  return isNeverMaskOrg(name);
}
