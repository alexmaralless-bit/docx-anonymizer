// КОНТРАКТ: настройки (FR-34, таблица §4.8). Хранятся в chrome.storage.local под ключом 'settings'.
// Ядро не знает про chrome.* — обёртка хранилища в src/shared/settings-store.js.
import { ALWAYS_ON_IDS, BUILTIN_CATEGORIES } from './categories.js';

export const SETTINGS_KEY = 'settings';
export const SETTINGS_SCHEMA_VERSION = 3;

export const DEFAULT_ALLOWLIST = Object.freeze([
  'https://chatgpt.com',
  'https://claude.ai',
  'https://gemini.google.com',
  'https://chat.deepseek.com',
  'https://www.perplexity.ai',
]);

const PROFILE_FIELDS = [
  'categories',
  'commercial',
  'mode',
  'language',
  'placeholderLanguage',
  'keepMetadata',
  'stripEmbedded',
  'govEntities',
  'dictNames',
  'nerThreshold',
  'nerThresholdOrg',
];

/** Категории групп `pii`/`ids` всегда `true` (политика 0.4, К1); `commercial` — по `defaultOn` внутри группы. */
function defaultCategories() {
  return Object.fromEntries(BUILTIN_CATEGORIES.map((c) => [c.id, ALWAYS_ON_IDS.includes(c.id) || c.defaultOn]));
}

/** Включает категории `pii`/`ids` в объекте категорий (миграция 2 → 3 и импорт старых конфигураций). */
function forceAlwaysOn(categories) {
  return { ...categories, ...Object.fromEntries(ALWAYS_ON_IDS.map((id) => [id, true])) };
}

/**
 * @typedef {object} Settings
 * @property {number} schemaVersion
 * @property {boolean} interceptEnabled
 * @property {'all'|'allowlist'} siteMode
 * @property {string[]} allowlist
 * @property {string[]} blocklist
 * @property {Record<string, boolean>} categories  переключатели внутри группы `commercial`; для `pii`/`ids` значения всегда true (К1 0.4)
 * @property {boolean} commercial         группа «Коммерческая информация» (COMPANY, CONTRACT, AMOUNT) включена (0.4, Ц1); по умолчанию выключена
 * @property {{name: string, aliases: string[]}[]} maskedCompanies  список компаний для маскирования (0.4, Ц3, FR списка компаний); ищутся всегда
 * @property {boolean} orgPolicyHintPending  показать один раз подсказку «организации теперь по желанию» (0.4, миграция 2 → 3); не экспортируется
 * @property {'placeholder'|'mask'|'delete'} mode
 * @property {'auto'|'ru'|'en'|'both'} language
 * @property {'document'|'ru'|'en'} placeholderLanguage
 * @property {boolean} nerEnabled
 * @property {number} nerThreshold       порог модели для PER/LOC
 * @property {number} nerThresholdOrg    порог модели для ORG (0.4, концепция п. 4; по умолчанию 0.85)
 * @property {string[]} nerStoplist      пользовательское дополнение стоп-списка модельных организаций (0.4, К10)
 * @property {string} nerModel           id установленного пакета модели NER ('' — нет; WP8), не экспортируется
 * @property {string} bundledModelSha    sha256 встроенного пакета, который профиль уже обработал ('' — ни одного; WP10-C, Ц7), не экспортируется
 * @property {string} bundledModelError  код последней неудачной автоустановки встроенного пакета ('' — нет; WP10-C, К15), не экспортируется
 * @property {boolean} keepMetadata
 * @property {boolean} stripEmbedded
 * @property {number} maxFileSizeMB
 * @property {'auto'|'ru'|'en'} uiLanguage
 * @property {{value: string, category: string}[]} exclusions
 * @property {boolean} govEntities
 * @property {boolean} dictNames          словарный детектор ФИО третьих лиц (WP7, FR-23)
 * @property {Record<string, {x: number, y: number}>} panelPosition
 * @property {boolean} hintMappingShown   подсказка о ключе восстановления уже показана (WP10-D, FR-28); не экспортируется
 * @property {object[]} customCategories   CustomCategory (FR-44)
 * @property {{id: string, name: {ru: string, en: string}, builtin: boolean, values: object}[]} profiles
 * @property {string} activeProfile
 * @property {'folder'|'zip'|'files'} batchOutput
 * @property {string} outputSuffix
 * @property {'markdown'|'text'|'off'} pdfMode  PDF (версия 0.3): в чат уходит .anon.md / .anon.txt; 'off' — PDF не перехватывается
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
    // политика 0.4: названия организаций, номера договоров и суммы — по желанию; у всех после обновления выключено
    commercial: false,
    maskedCompanies: [],
    orgPolicyHintPending: false,
    mode: 'placeholder',
    language: 'auto',
    placeholderLanguage: 'document',
    nerEnabled: true,
    // порог NER = recommendedThreshold пакета rubert-tiny2-ner-ruen (WP9, калибровка tools/ner-train/calibrate.py; docs/contracts.md §6.7)
    nerThreshold: 0.7,
    // порог для ORG выше: модель 1.0.0 на жанрах вне договоров давала десятки ложных организаций (концепция 0.4, п. 4)
    nerThresholdOrg: 0.85,
    nerStoplist: [],
    nerModel: '',
    // WP10-C: пишет только background по ответу MODEL_INSTALLED; удаление модели пользователем поле не трогает (модель не вернётся сама)
    bundledModelSha: '',
    // WP10-C: тоже пишет только background — код ошибки MODEL_INSTALLED failed (карточка «не удалось / повторить»); очищается успехом
    bundledModelError: '',
    keepMetadata: false,
    stripEmbedded: false,
    maxFileSizeMB: 50,
    uiLanguage: 'auto',
    exclusions: [],
    govEntities: true,
    dictNames: true,
    panelPosition: {},
    hintMappingShown: false,
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
    pdfMode: 'markdown',
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
  commercial: (v) => typeof v === 'boolean',
  maskedCompanies: (v) => Array.isArray(v) && v.length <= 200 && v.every(isMaskedCompany),
  orgPolicyHintPending: (v) => typeof v === 'boolean',
  mode: (v) => ['placeholder', 'mask', 'delete'].includes(v),
  language: (v) => ['auto', 'ru', 'en', 'both'].includes(v),
  placeholderLanguage: (v) => ['document', 'ru', 'en'].includes(v),
  nerEnabled: (v) => typeof v === 'boolean',
  nerThreshold: (v) => typeof v === 'number' && v >= 0 && v <= 1,
  nerThresholdOrg: (v) => typeof v === 'number' && v >= 0 && v <= 1,
  nerStoplist: (v) => Array.isArray(v) && v.length <= 500 && v.every((x) => typeof x === 'string' && x.length <= 80),
  // = PACK_ID_RE из core/ner/pack.js (не импортируется, чтобы не тянуть разбор пакета в content.js; равенство — в тесте)
  nerModel: (v) => v === '' || (typeof v === 'string' && /^[a-z0-9][a-z0-9-]{1,40}$/.test(v)),
  bundledModelSha: (v) => v === '' || (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)),
  // код ошибки как в schemas/protocol.schema.json (MODEL_INSTALLED.code): только A-Z и _, без значений документа
  bundledModelError: (v) => v === '' || (typeof v === 'string' && /^[A-Z_]{1,40}$/.test(v)),
  keepMetadata: (v) => typeof v === 'boolean',
  stripEmbedded: (v) => typeof v === 'boolean',
  maxFileSizeMB: (v) => Number.isInteger(v) && v >= 1 && v <= 100,
  uiLanguage: (v) => ['auto', 'ru', 'en'].includes(v),
  exclusions: (v) => Array.isArray(v) && v.every((x) => isPlainObject(x) && typeof x.value === 'string' && typeof x.category === 'string'),
  govEntities: (v) => typeof v === 'boolean',
  dictNames: (v) => typeof v === 'boolean',
  panelPosition: (v) => isPlainObject(v),
  hintMappingShown: (v) => typeof v === 'boolean',
  customCategories: (v) => Array.isArray(v) && v.length <= 100 && v.every((x) => isPlainObject(x) && typeof x.id === 'string'),
  profiles: (v) => Array.isArray(v) && v.every((x) => isPlainObject(x) && typeof x.id === 'string'),
  activeProfile: (v) => typeof v === 'string',
  batchOutput: (v) => ['folder', 'zip', 'files'].includes(v),
  outputSuffix: (v) => typeof v === 'string' && v.length <= 32 && !/[\\/:*?"<>|]/.test(v),
  pdfMode: (v) => ['markdown', 'text', 'off'].includes(v),
});

/**
 * Миграции: MIGRATIONS[n] переводит объект версии n в версию n+1.
 * Чтобы добавить поле/переименовать — увеличьте SETTINGS_SCHEMA_VERSION и добавьте функцию.
 * @type {Record<number, (s: any) => any>}
 */
export const MIGRATIONS = {
  // 0 → 1: исходная версия; объекты без schemaVersion считаются версией 0
  0: (s) => ({ ...s, schemaVersion: 1 }),
  // 1 → 2 (0.2, WP9): порог NER по умолчанию 0.6 → 0.7. В 0.1 модели не было, поэтому 0.6 — это всегда прежний
  // дефолт, а не выбор пользователя; другие значения не трогаем. Профили со своим порогом тоже не трогаем.
  1: (s) => ({ ...s, schemaVersion: 2, ...(s.nerThreshold === 0.6 ? { nerThreshold: 0.7 } : {}) }),
  // 2 → 3 (0.4, политика маскирования): категории групп pii/ids включаются принудительно — и в настройках, и в
  // сохранённых профилях; группа commercial у всех выключена (нового ключа в объекте нет → дефолт false, политика
  // едина). Существующий профиль (есть `categories`) получает одноразовую подсказку о смене политики.
  2: (s) => {
    const out = { ...s, schemaVersion: 3 };
    if (isPlainObject(s.categories)) {
      out.categories = forceAlwaysOn(s.categories);
      out.orgPolicyHintPending = true;
    }
    if (Array.isArray(s.profiles)) {
      out.profiles = s.profiles.map((p) =>
        isPlainObject(p) && isPlainObject(p.values) && isPlainObject(p.values.categories)
          ? { ...p, values: { ...p.values, categories: forceAlwaysOn(p.values.categories) } }
          : p,
      );
    }
    return out;
  },
};

/**
 * Прогоняет MIGRATIONS над объектом настроек версии `fromVersion` (целым или частичным — патчем из файла импорта,
 * FR-47) до SETTINGS_SCHEMA_VERSION. Чистая функция: вход не меняется. Миграции обязаны работать и на частичном
 * объекте (трогать только присутствующие поля). Версия больше текущей или нецелая (кроме отсутствующей — это 0) — без
 * изменений. Возвращает объект со `schemaVersion` той версии, до которой дошли.
 * @param {Record<string, any>} obj
 * @param {number} [fromVersion]  по умолчанию obj.schemaVersion, без него — 0
 */
export function applyMigrations(obj, fromVersion = obj?.schemaVersion) {
  let s = { ...obj };
  let v = fromVersion === undefined ? 0 : fromVersion;
  if (!Number.isInteger(v)) return s;
  while (v < SETTINGS_SCHEMA_VERSION) {
    const m = MIGRATIONS[v];
    if (!m) break;
    s = m(s);
    v = s.schemaVersion;
  }
  return s;
}

/**
 * Приводит сохранённый объект (любой версии, в т.ч. undefined) к текущей схеме:
 * миграции → дополнение дефолтами → отбрасывание невалидных полей.
 * @param {any} stored
 * @returns {{settings: Settings, changed: boolean}}
 */
export function migrateSettings(stored) {
  const defaults = defaultSettings();
  if (!isPlainObject(stored)) return { settings: defaults, changed: true };
  const s = applyMigrations(stored, Number.isInteger(stored.schemaVersion) ? stored.schemaVersion : 0);
  /** @type {any} */
  const out = {};
  for (const [k, def] of Object.entries(defaults)) {
    const val = s[k];
    out[k] = val !== undefined && VALIDATORS[k]?.(val) ? val : def;
  }
  // Новые встроенные категории получают defaultOn; pii/ids всегда включены (К1 0.4) — даже если сохранённый объект
  // текущей версии был изменён вручную
  out.categories = forceAlwaysOn({ ...defaults.categories, ...out.categories });
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

/** Запись списка компаний (0.4): название 1–120 символов, до 20 псевдонимов. */
function isMaskedCompany(x) {
  return (
    isPlainObject(x) &&
    typeof x.name === 'string' &&
    x.name.trim().length >= 1 &&
    x.name.length <= 120 &&
    (x.aliases === undefined || (Array.isArray(x.aliases) && x.aliases.length <= 20 && x.aliases.every((a) => typeof a === 'string' && a.length <= 120)))
  );
}

function isOriginPattern(v) {
  return typeof v === 'string' && /^https?:\/\/(\*\.)?[^/\s]+$/.test(v);
}
