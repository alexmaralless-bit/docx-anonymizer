// Popup (§3.2a, FR-42): тумблер перехвата с состоянием для текущего сайта, недавние сессии, «Восстановить», «Настройки».
// Блок «Проверка конвейера (dev)» оставлен для tests/e2e/pipeline.spec.js.
import { connectClient } from '../shared/port-client.js';
import { MSG } from '../shared/protocol.js';
import { loadSettings, saveSettingsPatch, onSettingsChanged } from '../shared/settings-store.js';
import { siteState, relativeTime } from '../ui/components/site-state.js';
import { createT, resolveUiLanguage } from '../ui/i18n/index.js';
import { common } from '../ui/i18n/common.js';
import { popup as popupDict } from '../ui/i18n/popup.js';
import { h, clear } from '../ui/components/dom.js';
import { matchOrigin } from '../core/sites.js';

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
let settings;
let tabUrl;
let t = (k) => k;

async function currentTabUrl() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.url;
  } catch {
    return undefined;
  }
}

function applyLanguage() {
  const lang = resolveUiLanguage(settings.uiLanguage);
  t = createT({ ru: { ...common.ru, ...popupDict.ru }, en: { ...common.en, ...popupDict.en } }, lang);
  document.documentElement.lang = lang;
  $('t-intercept').textContent = t('interceptLabel');
  $('t-hint').textContent = t('interceptHint');
  $('t-recent').textContent = t('recent');
  $('recent-empty').textContent = t('recentEmpty');
  $('open-restore').textContent = t('restore');
  $('open-options').textContent = t('options');
  $('open-help').textContent = t('help');
  $('made-by').firstChild.textContent = `${t('madeBy')} `;
  $('t-dev').textContent = t('devTitle');
}

function renderSite() {
  const toggle = /** @type {HTMLInputElement} */ ($('intercept-toggle'));
  toggle.checked = settings.interceptEnabled;
  const st = siteState(settings, tabUrl);
  const status = $('site-status');
  const actions = $('site-actions');
  clear(actions);
  status.dataset.state = st.state;
  const btn = (text, patch, testid) => h('button', { class: 'btn-sm', type: 'button', text, 'data-testid': testid, onClick: () => saveSettingsPatch(patch) });
  switch (st.state) {
    case 'unsupported':
      status.textContent = t('siteUnsupported');
      break;
    case 'on':
      status.textContent = t('siteOn', { host: st.host });
      actions.append(btn(t('blockSite', { host: st.host }), { blocklist: [...settings.blocklist, st.origin] }, 'site-block'));
      break;
    case 'notListed':
      status.textContent = t('siteNotListed', { host: st.host });
      actions.append(btn(t('addSite', { host: st.host }), { allowlist: [...settings.allowlist, st.origin] }, 'site-add'));
      break;
    case 'blocked':
      status.textContent = t('siteBlocked', { host: st.host });
      actions.append(btn(t('removeBlock', { host: st.host }), { blocklist: settings.blocklist.filter((p) => !matchOrigin(p, st.origin)) }, 'site-unblock'));
      break;
    default:
      status.textContent = t('siteOff');
  }
}

async function renderRecent() {
  const list = $('recent-list');
  clear(list);
  let sessions;
  const client = connectClient();
  try {
    const r = await client.request(MSG.LIST_SESSIONS);
    sessions = (r.sessions || []).sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);
  } catch {
    sessions = [];
  } finally {
    client.port.disconnect();
  }
  $('recent-empty').hidden = sessions.length > 0;
  const now = Date.now();
  for (const s of sessions) {
    const host = s.origin ? new URL(s.origin).host : '';
    list.append(
      h(
        'li',
        { class: 'item', 'data-testid': 'recent-item' },
        h(
          'div',
          { class: 'item-main' },
          h('b', { class: 'item-name', title: s.name, text: s.name }),
          h('small', { text: [relativeTime(s.createdAt, now, t), host, t('entities', { n: s.entities })].filter(Boolean).join(' · ') }),
        ),
        h('button', {
          class: 'btn-sm',
          type: 'button',
          text: t('restoreFor'),
          'data-testid': 'recent-restore',
          onClick: () => chrome.tabs.create({ url: chrome.runtime.getURL(`restore/restore.html?docId=${encodeURIComponent(s.docId)}`) }),
        }),
      ),
    );
  }
}

async function init() {
  settings = await loadSettings();
  tabUrl = await currentTabUrl();
  applyLanguage();
  renderSite();
  const toggle = /** @type {HTMLInputElement} */ ($('intercept-toggle'));
  toggle.addEventListener('change', () => saveSettingsPatch({ interceptEnabled: toggle.checked }));
  onSettingsChanged((s) => {
    settings = s;
    applyLanguage();
    renderSite();
  });
  $('open-options').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  $('open-restore').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('restore/restore.html') });
  });
  $('dev-file').addEventListener('change', onDevFile);
  renderRecent();
}

async function onDevFile(e) {
  const input = /** @type {HTMLInputElement} */ (e.target);
  const file = input.files?.[0];
  if (!file) return;
  const status = $('dev-status');
  const client = connectClient();
  try {
    status.textContent = 'Чтение…';
    const bytes = new Uint8Array(await file.arrayBuffer());
    const res = await client.analyzeFile({
      name: file.name,
      bytes,
      origin: location.origin,
      onProgress: (stage, p) => (status.textContent = `${stage}: ${p}%`),
    });
    $('dev-result').hidden = false;
    $('dev-result').querySelector('[data-testid="vt-length"]').textContent = String(res.stats.virtualTextLength);
    $('dev-result').querySelector('[data-testid="entity-count"]').textContent = String(res.entities.length);
    status.textContent = 'Применение…';
    const out = await client.apply({ docId: res.docId, decisions: [] });
    $('dev-result').querySelector('[data-testid="result-size"]').textContent = String(out.bytes.length);
    const a = /** @type {HTMLAnchorElement} */ ($('dev-download'));
    a.href = URL.createObjectURL(new Blob([out.bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
    a.download = out.name;
    a.hidden = false;
    status.textContent = `Готово: ${out.name}`;
  } catch (err) {
    status.textContent = `Ошибка: ${err.code || ''} ${err.message}`;
  } finally {
    client.port.disconnect();
  }
}

init();
