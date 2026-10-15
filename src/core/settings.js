// КОНТРАКТ: настройки (FR-34, таблица §4.8). Хранятся в chrome.storage.local под ключом 'settings'.
// Ядро не знает про chrome.* — обёртка хранилища в src/shared/settings-store.js.
import { BUILTIN_CATEGORIES } from './categories.js';

export const SETTINGS_KEY = 'settings';
export const SETTINGS_SCHEMA_VERSION = 1;

export const DEFAULT_ALLOWLIST = Object.freeze([
  'https://chatgpt.com',
  'https://claude.ai',
  'https://gemini.google.com',
  'https://chat.deepseek.com',
  'https://www.perplexity.ai',
]);

const PROFILE_FIELDS = ['categories', 'mode', 'language', 'placeholderLanguage', 'keepMetadata', 'stripEmbedded', 'govEntities', 'dictNames', 'nerThreshold'];

function defaultCategories() {
  return Object.fromEntries(BUILTIN_CATEGORIES.map((c) => [c.id, c.defaultOn]));
}

/**
 * @typedef {object} Settings
 * @property {number} schemaVersion
 * @property {boolean} interceptEnabled
 * @property {'all'|'allowlist'} siteMode
 * @property {string[]} allowlist
 * @property {string[]} blocklist
 * @property {Record<string, boolean>} categories
 * @property {'placeholder'|'mask'|'delete'} mode
 * @property {'auto'|'ru'|'en'|'both'} language
 * @property {'document'|'ru'|'en'} placeholderLanguage
 * @property {boolean} nerEnabled
 * @property {number} nerThreshold
 * @property {string} nerModel           id установленного пакета модели NER ('' — нет; WP8), не экспортируется
 * @property {boolean} keepMetadata
 * @property {boolean} stripEmbedded
 * @property {number} maxFileSizeMB
 * @property {'auto'|'ru'|'en'} uiLanguage
 * @property {{value: string, category: string}[]} exclusions
 * @property {boolean} govEntities
 * @property {boolean} dictNames          словарный детектор ФИО третьих лиц (WP7, FR-23)
 * @property {Record<string, {x: number, y: number}>} panelPosition
 * @property {object[]} customCategories   CustomCategory (FR-44)
 * @property {{id: string, name: {ru: string, en: string}, builtin: boolean, values: object}[]} profiles
 * @property {string} activeProfile
 * @property {'folder'|'zip'|'files'} batchOutput
 * @property {string} outputSuffix
 */

/** @returns {Settings} */
export function defaultSettings() {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    interceptEnabled: false,
    siteMode: 'allowlist',
    allowlist: [...DEFAULT_ALLOWLIST],
    blocklist: [],
    categories: defaultCategories(),
    mode: 'placeholder',
    language: 'auto',
    placeholderLanguage: 'document',
    nerEnabled: true,
    nerThreshold: 0.6,
    nerModel: '',
    keepMetadata: false,
    stripEmbedded: false,
    maxFileSizeMB: 50,
    uiLanguage: 'auto',
    exclusions: [],
    govEntities: true,
    dictNames: true,
    panelPosition: {},
    customCategories: [],
    profiles: [
      { id: 'llm', name: { ru: 'Для LLM', en: 'For LLM' }, builtin: true, values: {} },
      {
        id: 'external',
        name: { ru: 'Для внешней передачи', en: 'For external sharing' },
        builtin: true,
        values: {
          categories: Object.fromEntries(BUILTIN_CATEGORIES.map((c) => [c.id, true])),
          govEntities: false,
          stripEmbedded: true,
        },
      },
    ],
    activeProfile: 'llm',
    batchOutput: 'folder',
    outputSuffix: '.anon',
  };
}

/** Проверки полей: (value) => true если валидно. Используется миграцией и страницей настроек (FR-42). */
export const VALIDATORS = Object.freeze({
  schemaVersion: (v) => Number.isInteger(v),
  interceptEnabled: (v) => typeof v === 'boolean',
  siteMode: (v) => v === 'all' || v === 'allowlist',
  allowlist: (v) => Array.isArray(v) && v.every(isOriginPattern),
  blocklist: (v) => Array.isArray(v) && v.every(isOriginPattern),
  categories: (v) => isPlainObject(v) && Object.values(v).every((x) => typeof x === 'boolean'),
  mode: (v) => ['placeholder', 'mask', 'delete'].includes(v),
  language: (v) => ['auto', 'ru', 'en', 'both'].includes(v),
  placeholderLanguage: (v) => ['document', 'ru', 'en'].includes(v),
  nerEnabled: (v) => typeof v === 'boolean',
  nerThreshold: (v) => typeof v === 'number' && v >= 0 && v <= 1,
  // = PACK_ID_RE из core/ner/pack.js (не импортируется, чтобы не тянуть разбор пакета в content.js; равенство — в тесте)
  nerModel: (v) => v === '' || (typeof v === 'string' && /^[a-z0-9][a-z0-9-]{1,40}$/.test(v)),
  keepMetadata: (v) => typeof v === 'boolean',
  stripEmbedded: (v) => typeof v === 'boolean',
  maxFileSizeMB: (v) => Number.isInteger(v) && v >= 1 && v <= 100,
  uiLanguage: (v) => ['auto', 'ru', 'en'].includes(v),
  exclusions: (v) => Array.isArray(v) && v.every((x) => isPlainObject(x) && typeof x.value === 'string' && typeof x.category === 'string'),
  govEntities: (v) => typeof v === 'boolean',
  dictNames: (v) => typeof v === 'boolean',
  panelPosition: (v) => isPlainObject(v),
  customCategories: (v) => Array.isArray(v) && v.length <= 100 && v.every((x) => isPlainObject(x) && typeof x.id === 'string'),
  profiles: (v) => Array.isArray(v) && v.every((x) => isPlainObject(x) && typeof x.id === 'string'),
  activeProfile: (v) => typeof v === 'string',
  batchOutput: (v) => ['folder', 'zip', 'files'].includes(v),
  outputSuffix: (v) => typeof v === 'string' && v.length <= 32 && !/[\\/:*?"<>|]/.test(v),
});

/**
 * Миграции: MIGRATIONS[n] переводит объект версии n в версию n+1.
 * Чтобы добавить поле/переименовать — увеличьте SETTINGS_SCHEMA_VERSION и добавьте функцию.
 * @type {Record<number, (s: any) => any>}
 */
export const MIGRATIONS = {
  // 0 → 1: исходная версия; объекты без schemaVersion считаются версией 0
  0: (s) => ({ ...s, schemaVersion: 1 }),
};

/**
 * Приводит сохранённый объект (любой версии, в т.ч. undefined) к текущей схеме:
 * миграции → дополнение дефолтами → отбрасывание невалидных полей.
 * @param {any} stored
 * @returns {{settings: Settings, changed: boolean}}
 */
export function migrateSettings(stored) {
  const defaults = defaultSettings();
  if (!isPlainObject(stored)) return { settings: defaults, changed: true };
  let s = { ...stored };
  let v = Number.isInteger(s.schemaVersion) ? s.schemaVersion : 0;
  while (v < SETTINGS_SCHEMA_VERSION) {
    const m = MIGRATIONS[v];
    if (!m) break;
    s = m(s);
    v = s.schemaVersion;
  }
  /** @type {any} */
  const out = {};
  for (const [k, def] of Object.entries(defaults)) {
    const val = s[k];
    out[k] = val !== undefined && VALIDATORS[k]?.(val) ? val : def;
  }
  // Новые встроенные категории получают defaultOn
  out.categories = { ...defaults.categories, ...out.categories };
  out.schemaVersion = SETTINGS_SCHEMA_VERSION;
  const changed = JSON.stringify(out) !== JSON.stringify(stored);
  return { settings: out, changed };
}

/**
 * Проверяет патч настроек. Возвращает список невалидных ключей (пустой — всё хорошо).
 * @param {Partial<Settings>} patch
 */
export function validateSettingsPatch(patch) {
  const bad = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in VALIDATORS) || !VALIDATORS[k](v)) bad.push(k);
  }
  return bad;
}

/**
 * Эффективные настройки обработки = настройки + значения активного профиля (FR-52).
 * @param {Settings} settings
 * @param {string} [profileId]
 */
export function effectiveSettings(settings, profileId = settings.activeProfile) {
  const p = settings.profiles.find((x) => x.id === profileId);
  if (!p) return settings;
  const values = Object.fromEntries(Object.entries(p.values || {}).filter(([k]) => PROFILE_FIELDS.includes(k)));
  return { ...settings, ...values, categories: { ...settings.categories, ...(values.categories || {}) } };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isOriginPattern(v) {
  return typeof v === 'string' && /^https?:\/\/(\*\.)?[^/\s]+$/.test(v);
}
