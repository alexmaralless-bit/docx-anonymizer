// Клиент regex-guard: запускает Worker, ждёт ответ ≤ 500 мс, иначе terminate() и отказ «слишком медленный».
import { GUARD_TIMEOUT_MS } from './regex-guard-core.js';

const START_TIMEOUT_MS = 3000;

/**
 * @param {string} regex
 * @param {string} flags
 * @returns {Promise<{ok: boolean, code?: string, message?: string, matches?: number}>}
 */
export function guardRegex(regex, flags = '') {
  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker('regex-guard.worker.js');
    } catch (err) {
      resolve({ ok: false, code: 'GUARD_UNAVAILABLE', message: String(err?.message || err) });
      return;
    }
    let timer = setTimeout(() => done({ ok: false, code: 'GUARD_UNAVAILABLE' }), START_TIMEOUT_MS); // Worker не стартовал
    const done = (r) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(r);
    };
    worker.onmessage = (e) => {
      if (e.data?.ready) {
        clearTimeout(timer);
        timer = setTimeout(() => done({ ok: false, code: 'TIMEOUT' }), GUARD_TIMEOUT_MS);
        worker.postMessage({ regex, flags });
      } else done(e.data);
    };
    worker.onerror = () => done({ ok: false, code: 'SYNTAX' });
  });
}
