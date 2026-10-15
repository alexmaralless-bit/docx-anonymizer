// Хранилище пакетов модели NER в OPFS (WP8, ТЗ §5.2 NLP — отклонение 0.2; К5).
// Работает и в окне (страница настроек: импорт, удаление, статус), и в dedicated worker offscreen-документа (чтение модели).
// Раскладка: models/<id>/{pack.json, model.onnx, vocab.txt, …, installed.json}; пока идёт установка, в каталоге лежит
// маркер `.installing` — такие каталоги не считаются установленными и вычищаются. Квота: manifest.permissions
// включает unlimitedStorage. Сети не использует: пакет приходит байтами из <input type=file>.
import { unzipSync } from 'fflate';
import { sha256Hex } from '../core/hash.js';
import { PACK_ID_RE, PACK_MANIFEST, PACK_PATH_RE, parsePackManifest, verifyPackFiles } from '../core/ner/pack.js';
import { findKnownPack } from '../core/ner/known-packs.js';

const MODELS_DIR = 'models';
const INSTALLED = 'installed.json';
const INSTALLING = '.installing';
/** Маркер `.installing` старше этого — брошенная установка (вкладка закрыта посреди записи). */
const STALE_INSTALL_MS = 10 * 60 * 1000;
/** Защита от zip-бомбы: суммарный распакованный размер пакета. */
const MAX_UNPACKED = 512 * 1024 * 1024;

/** Коды ошибок хранилища; у каждого есть текст ner_err_<CODE> в src/ui/i18n/options.js. */
export const MODEL_STORE_ERROR_CODES = Object.freeze([
  'UNAVAILABLE',
  'BAD_ZIP',
  'BAD_MANIFEST',
  'INCOMPATIBLE',
  'HASH_MISMATCH',
  'QUOTA',
  'IO',
  'NOT_INSTALLED',
]);

export class ModelStoreError extends Error {
  /** @param {string} code @param {string} [message] @param {object} [details] */
  constructor(code, message = code, details) {
    super(message);
    this.name = 'ModelStoreError';
    this.code = code;
    this.details = details;
  }
}

/** OPFS доступен в этом контексте (окно или worker расширения — secure context). */
export function isAvailable() {
  return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function';
}

async function modelsDir(create = false) {
  if (!isAvailable()) throw new ModelStoreError('UNAVAILABLE', 'OPFS недоступен');
  const root = await navigator.storage.getDirectory();
  try {
    return await root.getDirectoryHandle(MODELS_DIR, { create });
  } catch (e) {
    if (!create && e?.name === 'NotFoundError') return null;
    throw ioError(e);
  }
}

function ioError(e) {
  if (e instanceof ModelStoreError) return e;
  if (e?.name === 'QuotaExceededError') return new ModelStoreError('QUOTA', 'Недостаточно места в хранилище браузера');
  return new ModelStoreError('IO', `Ошибка хранилища: ${e?.name || 'Error'}`);
}

async function readText(dir, name) {
  const f = await (await dir.getFileHandle(name)).getFile();
  return f.text();
}

async function exists(dir, name) {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Установленные пакеты (обычно один). Брошенные установки удаляются.
 * @returns {Promise<{id: string, version: string, name: {ru: string, en: string}, languages: string[], bytes: number,
 *   installedAt: number, verified: boolean, packSha256: string, manifest: import('../core/ner/pack.js').PackManifest}[]>}
 */
export async function listInstalled() {
  const models = await modelsDir(false);
  if (!models) return [];
  const out = [];
  try {
    for await (const [name, handle] of /** @type {any} */ (models).entries()) {
      if (handle.kind !== 'directory') continue;
      if (await exists(handle, INSTALLING)) {
        const started = Number(await readText(handle, INSTALLING).catch(() => '0')) || 0;
        if (Date.now() - started > STALE_INSTALL_MS) await models.removeEntry(name, { recursive: true }).catch(() => {});
        continue;
      }
      try {
        const info = JSON.parse(await readText(handle, INSTALLED));
        const parsed = parsePackManifest(await readText(handle, PACK_MANIFEST));
        if (!parsed.ok || parsed.manifest.id !== name) continue;
        out.push({ ...info, id: name, manifest: parsed.manifest });
      } catch {
        /* неполный каталог — не установлен */
      }
    }
  } catch (e) {
    throw ioError(e);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Распаковка и проверка пакета: zip → pack.json → хеши файлов. Ничего не записывает.
 * @param {Uint8Array} bytes  zip-файл пакета
 * @param {{extensionVersion?: string}} [opts]
 */
async function unpack(bytes, opts = {}) {
  let entries;
  try {
    let total = 0;
    entries = unzipSync(bytes, {
      filter: (f) => {
        total += f.originalSize;
        if (total > MAX_UNPACKED) throw new Error('too large');
        return !f.name.endsWith('/');
      },
    });
  } catch {
    throw new ModelStoreError('BAD_ZIP', 'Файл не является zip-архивом пакета');
  }
  if (!entries[PACK_MANIFEST]) throw new ModelStoreError('BAD_MANIFEST', 'В пакете нет pack.json');
  const parsed = parsePackManifest(entries[PACK_MANIFEST], opts);
  if (!parsed.ok) {
    if (parsed.error === 'minExtensionVersion') throw new ModelStoreError('INCOMPATIBLE', 'Пакет требует более новую версию расширения');
    throw new ModelStoreError('BAD_MANIFEST', `Неверное поле pack.json: ${parsed.error}`, { field: parsed.error });
  }
  const v = await verifyPackFiles(parsed.manifest, entries);
  if (!v.ok) {
    const code = v.error === 'SIZE_MISMATCH' || v.error === 'HASH_MISMATCH' ? 'HASH_MISMATCH' : 'BAD_MANIFEST';
    throw new ModelStoreError(code, `Файл пакета не совпадает с манифестом: ${v.path}`, { path: v.path, reason: v.error });
  }
  const packSha256 = await sha256Hex(bytes);
  return { manifest: parsed.manifest, entries, packSha256, verified: !!findKnownPack(packSha256) };
}

/**
 * Проверка пакета перед установкой (для подтверждения в UI).
 * @param {Uint8Array} bytes
 * @param {{extensionVersion?: string}} [opts]
 * @returns {Promise<{manifest: import('../core/ner/pack.js').PackManifest, packSha256: string, verified: boolean, bytes: number}>}
 */
export async function inspectPack(bytes, opts) {
  const r = await unpack(bytes, opts);
  return { manifest: r.manifest, packSha256: r.packSha256, verified: r.verified, bytes: sumSize(r.manifest) };
}

function sumSize(manifest) {
  return manifest.files.reduce((n, f) => n + f.size, 0);
}

/**
 * Установка: пакет проверяется заново (хеши), прежняя установка того же id удаляется, файлы пишутся в models/<id>/.
 * Признак «проверен» вычисляется по KNOWN_PACKS; opts.verified учитывается только как подсказка UI и не может его поднять.
 * @param {Uint8Array} bytes
 * @param {{verified?: boolean, extensionVersion?: string}} [opts]
 */
export async function install(bytes, opts = {}) {
  const { manifest, entries, packSha256, verified } = await unpack(bytes, opts);
  const models = await modelsDir(true);
  const id = manifest.id;
  try {
    await models.removeEntry(id, { recursive: true }).catch((e) => {
      if (e?.name !== 'NotFoundError') throw e;
    });
    const dir = await models.getDirectoryHandle(id, { create: true });
    await writeFile(dir, INSTALLING, new TextEncoder().encode(String(Date.now())));
    await writeFile(dir, PACK_MANIFEST, entries[PACK_MANIFEST]);
    for (const f of manifest.files) await writeFile(dir, f.path, entries[f.path]);
    const record = {
      id,
      version: manifest.version,
      name: manifest.name,
      languages: manifest.languages,
      bytes: sumSize(manifest),
      installedAt: Date.now(),
      verified: verified,
      packSha256,
    };
    await writeFile(dir, INSTALLED, new TextEncoder().encode(JSON.stringify(record)));
    await dir.removeEntry(INSTALLING);
    return { ...record, manifest };
  } catch (e) {
    await models.removeEntry(id, { recursive: true }).catch(() => {});
    throw ioError(e);
  }
}

async function writeFile(dir, name, bytes) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  try {
    await w.write(bytes);
    await w.close();
  } catch (e) {
    await w.abort().catch(() => {});
    throw e;
  }
}

/** Удаляет пакет; отсутствующий — не ошибка. */
export async function remove(id) {
  checkId(id);
  const models = await modelsDir(false);
  if (!models) return;
  try {
    await models.removeEntry(id, { recursive: true });
  } catch (e) {
    if (e?.name !== 'NotFoundError') throw ioError(e);
  }
}

function checkId(id) {
  if (typeof id !== 'string' || !PACK_ID_RE.test(id)) throw new ModelStoreError('NOT_INSTALLED', 'Неверный id пакета');
}

/**
 * Файл установленного пакета.
 * @param {string} id
 * @param {string} path  имя файла из манифеста или pack.json — без '/' и '..'
 * @returns {Promise<Uint8Array>}
 */
export async function readFile(id, path) {
  checkId(id);
  if (typeof path !== 'string' || !PACK_PATH_RE.test(path) || path === INSTALLING) throw new ModelStoreError('IO', 'Недопустимое имя файла');
  const models = await modelsDir(false);
  if (!models) throw new ModelStoreError('NOT_INSTALLED', 'Пакет не установлен');
  let dir;
  try {
    dir = await models.getDirectoryHandle(id);
  } catch (e) {
    throw e?.name === 'NotFoundError' ? new ModelStoreError('NOT_INSTALLED', 'Пакет не установлен') : ioError(e);
  }
  if (await exists(dir, INSTALLING)) throw new ModelStoreError('NOT_INSTALLED', 'Пакет ещё устанавливается');
  try {
    const f = await (await dir.getFileHandle(path)).getFile();
    return new Uint8Array(await f.arrayBuffer());
  } catch (e) {
    throw e?.name === 'NotFoundError' ? new ModelStoreError('NOT_INSTALLED', `Нет файла пакета: ${path}`) : ioError(e);
  }
}

/** Манифест установленного пакета или null. */
export async function getManifest(id) {
  try {
    const parsed = parsePackManifest(await readFile(id, PACK_MANIFEST));
    return parsed.ok ? parsed.manifest : null;
  } catch (e) {
    if (e instanceof ModelStoreError && e.code === 'NOT_INSTALLED') return null;
    throw e;
  }
}

/**
 * Доступ к файлам пакета для NER-провайдера (синхронно, без обращения к хранилищу до первого read).
 * @param {string} id
 * @returns {{modelId: string, read: (path: string) => Promise<Uint8Array>}}
 */
export function openModelFiles(id) {
  return { modelId: id, read: (path) => readFile(id, path) };
}
