// Пакет модели NER (WP8, ТЗ §5.2 NLP — отклонение 0.2: модель распространяется отдельным zip-пакетом, не внутри расширения).
// Чистые функции: разбор и проверка манифеста pack.json, сверка файлов пакета с хешами (К5). Без chrome.*, DOM и сети.
// Схема для тестов и внешних инструментов — schemas/model-pack.schema.json; проверки здесь её зеркалят (ядро не тянет
// валидатор JSON Schema). Формат и правила — docs/contracts.md, раздел «Пакет модели NER».
import { sha256Hex } from '../hash.js';

export const PACK_KIND = 'docx-anonymizer-model-pack';
export const PACK_SCHEMA_VERSION = 1;
export const PACK_MANIFEST = 'pack.json';
export const PACK_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
/** Имя файла пакета: плоское (без каталогов), без «..» и скрытых файлов. LICENSE/NOTICE — заглавными, поэтому A–Z допустимы. */
export const PACK_PATH_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;
/**
 * Имена, которые нельзя объявлять в files[].path (без учёта регистра): служебные файлы каталога пакета в хранилище
 * (pack.json, installed.json, маркер .installing — src/shared/model-store.js) и имена свойств прототипа объектов,
 * под которыми записи zip теряются или подменяются при разборе в обычный объект.
 */
export const RESERVED_PACK_PATHS = Object.freeze(['pack.json', 'installed.json', '.installing', '__proto__', 'constructor', 'prototype']);
const RESERVED = new Set(RESERVED_PACK_PATHS);
/** Зарезервированное имя файла пакета (см. RESERVED_PACK_PATHS). */
export const isReservedPackPath = (name) => typeof name === 'string' && RESERVED.has(name.toLowerCase());
export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const LABEL_RE = /^(O|[BI]-[A-Z][A-Z0-9_]*)$/;
const LANG_RE = /^[a-z]{2}$/;

const ROOT_KEYS = [
  'kind',
  'schemaVersion',
  'id',
  'version',
  'name',
  'languages',
  'task',
  'labels',
  'tokenizer',
  'model',
  'files',
  'license',
  'source',
  'minExtensionVersion',
  'recommendedThreshold',
];
const OPTIONAL_ROOT = new Set(['recommendedThreshold']);
const TOKENIZER_KEYS = ['type', 'vocab', 'lowercase', 'stripAccents', 'maxLen', 'stride', 'cls', 'sep', 'pad', 'unk'];
const MODEL_KEYS = ['file', 'inputs', 'output', 'indexType'];

/**
 * @typedef {object} PackFile
 * @property {string} path
 * @property {string} sha256
 * @property {number} size
 *
 * @typedef {object} PackManifest
 * @property {'docx-anonymizer-model-pack'} kind
 * @property {1} schemaVersion
 * @property {string} id
 * @property {string} version
 * @property {{ru: string, en: string}} name
 * @property {string[]} languages
 * @property {'token-classification'} task
 * @property {string[]} labels                 labels[0] === 'O', далее B-/I- метки
 * @property {{type: 'wordpiece', vocab: string, lowercase: boolean, stripAccents: boolean, maxLen: number, stride: number,
 *   cls: string, sep: string, pad: string, unk: string}} tokenizer
 * @property {{file: string, inputs: {ids: string, mask: string, types?: string}, output: string, indexType: 'int64'|'int32'}} model
 * @property {PackFile[]} files                 все файлы zip, кроме pack.json
 * @property {string} license
 * @property {Record<string, string|number|boolean|string[]>} source   происхождение: базовая модель, датасеты, дата
 * @property {string} minExtensionVersion
 * @property {number} [recommendedThreshold]
 */

class Bad extends Error {
  /** @param {string} field */
  constructor(field) {
    super(field);
    this.field = field;
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, f, max = 200) => {
  if (typeof v !== 'string' || !v.length || v.length > max) throw new Bad(f);
};
const keys = (o, allowed, f, optional = new Set()) => {
  if (!isObj(o)) throw new Bad(f);
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new Bad(f ? `${f}.${k}` : k);
  for (const k of allowed) if (!optional.has(k) && o[k] === undefined) throw new Bad(f ? `${f}.${k}` : k);
};

/** Сравнение semver без пререлизов/сборок: -1 | 0 | 1. */
export function compareVersions(a, b) {
  const pa = String(a).split(/[-+]/)[0].split('.').map(Number);
  const pb = String(b).split(/[-+]/)[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
  }
  return 0;
}

/**
 * Разбор и проверка pack.json. Никогда не бросает.
 * @param {string|Uint8Array|object} jsonOrObj  текст JSON, его байты (UTF-8) или уже разобранный объект
 * @param {{extensionVersion?: string}} [opts]  версия расширения — для проверки minExtensionVersion
 * @returns {{ok: true, manifest: PackManifest} | {ok: false, error: string}}
 *   error — путь к первому неверному полю ('tokenizer.stride', 'files[2].path'), 'json', 'minExtensionVersion'
 *   или 'manifest' (непредвиденная ошибка разбора)
 */
export function parsePackManifest(jsonOrObj, opts = {}) {
  let m = jsonOrObj;
  try {
    if (m instanceof Uint8Array) m = new TextDecoder('utf-8', { fatal: true }).decode(m);
    if (typeof m === 'string') m = JSON.parse(m);
  } catch {
    return { ok: false, error: 'json' };
  }
  try {
    checkManifest(m);
    if (opts.extensionVersion && SEMVER_RE.test(opts.extensionVersion) && compareVersions(opts.extensionVersion, m.minExtensionVersion) < 0) {
      return { ok: false, error: 'minExtensionVersion' };
    }
  } catch (e) {
    // непредвиденное (например, объект с геттерами вместо JSON) — тоже отказ, а не исключение
    return { ok: false, error: e instanceof Bad ? e.field : 'manifest' };
  }
  return { ok: true, manifest: /** @type {PackManifest} */ (m) };
}

function checkManifest(m) {
  keys(m, ROOT_KEYS, '', OPTIONAL_ROOT);
  if (m.kind !== PACK_KIND) throw new Bad('kind');
  if (m.schemaVersion !== PACK_SCHEMA_VERSION) throw new Bad('schemaVersion');
  if (typeof m.id !== 'string' || !PACK_ID_RE.test(m.id)) throw new Bad('id');
  if (typeof m.version !== 'string' || !SEMVER_RE.test(m.version)) throw new Bad('version');
  keys(m.name, ['ru', 'en'], 'name');
  str(m.name.ru, 'name.ru', 100);
  str(m.name.en, 'name.en', 100);
  if (!Array.isArray(m.languages) || !m.languages.length || m.languages.length > 10) throw new Bad('languages');
  if (!m.languages.every((l) => typeof l === 'string' && LANG_RE.test(l)) || new Set(m.languages).size !== m.languages.length) throw new Bad('languages');
  if (m.task !== 'token-classification') throw new Bad('task');
  if (!Array.isArray(m.labels) || m.labels.length < 2 || m.labels.length > 64 || m.labels[0] !== 'O') throw new Bad('labels');
  if (!m.labels.every((l) => typeof l === 'string' && LABEL_RE.test(l)) || new Set(m.labels).size !== m.labels.length) throw new Bad('labels');

  const t = m.tokenizer;
  keys(t, TOKENIZER_KEYS, 'tokenizer');
  if (t.type !== 'wordpiece') throw new Bad('tokenizer.type');
  if (typeof t.vocab !== 'string' || !PACK_PATH_RE.test(t.vocab)) throw new Bad('tokenizer.vocab');
  if (typeof t.lowercase !== 'boolean') throw new Bad('tokenizer.lowercase');
  if (typeof t.stripAccents !== 'boolean') throw new Bad('tokenizer.stripAccents');
  if (!Number.isInteger(t.maxLen) || t.maxLen < 64 || t.maxLen > 512) throw new Bad('tokenizer.maxLen');
  if (!Number.isInteger(t.stride) || t.stride < 0 || t.stride >= t.maxLen / 2) throw new Bad('tokenizer.stride');
  for (const k of ['cls', 'sep', 'pad', 'unk']) str(t[k], `tokenizer.${k}`, 32);

  const md = m.model;
  keys(md, MODEL_KEYS, 'model');
  if (typeof md.file !== 'string' || !PACK_PATH_RE.test(md.file)) throw new Bad('model.file');
  keys(md.inputs, ['ids', 'mask', 'types'], 'model.inputs', new Set(['types']));
  str(md.inputs.ids, 'model.inputs.ids', 64);
  str(md.inputs.mask, 'model.inputs.mask', 64);
  if (md.inputs.types !== undefined) str(md.inputs.types, 'model.inputs.types', 64);
  str(md.output, 'model.output', 64);
  if (md.indexType !== 'int64' && md.indexType !== 'int32') throw new Bad('model.indexType');

  if (!Array.isArray(m.files) || !m.files.length || m.files.length > 64) throw new Bad('files');
  const seen = new Set();
  m.files.forEach((f, i) => {
    const at = `files[${i}]`;
    keys(f, ['path', 'sha256', 'size'], at);
    if (typeof f.path !== 'string' || !PACK_PATH_RE.test(f.path) || isReservedPackPath(f.path) || seen.has(f.path)) throw new Bad(`${at}.path`);
    if (typeof f.sha256 !== 'string' || !SHA_RE.test(f.sha256)) throw new Bad(`${at}.sha256`);
    if (!Number.isSafeInteger(f.size) || f.size < 0) throw new Bad(`${at}.size`);
    seen.add(f.path);
  });
  if (!seen.has(md.file)) throw new Bad('model.file');
  if (!seen.has(t.vocab)) throw new Bad('tokenizer.vocab');

  str(m.license, 'license', 200);
  if (!isObj(m.source) || Object.keys(m.source).length > 32) throw new Bad('source');
  for (const [k, v] of Object.entries(m.source)) {
    const okScalar = (x) => ['number', 'boolean'].includes(typeof x) || (typeof x === 'string' && x.length <= 500);
    if (!(okScalar(v) || (Array.isArray(v) && v.length <= 20 && v.every((x) => typeof x === 'string' && x.length <= 500)))) throw new Bad(`source.${k}`);
  }
  if (typeof m.minExtensionVersion !== 'string' || !SEMVER_RE.test(m.minExtensionVersion)) throw new Bad('minExtensionVersion');
  if (m.recommendedThreshold !== undefined && !(typeof m.recommendedThreshold === 'number' && m.recommendedThreshold >= 0 && m.recommendedThreshold <= 1)) {
    throw new Bad('recommendedThreshold');
  }
}

const isBytes = (b) => b instanceof Uint8Array || Object.prototype.toString.call(b) === '[object Uint8Array]';

/**
 * Сверяет записи zip с манифестом: каждый файл из `files` есть в записях с тем же размером и SHA-256, и каждая запись,
 * кроме pack.json, объявлена в `files` (лишних нет). Никогда не бросает.
 * Записи — Map или объект; ключи объекта читаются только собственные (Object.hasOwn), поэтому имена свойств прототипа
 * (toString, hasOwnProperty…) не находятся «сами собой». Запись `__proto__` в обычном объекте теряется ещё при разборе
 * zip — недоверенный архив передавайте как Map или объект без прототипа (так делает src/shared/model-store.js).
 * @param {PackManifest} manifest  уже проверенный parsePackManifest
 * @param {Map<string, Uint8Array> | Record<string, Uint8Array>} entries  записи архива (pack.json допускается и игнорируется)
 * @param {{digest?: (bytes: Uint8Array) => Promise<string>}} [opts]
 * @returns {Promise<{ok: true} | {ok: false, error: 'EXTRA_FILE'|'MISSING_FILE'|'SIZE_MISMATCH'|'HASH_MISMATCH'|'VERIFY_FAILED', path: string}>}
 *   VERIFY_FAILED — непредвиденный сбой проверки (например, хеширования); path — файл, на котором он случился, или ''
 */
export async function verifyPackFiles(manifest, entries, { digest = sha256Hex } = {}) {
  let at = '';
  try {
    const isMap = entries instanceof Map;
    const names = isMap ? [...entries.keys()] : Object.keys(entries);
    const get = (p) => (isMap ? entries.get(p) : Object.hasOwn(entries, p) ? entries[p] : undefined);
    const declared = new Set(manifest.files.map((f) => f.path));
    for (const name of names.sort()) {
      if (name !== PACK_MANIFEST && !declared.has(name)) return { ok: false, error: 'EXTRA_FILE', path: String(name) };
    }
    for (const f of manifest.files) {
      at = f.path;
      const bytes = get(f.path);
      if (!isBytes(bytes)) return { ok: false, error: 'MISSING_FILE', path: f.path };
      if (bytes.length !== f.size) return { ok: false, error: 'SIZE_MISMATCH', path: f.path };
      if ((await digest(bytes)) !== f.sha256) return { ok: false, error: 'HASH_MISMATCH', path: f.path };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'VERIFY_FAILED', path: at };
  }
}

/** Имя zip-файла пакета: docx-anonymizer-ner-<id>-<version>.zip */
export function packZipName(manifest) {
  return `docx-anonymizer-ner-${manifest.id}-${manifest.version}.zip`;
}
