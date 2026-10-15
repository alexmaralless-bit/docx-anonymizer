// Страница настроек (FR-34, FR-35, FR-42, FR-44–FR-47). Каждое изменение сохраняется сразу через saveSettingsPatch;
// невалидное — подсвечивается и не сохраняется. Работает только через src/shared/settings-store.js.
import './options.css';
import { buildCatalog } from '../core/categories.js';
import { defaultSettings, validateSettingsPatch } from '../core/settings.js';
import { findCustomMatches } from '../core/detect/custom/index.js';
import { checkRegexSource, validateCustomCategory, CUSTOM_VALIDATORS, SHAPES } from '../core/detect/custom/rules.js';
import { loadSettings, onSettingsChanged, saveSettingsPatch } from '../shared/settings-store.js';
import { ALL_URLS, desiredPatterns, removeOrigins, requestOrigins, toMatchPattern } from '../shared/permissions.js';
import { createT, resolveUiLanguage } from '../ui/i18n/index.js';
import { OPTIONS_DICT } from '../ui/i18n/options.js';
import { confirmDialog, downloadJson, h } from '../ui/deanon/dom.js';
import { madeByLine, helpLink } from '../ui/brand.js';
import { guardRegex } from './regex-guard.js';
import { CATEGORIES_KIND, CONFIG_KIND, NOT_EXPORTED, parseCategoriesFile, parseConfigFile } from './config-io.js';

const TEST_MAX = 10000;
const DICT_WARNED_KEY = 'dictWarned';

/** @type {import('../core/settings.js').Settings} */
let settings;
let t = createT(OPTIONS_DICT, 'ru');
let lang = 'ru';
let statusTimer;

// ---------- общее ----------

function flash(text, bad = false) {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = text;
  el.className = `status show ${bad ? 'bad' : 'ok'}`;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

/** Сохраняет патч; при отказе подсвечивает поле `el` и ничего не пишет. */
async function save(patch, el) {
  const bad = validateSettingsPatch(patch);
  if (bad.length) {
    el?.classList.add('invalid');
    flash(t('invalid'), true);
    return false;
  }
  el?.classList.remove('invalid');
  const r = await saveSettingsPatch(patch);
  settings = r.settings;
  flash(t('saved'));
  return true;
}

function toggle(text, hint, checked, onChange, testid) {
  const input = h('input', { type: 'checkbox', checked, dataset: { testid }, onchange: () => onChange(input.checked, input) });
  return h(
    'label',
    { class: 'switch' },
    input,
    h('span', { class: 'track' }),
    h('span', { class: 'txt' }, h('span', {}, text), hint ? h('span', { class: 'hint' }, hint) : null),
  );
}

function selectField(labelText, options, value, onChange, testid) {
  const sel = h(
    'select',
    { id: testid, dataset: { testid }, onchange: () => onChange(sel.value, sel) },
    options.map(([v, text]) => h('option', { value: v, selected: v === value }, text)),
  );
  return h('div', { class: 'field' }, h('label', { for: testid }, labelText), sel);
}

function card(id, title, hint, ...children) {
  return h('section', { class: 'card', id }, h('h2', {}, title), hint ? h('p', { class: 'sec-hint' }, hint) : null, ...children);
}

// ---------- перехват ----------

const ORIGIN_RE = /^https?:\/\/(\*\.)?[^/\s]+$/;

function normalizeOrigin(v) {
  return v.trim().replace(/\/+$/, '').toLowerCase();
}

// К9: allowlist связан с host-разрешениями. Добавление сайта запрашивает доступ (синхронно, в жесте пользователя),
// удаление — отзывает его (в режиме «все сайты» доступ держит <all_urls>, отдельные сайты не трогаем).
function originList(key, title, testid) {
  const box = h('div', { dataset: { testid: `${testid}-box` } });
  const err = h('div', { class: 'err' });
  const access = h('div', { class: 'err', dataset: { testid: `${testid}-access` } });
  const input = h('input', { type: 'text', placeholder: t('origin_placeholder'), dataset: { testid: `${testid}-input` }, 'aria-label': title });
  const draw = () => {
    box.replaceChildren(
      settings[key].length
        ? h(
            'div',
            { class: 'chips' },
            settings[key].map((o) =>
              h(
                'span',
                { class: 'chip' },
                o,
                h('button', { type: 'button', title: t('remove'), 'aria-label': `${t('remove')} ${o}`, onclick: () => remove(o) }, '×'),
              ),
            ),
          )
        : h('div', { class: 'empty' }, t('list_empty')),
    );
  };
  const remove = async (o) => {
    if (key === 'allowlist' && settings.siteMode !== 'all') removeOrigins([toMatchPattern(o)]);
    await save({ [key]: settings[key].filter((x) => x !== o) });
    draw();
  };
  const add = async () => {
    const v = normalizeOrigin(input.value);
    if (!v) return;
    if (!ORIGIN_RE.test(v) || validateSettingsPatch({ [key]: [v] }).length) {
      input.classList.add('invalid');
      err.textContent = t('origin_bad');
      return;
    }
    // первым оператором после проверки, до любого await: permissions.request работает только из жеста пользователя
    const granted = key === 'allowlist' ? requestOrigins([toMatchPattern(v)]) : null;
    input.classList.remove('invalid');
    err.textContent = '';
    access.textContent = '';
    // сохраняем независимо от ответа Chrome: сайт в списке, доступ можно выдать позже из меню расширения
    if (!settings[key].includes(v)) await save({ [key]: [...settings[key], v] });
    input.value = '';
    draw();
    if (granted && !(await granted)) access.textContent = t('access_denied_hint');
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') add();
  });
  input.addEventListener('input', () => {
    input.classList.remove('invalid');
    err.textContent = '';
  });
  draw();
  return h(
    'div',
    { class: 'field' },
    h('span', { class: 'lbl' }, title),
    h(
      'div',
      { class: 'row' },
      h('div', { style: 'flex:1;min-width:220px' }, input),
      h('button', { type: 'button', class: 'btn', dataset: { testid: `${testid}-add` }, onclick: add }, t('add')),
    ),
    key === 'allowlist' ? h('span', { class: 'hint' }, t('allowlist_hint')) : null,
    err,
    access,
    box,
  );
}

function interceptSection() {
  const mode = selectField(
    t('site_mode'),
    [
      ['allowlist', t('site_mode_allowlist')],
      ['all', t('site_mode_all')],
    ],
    settings.siteMode,
    async (v, sel) => {
      if (v === 'all') {
        const ok = await confirmDialog(t('site_all_warn'), { ok: t('confirm'), cancel: t('cancel') });
        if (!ok) {
          sel.value = settings.siteMode;
          return;
        }
        // К9: сразу после клика «Подтвердить» (жест пользователя) — запрос доступа ко всем сайтам; без него режим не меняем
        if (!(await requestOrigins([ALL_URLS]))) {
          sel.value = settings.siteMode;
          flash(t('site_all_denied'), true);
          return;
        }
      } else if (settings.siteMode === 'all') {
        // all → allowlist: снять доступ ко всем сайтам и запросить доступ только к сайтам списка.
        // Сначала remove: пока <all_urls> выдан, request отдельных сайтов вернул бы true, ничего не добавив.
        await removeOrigins([ALL_URLS]);
        requestOrigins(desiredPatterns({ ...settings, siteMode: v }));
      }
      await save({ siteMode: v }, sel);
    },
    'site-mode',
  );
  return card(
    'intercept',
    t('intercept_h'),
    null,
    toggle(t('intercept_enabled'), t('intercept_enabled_hint'), settings.interceptEnabled, (v, el) => save({ interceptEnabled: v }, el), 'intercept-enabled'),
    mode,
    originList('allowlist', t('allowlist'), 'allowlist'),
    originList('blocklist', t('blocklist'), 'blocklist'),
  );
}

// ---------- категории ----------

function categoriesSection() {
  const catalog = buildCatalog(settings);
  const items = catalog.list
    .filter((c) => c.builtin)
    .map((c) => {
      const on = typeof settings.categories[c.id] === 'boolean' ? settings.categories[c.id] : c.defaultOn;
      const name = h('span', {}, h('span', { class: 'dot', style: `background:${c.color}` }), c.label[lang]);
      return toggle(name, c.defaultOn ? null : t('default_off'), on, (v, el) => save({ categories: { ...settings.categories, [c.id]: v } }, el), `cat-${c.id}`);
    });
  return card('categories', t('categories_h'), t('categories_hint'), h('div', { class: 'cat-grid' }, items));
}

// ---------- обработка ----------

function processingSection() {
  const size = h('input', {
    type: 'number',
    min: 1,
    max: 100,
    step: 1,
    value: String(settings.maxFileSizeMB),
    dataset: { testid: 'max-size' },
    id: 'max-size',
  });
  size.addEventListener('input', () => {
    const v = size.value.trim() === '' ? NaN : Number(size.value);
    save({ maxFileSizeMB: v }, size);
  });
  return card(
    'processing',
    t('processing_h'),
    null,
    h(
      'div',
      { class: 'grid2' },
      selectField(
        t('mode'),
        [
          ['placeholder', t('mode_placeholder')],
          ['mask', t('mode_mask')],
          ['delete', t('mode_delete')],
        ],
        settings.mode,
        (v, el) => save({ mode: v }, el),
        'mode',
      ),
      selectField(
        t('language'),
        [
          ['auto', t('language_auto')],
          ['ru', t('language_ru')],
          ['en', t('language_en')],
          ['both', t('language_both')],
        ],
        settings.language,
        (v, el) => save({ language: v }, el),
        'language',
      ),
      selectField(
        t('placeholder_language'),
        [
          ['document', t('placeholder_language_document')],
          ['ru', t('placeholder_language_ru')],
          ['en', t('placeholder_language_en')],
        ],
        settings.placeholderLanguage,
        (v, el) => save({ placeholderLanguage: v }, el),
        'placeholder-language',
      ),
      selectField(
        t('ui_language'),
        [
          ['auto', t('ui_auto')],
          ['ru', 'Русский'],
          ['en', 'English'],
        ],
        settings.uiLanguage,
        async (v, el) => {
          if (await save({ uiLanguage: v }, el)) renderApp();
        },
        'ui-language',
      ),
    ),
    h('div', { class: 'field' }, h('label', { for: 'max-size' }, t('max_size')), size),
    h(
      'div',
      { class: 'stack' },
      toggle(t('keep_metadata'), t('keep_metadata_hint'), settings.keepMetadata, (v, el) => save({ keepMetadata: v }, el), 'keep-metadata'),
      toggle(t('strip_embedded'), t('strip_embedded_hint'), settings.stripEmbedded, (v, el) => save({ stripEmbedded: v }, el), 'strip-embedded'),
      toggle(t('gov_entities'), null, settings.govEntities, (v, el) => save({ govEntities: v }, el), 'gov-entities'),
    ),
  );
}

// ---------- исключения ----------

function exclusionsSection() {
  const catalog = buildCatalog(settings);
  const box = h('div');
  const err = h('div', { class: 'err' });
  const value = h('input', { type: 'text', 'aria-label': t('exclusion_value'), placeholder: t('exclusion_value'), dataset: { testid: 'exclusion-value' } });
  const cat = h(
    'select',
    { 'aria-label': t('exclusion_category'), dataset: { testid: 'exclusion-category' } },
    catalog.list.map((c) => h('option', { value: c.id }, c.label[lang])),
  );
  const draw = () => {
    box.replaceChildren(
      settings.exclusions.length
        ? h(
            'div',
            { class: 'chips' },
            settings.exclusions.map((x, i) =>
              h(
                'span',
                { class: 'chip' },
                `${x.value} · ${catalog.byId.get(x.category)?.label[lang] || x.category}`,
                h(
                  'button',
                  {
                    type: 'button',
                    title: t('remove'),
                    'aria-label': `${t('remove')} ${x.value}`,
                    onclick: async () => {
                      await save({ exclusions: settings.exclusions.filter((_, j) => j !== i) });
                      draw();
                    },
                  },
                  '×',
                ),
              ),
            ),
          )
        : h('div', { class: 'empty' }, t('list_empty')),
    );
  };
  const add = async () => {
    const v = value.value.trim();
    if (!v) {
      value.classList.add('invalid');
      err.textContent = t('exclusion_empty');
      return;
    }
    value.classList.remove('invalid');
    err.textContent = '';
    if (!settings.exclusions.some((x) => x.value === v && x.category === cat.value))
      await save({ exclusions: [...settings.exclusions, { value: v, category: cat.value }] });
    value.value = '';
    draw();
  };
  value.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') add();
  });
  draw();
  return card(
    'exclusions',
    t('exclusions_h'),
    t('exclusions_hint'),
    h(
      'div',
      { class: 'row' },
      h('div', { style: 'flex:2;min-width:180px' }, value),
      h('div', { style: 'flex:1;min-width:160px' }, cat),
      h('button', { type: 'button', class: 'btn', dataset: { testid: 'exclusion-add' }, onclick: add }, t('add')),
    ),
    err,
    box,
  );
}

// ---------- свои категории ----------

const KIND_KEYS = ['dictionary', 'labeled', 'pattern'];

function newDraft() {
  return {
    id: '',
    label: { ru: '', en: '' },
    placeholderPrefix: { ru: '', en: '' },
    color: '#8e44ad',
    enabled: true,
    priority: 'belowBuiltin',
    kind: 'dictionary',
    dictionary: { values: [], caseSensitive: false, wholeWord: true },
    labeled: { labels: { ru: [], en: [] }, shape: 'digits', minLen: 6, maxLen: 6, validator: 'none' },
    pattern: { regex: '', flags: 'u', validator: 'none', labels: { ru: [], en: [] } },
    createdAt: new Date().toISOString(),
  };
}

const lines = (s) =>
  s
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);

function makeId(name) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 20);
  const rnd = Math.random().toString(36).slice(2, 7);
  return `custom:${slug ? slug + '-' : ''}${rnd}`;
}

function customSection() {
  const list = h('div', { class: 'cc-list', dataset: { testid: 'cc-list' } });
  const msg = h('div', { class: 'hint', role: 'status' });
  const draw = () => {
    list.replaceChildren(
      ...(settings.customCategories.length
        ? settings.customCategories.map((cc) => {
            const toggleEl = toggle(
              null,
              null,
              cc.enabled !== false,
              async (v, el) => {
                await save({ customCategories: settings.customCategories.map((x) => (x.id === cc.id ? { ...x, enabled: v } : x)) }, el);
              },
              `cc-toggle-${cc.id}`,
            );
            toggleEl.setAttribute('aria-label', cc.label?.[lang] || cc.label?.ru || cc.id);
            return h(
              'div',
              { class: 'cc', dataset: { testid: 'cc-item' } },
              h(
                'div',
                {},
                h(
                  'div',
                  {},
                  h('span', { class: 'dot', style: `background:${cc.color}` }),
                  h('strong', {}, cc.label?.[lang] || cc.label?.ru || cc.id),
                  h('span', { class: 'tag' }, t(`kind_${cc.kind}`)),
                  cc.priority === 'aboveBuiltin' ? h('span', { class: 'tag' }, '↑') : null,
                ),
                h('div', { class: 'meta' }, `[${cc.placeholderPrefix?.[lang] || cc.placeholderPrefix?.ru}_1]`),
              ),
              h(
                'div',
                { class: 'row' },
                toggleEl,
                h('button', { type: 'button', class: 'btn small', onclick: () => openEditor(cc) }, t('edit')),
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'btn small danger',
                    onclick: async () => {
                      const name = cc.label?.[lang] || cc.label?.ru || cc.id;
                      if (!(await confirmDialog(t('delete_cat_confirm', { name }), { ok: t('delete'), cancel: t('cancel'), danger: true }))) return;
                      await save({ customCategories: settings.customCategories.filter((x) => x.id !== cc.id) });
                      draw();
                    },
                  },
                  t('delete'),
                ),
              ),
            );
          })
        : [h('div', { class: 'empty' }, t('custom_none'))]),
    );
  };

  async function openEditor(existing) {
    const saved = await openCategoryDialog(existing);
    if (saved) draw();
  }

  const fileInput = h('input', {
    type: 'file',
    accept: '.json,application/json',
    hidden: true,
    dataset: { testid: 'cc-import-file' },
    onchange: async () => {
      const f = fileInput.files?.[0];
      fileInput.value = '';
      if (!f) return;
      const r = parseCategoriesFile(await f.text());
      if (r.error) {
        msg.textContent = t('custom_import_bad', { why: r.error });
        return;
      }
      const byId = new Map(settings.customCategories.map((c) => [c.id, c]));
      for (const c of r.categories) byId.set(c.id, c);
      if (!(await save({ customCategories: [...byId.values()] }))) {
        msg.textContent = t('custom_import_bad', { why: 'max 100' });
        return;
      }
      msg.textContent = t('custom_imported', { n: r.categories.length });
      draw();
    },
  });
  draw();
  return card(
    'custom',
    t('custom_h'),
    t('custom_hint'),
    h(
      'div',
      { class: 'row' },
      h('button', { type: 'button', class: 'btn primary', dataset: { testid: 'cc-new' }, onclick: () => openEditor(null) }, t('custom_new')),
      h(
        'button',
        {
          type: 'button',
          class: 'btn',
          dataset: { testid: 'cc-export' },
          onclick: () => downloadJson('custom.categories.json', { kind: CATEGORIES_KIND, version: 1, categories: settings.customCategories }),
        },
        t('custom_export'),
      ),
      h('button', { type: 'button', class: 'btn', dataset: { testid: 'cc-import' }, onclick: () => fileInput.click() }, t('custom_import')),
      fileInput,
    ),
    msg,
    list,
  );
}

function field(labelText, control, hint, key) {
  const err = h('div', { class: 'err', dataset: { err: key || '' } });
  return h('div', { class: 'field' }, labelText ? h('span', { class: 'lbl' }, labelText) : null, control, hint ? h('div', { class: 'hint' }, hint) : null, err);
}

/** Диалог создания/редактирования. Возвращает true, если категория сохранена. */
function openCategoryDialog(existing) {
  return new Promise((resolve) => {
    const d = existing ? structuredClone(existing) : newDraft();
    d.dictionary ||= newDraft().dictionary;
    d.labeled ||= newDraft().labeled;
    d.pattern ||= newDraft().pattern;
    d.pattern.labels ||= { ru: [], en: [] };
    const dlg = h('dialog', { class: 'dlg wide', dataset: { testid: 'cc-dialog' } });
    const $ = (name) => dlg.querySelector(`[data-f="${name}"]`);
    const inp = (name, attrs = {}) => h('input', { type: 'text', dataset: { f: name }, ...attrs });
    const area = (name, value, attrs = {}) => h('textarea', { dataset: { f: name }, value, ...attrs });

    const nameRu = inp('label.ru', { value: d.label.ru || '' });
    const nameEn = inp('label.en', { value: d.label.en || '' });
    const prefRu = inp('placeholderPrefix.ru', { value: d.placeholderPrefix.ru || '' });
    const prefEn = inp('placeholderPrefix.en', { value: d.placeholderPrefix.en || '' });
    const color = h('input', { type: 'color', value: d.color, dataset: { f: 'color' }, 'aria-label': t('f_color') });
    const prio = h(
      'select',
      { dataset: { f: 'priority' } },
      h('option', { value: 'belowBuiltin', selected: d.priority !== 'aboveBuiltin' }, t('priority_below')),
      h('option', { value: 'aboveBuiltin', selected: d.priority === 'aboveBuiltin' }, t('priority_above')),
    );
    const kindSeg = h(
      'div',
      { class: 'seg', role: 'radiogroup', 'aria-label': t('f_kind') },
      KIND_KEYS.map((k) =>
        h(
          'label',
          {},
          h('input', { type: 'radio', name: 'kind', value: k, checked: d.kind === k, dataset: { testid: `kind-${k}` }, onchange: () => setKind(k) }),
          t(`kind_${k}`),
        ),
      ),
    );
    const kindHint = h('div', { class: 'hint' });

    // словарь
    const dictValues = area('dictionary.values', (d.dictionary.values || []).join('\n'), { rows: 6 });
    const dictCase = toggle(t('f_case'), null, !!d.dictionary.caseSensitive, () => refresh(), 'dict-case');
    const dictWord = toggle(t('f_word'), null, d.dictionary.wholeWord !== false, () => refresh(), 'dict-word');
    dictCase.querySelector('input').dataset.f = 'dictionary.caseSensitive';
    dictWord.querySelector('input').dataset.f = 'dictionary.wholeWord';
    // метка + форма
    const lblRu = area('labeled.labels.ru', (d.labeled.labels?.ru || []).join('\n'), { rows: 3 });
    const lblEn = area('labeled.labels.en', (d.labeled.labels?.en || []).join('\n'), { rows: 3 });
    const shape = h(
      'select',
      { dataset: { f: 'labeled.shape' } },
      SHAPES.map((s) => h('option', { value: s, selected: d.labeled.shape === s }, t(`shape_${s}`))),
    );
    const minLen = h('input', { type: 'number', min: 1, max: 64, value: String(d.labeled.minLen), dataset: { f: 'labeled.minLen' } });
    const maxLen = h('input', { type: 'number', min: 1, max: 64, value: String(d.labeled.maxLen), dataset: { f: 'labeled.maxLen' } });
    const validatorSel = (name, value) =>
      h(
        'select',
        { dataset: { f: name } },
        CUSTOM_VALIDATORS.map((v) => h('option', { value: v, selected: (value || 'none') === v }, v === 'none' ? t('validator_none') : v)),
      );
    const lblValidator = validatorSel('labeled.validator', d.labeled.validator);
    // шаблон
    const regex = inp('pattern.regex', { value: d.pattern.regex || '', 'aria-label': t('f_regex') });
    const flagI = toggle(t('f_flags_i'), null, (d.pattern.flags || '').includes('i'), () => refresh(), 'flag-i');
    const flagU = toggle(t('f_flags_u'), null, (d.pattern.flags || '').includes('u'), () => refresh(), 'flag-u');
    flagI.querySelector('input').dataset.f = 'flag.i';
    flagU.querySelector('input').dataset.f = 'flag.u';
    const patValidator = validatorSel('pattern.validator', d.pattern.validator);
    const patLblRu = area('pattern.labels.ru', (d.pattern.labels.ru || []).join('\n'), { rows: 2 });
    const patLblEn = area('pattern.labels.en', (d.pattern.labels.en || []).join('\n'), { rows: 2 });

    const blocks = {
      dictionary: h(
        'div',
        {},
        field(t('f_values'), dictValues, null, 'dictionary.values'),
        h('div', { class: 'row', style: 'margin-top:10px;gap:24px' }, dictCase, dictWord),
      ),
      labeled: h(
        'div',
        {},
        h('div', { class: 'grid2' }, field(t('f_labels_ru'), lblRu, null, 'labeled.labels'), field(t('f_labels_en'), lblEn)),
        h('div', { class: 'grid2' }, field(t('f_shape'), shape, null, 'labeled.shape'), field(t('f_validator'), lblValidator, null, 'labeled.validator')),
        h('div', { class: 'grid2' }, field(t('f_min'), minLen, null, 'labeled.minLen'), field(t('f_max'), maxLen, null, 'labeled.maxLen')),
      ),
      pattern: h(
        'div',
        {},
        field(t('f_regex'), regex, null, 'pattern.regex'),
        h('div', { class: 'row', style: 'margin-top:8px;gap:24px' }, flagI, flagU),
        h('div', { class: 'grid2' }, field(t('f_validator'), patValidator, null, 'pattern.validator')),
        h('div', { class: 'grid2' }, field(`${t('f_regex_labels')} RU`, patLblRu), field(`${t('f_regex_labels')} EN`, patLblEn)),
      ),
    };

    // проверка на тексте
    const testText = h('textarea', { rows: 4, maxLength: TEST_MAX, 'aria-label': t('f_test'), dataset: { testid: 'cc-test-text' } });
    const preview = h('div', { class: 'preview', dataset: { testid: 'cc-preview' }, 'aria-live': 'polite' });
    const previewCount = h('div', { class: 'hint', dataset: { testid: 'cc-preview-count' } });

    const collect = () => {
      const cc = {
        id: d.id || '',
        label: { ru: nameRu.value.trim(), en: nameEn.value.trim() || nameRu.value.trim() },
        placeholderPrefix: { ru: prefRu.value.trim().toUpperCase(), en: (prefEn.value.trim() || prefRu.value.trim()).toUpperCase() },
        color: color.value,
        enabled: d.enabled !== false,
        priority: prio.value,
        kind: d.kind,
        createdAt: d.createdAt || new Date().toISOString(),
      };
      if (d.kind === 'dictionary') {
        cc.dictionary = {
          values: lines(dictValues.value),
          caseSensitive: dictCase.querySelector('input').checked,
          wholeWord: dictWord.querySelector('input').checked,
        };
      } else if (d.kind === 'labeled') {
        cc.labeled = {
          labels: { ru: lines(lblRu.value), en: lines(lblEn.value) },
          shape: shape.value,
          minLen: Number(minLen.value),
          maxLen: Number(maxLen.value),
          validator: lblValidator.value,
        };
      } else {
        const flags = (flagI.querySelector('input').checked ? 'i' : '') + (flagU.querySelector('input').checked ? 'u' : '');
        cc.pattern = { regex: regex.value, flags, validator: patValidator.value };
        const labels = { ru: lines(patLblRu.value), en: lines(patLblEn.value) };
        if (labels.ru.length || labels.en.length) cc.pattern.labels = labels;
      }
      return cc;
    };

    let token = 0;
    let timer;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(runPreview, 300);
    };
    async function runPreview() {
      const my = ++token;
      const text = testText.value.slice(0, TEST_MAX);
      const cc = collect();
      if (!text) {
        preview.replaceChildren();
        previewCount.textContent = '';
        return;
      }
      let matches;
      try {
        if (cc.kind === 'pattern') {
          const chk = checkRegexSource(cc.pattern.regex, cc.pattern.flags);
          if (!chk.ok) {
            previewCount.textContent = t(`err_${chk.code}`);
            preview.textContent = text;
            return;
          }
          previewCount.textContent = t('guard_checking');
          const g = await guardRegex(cc.pattern.regex, cc.pattern.flags);
          if (my !== token) return;
          if (!g.ok) {
            previewCount.textContent =
              g.code === 'TIMEOUT' ? t('guard_slow') : t(`err_${g.code}`) !== `err_${g.code}` ? t(`err_${g.code}`) : t('guard_unavailable');
            preview.textContent = text;
            return;
          }
        }
        matches = findCustomMatches(cc, text, 'both');
      } catch (err) {
        return;
      }
      if (my !== token) return;
      const frag = [];
      let pos = 0;
      for (const m of matches) {
        if (m.start < pos) continue;
        frag.push(text.slice(pos, m.start), h('mark', { class: 'hit' }, text.slice(m.start, m.end)));
        pos = m.end;
      }
      frag.push(text.slice(pos));
      preview.replaceChildren(...frag);
      previewCount.textContent = t('test_count', { n: matches.length });
    }

    function setKind(k) {
      d.kind = k;
      for (const key of KIND_KEYS) blocks[key].hidden = key !== k;
      kindHint.textContent = t(`kind_${k}_hint`);
      refresh();
    }

    const showErrors = (errs) => {
      dlg.querySelectorAll('.invalid').forEach((e) => e.classList.remove('invalid'));
      dlg.querySelectorAll('[data-err]').forEach((e) => (e.textContent = ''));
      for (const { field: f, code } of errs) {
        const el = $(f) || (f === 'labeled.maxLen' ? $('labeled.maxLen') : null);
        el?.classList.add('invalid');
        const slot = dlg.querySelector(`[data-err="${f}"]`);
        if (slot) slot.textContent = t(`err_${code}`) !== `err_${code}` ? t(`err_${code}`) : t('err_INVALID');
      }
      dlg.querySelector('.invalid')?.focus();
    };

    const close = (v) => {
      dlg.close();
      dlg.remove();
      resolve(v);
    };

    const saveBtn = h('button', { type: 'button', class: 'btn primary', dataset: { testid: 'cc-save' } }, t('save'));
    saveBtn.addEventListener('click', async () => {
      const cc = collect();
      if (!existing) cc.id = makeId(cc.label.ru);
      else cc.id = existing.id;
      const errs = validateCustomCategory(cc);
      showErrors(errs);
      if (errs.length) return;
      if (cc.kind === 'pattern') {
        saveBtn.disabled = true;
        const orig = saveBtn.textContent;
        saveBtn.textContent = t('guard_checking');
        const g = await guardRegex(cc.pattern.regex, cc.pattern.flags);
        saveBtn.disabled = false;
        saveBtn.textContent = orig;
        if (!g.ok) {
          const code = g.code === 'TIMEOUT' ? null : g.code;
          const text = code ? (t(`err_${code}`) !== `err_${code}` ? t(`err_${code}`) : t('guard_unavailable')) : t('guard_slow');
          $('pattern.regex').classList.add('invalid');
          dlg.querySelector('[data-err="pattern.regex"]').textContent = text;
          return;
        }
      }
      if (cc.kind === 'dictionary' && !safeGet(DICT_WARNED_KEY)) {
        const ok = await confirmDialog(t('dict_warn'), { ok: t('confirm'), cancel: t('cancel') });
        if (!ok) return;
        safeSet(DICT_WARNED_KEY, '1');
      }
      const others = settings.customCategories.filter((c) => c.id !== cc.id);
      const next = existing ? settings.customCategories.map((c) => (c.id === cc.id ? cc : c)) : [...others, cc];
      if (await save({ customCategories: next })) close(true);
      else showErrors([{ field: 'label.ru', code: 'INVALID' }]);
    });

    dlg.append(
      h('h3', {}, existing ? t('edit') : t('custom_new')),
      h('div', { class: 'grid2' }, field(t('f_name_ru'), nameRu, null, 'label.ru'), field(t('f_name_en'), nameEn)),
      h(
        'div',
        { class: 'grid2' },
        field(t('f_prefix_ru'), prefRu, t('f_prefix_hint'), 'placeholderPrefix.ru'),
        field(t('f_prefix_en'), prefEn, null, 'placeholderPrefix.en'),
      ),
      h('div', { class: 'grid2' }, field(t('f_priority'), prio, null, 'priority'), field(t('f_color'), color, null, 'color')),
      field(t('f_kind'), kindSeg),
      kindHint,
      h('div', { style: 'margin-top:12px' }, blocks.dictionary, blocks.labeled, blocks.pattern),
      field(t('f_test'), testText, t('f_test_hint')),
      preview,
      previewCount,
      h(
        'div',
        { class: 'dlg-actions' },
        h('button', { type: 'button', class: 'btn', dataset: { testid: 'cc-cancel' }, onclick: () => close(false) }, t('cancel')),
        saveBtn,
      ),
    );
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      close(false);
    });
    dlg.addEventListener('input', (e) => {
      refresh();
    });
    document.body.append(dlg);
    setKind(d.kind);
    dlg.showModal();
  });
}

function safeGet(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function safeSet(k, v) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* хранилище недоступно — предупреждение покажется ещё раз */
  }
}

// ---------- данные ----------

function dataSection() {
  const msg = h('div', { class: 'hint', role: 'status', dataset: { testid: 'data-msg' } });
  const file = h('input', {
    type: 'file',
    accept: '.json,application/json',
    hidden: true,
    dataset: { testid: 'config-import-file' },
    onchange: async () => {
      const f = file.files?.[0];
      file.value = '';
      if (!f) return;
      const r = parseConfigFile(await f.text());
      if (r.error) {
        msg.textContent = t('config_import_bad', { why: r.error });
        return;
      }
      await save(r.patch);
      msg.textContent = t('config_imported') + (r.skipped.length ? `. ${t('config_skipped', { keys: r.skipped.join(', ') })}` : '');
      renderApp();
    },
  });
  return card(
    'data',
    t('data_h'),
    t('data_hint'),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          type: 'button',
          class: 'btn',
          dataset: { testid: 'config-export' },
          onclick: () => {
            const s = { ...settings };
            for (const k of NOT_EXPORTED) delete s[k];
            downloadJson('docx-anonymizer.config.json', { kind: CONFIG_KIND, version: 1, exportedAt: new Date().toISOString(), settings: s });
          },
        },
        t('export_config'),
      ),
      h('button', { type: 'button', class: 'btn', dataset: { testid: 'config-import' }, onclick: () => file.click() }, t('import_config')),
      file,
      h(
        'button',
        {
          type: 'button',
          class: 'btn danger',
          dataset: { testid: 'config-reset' },
          onclick: async () => {
            if (!(await confirmDialog(t('reset_confirm'), { ok: t('reset'), cancel: t('cancel'), danger: true }))) return;
            await save(defaultSettings());
            msg.textContent = t('reset_done');
            renderApp();
          },
        },
        t('reset'),
      ),
    ),
    msg,
  );
}

// ---------- каркас ----------

function renderApp() {
  lang = resolveUiLanguage(settings.uiLanguage);
  t = createT(OPTIONS_DICT, lang);
  document.documentElement.lang = lang;
  document.title = `DOCX Anonymizer — ${t('title').toLowerCase()}`;
  const nav = [
    ['intercept', 'nav_intercept'],
    ['categories', 'nav_categories'],
    ['processing', 'nav_processing'],
    ['exclusions', 'nav_exclusions'],
    ['custom', 'nav_custom'],
    ['data', 'nav_data'],
  ];
  const app = document.getElementById('app');
  app.replaceChildren(
    h(
      'div',
      { class: 'layout' },
      h(
        'nav',
        { class: 'nav', 'aria-label': t('title') },
        h('div', { class: 'brand' }, 'DOCX Anonymizer'),
        nav.map(([id, key]) => h('a', { href: `#${id}` }, t(key))),
        helpLink(lang),
        madeByLine(lang),
      ),
      h(
        'main',
        {},
        h('header', { class: 'page-head' }, h('h1', {}, t('title')), h('p', {}, t('subtitle'))),
        interceptSection(),
        categoriesSection(),
        processingSection(),
        exclusionsSection(),
        customSection(),
        dataSection(),
      ),
    ),
    h('div', { id: 'status', class: 'status', role: 'status', 'aria-live': 'polite' }),
  );
}

async function init() {
  settings = await loadSettings();
  renderApp();
  onSettingsChanged((s) => {
    // Изменения из другой вкладки/popup: обновляем состояние и перерисовываем, если пользователь сейчас ничего не вводит
    const same = JSON.stringify(s) === JSON.stringify(settings);
    settings = s;
    const a = document.activeElement;
    if (!same && !document.querySelector('dialog[open]') && !(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) renderApp();
  });
}

if (typeof document !== 'undefined' && document.getElementById('app')) init();
