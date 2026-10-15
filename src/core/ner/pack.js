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
 *   error — путь к первому неверному полю ('tokenizer.stride', 'files[2].path'), 'json' или 'minExtensionVersion'
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
  } catch (e) {
    if (e instanceof Bad) return { ok: false, error: e.field };
    throw e;
  }
  if (opts.extensionVersion && SEMVER_RE.test(opts.extensionVersion) && compareVersions(opts.extensionVersion, m.minExtensionVersion) < 0) {
    return { ok: false, error: 'minExtensionVersion' };
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
    if (typeof f.path !== 'string' || !PACK_PATH_RE.test(f.path) || f.path === PACK_MANIFEST || seen.has(f.path)) throw new Bad(`${at}.path`);
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

/**
 * Сверяет записи zip с манифестом: каждый файл из `files` есть с тем же размером и SHA-256, лишних записей нет.
 * @param {PackManifest} manifest  уже проверенный parsePackManifest
 * @param {Record<string, Uint8Array>} entries  записи архива (pack.json допускается и игнорируется)
 * @param {{digest?: (bytes: Uint8Array) => Promise<string>}} [opts]
 * @returns {Promise<{ok: true} | {ok: false, error: 'EXTRA_FILE'|'MISSING_FILE'|'SIZE_MISMATCH'|'HASH_MISMATCH', path: string}>}
 */
export async function verifyPackFiles(manifest, entries, { digest = sha256Hex } = {}) {
  const declared = new Map(manifest.files.map((f) => [f.path, f]));
  for (const name of Object.keys(entries).sort()) {
    if (name !== PACK_MANIFEST && !declared.has(name)) return { ok: false, error: 'EXTRA_FILE', path: name };
  }
  for (const f of manifest.files) {
    const bytes = entries[f.path];
    if (!bytes) return { ok: false, error: 'MISSING_FILE', path: f.path };
    if (bytes.length !== f.size) return { ok: false, error: 'SIZE_MISMATCH', path: f.path };
    if ((await digest(bytes)) !== f.sha256) return { ok: false, error: 'HASH_MISMATCH', path: f.path };
  }
  return { ok: true };
}

/** Имя zip-файла пакета: docx-anonymizer-ner-<id>-<version>.zip */
export function packZipName(manifest) {
  return `docx-anonymizer-ner-${manifest.id}-${manifest.version}.zip`;
}
