// Извлечение PDF (версия 0.3, К5) на заглушке pdf.js: коды отказов, предупреждение о страницах без текста, прогресс,
// сигнатура. Настоящий pdf.js — в tests/integration/pdf-*.spec.js.
import { describe, it, expect } from 'vitest';
import { extractPdf, isPdf, lettersOnPage, mapPdfError, BASE_DOC_OPTIONS } from '../../../src/core/pdf/extract.js';
import { CoreError } from '../../../src/core/errors.js';

const TEXT = 'Договор поставки между ООО «Ромашка» и АО «Вектор-М» о поставке товара.';

/** Заглушка pdf.js: страницы — массив строк (пустая строка — страница без текста) или ошибка открытия. */
function stubPdfjs({ pages = [TEXT], openError = null, fonts = {} } = {}) {
  const calls = { getDocument: null, destroyed: 0, operatorLists: 0 };
  const pdfjs = {
    AnnotationMode: { DISABLE: 0 },
    VerbosityLevel: { ERRORS: 0 },
    getDocument(opts) {
      calls.getDocument = opts;
      const promise = openError
        ? Promise.reject(openError)
        : Promise.resolve({
            numPages: pages.length,
            async getPage(i) {
              const str = pages[i - 1];
              return {
                view: [0, 0, 595, 842],
                async getTextContent() {
                  return {
                    items: str ? [{ str, transform: [12, 0, 0, 12, 50, 742], width: str.length * 6, height: 12, fontName: 'f1', hasEOL: false }] : [],
                    styles: { f1: {} },
                  };
                },
                async getOperatorList() {
                  calls.operatorLists++;
                },
                commonObjs: { has: (n) => n in fonts, get: (n) => fonts[n] },
                cleanup() {},
              };
            },
          });
      return { promise, destroy: async () => void calls.destroyed++ };
    },
  };
  return { pdfjs, calls };
}

const named = (name, extra = {}) => Object.assign(new Error('internal pdf.js message'), { name, ...extra });

describe('isPdf / lettersOnPage', () => {
  const enc = (s) => new TextEncoder().encode(s);
  it('сигнатура %PDF- в первых 1024 байтах, в том числе после мусора', () => {
    expect(isPdf(enc('%PDF-1.7\n...'))).toBe(true);
    expect(isPdf(enc(`${'x'.repeat(900)}%PDF-1.4`))).toBe(true);
    expect(isPdf(enc(`${'x'.repeat(1100)}%PDF-1.4`))).toBe(false);
    expect(isPdf(enc('PK\u0003\u0004 docx'))).toBe(false);
    expect(isPdf(enc('%PDF'))).toBe(false);
    expect(isPdf(new Uint8Array(0))).toBe(false);
  });
  it('буквы считаются по \\p{L}', () => {
    expect(lettersOnPage([{ str: 'ИНН 7736050003' }, { str: 'abc' }])).toBe(6);
    expect(lettersOnPage([])).toBe(0);
  });
});

describe('extractPdf: коды и предупреждения', () => {
  it('текстовый PDF → блоки, опции getDocument без сети и шрифтов в DOM, копия байтов, destroy', async () => {
    const { pdfjs, calls } = stubPdfjs({ fonts: { f1: { name: 'AAAAAA+Times-Bold' } } });
    const bytes = new Uint8Array([1, 2, 3]);
    const progress = [];
    const L = await extractPdf(pdfjs, bytes, { onProgress: (p) => progress.push(p), docOptions: { cMapUrl: '/c/' } });
    expect(L.blocks.map((b) => b.text)).toEqual([TEXT]);
    expect(L.blocks[0].kind).toBe('h2'); // жирный по имени шрифта, короткий абзац
    expect(L.pages).toBe(1);
    expect(L.warnings).toEqual([]);
    expect(progress).toEqual([100]);
    expect(calls.getDocument).toMatchObject({ ...BASE_DOC_OPTIONS, cMapUrl: '/c/' });
    expect(calls.getDocument.data).not.toBe(bytes);
    expect([...calls.getDocument.data]).toEqual([1, 2, 3]);
    expect(calls.destroyed).toBe(1);
    expect(calls.operatorLists).toBe(1);
  });

  it('PasswordException → PDF_ENCRYPTED (код 1 и 2)', async () => {
    for (const [code, reason] of [
      [1, 'NEED_PASSWORD'],
      [2, 'INCORRECT_PASSWORD'],
    ]) {
      const { pdfjs, calls } = stubPdfjs({ openError: named('PasswordException', { code }) });
      const err = await extractPdf(pdfjs, new Uint8Array(1)).catch((e) => e);
      expect(err).toBeInstanceOf(CoreError);
      expect(err.code).toBe('PDF_ENCRYPTED');
      expect(err.details).toEqual({ reason });
      expect(calls.destroyed).toBe(1);
    }
  });

  it('InvalidPDFException, FormatError, UnknownErrorException → PDF_INVALID без текста pdf.js', async () => {
    for (const name of ['InvalidPDFException', 'FormatError', 'UnknownErrorException']) {
      const { pdfjs } = stubPdfjs({ openError: named(name) });
      const err = await extractPdf(pdfjs, new Uint8Array(1)).catch((e) => e);
      expect(err.code).toBe('PDF_INVALID');
      expect(err.message).not.toContain('internal');
    }
    expect(mapPdfError(new TypeError('x')).code).toBe('INTERNAL');
  });

  it('нет страниц → PDF_EMPTY; больше maxPages → TOO_LARGE {pages}', async () => {
    let err = await extractPdf(stubPdfjs({ pages: [] }).pdfjs, new Uint8Array(1)).catch((e) => e);
    expect(err.code).toBe('PDF_EMPTY');
    err = await extractPdf(stubPdfjs({ pages: [TEXT, TEXT, TEXT] }).pdfjs, new Uint8Array(1), { maxPages: 2 }).catch((e) => e);
    expect(err.code).toBe('TOO_LARGE');
    expect(err.details).toMatchObject({ pages: 3, limitPages: 2 });
  });

  it('ни на одной странице нет 20 букв → PDF_NO_TEXT', async () => {
    const err = await extractPdf(stubPdfjs({ pages: ['', '12 34', 'стр. 3'] }).pdfjs, new Uint8Array(1)).catch((e) => e);
    expect(err.code).toBe('PDF_NO_TEXT');
    expect(err.details).toEqual({ pages: 3 });
  });

  it('часть страниц без текста → PDF_PAGES_NO_TEXT {pages: [2, 5]}, прогресс по страницам', async () => {
    const progress = [];
    const L = await extractPdf(stubPdfjs({ pages: [TEXT, '', TEXT, TEXT, ' '] }).pdfjs, new Uint8Array(1), { onProgress: (p) => progress.push(p) });
    expect(L.warnings).toEqual([{ code: 'PDF_PAGES_NO_TEXT', count: 2, details: { pages: [2, 5] } }]);
    expect(progress).toEqual([20, 40, 60, 80, 100]);
    expect(L.pages).toBe(5);
  });
});
