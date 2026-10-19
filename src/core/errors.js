/** Коды ошибок совпадают с протоколом §5.4 (`ERROR.code`). */
export const ERROR_CODES = Object.freeze({
  NOT_DOCX: 'NOT_DOCX',
  ENCRYPTED: 'ENCRYPTED',
  TOO_LARGE: 'TOO_LARGE',
  PARSE_FAILED: 'PARSE_FAILED',
  HOST_UNAVAILABLE: 'HOST_UNAVAILABLE',
  MODEL_LOAD_FAILED: 'MODEL_LOAD_FAILED',
  // PDF (версия 0.3, К5): повреждён или не PDF, защищён паролем, без страниц, без текстового слоя (скан)
  PDF_INVALID: 'PDF_INVALID',
  PDF_ENCRYPTED: 'PDF_ENCRYPTED',
  PDF_EMPTY: 'PDF_EMPTY',
  PDF_NO_TEXT: 'PDF_NO_TEXT',
  INTERNAL: 'INTERNAL',
});

/** Ошибка ядра с кодом протокола. Сообщение не содержит текста документа (NFR-14). */
export class CoreError extends Error {
  /** @param {keyof typeof ERROR_CODES} code @param {string} message @param {object} [details] */
  constructor(code, message, details) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
    this.details = details;
  }
}
