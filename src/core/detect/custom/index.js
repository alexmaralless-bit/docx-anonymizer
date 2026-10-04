// WP4: пользовательские категории (FR-44): словарь / лейбл+форма / шаблон.
// Категории динамические (из settings.customCategories) — поэтому это документный детектор:
// api.registerDocumentDetector('custom', (doc, entities, ctx) => …), категории берутся из ctx.catalog.
// Контракт — docs/contracts.md §2.

/** @param {{registerDetector: Function, registerDocumentDetector: Function}} api */
export function register(api) {}
