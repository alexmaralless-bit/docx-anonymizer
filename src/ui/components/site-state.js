// Состояние перехвата для текущего сайта: popup (3.2a) и бейдж (FR-43). Без chrome.*.
import { isInterceptActive, isOriginAllowed, matchOrigin } from '../../core/sites.js';

/**
 * @param {import('../../core/settings.js').Settings} settings
 * @param {string|undefined} url адрес вкладки
 * @param {{granted?: boolean}} [access] выдан ли доступ к сайту (chrome.permissions); не задано — неизвестно (бейдж)
 * @returns {{state: 'unsupported'|'off'|'on'|'needsAccess'|'notListed'|'blocked', host: string, origin: string}}
 */
export function siteState(settings, url, { granted } = {}) {
  let u;
  try {
    u = new URL(url || '');
  } catch {
    return { state: 'unsupported', host: '', origin: '' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { state: 'unsupported', host: '', origin: '' };
  const origin = u.origin;
  const host = u.host;
  const blocked = settings.blocklist.some((p) => matchOrigin(p, origin));
  if (blocked) return { state: 'blocked', host, origin };
  // К9: настройки разрешают, но Chrome не дал доступа к сайту — content script туда не попадёт
  if (isInterceptActive(settings, origin)) return { state: granted === false ? 'needsAccess' : 'on', host, origin };
  if (settings.interceptEnabled && !isOriginAllowed(settings, origin)) return { state: 'notListed', host, origin };
  return { state: 'off', host, origin };
}

/** Относительное время для списка недавних. */
export function relativeTime(ts, now, t) {
  const min = Math.floor((now - ts) / 60000);
  if (min < 1) return t('time.now');
  if (min < 60) return t('time.min', { n: min });
  return t('time.hour', { n: Math.floor(min / 60) });
}
