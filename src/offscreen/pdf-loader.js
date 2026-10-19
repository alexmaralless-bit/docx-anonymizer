// Загрузчик pdf.js для воркера ядра (версия 0.3, Ц5, К6, К7; docs/contracts.md §7).
// pdf.js не бандлится в worker.js (бюджет К15): вендорная legacy-сборка лежит в vendor/pdfjs/ пакета расширения и
// импортируется лениво при первом PDF. Свой воркер pdf.js — настоящий вложенный Worker (модуль vendor/pdfjs/pdf.worker.mjs),
// один на жизнь offscreen-документа; документ закрывается (loadingTask.destroy) после каждого файла.
// CMaps и стандартные шрифты pdf.js читает сам через fetch по chrome-extension:// (useWorkerFetch) — CSP connect-src 'self',
// ни одного http(s)-запроса (NFR-01). Пути строятся от import.meta.url: chrome.runtime.getURL в воркере нет.
import { extractPdf } from '../core/pdf/extract.js';

/**
 * @param {{vendorBase?: string, maxPages?: number}} [o] vendorBase — URL каталога vendor/pdfjs/ (со слешем в конце)
 * @returns {(bytes: Uint8Array, opts?: {onProgress?: (percent: number) => void, password?: string}) => Promise<import('../core/pdf/layout.js').Layout>}
 */
export function createPdfExtractor(o = {}) {
  const base = o.vendorBase || new URL('../vendor/pdfjs/', import.meta.url).href;
  /** @type {Promise<any> | null} */
  let pdfjsP = null;
  /** @type {any} */
  let pdfWorker = null;

  function load() {
    pdfjsP ||= import(/* webpackIgnore: true */ `${base}pdf.mjs`).then((m) => {
      m.GlobalWorkerOptions.workerSrc = `${base}pdf.worker.mjs`;
      return m;
    });
    // сбой загрузки не кэшируется: следующий PDF попробует снова
    pdfjsP.catch(() => (pdfjsP = null));
    return pdfjsP;
  }

  function workerFor(pdfjs) {
    if (pdfWorker && !pdfWorker.destroyed) return pdfWorker;
    // Порт — собственный модульный Worker: так pdf.js не проверяет window.location (его в воркере нет) и не уходит
    // в «fake worker», который повесил бы обработчик сообщений на self нашего воркера.
    const port = new Worker(`${base}pdf.worker.mjs`, { type: 'module', name: 'pdfjs' });
    pdfWorker = new pdfjs.PDFWorker({ port, verbosity: pdfjs.VerbosityLevel?.ERRORS ?? 0 });
    return pdfWorker;
  }

  return async (bytes, opts = {}) => {
    const pdfjs = await load();
    return extractPdf(pdfjs, bytes, {
      ...opts,
      maxPages: o.maxPages,
      docOptions: {
        worker: workerFor(pdfjs),
        useWorkerFetch: true,
        cMapUrl: `${base}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${base}standard_fonts/`,
      },
    });
  };
}
