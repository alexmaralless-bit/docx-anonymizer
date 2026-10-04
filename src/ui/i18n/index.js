// Мини-i18n интерфейса. Словари — по модулям (src/ui/i18n/<модуль>.js), чтобы рабочие пакеты
// не правили один файл. manifest name/description — через _locales.

/** @param {'auto'|'ru'|'en'} uiLanguage */
export function resolveUiLanguage(uiLanguage = 'auto') {
  if (uiLanguage === 'ru' || uiLanguage === 'en') return uiLanguage;
  const nav = (globalThis.navigator?.language || 'ru').toLowerCase();
  return nav.startsWith('ru') ? 'ru' : 'en';
}

/**
 * @param {{ru: Record<string, string>, en: Record<string, string>}} dict
 * @param {'ru'|'en'} lang
 */
export function createT(dict, lang) {
  return (key, params = {}) => {
    const s = dict[lang]?.[key] ?? dict.ru?.[key] ?? key;
    return s.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? `{${k}}`);
  };
}
