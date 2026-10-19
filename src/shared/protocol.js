// КОНТРАКТ: протокол сообщений (ТЗ §5.4) + маленький транспорт.
// Без chrome.* — работает с любым «портом» вида { postMessage(msg), onMessage.addListener(fn),
// onDisconnect?.addListener(fn) } (chrome.runtime.Port, MessagePort-адаптер, фейк в тестах).

export const PORT_NAME = 'docx';
/** Чанк base64: 4 МиБ символов (кратно 4 — каждый чанк декодируется отдельно). */
export const CHUNK_CHARS = 4 * 1024 * 1024;

export const MSG = Object.freeze({
  // client → bg
  FILE_BEGIN: 'FILE_BEGIN',
  FILE_CHUNK: 'FILE_CHUNK',
  ANALYZE: 'ANALYZE',
  GET_TEXT: 'GET_TEXT',
  ADD_ENTITY: 'ADD_ENTITY',
  APPLY: 'APPLY',
  CANCEL: 'CANCEL',
  DISCARD: 'DISCARD',
  LIST_SESSIONS: 'LIST_SESSIONS',
  /** {mappingRef, text, decline?} — decline: склонять ФИО по контексту (FR-37); ответ DEANON_RESULT {…, declined?} */
  DEANON: 'DEANON',
  /** {docId} — карта замен сессии для восстановления файла на странице (WP10-B, FR-36а); ответ MAPPING {docId, mapping} */
  GET_MAPPING: 'GET_MAPPING',
  BATCH_BEGIN: 'BATCH_BEGIN',
  BATCH_ADD: 'BATCH_ADD',
  BATCH_END: 'BATCH_END',
  BATCH_APPLY: 'BATCH_APPLY',
  CATALOG_CHANGED: 'CATALOG_CHANGED',
  /** {modelId?} — пакет модели NER установлен/удалён (WP8): хост сбрасывает кэш провайдера; ответ ACK */
  MODEL_CHANGED: 'MODEL_CHANGED',
  /** {} — поставить встроенный пакет модели заново (WP10-C, кнопка «Восстановить встроенную модель»): background отвечает ACK сразу */
  MODEL_BOOTSTRAP: 'MODEL_BOOTSTRAP',
  // bg → offscreen (clientId 'bootstrap', не порт клиента; WP10-C, docs/contracts.md §6.8)
  /** {url, id, sha256, version, extensionVersion} — установить пакет из архива расширения; ответ MODEL_INSTALLED */
  MODEL_INSTALL: 'MODEL_INSTALL',
  /** {status: 'installed'|'present'|'failed', id, sha256, version?, bytes?, ms?, code?} — итог MODEL_INSTALL */
  MODEL_INSTALLED: 'MODEL_INSTALLED',
  // bg → client
  PROGRESS: 'PROGRESS',
  ENTITIES: 'ENTITIES',
  TEXT: 'TEXT',
  RESULT_BEGIN: 'RESULT_BEGIN',
  RESULT_CHUNK: 'RESULT_CHUNK',
  RESULT_END: 'RESULT_END',
  ERROR: 'ERROR',
  SESSIONS: 'SESSIONS',
  DEANON_RESULT: 'DEANON_RESULT',
  MAPPING: 'MAPPING',
  BATCH_DONE: 'BATCH_DONE',
  /** Расширение протокола: подтверждение для DISCARD/CANCEL/CATALOG_CHANGED/MODEL_CHANGED/MODEL_BOOTSTRAP/BATCH_* без данных. */
  ACK: 'ACK',
});

// 'pdf' — извлечение текста PDF (версия 0.3)
export const STAGES = Object.freeze(['receiving', 'unzip', 'parse', 'pdf', 'detect', 'ner', 'kb', 'apply', 'zip', 'sending']);

export const ERROR_CODES = Object.freeze([
  'NOT_DOCX',
  'ENCRYPTED',
  'TOO_LARGE',
  'PARSE_FAILED',
  'HOST_UNAVAILABLE',
  'MODEL_LOAD_FAILED',
  // PDF (версия 0.3, К5)
  'PDF_INVALID',
  'PDF_ENCRYPTED',
  'PDF_EMPTY',
  'PDF_NO_TEXT',
  'INTERNAL',
]);

/** Сообщения, завершающие запрос (на них резолвится client.request). */
export const TERMINAL = Object.freeze(
  new Set(['ENTITIES', 'TEXT', 'RESULT_END', 'SESSIONS', 'DEANON_RESULT', 'MAPPING', 'MODEL_INSTALLED', 'BATCH_DONE', 'ACK', 'ERROR']),
);

/** Ключи runtime.sendMessage между background и offscreen. */
export const TARGET = Object.freeze({ OFFSCREEN: 'offscreen', BACKGROUND: 'background' });

/** Ошибка протокола на стороне клиента. */
export class ProtocolError extends Error {
  /** @param {string} code @param {string} message @param {any} [details] */
  constructor(code, message, details) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.details = details;
  }
}

let reqCounter = 0;
export function makeRequestId(prefix = 'r') {
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${prefix}${Date.now().toString(36)}${(reqCounter++).toString(36)}${rnd}`;
}

/* ---------- base64 ---------- */

/**
 * Uint8Array → base64 без посимвольной конкатенации (дефект 7).
 * @param {Uint8Array} bytes
 */
export function bytesToBase64(bytes) {
  // @ts-ignore — Chrome 140+ / будущие Node
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  const parts = [];
  const STEP = 0x8000; // лимит аргументов String.fromCharCode.apply
  // Блок кратен 3 байтам — base64 блоков склеивается без паддинга посередине
  const BLOCK = 3 * 0x4000;
  for (let i = 0; i < bytes.length; i += BLOCK) {
    const sub = bytes.subarray(i, Math.min(i + BLOCK, bytes.length));
    let bin = '';
    for (let j = 0; j < sub.length; j += STEP) bin += String.fromCharCode.apply(null, /** @type {any} */ (sub.subarray(j, j + STEP)));
    parts.push(btoa(bin));
  }
  return parts.join('');
}

/**
 * base64 → Uint8Array. Пишет в target по смещению, если задан (сборка чанков в буфер фиксированного размера).
 * @param {string} b64
 * @param {Uint8Array} [target]
 * @param {number} [offset=0]
 * @returns {number|Uint8Array} при target — число записанных байт, иначе новый массив
 */
export function base64ToBytes(b64, target, offset = 0) {
  const bin = atob(b64);
  const out = target || new Uint8Array(bin.length);
  const base = target ? offset : 0;
  if (base + bin.length > out.length) throw new ProtocolError('INTERNAL', 'Данные больше объявленного размера');
  for (let i = 0; i < bin.length; i++) out[base + i] = bin.charCodeAt(i);
  return target ? bin.length : out;
}

/** Делит base64-строку на чанки по CHUNK_CHARS (кратно 4). */
export function splitBase64(b64, chunkChars = CHUNK_CHARS) {
  if (chunkChars % 4) throw new Error('Размер чанка должен быть кратен 4');
  const out = [];
  for (let i = 0; i < b64.length; i += chunkChars) out.push(b64.slice(i, i + chunkChars));
  return out.length ? out : [''];
}

/** Из data URL (FileReader.readAsDataURL) — чистый base64. */
export function dataUrlToBase64(dataUrl) {
  const i = dataUrl.indexOf(',');
  return i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
}

/** SHA-256 в hex — живёт в ядре (src/core/hash.js), здесь реэкспорт для прежних импортов. */
export { sha256Hex } from '../core/hash.js';

/* ---------- приём чанков ---------- */

/**
 * Собирает файл из FILE_BEGIN + FILE_CHUNK* (или RESULT_BEGIN + RESULT_CHUNK*).
 * Буфер фиксированного размера, без промежуточных строк.
 */
export class ChunkAssembler {
  /** @param {{size: number, chunks: number}} begin */
  constructor(begin) {
    if (!Number.isInteger(begin.size) || begin.size < 0) throw new ProtocolError('INTERNAL', 'Некорректный размер');
    this.size = begin.size;
    this.expected = begin.chunks;
    this.buf = new Uint8Array(begin.size);
    this.received = 0;
    this.written = 0;
    this.seen = new Set();
  }
  /** @param {number} index @param {string} data base64 */
  add(index, data) {
    if (this.seen.has(index)) throw new ProtocolError('INTERNAL', `Повторный чанк ${index}`);
    if (index < 0 || index >= this.expected) throw new ProtocolError('INTERNAL', `Чанк вне диапазона ${index}`);
    // Все чанки, кроме последнего, имеют длину CHUNK_CHARS → смещение вычисляется по индексу
    const offset = index * (CHUNK_CHARS / 4) * 3;
    this.written += /** @type {number} */ (base64ToBytes(data, this.buf, offset));
    this.seen.add(index);
    this.received++;
  }
  get complete() {
    return this.received === this.expected;
  }
  /** @returns {Uint8Array} */
  result() {
    if (!this.complete) throw new ProtocolError('INTERNAL', 'Файл получен не полностью');
    if (this.written !== this.size) throw new ProtocolError('INTERNAL', 'Размер не совпадает с объявленным');
    return this.buf;
  }
}

/* ---------- отправка байтов ---------- */

/**
 * Отправляет байты чанками: BEGIN, CHUNK…, затем вызывающий шлёт команду (ANALYZE) или END.
 * @param {(msg: object) => void} post
 * @param {{requestId: string, kind: 'FILE'|'RESULT', bytes?: Uint8Array, base64?: string, meta?: object}} p
 * @returns {number} число чанков
 */
export function postChunked(post, p) {
  const b64 = p.base64 ?? bytesToBase64(/** @type {Uint8Array} */ (p.bytes));
  const size = p.bytes ? p.bytes.length : base64DecodedLength(b64);
  const chunks = splitBase64(b64);
  post({ type: `${p.kind}_BEGIN`, requestId: p.requestId, size, chunks: chunks.length, ...(p.meta || {}) });
  chunks.forEach((data, index) => post({ type: `${p.kind}_CHUNK`, requestId: p.requestId, index, data }));
  return chunks.length;
}

export function base64DecodedLength(b64) {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return (b64.length / 4) * 3 - pad;
}

/* ---------- клиент (content / popup / options / restore) ---------- */

/**
 * @typedef {object} PortLike
 * @property {(msg: any) => void} postMessage
 * @property {{addListener: (fn: (msg: any) => void) => void}} onMessage
 * @property {{addListener: (fn: () => void) => void}} [onDisconnect]
 */

/**
 * Клиент протокола поверх порта к background.
 * @param {PortLike} port
 */
export function createClient(port) {
  /** @type {Map<string, {resolve: Function, reject: Function, onProgress?: Function, onMessage?: Function, assembler?: ChunkAssembler, begin?: any}>} */
  const pending = new Map();
  let closed = false;

  port.onMessage.addListener((msg) => {
    if (!msg || !msg.requestId) return;
    const p = pending.get(msg.requestId);
    if (!p) return;
    p.onMessage?.(msg);
    switch (msg.type) {
      case MSG.PROGRESS:
        p.onProgress?.(msg.stage, msg.percent);
        return;
      case MSG.RESULT_BEGIN:
        p.begin = msg;
        p.assembler = new ChunkAssembler(msg);
        return;
      case MSG.RESULT_CHUNK:
        try {
          p.assembler?.add(msg.index, msg.data);
        } catch (err) {
          pending.delete(msg.requestId);
          p.reject(err);
        }
        return;
      case MSG.ERROR:
        pending.delete(msg.requestId);
        p.reject(new ProtocolError(msg.code, msg.message, msg.details));
        return;
      case MSG.RESULT_END:
        pending.delete(msg.requestId);
        try {
          const bytes = /** @type {ChunkAssembler} */ (p.assembler).result();
          // mime — тип результата (версия 0.3: text/markdown, text/plain для PDF; MIME .docx для DOCX)
          p.resolve({ ...msg, name: p.begin.name, mime: p.begin.mime, bytes });
        } catch (err) {
          p.reject(err);
        }
        return;
      default:
        if (TERMINAL.has(msg.type)) {
          pending.delete(msg.requestId);
          p.resolve(msg);
        }
    }
  });
  port.onDisconnect?.addListener(() => {
    closed = true;
    for (const [, p] of pending) p.reject(new ProtocolError('HOST_UNAVAILABLE', 'Соединение с расширением потеряно'));
    pending.clear();
  });

  /**
   * Отправляет сообщение и ждёт терминальный ответ с тем же requestId.
   * @param {string} type
   * @param {object} [payload]
   * @param {{requestId?: string, onProgress?: (stage: string, percent: number) => void, onMessage?: (msg: any) => void}} [opts]
   */
  function request(type, payload = {}, opts = {}) {
    if (closed) return Promise.reject(new ProtocolError('HOST_UNAVAILABLE', 'Соединение закрыто'));
    const requestId = opts.requestId || makeRequestId();
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject, onProgress: opts.onProgress, onMessage: opts.onMessage });
      port.postMessage({ type, requestId, ...payload });
    });
  }

  return {
    request,
    /**
     * Передаёт файл и запускает анализ. Ответ — сообщение ENTITIES.
     * @param {{name: string, bytes?: Uint8Array, base64?: string, size?: number, sha256?: string, origin?: string, settingsOverride?: object, batchId?: string,
     *          onProgress?: (stage: string, percent: number) => void}} f
     */
    analyzeFile(f) {
      if (closed) return Promise.reject(new ProtocolError('HOST_UNAVAILABLE', 'Соединение закрыто'));
      const requestId = makeRequestId();
      const promise = new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject, onProgress: f.onProgress });
      });
      postChunked((m) => port.postMessage(m), {
        requestId,
        kind: 'FILE',
        bytes: f.bytes,
        base64: f.base64,
        meta: { name: f.name, sha256: f.sha256 || null, origin: f.origin || null },
      });
      port.postMessage({ type: MSG.ANALYZE, requestId, settingsOverride: f.settingsOverride, batchId: f.batchId });
      return promise;
    },
    /**
     * Применяет решения. Ответ — {name, mime, bytes, mapping, size, ...RESULT_END}.
     * @param {{docId: string, mode?: string, decisions?: object[], options?: object, onProgress?: Function}} a
     */
    apply(a) {
      const { onProgress, ...payload } = a;
      return request(MSG.APPLY, payload, { onProgress: /** @type {any} */ (onProgress) });
    },
    cancel(requestId) {
      port.postMessage({ type: MSG.CANCEL, requestId });
    },
    get pendingCount() {
      return pending.size;
    },
  };
}

/** Сериализуемое сообщение об ошибке для отправки клиенту (без текста документа). */
export function errorMessage(requestId, err) {
  const code = err && ERROR_CODES.includes(err.code) ? err.code : 'INTERNAL';
  return { type: MSG.ERROR, requestId, code, message: (err && err.message) || 'Внутренняя ошибка', details: err?.details };
}
