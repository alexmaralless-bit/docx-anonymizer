// Точка регистрации всех детекторов. Файл НЕ редактируется рабочими пакетами:
// каждый пакет регистрирует свои детекторы в своём index.js.
import { registerDetector, registerDocumentDetector } from '../contracts/detector.js';
import { register as registerIdentifiers } from './identifiers/index.js'; // WP1
import { register as registerNames } from './names/index.js'; // WP2
import { register as registerCustom } from './custom/index.js'; // WP4

let done = false;

/** Регистрирует встроенные детекторы один раз на процесс (воркер, тест). */
export function registerBuiltinDetectors() {
  if (done) return;
  done = true;
  const api = { registerDetector, registerDocumentDetector };
  registerIdentifiers(api);
  registerNames(api);
  registerCustom(api);
}
