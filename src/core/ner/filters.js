// Фильтры модельных организаций (версия 0.4, концепция п. 4, К10). Каркас волны 0: раннер уже вызывает обе функции,
// наполнение — WP11-B (`src/core/ner/stoplist.js`, правила по виду блока, стоп-список, повторы в документе).
// Чистый JS без chrome.* и DOM; значения документа в логи не попадают.

/**
 * Контекст документа для фильтра: строится один раз на анализ (частоты слов, капс-строки и т.п. — WP11-B).
 * @param {import('../docx/model.js').DocModel} doc
 * @param {object} settings  эффективные настройки (`nerStoplist` — пользовательское дополнение стоп-списка)
 * @returns {object}
 */
export function createOrgFilterContext(doc, settings) {
  return {};
}

/**
 * Отбрасывает ложные спаны ORG модели (заголовки капсом, строки списка из 1–3 слов без ОПФ, аббревиатуры и продукты
 * из стоп-списка, одиночные слова, встречающиеся только в капс-строках). Остальные метки не трогает.
 * @param {import('../contracts/ner.js').NerSpan[]} spans  спаны одного потока (после порога)
 * @param {{text: string, blockKind?: string} & object} ctx  текст потока, вид блока (`paragraph.kind`), контекст документа
 * @returns {import('../contracts/ner.js').NerSpan[]}
 */
export function filterOrgSpans(spans, ctx) {
  return spans;
}
