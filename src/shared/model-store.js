// Хранилище пакетов модели NER в OPFS (WP8, ТЗ §5.2 NLP — отклонение 0.2; К5).
// Работает и в окне (страница настроек: импорт, удаление, статус), и в dedicated worker offscreen-документа (чтение модели).
// Раскладка: у пакета два слота — models/<id>/ и models/<id>.1/, в каждом {pack.json, model.onnx, vocab.txt, …,
// installed.json}. Установка пишет в НЕактивный слот; пока она идёт, в слоте лежит маркер `.installing` — такой слот не
// считается установленным. Переключение — удаление маркера (одна операция): с этого момента активен новый слот (его
// installedAt больше), и только потом удаляется прежний. Сбой записи на любом шаге оставляет прежнюю версию рабочей
// (переименовать каталог в OPFS нельзя, поэтому слоты, а не «запись во временный каталог и rename»). Брошенные
// установки и устаревшие слоты вычищает listInstalled. id пакета не содержит точки, поэтому имена слотов разных
// пакетов не пересекаются. Квота: manifest.permissions включает unlimitedStorage. Сети не использует: пакет приходит
// байтами из <input type=file>.
import { unzipSync } from 'fflate';
import { sha256Hex } from '../core/hash.js';
import { PACK_ID_RE, PACK_MANIFEST, PACK_PATH_RE, isReservedPackPath, parsePackManifest, verifyPackFiles } from '../core/ner/pack.js';
import { findKnownPack } from '../core/ner/known-packs.js';

const MODELS_DIR = 'models';
const INSTALLED = 'installed.json';
const INSTALLING = '.installing';
/** Суффикс второго слота пакета: models/<id>.1/ */
const SLOT_B = '.1';
/** Маркер `.installing` старше этого — брошенная установка (вкладка закрыта посреди записи). */
const STALE_INSTALL_MS = 10 * 60 * 1000;
/**
 * Предел размера пакета: и самого zip-файла, и суммы распакованных размеров записей по центральному каталогу
 * (защита от zip-бомбы и от чтения в память заведомо неподходящего файла). Больше — ошибка TOO_LARGE.
 */
export const MAX_PACK_BYTES = 512 * 1024 * 1024;

/** Коды ошибок хранилища; у каждого есть текст ner_err_<CODE> в src/ui/i18n/options.js. */
export const MODEL_STORE_ERROR_CODES = Object.freeze([
  'UNAVAILABLE',
  'BAD_ZIP',
  'TOO_LARGE',
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

const slotNames = (id) => [id, id + SLOT_B];
/** id пакета по имени каталога-слота или null для посторонних каталогов. */
function slotOwner(name) {
  const id = name.endsWith(SLOT_B) ? name.slice(0, -SLOT_B.length) : name;
  return PACK_ID_RE.test(id) ? id : null;
}

async function removeDir(models, name) {
  try {
    await models.removeEntry(name, { recursive: true });
  } catch (e) {
    if (e?.name !== 'NotFoundError') throw e;
  }
}

/**
 * Состояние слота: null — каталога нет; complete=false — установка идёт или брошена (started — время из маркера,
 * 0 — маркера нет, но нет и installed.json); complete=true — установка завершена, info — installed.json.
 */
async function readSlot(models, name) {
  let dir;
  try {
    dir = await models.getDirectoryHandle(name);
  } catch (e) {
    if (e?.name === 'NotFoundError' || e?.name === 'TypeMismatchError') return null;
    throw e;
  }
  if (await exists(dir, INSTALLING)) {
    const started = Number(await readText(dir, INSTALLING).catch(() => '0')) || 0;
    return { name, dir, complete: false, started };
  }
  try {
    const info = JSON.parse(await readText(dir, INSTALLED));
    if (info && typeof info === 'object') return { name, dir, complete: true, info };
  } catch {
    /* нет или битый installed.json — каталог неполный */
  }
  return { name, dir, complete: false, started: 0 };
}

/** Слоты пакета и активный из них: завершённый с наибольшим installedAt. */
async function slotsOf(models, id) {
  const slots = (await Promise.all(slotNames(id).map((n) => readSlot(models, n)))).filter(Boolean);
  const at = (s) => Number(s.info.installedAt) || 0;
  const active = slots.filter((s) => s.complete).sort((a, b) => at(b) - at(a))[0] || null;
  return { slots, active };
}

const isStale = (slot) => !slot.complete && Date.now() - slot.started > STALE_INSTALL_MS;

/**
 * Установленные пакеты (обычно один). Брошенные установки и устаревшие слоты удаляются.
 * @returns {Promise<{id: string, version: string, name: {ru: string, en: string}, languages: string[], bytes: number,
 *   installedAt: number, verified: boolean, packSha256: string, manifest: import('../core/ner/pack.js').PackManifest}[]>}
 */
export async function listInstalled() {
  const models = await modelsDir(false);
  if (!models) return [];
  const out = [];
  try {
    const ids = new Set();
    for await (const [name, handle] of /** @type {any} */ (models).entries()) {
      const id = handle.kind === 'directory' ? slotOwner(name) : null;
      if (id) ids.add(id);
    }
    for (const id of ids) {
      const { slots, active } = await slotsOf(models, id);
      // не трогаем активный слот и свежую незавершённую установку (она может идти прямо сейчас в другой вкладке)
      for (const s of slots) if (s !== active && (s.complete ? !!active : isStale(s))) await removeDir(models, s.name).catch(() => {});
      if (!active) continue;
      try {
        const parsed = parsePackManifest(await readText(active.dir, PACK_MANIFEST));
        if (!parsed.ok || parsed.manifest.id !== id) continue;
        out.push({ ...active.info, id, manifest: parsed.manifest });
      } catch {
        /* неполный каталог — не установлен */
      }
    }
  } catch (e) {
    throw ioError(e);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Отказ разбора zip изнутри filter: unzipSync прерывается, код уходит наружу как ModelStoreError. */
class ZipReject extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/**
 * Распаковка и проверка пакета: zip → pack.json → хеши файлов. Ничего не записывает.
 * Записи zip кладутся в Map: в обычном объекте запись `__proto__` пропала бы, а имена свойств прототипа нашлись бы
 * «сами собой». Повторяющиеся имена записей и зарезервированные имена (pack.js, RESERVED_PACK_PATHS) отвергаются.
 * @param {Uint8Array} bytes  zip-файл пакета
 * @param {{extensionVersion?: string}} [opts]
 */
async function unpack(bytes, opts = {}) {
  if (!(bytes instanceof Uint8Array)) throw new ModelStoreError('BAD_ZIP', 'Файл не является zip-архивом пакета');
  if (bytes.length > MAX_PACK_BYTES) throw new ModelStoreError('TOO_LARGE', 'Пакет больше допустимого размера');
  const names = new Set();
  let raw;
  try {
    let total = 0;
    raw = unzipSync(bytes, {
      filter: (f) => {
        if (f.name.endsWith('/')) return false;
        if (names.has(f.name)) throw new ZipReject('BAD_MANIFEST', `Запись повторяется: ${f.name}`, { path: f.name, reason: 'DUPLICATE_ENTRY' });
        if (f.name !== PACK_MANIFEST && isReservedPackPath(f.name)) {
          throw new ZipReject('BAD_MANIFEST', `Файл пакета не совпадает с манифестом: ${f.name}`, { path: f.name, reason: 'EXTRA_FILE' });
        }
        names.add(f.name);
        total += f.originalSize;
        if (total > MAX_PACK_BYTES) throw new ZipReject('TOO_LARGE', 'Распакованный пакет больше допустимого размера');
        return true;
      },
    });
  } catch (e) {
    if (e instanceof ZipReject) throw new ModelStoreError(e.code, e.message, e.details);
    throw new ModelStoreError('BAD_ZIP', 'Файл не является zip-архивом пакета');
  }
  /** @type {Map<string, Uint8Array>} */
  const entries = new Map();
  for (const n of names) if (Object.hasOwn(raw, n)) entries.set(n, raw[n]);
  if (!entries.has(PACK_MANIFEST)) throw new ModelStoreError('BAD_MANIFEST', 'В пакете нет pack.json');
  const parsed = parsePackManifest(entries.get(PACK_MANIFEST), opts);
  if (!parsed.ok) {
    if (parsed.error === 'minExtensionVersion') throw new ModelStoreError('INCOMPATIBLE', 'Пакет требует более новую версию расширения');
    throw new ModelStoreError('BAD_MANIFEST', `Неверное поле pack.json: ${parsed.error}`, { field: parsed.error });
  }
  const v = await verifyPackFiles(parsed.manifest, entries);
  if (!v.ok) {
    if (v.error === 'VERIFY_FAILED') throw new ModelStoreError('IO', `Не удалось проверить файл пакета: ${v.path}`, { path: v.path, reason: v.error });
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
 * Установка: пакет проверяется заново (хеши) и пишется в неактивный слот; прежняя версия того же id удаляется только
 * после того, как новая записана целиком (см. раскладку в начале файла). Сбой записи — ошибка, прежняя версия цела.
 * Признак «проверен» вычисляется по KNOWN_PACKS; opts.verified учитывается только как подсказка UI и не может его поднять.
 * @param {Uint8Array} bytes
 * @param {{verified?: boolean, extensionVersion?: string}} [opts]
 */
export async function install(bytes, opts = {}) {
  const { manifest, entries, packSha256, verified } = await unpack(bytes, opts);
  const models = await modelsDir(true);
  const id = manifest.id;
  let prev;
  let target;
  try {
    ({ active: prev } = await slotsOf(models, id));
    // целевой слот не активен: в нём брошенная установка или устаревшая версия — очищаем
    target = slotNames(id).find((n) => n !== prev?.name);
    await removeDir(models, target);
  } catch (e) {
    throw ioError(e);
  }
  // installedAt новой версии строго больше прежней — даже если часы ушли назад, активным станет новый слот
  const installedAt = Math.max(Date.now(), (Number(prev?.info.installedAt) || 0) + 1);
  const record = {
    id,
    version: manifest.version,
    name: manifest.name,
    languages: manifest.languages,
    bytes: sumSize(manifest),
    installedAt,
    verified: verified,
    packSha256,
  };
  try {
    const dir = await models.getDirectoryHandle(target, { create: true });
    await writeFile(dir, INSTALLING, new TextEncoder().encode(String(Date.now())));
    await writeFile(dir, PACK_MANIFEST, entries.get(PACK_MANIFEST));
    for (const f of manifest.files) await writeFile(dir, f.path, entries.get(f.path));
    await writeFile(dir, INSTALLED, new TextEncoder().encode(JSON.stringify(record)));
    await dir.removeEntry(INSTALLING); // переключение: с этого момента активен новый слот
  } catch (e) {
    await removeDir(models, target).catch(() => {}); // не удалось — останется маркер, слот не активен; дочистит listInstalled
    throw ioError(e);
  }
  // прежняя версия больше не нужна; сбой удаления — не ошибка установки (устаревший слот дочистит listInstalled)
  if (prev) await removeDir(models, prev.name).catch(() => {});
  return { ...record, manifest };
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

/** Удаляет пакет (оба слота); отсутствующий — не ошибка. */
export async function remove(id) {
  checkId(id);
  const models = await modelsDir(false);
  if (!models) return;
  try {
    for (const n of slotNames(id)) await removeDir(models, n);
  } catch (e) {
    throw ioError(e);
  }
}

function checkId(id) {
  if (typeof id !== 'string' || !PACK_ID_RE.test(id)) throw new ModelStoreError('NOT_INSTALLED', 'Неверный id пакета');
}

/**
 * Файл установленного пакета (из активного слота).
 * @param {string} id
 * @param {string} path  имя файла из манифеста или pack.json — без '/' и '..'
 * @returns {Promise<Uint8Array>}
 */
export async function readFile(id, path) {
  checkId(id);
  if (typeof path !== 'string' || !PACK_PATH_RE.test(path) || path === INSTALLING) throw new ModelStoreError('IO', 'Недопустимое имя файла');
  const models = await modelsDir(false);
  if (!models) throw new ModelStoreError('NOT_INSTALLED', 'Пакет не установлен');
  let slots, active;
  try {
    ({ slots, active } = await slotsOf(models, id));
  } catch (e) {
    throw ioError(e);
  }
  if (!active) throw new ModelStoreError('NOT_INSTALLED', slots.length ? 'Пакет ещё устанавливается' : 'Пакет не установлен');
  try {
    const f = await (await active.dir.getFileHandle(path)).getFile();
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
