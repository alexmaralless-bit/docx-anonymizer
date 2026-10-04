// Бейдж «ON» и тултип на иконке действия (FR-43). Вызывается из background/index.js синхронно при старте
// service worker — слушатели должны регистрироваться на верхнем уровне, иначе MV3 не разбудит воркер событием.
import { loadSettings } from '../shared/settings-store.js';
import { SETTINGS_KEY } from '../core/settings.js';
import { siteState } from '../ui/components/site-state.js';
import { createT, resolveUiLanguage } from '../ui/i18n/index.js';
import { common } from '../ui/i18n/common.js';

const BADGE_COLOR = '#12703f';

/** Бейдж и тултип для одной вкладки. */
export async function updateTab(tabId, url, settings) {
  try {
    const s = settings || (await loadSettings());
    const t = createT(common, resolveUiLanguage(s.uiLanguage));
    const st = siteState(s, url);
    const on = st.state === 'on';
    const title = on ? t('tooltip.on', { host: st.host }) : st.state === 'notListed' ? t('tooltip.notListed', { host: st.host }) : t('tooltip.off');
    await chrome.action.setBadgeText({ tabId, text: on ? 'ON' : '' });
    if (on) await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR });
    await chrome.action.setTitle({ tabId, title });
  } catch {
    /* вкладка закрыта между событием и обновлением */
  }
}

async function updateAll() {
  const settings = await loadSettings();
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.filter((tb) => tb.id != null).map((tb) => updateTab(/** @type {number} */ (tb.id), tb.url, settings)));
}

export function initBadge() {
  chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    try {
      const tab = await chrome.tabs.get(tabId);
      await updateTab(tabId, tab.url);
    } catch {
      /* вкладки уже нет */
    }
  });
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.url || info.status === 'loading' || info.status === 'complete') updateTab(tabId, tab.url);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[SETTINGS_KEY]) updateAll();
  });
  chrome.runtime.onStartup?.addListener(updateAll);
  chrome.runtime.onInstalled.addListener(updateAll);
}
