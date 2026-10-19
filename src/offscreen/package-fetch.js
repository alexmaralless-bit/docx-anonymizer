// Чтение файла из СОБСТВЕННОГО пакета расширения (WP10-C, Ц7): zip встроенной модели NER лежит в архиве расширения
// (models/<file>, scripts/build.mjs --with-model) и ставится в OPFS модульным воркером offscreen-документа.
//
// Единственный `fetch` в src/ (сторож — tests/unit/bundled-model.spec.js; override ESLint — eslint.config.js, ровно на этот файл).
// NFR-01 не нарушается: запрос не уходит в сеть — разрешены только адреса chrome-extension:// того же origin, что и воркер
// (файлы, уже установленные вместе с расширением); http(s), data:, blob: и чужие расширения отклоняются до вызова fetch.
// CSP extension_pages (connect-src 'self') дублирует это ограничение на стороне браузера.
import { ModelStoreError } from '../shared/model-store.js';

/**
 * @param {string} url  chrome-extension://<этот id>/models/<file>
 * @returns {Promise<Uint8Array>}
 */
export async function readPackageFile(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new ModelStoreError('IO', 'Неверный адрес файла пакета расширения');
  }
  // origin сравнивается как протокол + хост: URL.origin для chrome-extension: в Node — 'null' (схема «не особая»), в Chrome — сам origin
  const loc = globalThis.self?.location;
  if (u.protocol !== 'chrome-extension:' || !loc || loc.protocol !== 'chrome-extension:' || !u.host || u.host !== loc.host) {
    throw new ModelStoreError('IO', 'Файл должен лежать в пакете расширения');
  }
  let res;
  try {
    res = await fetch(u.href);
  } catch {
    throw new ModelStoreError('IO', 'Файл пакета расширения не найден');
  }
  if (!res.ok) throw new ModelStoreError('IO', 'Файл пакета расширения не найден');
  return new Uint8Array(await res.arrayBuffer());
}
