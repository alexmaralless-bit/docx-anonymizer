// Извлечение текста PDF (версия 0.3, Ц1, Ц4, К5; docs/concept-0.3.md «Как это устроено», п. 2, 5).
// Модуль pdf.js передаётся снаружи (`pdfjs`): в воркере offscreen — вендорная сборка из vendor/pdfjs/ (offscreen/pdf-loader.js),
// в Node-тестах — pdfjs-dist/legacy. Ядро не импортирует pdf.js, не знает про chrome.* и не делает сетевых запросов (NFR-01):
// откуда грузить CMaps и шрифты, решает вызывающий через `docOptions`.
// Тексты ошибок не содержат текста документа (NFR-14).
import { CoreError } from '../errors.js';
import { buildLayout, isUpright, mulTransform, orientPage, MONO_FONT_RE } from './layout.js';

/** Меньше стольких букв на странице — страница «без текста» (скан, картинка). */
export const MIN_LETTERS = 20;
/** Лимит страниц по умолчанию (TOO_LARGE с details.pages). */
export const MAX_PAGES = 1000;

/** Опции getDocument, общие для воркера и тестов: без шрифтов в DOM, без wasm-декодеров, без сети. */
export const BASE_DOC_OPTIONS = Object.freeze({
  disableFontFace: true,
  useSystemFonts: false,
  useWasm: false,
  stopAtErrors: false,
  isOffscreenCanvasSupported: false,
  isImageDecoderSupported: false,
  enableXfa: false,
  disableRange: true,
  disableStream: true,
  disableAutoFetch: true,
  // имя шрифта (`…-Bold`) приходит в commonObjs только с этим флагом — по нему определяется жирность заголовков
  fontExtraProperties: true,
});

const BOLD_FONT_RE = /bold|black|heavy|semibold|demi|[-,]bd\b|w[6-9]00/i;

/**
 * Сигнатура PDF: «%PDF-» в первых 1024 байтах (так проверяют и читатели PDF — перед заголовком бывает мусор).
 * @param {Uint8Array} bytes
 */
export function isPdf(bytes) {
  if (!bytes || bytes.length < 5) return false;
  const n = Math.min(bytes.length - 4, 1024);
  for (let i = 0; i < n; i++) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d) return true;
  }
  return false;
}

/**
 * Число букв (\p{L}) в текстовых элементах страницы.
 * @param {{str?: string}[]} items
 */
export function lettersOnPage(items) {
  let n = 0;
  for (const it of items || []) {
    const m = String(it.str || '').match(/\p{L}/gu);
    if (m) n += m.length;
  }
  return n;
}

/**
 * Пространство страницы для разметки: размеры видимой страницы (с учётом /Rotate) и матрица из пространства PDF
 * в «y вверх» этой страницы. Без getViewport (заглушки в тестах) — сдвиг на начало page.view.
 * @param {any} page страница pdf.js
 * @returns {{width: number, height: number, toPage: number[]}}
 */
export function pageSpace(page) {
  const [x0, y0, x1, y1] = page.view || [0, 0, 0, 0];
  const vp = typeof page.getViewport === 'function' ? page.getViewport({ scale: 1 }) : null;
  if (!vp?.transform) return { width: x1 - x0, height: y1 - y0, toPage: [1, 0, 0, 1, -x0, -y0] };
  return { width: vp.width, height: vp.height, toPage: mulTransform([1, 0, 0, -1, 0, vp.height], vp.transform) };
}

/**
 * Исключение pdf.js → CoreError с кодом протокола. Сообщения pdf.js в ответ не попадают.
 * @param {any} err
 */
export function mapPdfError(err) {
  if (err instanceof CoreError) return err;
  const name = String(err?.name || '');
  if (name === 'PasswordException') {
    return new CoreError('PDF_ENCRYPTED', 'PDF защищён паролем', { reason: err?.code === 2 ? 'INCORRECT_PASSWORD' : 'NEED_PASSWORD' });
  }
  if (/InvalidPDF|FormatError|UnknownError|MissingPDF/.test(name)) return new CoreError('PDF_INVALID', 'Файл повреждён или не является PDF');
  return new CoreError('INTERNAL', 'Не удалось прочитать PDF');
}

/**
 * Жирность шрифтов страницы. Имена шрифтов (`AAAAAA+TimesNewRoman-Bold`) приходят в commonObjs только после
 * разбора операторов страницы, поэтому для страниц с текстом вызывается getOperatorList (без аннотаций).
 * Сбой — не ошибка: шрифты просто неизвестны.
 */
async function pageFonts(pdfjs, page, styles) {
  /** @type {Record<string, {bold: boolean, name: string}>} */
  const fonts = {};
  try {
    await page.getOperatorList({ annotationMode: pdfjs.AnnotationMode?.DISABLE ?? 0 });
    for (const fn of Object.keys(styles || {})) {
      if (!page.commonObjs.has(fn)) continue;
      const f = page.commonObjs.get(fn);
      const name = String(f?.name || '');
      fonts[fn] = { name, bold: !!f?.bold || BOLD_FONT_RE.test(name), mono: !!f?.isMonospace || MONO_FONT_RE.test(name) };
    }
  } catch {
    /* шрифты неизвестны — заголовки определятся по кеглю */
  }
  return fonts;
}

/**
 * PDF → разметка (Layout). Коды: PDF_ENCRYPTED (пароль), PDF_INVALID (не PDF, повреждён), PDF_EMPTY (нет страниц),
 * PDF_NO_TEXT (ни на одной странице нет текстового слоя), TOO_LARGE {pages} (больше maxPages страниц).
 * Часть страниц без текста — предупреждение PDF_PAGES_NO_TEXT {details: {pages}} в layout.warnings.
 * @param {any} pdfjs   модуль pdf.js ({getDocument, AnnotationMode?, VerbosityLevel?})
 * @param {Uint8Array} bytes
 * @param {{password?: string, maxPages?: number, onProgress?: (percent: number) => void, docOptions?: object, fonts?: boolean}} [opts]
 * @returns {Promise<import('./layout.js').Layout>}
 */
export async function extractPdf(pdfjs, bytes, opts = {}) {
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const task = pdfjs.getDocument({
    ...BASE_DOC_OPTIONS,
    ...(opts.docOptions || {}),
    // копия: pdf.js передаёт буфер в свой воркер (transfer), исходные байты нужны хосту
    data: bytes.slice(),
    ...(opts.password ? { password: opts.password } : {}),
    verbosity: pdfjs.VerbosityLevel?.ERRORS ?? 0,
  });
  try {
    let doc;
    try {
      doc = await task.promise;
    } catch (err) {
      throw mapPdfError(err);
    }
    const n = doc.numPages;
    if (!n) throw new CoreError('PDF_EMPTY', 'В PDF нет страниц');
    if (n > maxPages) throw new CoreError('TOO_LARGE', `В PDF больше ${maxPages} страниц`, { pages: n, limitPages: maxPages });
    /** @type {import('./layout.js').PageItems[]} */
    const pages = [];
    const noText = [];
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      // Экранные координаты: матрица viewport учитывает /Rotate и смещение MediaBox/CropBox (y вниз) — переводим её
      // обратно в «y вверх» размера видимой страницы. Без /Rotate это прежний сдвиг на начало view.
      const { width, height, toPage } = pageSpace(page);
      const tc = await page.getTextContent({ includeMarkedContent: false });
      const items = [];
      for (const it of tc.items) {
        if (!it || typeof it.str !== 'string') continue;
        items.push({
          str: it.str,
          transform: mulTransform(toPage, it.transform || [1, 0, 0, 1, 0, 0]),
          width: it.width,
          height: it.height,
          fontName: it.fontName,
          hasEOL: it.hasEOL,
        });
      }
      // повёрнутое содержимое (матрица cm) — к преобладающей ориентации текста; «без текста» — по буквам, которые
      // разметка действительно возьмёт (не повёрнутые водяные знаки), иначе страница ушла бы пустой без предупреждения
      const oriented = orientPage({ page: i, width, height, items });
      const letters = lettersOnPage(oriented.items.filter((it) => isUpright(it.transform)));
      if (letters < MIN_LETTERS) noText.push(i);
      const fonts = letters >= MIN_LETTERS && opts.fonts !== false ? await pageFonts(pdfjs, page, tc.styles) : {};
      pages.push({ ...oriented, fonts });
      try {
        page.cleanup();
      } catch {
        /* освобождение ресурсов страницы не обязательно */
      }
      opts.onProgress?.(Math.round((i / n) * 100));
    }
    if (noText.length === n) throw new CoreError('PDF_NO_TEXT', 'В PDF нет текстового слоя — похоже, это скан', { pages: n });
    const layout = buildLayout(pages);
    if (noText.length) layout.warnings.push({ code: 'PDF_PAGES_NO_TEXT', count: noText.length, details: { pages: noText } });
    return layout;
  } catch (err) {
    throw mapPdfError(err);
  } finally {
    try {
      await task.destroy();
    } catch {
      /* документ уже закрыт */
    }
  }
}
