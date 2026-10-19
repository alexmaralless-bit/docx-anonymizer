// Чистые функции работы с файлами перехвата (FR-04, FR-05, FR-06). Без DOM-событий — тестируются в Node.

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const PDF_MIME = 'application/pdf';

/** FR-04: расширение .docx/.docm без учёта регистра или MIME документа Word. */
export function isDocx(file) {
  if (!file) return false;
  if (/\.(docx|docm)$/i.test(file.name || '')) return true;
  return file.type === DOCX_MIME;
}

/** Есть ли среди файлов хотя бы один .docx. */
export function hasDocx(files) {
  return Array.from(files || []).some(isDocx);
}

/** PDF (версия 0.3): расширение .pdf без учёта регистра или MIME application/pdf. */
export function isPdfFile(file) {
  if (!file) return false;
  return /\.pdf$/i.test(file.name || '') || file.type === PDF_MIME;
}

/** Вид файла для перехвата: 'docx' | 'pdf' | null (остальное проходит как есть). */
export function fileKind(file) {
  if (isDocx(file)) return 'docx';
  if (isPdfFile(file)) return 'pdf';
  return null;
}

/** Обрабатывает ли расширение файл при этих настройках: DOCX — всегда, PDF — если pdfMode не 'off' (FR-04, версия 0.3). */
export function isSupported(file, settings) {
  const kind = fileKind(file);
  if (kind === 'pdf') return (settings?.pdfMode ?? 'markdown') !== 'off';
  return kind === 'docx';
}

/** Есть ли среди файлов хотя бы один обрабатываемый. */
export function hasSupported(files, settings) {
  return Array.from(files || []).some((f) => isSupported(f, settings));
}

/** Сигнатура файла: по ней узнаём собственные результаты при повторной отправке события страницей. */
export function fileSignature(file) {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

/**
 * Собирает итоговый список файлов в исходном порядке (FR-06):
 * для каждого исходного файла — его замена или он сам.
 * @template T
 * @param {T[]} originals
 * @param {Map<number, T>} replacements индекс в originals → новый файл
 */
export function mergeInOrder(originals, replacements) {
  return originals.map((f, i) => replacements.get(i) ?? f);
}

/** Имя файла для скачивания маппинга: «договор.anon.docx» (или «.anon.md», «.anon.txt» из PDF) → «договор.mapping.json». */
export function mappingFileName(resultName) {
  const base = String(resultName || 'document')
    .replace(/\.(docx|docm|md|txt)$/i, '')
    .replace(/\.anon$/i, '');
  return `${base}.mapping.json`;
}

/**
 * Тип результата: для DOCX сохраняем MIME исходника (FR-05), если пустой — MIME документа Word; для PDF — тип текста
 * от хоста (text/markdown или text/plain, версия 0.3).
 * @param {{type?: string}} original @param {string} [mime] MIME результата из RESULT_BEGIN
 */
export function resultType(original, mime) {
  if (mime && /^text\//.test(mime)) return mime;
  return original?.type || DOCX_MIME;
}

/** Содержит ли сообщение ошибки признак инвалидации контекста расширения (FR-09). */
export function isInvalidatedError(err) {
  const msg = String((err && err.message) || err || '');
  return /Extension context invalidated|context invalidated|Receiving end does not exist/i.test(msg);
}

/** «1,2 МБ» / «340 КБ». */
export function formatSize(bytes, lang = 'ru') {
  const mb = lang === 'ru' ? 'МБ' : 'MB';
  const kb = lang === 'ru' ? 'КБ' : 'KB';
  const sep = lang === 'ru' ? ',' : '.';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1).replace('.', sep)} ${mb}`;
  return `${Math.max(1, Math.round(bytes / 1024))} ${kb}`;
}

/**
 * Имя результата на стороне клиента: 'договор.docx' → 'договор.anon.docx'; с `{ext}` — 'договор.pdf' → 'договор.anon.md'. Нужно, потому что при повторной
 * загрузке файла с тем же содержимым хост возвращает прежнюю сессию (§3.6) вместе с её именем.
 */
export function makeResultName(name, suffix = '.anon', opts = {}) {
  if (opts.ext) {
    // PDF → текст (версия 0.3): 'договор.pdf' → 'договор.anon.md'
    const base = String(name || 'document').replace(/\.(docx|docm|pdf)$/i, '') || 'document';
    return `${base}${suffix}${opts.ext}`;
  }
  const m = /^(.*?)(\.(docx|docm))?$/i.exec(name || 'document.docx');
  return `${m?.[1] || 'document'}${suffix}${m?.[2] || '.docx'}`;
}
