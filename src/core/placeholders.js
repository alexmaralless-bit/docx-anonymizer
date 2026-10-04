// Плейсхолдеры и тексты замены (FR-25).

/**
 * Выдаёт плейсхолдеры: одно нормализованное значение категории → один токен.
 * Один экземпляр на документ или на партию файлов (сквозная нумерация, §3.7).
 */
export class PlaceholderAllocator {
  /** @param {'ru'|'en'} lang язык префиксов */
  constructor(lang = 'ru') {
    this.lang = lang;
    /** @type {Map<string, number>} */
    this.counters = new Map();
    /** @type {Map<string, string>} */
    this.assigned = new Map();
  }
  /**
   * @param {import('./categories.js').CategoryDef} cat
   * @param {string} key нормализованное значение
   */
  get(cat, key) {
    const k = `${cat.id}\u0000${key}`;
    let p = this.assigned.get(k);
    if (!p) {
      const n = (this.counters.get(cat.id) || 0) + 1;
      this.counters.set(cat.id, n);
      p = `[${cat.placeholderPrefix[this.lang] || cat.placeholderPrefix.ru}_${n}]`;
      this.assigned.set(k, p);
    }
    return p;
  }
  /** Резервирует существующий плейсхолдер (повторное применение маппинга, FR-51). */
  seed(categoryId, key, placeholder) {
    this.assigned.set(`${categoryId}\u0000${key}`, placeholder);
    const m = /_(\d+)\]$/.exec(placeholder);
    if (m) this.counters.set(categoryId, Math.max(this.counters.get(categoryId) || 0, Number(m[1])));
  }
}

/** Язык префиксов: settings.placeholderLanguage ('document'|'ru'|'en') + язык документа. */
export function resolvePlaceholderLanguage(placeholderLanguage, docLanguage) {
  if (placeholderLanguage === 'ru' || placeholderLanguage === 'en') return placeholderLanguage;
  return docLanguage === 'en' ? 'en' : 'ru';
}

/** Маска: каждая буква/цифра → 'X', разделители сохраняются (FR-25). */
export function maskText(s) {
  return s.replace(/[\p{L}\p{N}]/gu, 'X');
}

export const DELETED_TEXT = Object.freeze({ ru: '[удалено]', en: '[redacted]' });

/**
 * Текст, который встаёт на место «ядра» вхождения (без сохраняемой обёртки keepPrefix/keepSuffix).
 * @param {import('./contracts/entity.js').EntityGroup} group
 * @param {string} core  текст ядра вхождения
 * @param {'placeholder'|'mask'|'delete'} mode
 * @param {'ru'|'en'} lang
 */
export function replacementFor(group, core, mode, lang) {
  if (group.replacement != null && group.replacement !== '') return group.replacement; // FR-26
  if (mode === 'mask') return maskText(core);
  if (mode === 'delete') return DELETED_TEXT[lang];
  return group.placeholder;
}
