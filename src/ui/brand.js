// Подпись студии: «Сделано в Sitimlab» и ссылка на справку. Общая для меню, настроек, восстановления и справки.
// Ссылки открываются щелчком пользователя в новой вкладке; сам код расширения сеть не использует (NFR-01).
import { createT } from './i18n/index.js';
import { common } from './i18n/common.js';

export const SITIMLAB_URL = 'https://sitimlab.ru';
export const HELP_PATH = 'help/help.html';

/** @param {'ru'|'en'} lang */
export function madeByLine(lang) {
  const t = createT(common, lang);
  const p = document.createElement('p');
  p.className = 'made-by';
  p.append(`${t('madeBy')} `);
  const a = document.createElement('a');
  a.href = SITIMLAB_URL;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = 'Sitimlab';
  a.dataset.testid = 'made-by-link';
  p.append(a);
  return p;
}

/**
 * Ссылка «Справка» на страницу справки; `prefix` — путь от текущей страницы к корню расширения.
 * @param {'ru'|'en'} lang
 */
export function helpLink(lang, prefix = '../') {
  const t = createT(common, lang);
  const a = document.createElement('a');
  a.href = `${prefix}${HELP_PATH}`;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = t('help');
  a.dataset.testid = 'help-link';
  return a;
}
