// SHA-256 в hex (WebCrypto: есть в браузере — window и worker — и в Node 22). Используется протоколом (§3.6: повторная
// загрузка того же файла) и проверкой пакетов модели NER (WP8, К5).

/**
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {Promise<string>} 64 hex-символа в нижнем регистре
 */
export async function sha256Hex(bytes) {
  const d = await globalThis.crypto.subtle.digest('SHA-256', /** @type {any} */ (bytes));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
