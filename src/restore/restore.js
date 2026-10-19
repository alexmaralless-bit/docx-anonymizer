// Обратная замена (С3, FR-36, FR-36а, FR-37): ответ ИИ с плейсхолдерами + маппинг (сессия или .mapping.json) → настоящие значения.
// Ответ — вставленный текст или файл от ИИ (.docx/.docm/.md/.txt, WP10-B). Карта: из файла (разбор на странице) или из сессии
// по GET_MAPPING; замена всегда идёт здесь, ядром: restoreText() для текста, restoreDocx() для DOCX (форматирование сохраняется).
// Склонение ФИО по контексту (FR-37, редакция 0.2) включено по умолчанию; склонённые подстановки подсвечиваются зелёным.
import './restore.css';
import { restoreDocx, restoreText } from '../core/restore-doc.js';
import { MSG } from '../shared/protocol.js';
import { connectClient } from '../shared/port-client.js';
import { loadSettings } from '../shared/settings-store.js';
import { createT, resolveUiLanguage } from '../ui/i18n/index.js';
import { RESTORE_DICT } from '../ui/i18n/restore.js';
import { aiFileKind, countUnresolved, mimeFor, parseMappingFiles, pickSession, restoredName, toSegments } from '../ui/deanon/index.js';
import { downloadBlob, h } from '../ui/deanon/dom.js';
import { madeByLine, helpLink } from '../ui/brand.js';

let t = createT(RESTORE_DICT, 'ru');
let client = null;
/** @type {{maxFileSizeMB: number, outputSuffix: string}} */
let limits = { maxFileSizeMB: 50, outputSuffix: '.anon' };
/** @type {{docId: string, name: string, createdAt: number, entities: number}[]} */
let sessions = [];
let source = 'session';
let sessionId = '';
let fileMapping = null;
/** Что восстанавливаем: вставленный текст или файл от ИИ (FR-36а) */
let mode = 'text';
/** @type {{name: string, size: number, kind: 'docx'|'text', bytes?: Uint8Array, text?: string} | null} */
let aiFile = null;
/** Склонять ФИО по контексту метки (FR-37) */
let decline = true;

const getClient = () => (client ||= connectClient());

async function init() {
  const settings = await loadSettings();
  const lang = resolveUiLanguage(settings.uiLanguage);
  t = createT(RESTORE_DICT, lang);
  limits = { maxFileSizeMB: settings.maxFileSizeMB || 50, outputSuffix: settings.outputSuffix || '.anon' };
  document.documentElement.lang = lang;
  document.title = `DOCX Anonymizer — ${t('title').toLowerCase()}`;
  try {
    const r = await getClient().request(MSG.LIST_SESSIONS);
    sessions = [...(r.sessions || [])].sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    sessions = [];
  }
  // popup открывает страницу как restore.html?docId=… — предвыбираем эту обработку (неизвестная → самая свежая)
  sessionId = pickSession(sessions, new URLSearchParams(location.search).get('docId'));
  if (!sessions.length) source = 'file';
  render(lang);
}

/** Радиогруппа-переключатель в стиле .seg. */
function segGroup(name, label, options, current, onPick, testPrefix) {
  return h(
    'div',
    { class: 'seg', role: 'radiogroup', 'aria-label': label },
    options.map(([v, text]) =>
      h(
        'label',
        {},
        h('input', { type: 'radio', name, value: v, checked: current === v, dataset: { testid: `${testPrefix}${v}` }, onchange: () => onPick(v) }),
        text,
      ),
    ),
  );
}

function render(lang) {
  const input = h('textarea', { class: 'big', placeholder: t('input_placeholder'), dataset: { testid: 'restore-input' }, 'aria-label': t('input_h') });
  const out = h('div', { class: 'result placeholder', dataset: { testid: 'restore-output' }, 'aria-live': 'polite' }, t('result_empty'));
  const stat = h('div', { class: 'hint', dataset: { testid: 'restore-stat' } });
  const unres = h('div', { dataset: { testid: 'restore-unresolved' } });
  const msg = h('div', { class: 'err', role: 'alert', dataset: { testid: 'restore-error' } });
  const declineBox = h(
    'label',
    { class: 'check' },
    h('input', { type: 'checkbox', checked: decline, dataset: { testid: 'restore-decline' }, onchange: (e) => (decline = e.target.checked) }),
    t('decline_label'),
  );
  const copyBtn = h('button', { type: 'button', class: 'btn', disabled: true, dataset: { testid: 'restore-copy' } }, t('copy'));
  const downloadBtn = h('button', { type: 'button', class: 'btn', disabled: true, dataset: { testid: 'restore-download' } }, t('download'));
  let lastText = '';
  /** @type {{name: string, blob: Blob} | null} */
  let lastDownload = null;

  /* ---------- 1. Ответ ИИ: текст или файл ---------- */
  const inputBox = h('div', { class: 'input-box' });
  const fileInfo = h('div', { class: 'hint', dataset: { testid: 'ai-file-info' } });
  const aiInput = h('input', {
    type: 'file',
    accept: '.docx,.docm,.md,.txt,.markdown',
    dataset: { testid: 'ai-file' },
    'aria-label': t('ai_file_pick'),
    onchange: async () => {
      const f = aiInput.files?.[0];
      aiFile = null;
      fileInfo.className = 'err';
      if (!f) return (fileInfo.textContent = '');
      const kind = aiFileKind(f.name);
      if (!kind) return (fileInfo.textContent = t('ai_file_bad'));
      if (f.size > limits.maxFileSizeMB * 1024 * 1024) return (fileInfo.textContent = t('file_too_big', { limit: limits.maxFileSizeMB }));
      try {
        aiFile =
          kind === 'docx'
            ? { name: f.name, size: f.size, kind, bytes: new Uint8Array(await f.arrayBuffer()) }
            : { name: f.name, size: f.size, kind, text: await f.text() };
      } catch (err) {
        return (fileInfo.textContent = t('error', { msg: String(err?.message || err) }));
      }
      fileInfo.className = 'hint';
      fileInfo.textContent = t('ai_file_loaded', { name: f.name, kb: Math.max(1, Math.round(f.size / 1024)) });
    },
  });
  const fileField = h('div', { class: 'field' }, h('span', { class: 'lbl' }, t('ai_file_pick')), aiInput, fileInfo);
  const drawInput = () => {
    const seg = segGroup(
      'mode',
      t('input_h'),
      [
        ['text', t('mode_text')],
        ['file', t('mode_file')],
      ],
      mode,
      (v) => {
        mode = v;
        drawInput();
      },
      'restore-mode-',
    );
    inputBox.replaceChildren(seg, mode === 'text' ? input : fileField);
  };
  drawInput();

  /* ---------- 2. Карта замен ---------- */
  const sourceBox = h('div');
  const drawSource = () => {
    const seg = segGroup(
      'source',
      t('source_h'),
      [
        ['session', t('source_session')],
        ['file', t('source_file')],
      ],
      source,
      (v) => {
        source = v;
        drawSource();
      },
      'source-',
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

  /** Карта: из файла или из сессии (GET_MAPPING); null — сообщение уже показано. */
  const getMapping = async () => {
    if (source === 'file') {
      if (!fileMapping) msg.textContent = t('need_mapping');
      return fileMapping;
    }
    if (!sessionId) {
      msg.textContent = t('need_mapping');
      return null;
    }
    const res = await getClient().request(MSG.GET_MAPPING, { docId: sessionId });
    return res.mapping;
  };

  /** Список нераспознанных меток (общий для текста и DOCX). */
  const showUnresolved = (list) => {
    const groups = countUnresolved(list);
    unres.replaceChildren(
      groups.length
        ? h(
            'div',
            {},
            h('strong', {}, t('unresolved_h', { n: list.length })),
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
  const statLine = (replaced, declinedN) => t('stat', { n: replaced }) + (declinedN ? ` · ${t('declined_stat', { n: declinedN })}` : '');

  const showText = (r) => {
    lastText = r.text;
    out.className = 'result';
    out.replaceChildren(
      ...toSegments(r.text, r.unresolved, r.declined).map((s) => {
        if (s.unresolved) return h('mark', { dataset: { testid: 'unresolved-mark' } }, s.text);
        if (s.declined) {
          const title = t('declined_title', { case: t(`case_${s.item.case}`), original: s.item.original });
          return h('mark', { class: 'declined', title, dataset: { testid: 'declined-mark' } }, s.text);
        }
        return s.text;
      }),
    );
    stat.textContent = statLine(r.replaced, r.declined.length);
    copyBtn.disabled = false;
    showUnresolved(r.unresolved);
  };

  const showDocx = (r) => {
    lastText = '';
    out.className = 'result summary';
    out.replaceChildren(
      h(
        'div',
        { dataset: { testid: 'restore-docx-summary' } },
        h('p', { class: 'good' }, t('docx_done', { n: r.replaced })),
        r.declined.length
          ? h(
              'div',
              {},
              h('strong', {}, t('docx_declined_h', { n: r.declined.length })),
              h(
                'ul',
                { class: 'declined-list' },
                r.declined.map((d) =>
                  h('li', {}, `${t(`case_${d.case}`)} · ${d.original} → `, h('mark', { class: 'declined', dataset: { testid: 'declined-mark' } }, d.text)),
                ),
              ),
            )
          : null,
        r.skipped.length ? h('p', { class: 'err' }, t('docx_skipped', { n: r.skipped.length })) : null,
        h('p', { class: 'hint' }, t('docx_hint')),
      ),
    );
    stat.textContent = statLine(r.replaced, r.declined.length);
    copyBtn.disabled = true;
    showUnresolved(r.unresolved);
  };

  const run = async () => {
    msg.textContent = '';
    lastDownload = null;
    downloadBtn.disabled = true;
    const file = mode === 'file' ? aiFile : null;
    if (mode === 'text' && !input.value.trim()) {
      msg.textContent = t('need_text');
      return;
    }
    if (mode === 'file' && !file) {
      msg.textContent = t('need_file');
      return;
    }
    let mapping;
    try {
      mapping = await getMapping();
    } catch (err) {
      const m = String(err?.message || err);
      msg.textContent = /Маппинг не найден/.test(m) ? t('session_missing') : t('error', { msg: m });
      return;
    }
    if (!mapping) return;
    const name = file ? restoredName(file.name, limits.outputSuffix) : '';
    if (file?.kind === 'docx') {
      let r;
      try {
        r = restoreDocx(/** @type {Uint8Array} */ (file.bytes), mapping, { decline });
      } catch (err) {
        msg.textContent = ['NOT_DOCX', 'ENCRYPTED', 'PARSE_FAILED'].includes(err?.code)
          ? t('error_not_docx')
          : t('error', { msg: String(err?.message || err) });
        return;
      }
      showDocx(r);
      lastDownload = { name, blob: new Blob([r.bytes], { type: mimeFor(name) }) };
    } else {
      const r = restoreText(file ? /** @type {string} */ (file.text) : input.value, mapping, { decline });
      showText(r);
      if (file) lastDownload = { name, blob: new Blob([r.text], { type: mimeFor(name) }) };
    }
    downloadBtn.disabled = !lastDownload;
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
  downloadBtn.addEventListener('click', () => {
    if (lastDownload) downloadBlob(lastDownload.name, lastDownload.blob);
  });

  document
    .getElementById('app')
    .replaceChildren(
      h(
        'div',
        { class: 'restore' },
        h('header', { class: 'page-head' }, h('h1', {}, t('title')), h('p', {}, t('subtitle'))),
        h('section', { class: 'card' }, h('h2', {}, t('input_h')), inputBox),
        h('section', { class: 'card' }, h('h2', {}, t('source_h')), sourceBox),
        h(
          'div',
          { class: 'row' },
          h('button', { type: 'button', class: 'btn primary', dataset: { testid: 'restore-run' }, onclick: run }, t('restore')),
          declineBox,
          msg,
        ),
        h(
          'section',
          { class: 'card' },
          h('h2', {}, t('result_h')),
          out,
          h('div', { class: 'row between', style: 'margin-top:10px' }, stat, h('div', { class: 'row' }, copyBtn, downloadBtn)),
          unres,
          h('p', { class: 'hint' }, t('declension_hint')),
        ),
        h('div', { class: 'row between' }, helpLink(lang), madeByLine(lang)),
      ),
    );
}

init();
