// Справка: что делает расширение, как им пользоваться, что данные не покидают компьютер.
// Статичный текст из src/ui/i18n/help.js, язык — из настроек. Сети не использует.
import './help.css';
import { loadSettings } from '../shared/settings-store.js';
import { createT, resolveUiLanguage } from '../ui/i18n/index.js';
import { HELP_DICT } from '../ui/i18n/help.js';
import { madeByLine } from '../ui/brand.js';
import { h } from '../ui/deanon/dom.js';

const list = (tag, t, prefix, n) =>
  h(
    tag,
    {},
    Array.from({ length: n }, (_, i) => h('li', {}, t(`${prefix}_${i + 1}`))),
  );

function render(lang) {
  const t = createT(HELP_DICT, lang);
  document.documentElement.lang = lang;
  document.title = `DOCX Anonymizer — ${t('title').toLowerCase()}`;
  document
    .getElementById('app')
    .replaceChildren(
      h(
        'div',
        { class: 'help' },
        h(
          'header',
          { class: 'page-head' },
          h('img', { src: '../icons/icon-48.png', alt: '', width: 48, height: 48 }),
          h('div', {}, h('h1', {}, t('title')), h('p', {}, t('subtitle'))),
        ),
        h('section', { class: 'card', dataset: { testid: 'help-what' } }, h('h2', {}, t('what_h')), h('p', {}, t('what_p1')), h('p', {}, t('what_p2'))),
        h('section', { class: 'card', dataset: { testid: 'help-how' } }, h('h2', {}, t('how_h')), list('ol', t, 'how', 4)),
        h('section', { class: 'card', dataset: { testid: 'help-privacy' } }, h('h2', {}, t('privacy_h')), list('ul', t, 'privacy', 4)),
        h('section', { class: 'card', dataset: { testid: 'help-check' } }, h('h2', {}, t('check_h')), list('ul', t, 'check', 4)),
        h(
          'div',
          { class: 'row' },
          h('a', { href: '../options/options.html' }, t('open_options')),
          h('a', { href: '../restore/restore.html' }, t('open_restore')),
        ),
        madeByLine(lang),
      ),
    );
}

async function init() {
  let lang = 'ru';
  try {
    lang = resolveUiLanguage((await loadSettings()).uiLanguage);
  } catch {
    /* без настроек — русский */
  }
  render(lang);
}

init();
