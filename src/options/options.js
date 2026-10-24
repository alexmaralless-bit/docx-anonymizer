// Страница настроек (FR-34, FR-35, FR-42, FR-44–FR-47). Каждое изменение сохраняется сразу через saveSettingsPatch;
// невалидное — подсвечивается и не сохраняется. Работает только через src/shared/settings-store.js.
import './options.css';
import { buildCatalog, CATEGORY_GROUPS } from '../core/categories.js';
import { defaultSettings, validateSettingsPatch, SETTINGS_SCHEMA_VERSION } from '../core/settings.js';
import { findCustomMatches } from '../core/detect/custom/index.js';
import { checkRegexSource, validateCustomCategory, CUSTOM_VALIDATORS, SHAPES } from '../core/detect/custom/rules.js';
import { loadSettings, onSettingsChanged, saveSettingsPatch } from '../shared/settings-store.js';
import { ALL_URLS, desiredPatterns, removeOrigins, requestOrigins, toMatchPattern } from '../shared/permissions.js';
import { createT, resolveUiLanguage } from '../ui/i18n/index.js';
import { OPTIONS_DICT } from '../ui/i18n/options.js';
import { confirmDialog, downloadJson, h } from '../ui/deanon/dom.js';
import { madeByLine, helpLink } from '../ui/brand.js';
import { guardRegex } from './regex-guard.js';
import { CATEGORIES_KIND, CONFIG_KIND, KEPT_ON_RESET, NOT_EXPORTED, parseCategoriesFile, parseConfigFile } from './config-io.js';
import { companiesFile, isOwnerBrand, isRiskyCompanyName, mergeCompanies, parseAliases, parseCompaniesFile } from './companies-io.js';
import {
  MAX_PACK_BYTES,
  MODEL_STORE_ERROR_CODES,
  ModelStoreError,
  inspectPack,
  install,
  isAvailable as modelStoreAvailable,
  listInstalled,
  remove as removeModel,
} from '../shared/model-store.js';
import { connectClient } from '../shared/port-client.js';
import { MSG } from '../shared/protocol.js';

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

// ---------- что маскируется (политика 0.4) ----------

// Политика 0.4 (docs/concept-0.4.md, решения владельца 1–3 и 5; К1): персональные данные и идентификаторы — всегда,
// без переключателей (чипы из CATEGORY_GROUPS); коммерческая информация — переключатель группы `commercial`
// и прежние переключатели категорий внутри (активны всегда, действуют при включённой группе).
function categoriesSection() {
  const catalog = buildCatalog(settings);
  const chip = (id) => {
    const c = catalog.byId.get(id);
    return h(
      'span',
      { class: 'chip', dataset: { testid: `always-${id}` } },
      h('span', { class: 'dot', style: `background:${c?.color || '#888'}` }),
      c?.label[lang] || id,
    );
  };
  const always = (group, title, hint) =>
    h(
      'div',
      { class: 'group', dataset: { testid: `group-${group}` } },
      h('h3', {}, title),
      h('p', { class: 'hint' }, hint),
      h('div', { class: 'chips' }, CATEGORY_GROUPS[group].map(chip)),
    );
  const inner = h(
    'div',
    { class: `cat-grid${settings.commercial ? '' : ' muted'}`, dataset: { testid: 'commercial-categories' } },
    CATEGORY_GROUPS.commercial.map((id) => {
      const c = /** @type {any} */ (catalog.byId.get(id));
      const on = typeof settings.categories[id] === 'boolean' ? settings.categories[id] : c.defaultOn;
      const name = h('span', {}, h('span', { class: 'dot', style: `background:${c.color}` }), c.label[lang]);
      return toggle(name, c.defaultOn ? null : t('default_off'), on, (v, el) => save({ categories: { ...settings.categories, [id]: v } }, el), `cat-${id}`);
    }),
  );
  const innerHint = h('p', { class: 'hint', hidden: !!settings.commercial, dataset: { testid: 'commercial-off-hint' } }, t('commercial_off_hint'));
  const commercial = toggle(
    t('commercial'),
    t('commercial_hint'),
    settings.commercial === true,
    async (v, el) => {
      if (await save({ commercial: v }, el)) {
        inner.classList.toggle('muted', !v);
        innerHint.hidden = v;
      }
    },
    'commercial',
  );
  return card(
    'categories',
    t('categories_h'),
    t('categories_hint'),
    always('pii', t('group_pii_h'), t('group_pii_hint')),
    always('ids', t('group_ids_h'), t('group_ids_hint')),
    h('div', { class: 'group', dataset: { testid: 'group-commercial' } }, h('h3', {}, t('group_commercial_h')), commercial, innerHint, inner),
  );
}

// ---------- компании для маскирования (политика 0.4, Ц3) ----------

// Список settings.maskedCompanies: ищется во всех документах независимо от группы «Коммерческая информация»
// (detect/names/company-list.js); пополняется и из панели («Маскировать всегда», «запомнить»).
// Итог импорта переживает перерисовку страницы (onSettingsChanged после сохранения списка) — как nerNote
const companiesNote = { text: '' };

function companiesSection() {
  const box = h('div', { dataset: { testid: 'company-list' } });
  const err = h('div', { class: 'err' });
  const msg = h('div', { class: 'hint', role: 'status', dataset: { testid: 'companies-msg' } }, companiesNote.text);
  const note = (text) => {
    companiesNote.text = text;
    const el = document.querySelector('[data-testid="companies-msg"]');
    if (el) el.textContent = text;
    else msg.textContent = text;
  };
  const warn = h('div', { class: 'hint warn', hidden: true, dataset: { testid: 'company-short' } }, t('company_short'));
  // бренд владельца не маскируется никогда (решение 6): запись сохранится, но искаться не будет
  const brand = h('div', { class: 'hint warn', hidden: true, dataset: { testid: 'company-brand' } }, t('company_brand'));
  const checkName = (v) => {
    brand.hidden = !isOwnerBrand(v);
    warn.hidden = !brand.hidden || !isRiskyCompanyName(v);
  };
  const name = h('input', {
    type: 'text',
    maxLength: 120,
    'aria-label': t('company_name'),
    placeholder: t('company_name_placeholder'),
    dataset: { testid: 'company-name' },
  });
  const list = () => settings.maskedCompanies || [];
  const draw = () => {
    box.replaceChildren(
      list().length
        ? h(
            'div',
            { class: 'company-rows' },
            list().map((c, i) =>
              h(
                'div',
                { class: 'company-row', dataset: { testid: 'company-item' } },
                h(
                  'div',
                  { class: 'chips' },
                  h(
                    'span',
                    { class: 'chip' },
                    c.name,
                    h(
                      'button',
                      {
                        type: 'button',
                        title: t('remove'),
                        'aria-label': `${t('remove')} ${c.name}`,
                        dataset: { testid: `company-remove-${i}` },
                        onclick: async () => {
                          await save({ maskedCompanies: list().filter((_, j) => j !== i) });
                          draw();
                        },
                      },
                      '×',
                    ),
                  ),
                ),
                h('input', {
                  type: 'text',
                  value: (c.aliases || []).join(', '),
                  placeholder: t('company_aliases'),
                  'aria-label': `${t('company_aliases')}: ${c.name}`,
                  dataset: { testid: `company-aliases-${i}` },
                  onchange: (e) => {
                    const aliases = parseAliases(e.target.value);
                    save({ maskedCompanies: list().map((x, j) => (j === i ? { name: x.name, aliases } : x)) }, e.target);
                  },
                }),
              ),
            ),
          )
        : h('div', { class: 'empty' }, t('companies_empty')),
    );
  };
  const add = async () => {
    const v = name.value.replace(/\s+/g, ' ').trim();
    if (!v) {
      name.classList.add('invalid');
      err.textContent = t('company_empty');
      return;
    }
    name.classList.remove('invalid');
    err.textContent = '';
    checkName(v);
    const next = mergeCompanies(list(), [{ name: v, aliases: [] }]);
    if (next.length !== list().length && !(await save({ maskedCompanies: next }, name))) return;
    name.value = '';
    draw();
  };
  name.addEventListener('input', () => checkName(name.value));
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') add();
  });
  const fileInput = h('input', {
    type: 'file',
    accept: '.json,application/json',
    hidden: true,
    dataset: { testid: 'companies-import-file' },
    onchange: async () => {
      const f = fileInput.files?.[0];
      fileInput.value = '';
      if (!f) return;
      const r = parseCompaniesFile(await f.text());
      if ('error' in r) {
        note(t('companies_import_bad', { why: r.error }));
        return;
      }
      if (!(await save({ maskedCompanies: mergeCompanies(list(), r.companies) }))) {
        note(t('companies_import_bad', { why: 'max 200' }));
        return;
      }
      note(t('companies_imported', { n: r.companies.length }));
      draw();
    },
  });
  draw();
  return card(
    'companies',
    t('companies_h'),
    t('companies_hint'),
    h(
      'div',
      { class: 'row' },
      h('div', { style: 'flex:2;min-width:200px' }, name),
      h('button', { type: 'button', class: 'btn', dataset: { testid: 'company-add' }, onclick: add }, t('add')),
    ),
    err,
    warn,
    brand,
    box,
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          type: 'button',
          class: 'btn',
          dataset: { testid: 'companies-export' },
          onclick: () => downloadJson('companies.json', companiesFile(list())),
        },
        t('companies_export'),
      ),
      h('button', { type: 'button', class: 'btn', dataset: { testid: 'companies-import' }, onclick: () => fileInput.click() }, t('companies_import')),
      fileInput,
    ),
    msg,
  );
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
    // версия 0.3: PDF с текстовым слоем уходит в чат текстом (.anon.md / .anon.txt) или не перехватывается
    selectField(
      t('pdf_mode'),
      [
        ['markdown', t('pdf_mode_markdown')],
        ['text', t('pdf_mode_text')],
        ['off', t('pdf_mode_off')],
      ],
      settings.pdfMode,
      (v, el) => save({ pdfMode: v }, el),
      'pdf-mode',
    ),
    h('p', { class: 'sec-hint', dataset: { testid: 'pdf-mode-hint' } }, t('pdf_mode_hint')),
    h(
      'div',
      { class: 'stack' },
      toggle(t('keep_metadata'), t('keep_metadata_hint'), settings.keepMetadata, (v, el) => save({ keepMetadata: v }, el), 'keep-metadata'),
      toggle(t('strip_embedded'), t('strip_embedded_hint'), settings.stripEmbedded, (v, el) => save({ stripEmbedded: v }, el), 'strip-embedded'),
      toggle(t('gov_entities'), null, settings.govEntities, (v, el) => save({ govEntities: v }, el), 'gov-entities'),
      // WP7, FR-23: словарный детектор ФИО третьих лиц; не зависит от NER
      toggle(t('dict_names'), t('dict_names_hint'), settings.dictNames, (v, el) => save({ dictNames: v }, el), 'dict-names'),
    ),
  );
}

// ---------- модель NER (WP8, §5.2 NLP) ----------

const RELEASES_URL = 'https://github.com/argmaster-dev/docx-anonymizer/releases';
const EXT_VERSION = typeof __VERSION__ !== 'undefined' ? __VERSION__ : '0.0.0';
/** Встроенный пакет модели полной сборки ({file, id, version, sha256, size}) или null — лёгкая (WP10-C, scripts/build.mjs --with-model). */
const BUNDLED = typeof __BUNDLED_MODEL__ !== 'undefined' ? __BUNDLED_MODEL__ : null;
const NER_ERRORS = new Set(MODEL_STORE_ERROR_CODES);

/** Хост сбрасывает кэш NER-провайдера (MODEL_CHANGED → ACK). Хост недоступен — не страшно: новый воркер прочтёт модель сам. */
async function notifyModelChanged(modelId) {
  let client;
  try {
    client = connectClient();
    await client.request(MSG.MODEL_CHANGED, { modelId });
  } catch {
    /* см. выше */
  } finally {
    try {
      client?.port.disconnect();
    } catch {
      /* порт уже закрыт */
    }
  }
}

// Пакет модели импортируется из файла (сети нет, NFR-01), проверяется по sha256 и хранится в OPFS (src/shared/model-store.js).
// Установлена не больше одной модели: импорт другой удаляет прежнюю.
// Сохранение nerModel может перерисовать страницу (onSettingsChanged) посреди импорта — последнее сообщение
// живёт вне секции и пишется в актуальный элемент.
const nerNote = { text: '', bad: false, /** @type {HTMLElement|null} */ el: null };
/** «Восстановить встроенную модель»/«Повторить» нажата, установка идёт в фоне (WP10-C): переживает перерисовку страницы. */
let nerRestoring = false;
/**
 * Сколько ждать итога автоустановки/восстановления встроенной модели, прежде чем показать «не удалось / повторить»
 * (WP10-C, К15): ответ хоста мог потеряться (service worker уснул, offscreen закрыт) — карточка не должна висеть вечно.
 */
const BUNDLED_WAIT_MS = 60000;
/** Начало ожидания: открытие страницы или нажатие «Восстановить»/«Повторить». */
let bundledWaitFrom = Date.now();
let bundledTimer = 0;
/** refresh актуальной карточки NER (renderApp пересоздаёт её) — для таймера ожидания. */
let nerRefresh = () => {};

/** Восстановление встроенной модели: background ставит пакет из архива расширения сам и отвечает ACK сразу (MSG.MODEL_BOOTSTRAP). */
async function requestBundledBootstrap() {
  const client = connectClient();
  try {
    await client.request(MSG.MODEL_BOOTSTRAP);
  } finally {
    try {
      client.port.disconnect();
    } catch {
      /* порт уже закрыт */
    }
  }
}

function nerSection() {
  const msg = h('div', { class: nerNote.bad ? 'hint err' : 'hint', role: 'status', dataset: { testid: 'ner-msg' } }, nerNote.text);
  nerNote.el = msg;
  const status = h('div', { class: 'ner-status', dataset: { testid: 'ner-status', state: 'loading' } }, t('ner_loading'));
  let installed = [];
  const say = (text, bad = false) => {
    Object.assign(nerNote, { text, bad });
    for (const el of new Set([msg, nerNote.el])) {
      el.textContent = text;
      el.classList.toggle('err', bad);
    }
  };
  const fail = (e) => say(t(`ner_err_${NER_ERRORS.has(e?.code) ? e.code : 'IO'}`), true);
  const label = (m) => ({ name: m.name[lang] || m.name.ru, version: m.version });

  const refresh = async () => {
    if (!modelStoreAvailable()) {
      status.textContent = t('ner_err_UNAVAILABLE');
      importBtn.disabled = true;
      removeBtn.hidden = true;
      restoreBtn.hidden = true;
      return;
    }
    try {
      installed = await listInstalled();
    } catch (e) {
      installed = [];
      fail(e);
    }
    const active = installed.find((m) => m.id === settings.nerModel);
    // WP10-C (docs/contracts.md §6.3): без активной модели. Полная сборка: встроенный пакет ещё не обработан профилем →
    // «устанавливается» (импорт отключён); попытка не удалась или нет итога за BUNDLED_WAIT_MS → «не удалось ({код})» и
    // «Повторить» (импорт включён); обработан, но модель удалена → кнопка «Восстановить». Лёгкая — три шага.
    const bundledPending = !!BUNDLED && !settings.nerModel && settings.bundledModelSha !== BUNDLED.sha256;
    const bundledRemoved = !!BUNDLED && !settings.nerModel && settings.bundledModelSha === BUNDLED.sha256;
    // Неудача: код из bundledModelError (background по MODEL_INSTALLED failed/ERROR) или ожидание дольше BUNDLED_WAIT_MS → TIMEOUT
    const waiting = !active && (bundledPending || (bundledRemoved && nerRestoring));
    const waitLeft = bundledWaitFrom + BUNDLED_WAIT_MS - Date.now();
    const failCode = !!BUNDLED && !active && !settings.nerModel ? settings.bundledModelError || (waiting && waitLeft <= 0 ? 'TIMEOUT' : '') : '';
    clearTimeout(bundledTimer);
    if (waiting && !failCode) bundledTimer = setTimeout(() => nerRefresh(), waitLeft + 50);
    if (failCode && nerRestoring) {
      nerRestoring = false;
      // «устанавливается заново…» сменяется расшифровкой кода, если она есть (коды хранилища), иначе — только статус
      say(NER_ERRORS.has(failCode) ? t(`ner_err_${failCode}`) : '', NER_ERRORS.has(failCode));
    }
    if (active) {
      if (nerRestoring) say(t('ner_imported', label(active))); // «устанавливается заново…» сменяется итогом
      nerRestoring = false;
      const size = t('ner_size_mb', { n: (active.bytes / (1024 * 1024)).toFixed(1) });
      status.dataset.state = 'installed';
      status.replaceChildren(
        t('ner_installed', { ...label(active), size }),
        ' · ',
        h('span', { class: active.verified ? 'ner-verified' : 'ner-unverified' }, t(active.verified ? 'ner_verified' : 'ner_unverified')),
      );
    } else if (failCode) {
      status.dataset.state = 'failed';
      status.textContent = t('ner_bundled_failed', { code: failCode });
    } else if (bundledPending || (bundledRemoved && nerRestoring)) {
      status.dataset.state = 'installing';
      status.textContent = t(bundledPending ? 'ner_bundled_installing' : 'ner_bundled_restoring');
    } else {
      status.dataset.state = 'none';
      status.textContent = t('ner_not_installed');
    }
    importBtn.disabled = !active && bundledPending && !failCode;
    restoreBtn.hidden = !!active || !bundledRemoved || !!failCode;
    restoreBtn.disabled = nerRestoring;
    retryBtn.hidden = !failCode;
    retryBtn.disabled = nerRestoring;
    placeOnboarding(!BUNDLED && !active);
    removeBtn.hidden = !installed.length;
  };

  // Сбой посреди установки мог оставить nerModel без файлов — сбрасываем, чтобы анализ не ссылался на пустоту
  const dropDangling = async () => {
    const list = await listInstalled().catch(() => []);
    if (settings.nerModel && !list.some((m) => m.id === settings.nerModel)) {
      await save({ nerModel: '' });
      await notifyModelChanged('');
    }
  };

  const file = h('input', {
    type: 'file',
    accept: '.zip,application/zip',
    hidden: true,
    dataset: { testid: 'ner-import-file' },
    onchange: async () => {
      const f = file.files?.[0];
      file.value = '';
      if (!f) return;
      importBtn.disabled = true;
      say(t('ner_importing'));
      try {
        // заведомо слишком большой файл не читаем в память целиком (К5)
        if (f.size > MAX_PACK_BYTES) throw new ModelStoreError('TOO_LARGE');
        const bytes = new Uint8Array(await f.arrayBuffer());
        const info = await inspectPack(bytes, { extensionVersion: EXT_VERSION });
        const l = label(info.manifest);
        if (!info.verified && !(await confirmDialog(t('ner_unverified_confirm', l), { ok: t('ner_install'), cancel: t('cancel') }))) {
          say(t('ner_import_cancelled'));
          return;
        }
        const rec = await install(bytes, { verified: info.verified, extensionVersion: EXT_VERSION });
        for (const m of await listInstalled()) if (m.id !== rec.id) await removeModel(m.id);
        await save({ nerModel: rec.id });
        await notifyModelChanged(rec.id);
        say(t('ner_imported', l));
      } catch (e) {
        fail(e);
        await dropDangling();
      } finally {
        importBtn.disabled = false;
        await refresh();
      }
    },
  });
  const importBtn = h('button', { type: 'button', class: 'btn', dataset: { testid: 'ner-import' }, onclick: () => file.click() }, t('ner_import'));
  const removeBtn = h(
    'button',
    {
      type: 'button',
      class: 'btn danger',
      hidden: true,
      dataset: { testid: 'ner-remove' },
      onclick: async () => {
        if (!(await confirmDialog(t('ner_remove_confirm'), { ok: t('ner_remove'), cancel: t('cancel'), danger: true }))) return;
        try {
          for (const m of installed) await removeModel(m.id);
          await save({ nerModel: '' });
          await notifyModelChanged('');
          say(t('ner_removed'));
        } catch (e) {
          fail(e);
        } finally {
          await refresh();
        }
      },
    },
    t('ner_remove'),
  );
  const restoreBtn = h(
    'button',
    {
      type: 'button',
      class: 'btn',
      hidden: true,
      dataset: { testid: 'ner-restore' },
      onclick: () => startBundled(restoreBtn),
    },
    t('ner_bundled_restore'),
  );
  // «Повторить» после неудачной автоустановки (WP10-C, К15): то же, что «Восстановить», и стирает прежний код ошибки
  const retryBtn = h(
    'button',
    { type: 'button', class: 'btn', hidden: true, dataset: { testid: 'ner-retry' }, onclick: () => startBundled(retryBtn) },
    t('ner_bundled_retry'),
  );
  async function startBundled(btn) {
    nerRestoring = true;
    bundledWaitFrom = Date.now();
    btn.disabled = true;
    status.dataset.state = 'installing';
    status.textContent = t('ner_bundled_restoring');
    say(t('ner_bundled_restoring'));
    try {
      // ошибку стирает и background в начале попытки; здесь — чтобы перерисовка до его записи не вернула «не удалось»
      if (settings.bundledModelError) settings = (await saveSettingsPatch({ bundledModelError: '' })).settings;
      await requestBundledBootstrap(); // итог придёт сменой настроек (nerModel / bundledModelError) → перерисовка карточки
    } catch (e) {
      nerRestoring = false;
      fail(e);
      await refresh();
    }
  }

  // Онбординг лёгкой сборки (WP10-C, К16): три шага, пока модели нет. Ссылка на релизы и кнопка импорта — те же элементы,
  // что в обычном виде карточки (testid не дублируются): переезжают в шаги и обратно.
  const releasesLink = h('a', { href: RELEASES_URL, target: '_blank', rel: 'noopener', dataset: { testid: 'ner-releases-link' } }, t('ner_releases'));
  const linkHome = h('p', { class: 'hint' });
  const step1 = h('li', {}, h('span', {}, t('ner_step_1')), ' ');
  const step2 = h('li', {}, h('span', {}, t('ner_step_2')), h('div', { class: 'row', style: 'margin-top:6px' }));
  const onboarding = h(
    'div',
    { class: 'ner-onboarding', hidden: true, dataset: { testid: 'ner-onboarding' } },
    h('h3', {}, t('ner_onboard_h')),
    h('ol', { class: 'steps' }, step1, step2, h('li', {}, t('ner_step_3'))),
  );
  const row = h('div', { class: 'row', style: 'margin-top:10px' }, importBtn, file, removeBtn, restoreBtn, retryBtn);
  function placeOnboarding(on) {
    onboarding.hidden = !on;
    if (on) {
      step1.append(releasesLink);
      step2.lastElementChild.append(importBtn);
    } else {
      linkHome.append(releasesLink);
      row.prepend(importBtn);
    }
  }
  placeOnboarding(!BUNDLED && !settings.nerModel);

  const threshold = h('input', {
    type: 'number',
    min: 0,
    max: 1,
    step: 0.05,
    value: String(settings.nerThreshold),
    dataset: { testid: 'ner-threshold' },
    id: 'ner-threshold',
  });
  threshold.addEventListener('input', () => {
    const v = threshold.value.trim() === '' ? NaN : Number(threshold.value);
    save({ nerThreshold: v }, threshold);
  });
  // Политика 0.4 (концепция п. 4, К10): свой порог для организаций и дополнение стоп-списка модельных организаций
  const thresholdOrg = h('input', {
    type: 'number',
    min: 0,
    max: 1,
    step: 0.05,
    value: String(settings.nerThresholdOrg ?? 0.85),
    dataset: { testid: 'ner-threshold-org' },
    id: 'ner-threshold-org',
  });
  thresholdOrg.addEventListener('input', () => {
    const v = thresholdOrg.value.trim() === '' ? NaN : Number(thresholdOrg.value);
    save({ nerThresholdOrg: v }, thresholdOrg);
  });
  const stoplist = h('textarea', {
    rows: 4,
    id: 'ner-stoplist',
    spellcheck: false,
    placeholder: t('ner_stoplist_placeholder'),
    dataset: { testid: 'ner-stoplist' },
  });
  stoplist.value = (settings.nerStoplist || []).join('\n');
  stoplist.addEventListener('change', () => save({ nerStoplist: [...new Set(lines(stoplist.value))] }, stoplist));

  nerRefresh = refresh;
  refresh();
  return card(
    'ner',
    t('ner_h'),
    t('ner_hint'),
    toggle(t('ner_enabled'), t('ner_enabled_hint'), settings.nerEnabled, (v, el) => save({ nerEnabled: v }, el), 'ner-enabled'),
    h('div', { class: 'field' }, h('label', { for: 'ner-threshold' }, t('ner_threshold')), threshold),
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'ner-threshold-org' }, t('ner_threshold_org')),
      thresholdOrg,
      h('div', { class: 'hint' }, t('ner_threshold_org_hint')),
    ),
    h('div', { class: 'field' }, h('label', { for: 'ner-stoplist' }, t('ner_stoplist')), stoplist, h('div', { class: 'hint' }, t('ner_stoplist_hint'))),
    h('div', { class: 'field' }, status),
    onboarding,
    row,
    msg,
    linkHome,
    h('p', { class: 'hint', dataset: { testid: 'ner-privacy' } }, t('ner_privacy')),
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
            downloadJson('docx-anonymizer.config.json', {
              kind: CONFIG_KIND,
              version: 1,
              schemaVersion: SETTINGS_SCHEMA_VERSION,
              exportedAt: new Date().toISOString(),
              settings: s,
            });
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
            // модель и её автоустановка — состояние этого браузера, не настройка (как в экспорте): сброс их не трогает,
            // иначе полная сборка показала бы «устанавливается…» без попытки установки (WP10-C)
            await save({ ...defaultSettings(), ...Object.fromEntries(KEPT_ON_RESET.map((k) => [k, settings[k]])) });
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
    ['companies', 'nav_companies'],
    ['processing', 'nav_processing'],
    ['ner', 'nav_ner'],
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
        companiesSection(),
        processingSection(),
        nerSection(),
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
  // Карточки строятся динамически — браузер не прокрутил к якорю при загрузке (options.html#ner из popup, WP10-C)
  if (location.hash.length > 1) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
  onSettingsChanged((s) => {
    // Изменения из другой вкладки/popup: обновляем состояние и перерисовываем, если пользователь сейчас ничего не вводит
    const same = JSON.stringify(s) === JSON.stringify(settings);
    settings = s;
    const a = document.activeElement;
    if (!same && !document.querySelector('dialog[open]') && !(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) renderApp();
  });
}

if (typeof document !== 'undefined' && document.getElementById('app')) init();
