// pdf.js в Node для тестов PDF (версия 0.3, спайк S4): legacy-сборка pdfjs-dist (та же, что вендорится в vendor/pdfjs/),
// CMaps и стандартные шрифты — путями файловой системы (в Node pdf.js читает их через fs, без fetch и сети).
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractPdf } from '../../../src/core/pdf/extract.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const PDFJS_DIR = join(root, 'node_modules/pdfjs-dist');

let pdfjsP;
/** Модуль pdf.js (legacy: в Node 22 нет Promise.try и других API, которые нужны современной сборке). */
export function loadPdfjs() {
  pdfjsP ||= import(join(PDFJS_DIR, 'legacy/build/pdf.mjs'));
  return pdfjsP;
}

/** Опции getDocument для Node: данные pdf.js из node_modules. */
export const NODE_DOC_OPTIONS = Object.freeze({
  cMapUrl: join(PDFJS_DIR, 'cmaps') + '/',
  cMapPacked: true,
  standardFontDataUrl: join(PDFJS_DIR, 'standard_fonts') + '/',
});

/**
 * Извлечение PDF в Node тем же ядром, что и в воркере.
 * @param {Uint8Array} bytes
 * @param {object} [opts] опции extractPdf
 */
export async function extractPdfNode(bytes, opts = {}) {
  const pdfjs = await loadPdfjs();
  return extractPdf(pdfjs, bytes, { ...opts, docOptions: { ...NODE_DOC_OPTIONS, ...(opts.docOptions || {}) } });
}
