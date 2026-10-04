// Минимальный ZIP-читатель/писатель для DOCX.
// Зачем свой: нетронутые части копируются сжатыми байтами как есть (ТЗ §6.3 п.7),
// а вывод детерминирован (FR-40): порядок как в исходнике, дата 1980-01-01, DEFLATE 6.
import { inflateSync, deflateSync } from 'fflate';
import { CoreError } from '../errors.js';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const DOS_DATE_1980 = 0x0021; // 1980-01-01
const DOS_TIME_0 = 0;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** @param {Uint8Array} data */
export function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * @typedef {object} ZipEntry
 * @property {string} name
 * @property {number} method 0 = stored, 8 = deflate
 * @property {number} flags
 * @property {number} crc
 * @property {number} compressedSize
 * @property {number} size
 * @property {Uint8Array} raw сжатые байты как в исходнике
 */

/**
 * Читает центральный каталог. Бросает CoreError NOT_DOCX/ENCRYPTED/PARSE_FAILED.
 * @param {Uint8Array} bytes
 * @returns {ZipEntry[]} в порядке центрального каталога
 */
export function readZip(bytes) {
  if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    throw new CoreError('ENCRYPTED', 'OLE-контейнер: зашифрованный .docx или .doc');
  }
  if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    throw new CoreError('NOT_DOCX', 'Файл не является ZIP-архивом');
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new CoreError('NOT_DOCX', 'Не найден конец ZIP-каталога');
  const count = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new CoreError('PARSE_FAILED', 'ZIP64 не поддерживается');
  const dec = new TextDecoder('utf-8');
  /** @type {ZipEntry[]} */
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== SIG_CENTRAL) {
      throw new CoreError('PARSE_FAILED', 'Повреждён центральный каталог ZIP');
    }
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (flags & 1) throw new CoreError('ENCRYPTED', 'Зашифрованная запись ZIP');
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new CoreError('PARSE_FAILED', 'ZIP64 не поддерживается');
    }
    if (method !== 0 && method !== 8) throw new CoreError('PARSE_FAILED', `Метод сжатия ${method} не поддерживается`);
    if (dv.getUint32(localOffset, true) !== SIG_LOCAL) throw new CoreError('PARSE_FAILED', 'Повреждён локальный заголовок ZIP');
    const lNameLen = dv.getUint16(localOffset + 26, true);
    const lExtraLen = dv.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);
    if (raw.length !== compressedSize) throw new CoreError('PARSE_FAILED', 'Обрезанный ZIP');
    entries.push({ name, method, flags, crc, compressedSize, size, raw });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** @param {ZipEntry} e @returns {Uint8Array} */
export function inflateEntry(e) {
  const out = e.method === 0 ? e.raw : inflateSync(e.raw, { out: new Uint8Array(e.size) });
  return out;
}

/**
 * @typedef {object} ZipOutEntry
 * @property {string} name
 * @property {ZipEntry} [source] исходная запись — копируется байт-в-байт
 * @property {Uint8Array} [data] новые несжатые данные — сжимаются DEFLATE 6
 */

/**
 * Детерминированная запись ZIP.
 * @param {ZipOutEntry[]} items
 * @returns {Uint8Array}
 */
export function writeZip(items) {
  const enc = new TextEncoder();
  const prepared = items.map((it) => {
    const nameBytes = enc.encode(it.name);
    const utf8 = /[^\x20-\x7e]/.test(it.name);
    if (it.source && !it.data) {
      const s = it.source;
      return { nameBytes, method: s.method, crc: s.crc, size: s.size, payload: s.raw, flags: (s.flags & 0x0800) | (utf8 ? 0x0800 : 0) };
    }
    const data = /** @type {Uint8Array} */ (it.data);
    const payload = deflateSync(data, { level: 6 });
    return { nameBytes, method: 8, crc: crc32(data), size: data.length, payload, flags: utf8 ? 0x0800 : 0 };
  });
  let total = 22;
  for (const e of prepared) total += 30 + e.nameBytes.length + e.payload.length + 46 + e.nameBytes.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let p = 0;
  const offsets = [];
  for (const e of prepared) {
    offsets.push(p);
    dv.setUint32(p, SIG_LOCAL, true);
    dv.setUint16(p + 4, 20, true);
    dv.setUint16(p + 6, e.flags, true);
    dv.setUint16(p + 8, e.method, true);
    dv.setUint16(p + 10, DOS_TIME_0, true);
    dv.setUint16(p + 12, DOS_DATE_1980, true);
    dv.setUint32(p + 14, e.crc, true);
    dv.setUint32(p + 18, e.payload.length, true);
    dv.setUint32(p + 22, e.size, true);
    dv.setUint16(p + 26, e.nameBytes.length, true);
    dv.setUint16(p + 28, 0, true);
    out.set(e.nameBytes, p + 30);
    p += 30 + e.nameBytes.length;
    out.set(e.payload, p);
    p += e.payload.length;
  }
  const cdStart = p;
  prepared.forEach((e, i) => {
    dv.setUint32(p, SIG_CENTRAL, true);
    dv.setUint16(p + 4, 20, true);
    dv.setUint16(p + 6, 20, true);
    dv.setUint16(p + 8, e.flags, true);
    dv.setUint16(p + 10, e.method, true);
    dv.setUint16(p + 12, DOS_TIME_0, true);
    dv.setUint16(p + 14, DOS_DATE_1980, true);
    dv.setUint32(p + 16, e.crc, true);
    dv.setUint32(p + 20, e.payload.length, true);
    dv.setUint32(p + 24, e.size, true);
    dv.setUint16(p + 28, e.nameBytes.length, true);
    // extra, comment, disk, internal attrs = 0
    dv.setUint32(p + 38, 0, true);
    dv.setUint32(p + 42, offsets[i], true);
    out.set(e.nameBytes, p + 46);
    p += 46 + e.nameBytes.length;
  });
  dv.setUint32(p, SIG_EOCD, true);
  dv.setUint16(p + 8, prepared.length, true);
  dv.setUint16(p + 10, prepared.length, true);
  dv.setUint32(p + 12, p - cdStart, true);
  dv.setUint32(p + 16, cdStart, true);
  return out;
}
