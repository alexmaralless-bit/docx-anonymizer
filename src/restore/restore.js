// Обратная замена (С3, FR-36, FR-37): текст с плейсхолдерами + маппинг (сессия или .mapping.json) → текст с реальными значениями.
// Сессия: порт 'docx' → LIST_SESSIONS / DEANON {mappingRef: docId}. Файл: разбор на странице, замена ядром deanonymize().
import './restore.css';
import { deanonymize } from '../core/deanon.js';
import { MSG } from '../shared/protocol.js';
import { connectClient } from '../shared/port-client.js';
import { loadSettings } from '../shared/settings-store.js';
import { createT, resolveUiLanguage } from '../ui/i18n/index.js';
import { RESTORE_DICT } from '../ui/i18n/restore.js';
import { countUnresolved, parseMappingFiles, toSegments } from '../ui/deanon/index.js';
import { h } from '../ui/deanon/dom.js';
import { madeByLine, helpLink } from '../ui/brand.js';

let t = createT(RESTORE_DICT, 'ru');
let client = null;
/** @type {{docId: string, name: string, createdAt: number, entities: number}[]} */
let sessions = [];
let source = 'session';
let sessionId = '';
let fileMapping = null;

const getClient = () => (client ||= connectClient());

async function init() {
  const settings = await loadSettings();
  const lang = resolveUiLanguage(settings.uiLanguage);
  t = createT(RESTORE_DICT, lang);
  document.documentElement.lang = lang;
  document.title = `DOCX Anonymizer — ${t('title').toLowerCase()}`;
  try {
    const r = await getClient().request(MSG.LIST_SESSIONS);
    sessions = [...(r.sessions || [])].sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    sessions = [];
  }
  sessionId = sessions[0]?.docId || '';
  if (!sessions.length) source = 'file';
  render(lang);
}

function render(lang) {
  const input = h('textarea', { class: 'big', placeholder: t('input_placeholder'), dataset: { testid: 'restore-input' }, 'aria-label': t('input_h') });
  const out = h('div', { class: 'result placeholder', dataset: { testid: 'restore-output' }, 'aria-live': 'polite' }, t('result_empty'));
  const stat = h('div', { class: 'hint', dataset: { testid: 'restore-stat' } });
  const unres = h('div', { dataset: { testid: 'restore-unresolved' } });
  const msg = h('div', { class: 'err', role: 'alert', dataset: { testid: 'restore-error' } });
  const copyBtn = h('button', { type: 'button', class: 'btn', disabled: true, dataset: { testid: 'restore-copy' } }, t('copy'));
  let lastText = '';

  const sourceBox = h('div');
  const drawSource = () => {
    const seg = h(
      'div',
      { class: 'seg', role: 'radiogroup', 'aria-label': t('source_h') },
      [
        ['session', t('source_session')],
        ['file', t('source_file')],
      ].map(([v, text]) =>
        h(
          'label',
          {},
          h('input', {
            type: 'radio',
            name: 'source',
            value: v,
            checked: source === v,
            dataset: { testid: `source-${v}` },
            onchange: () => {
              source = v;
              drawSource();
            },
          }),
          text,
        ),
      ),
    );
    let body;
    if (source === 'session') {
      body = sessions.length
        ? h(
            'div',
            { class: 'sessions', role: 'radiogroup', 'aria-label': t('session_pick') },
            sessions.map((s) =>
              h(
                'label',
                { class: 'sess' },
                h('input', {
                  type: 'radio',
                  name: 'session',
                  value: s.docId,
                  checked: s.docId === sessionId,
                  dataset: { testid: 'session-radio' },
                  onchange: () => (sessionId = s.docId),
                }),
                t('session_item', { name: s.name, time: new Date(s.createdAt).toLocaleString(lang), n: s.entities }),
              ),
            ),
          )
        : h('div', { class: 'empty' }, t('session_none'));
    } else {
      const info = h('div', { class: 'hint', dataset: { testid: 'file-info' } });
      if (fileMapping) info.textContent = t('file_loaded', { n: fileMapping.entries.length });
      const file = h('input', {
        type: 'file',
        multiple: true,
        accept: '.json,application/json',
        dataset: { testid: 'mapping-file' },
        'aria-label': t('file_pick'),
        onchange: async () => {
          const texts = await Promise.all([...file.files].map((f) => f.text()));
          const r = parseMappingFiles(texts);
          if (r.error) {
            fileMapping = null;
            info.className = 'err';
            info.textContent = t('file_bad', { why: t(r.error === 'json' ? 'file_bad_json' : 'file_bad_shape') });
          } else {
            fileMapping = r.mapping;
            info.className = 'hint';
            info.textContent = t('file_loaded', { n: r.mapping.entries.length });
          }
        },
      });
      body = h('div', { class: 'field' }, h('span', { class: 'lbl' }, t('file_pick')), file, info);
    }
    sourceBox.replaceChildren(seg, body);
  };
  drawSource();

  const run = async () => {
    msg.textContent = '';
    const text = input.value;
    if (!text.trim()) {
      msg.textContent = t('need_text');
      return;
    }
    let r;
    try {
      if (source === 'file') {
        if (!fileMapping) {
          msg.textContent = t('need_mapping');
          return;
        }
        r = deanonymize(text, fileMapping);
      } else {
        if (!sessionId) {
          msg.textContent = t('need_mapping');
          return;
        }
        const res = await getClient().request(MSG.DEANON, { mappingRef: sessionId, text });
        r = { text: res.text, unresolved: res.unresolved || [], replaced: res.replaced };
      }
    } catch (err) {
      const m = String(err?.message || err);
      msg.textContent = /Маппинг не найден/.test(m) ? t('session_missing') : t('error', { msg: m });
      return;
    }
    lastText = r.text;
    out.className = 'result';
    out.replaceChildren(
      ...toSegments(r.text, r.unresolved).map((s) => (s.unresolved ? h('mark', { dataset: { testid: 'unresolved-mark' } }, s.text) : s.text)),
    );
    stat.textContent = t('stat', { n: r.replaced });
    copyBtn.disabled = false;
    const groups = countUnresolved(r.unresolved);
    unres.replaceChildren(
      groups.length
        ? h(
            'div',
            {},
            h('strong', {}, t('unresolved_h', { n: r.unresolved.length })),
            h('p', { class: 'hint' }, t('unresolved_hint')),
            h(
              'ul',
              { class: 'unres' },
              groups.map((g) => h('li', {}, h('mark', {}, g.text), g.count > 1 ? ` × ${g.count}` : '')),
            ),
          )
        : h('div', { class: 'good' }, t('unresolved_none')),
    );
  };

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(lastText);
      copyBtn.textContent = t('copied');
    } catch {
      const range = document.createRange();
      range.selectNodeContents(out);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
    }
    setTimeout(() => (copyBtn.textContent = t('copy')), 1500);
  });

  document
    .getElementById('app')
    .replaceChildren(
      h(
        'div',
        { class: 'restore' },
        h('header', { class: 'page-head' }, h('h1', {}, t('title')), h('p', {}, t('subtitle'))),
        h('section', { class: 'card' }, h('h2', {}, t('input_h')), input),
        h('section', { class: 'card' }, h('h2', {}, t('source_h')), sourceBox),
        h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', dataset: { testid: 'restore-run' }, onclick: run }, t('restore')), msg),
        h(
          'section',
          { class: 'card' },
          h('h2', {}, t('result_h')),
          out,
          h('div', { class: 'row between', style: 'margin-top:10px' }, stat, copyBtn),
          unres,
          h('p', { class: 'hint' }, t('declension_hint')),
        ),
        h('div', { class: 'row between' }, helpLink(lang), madeByLine(lang)),
      ),
    );
}

init();
