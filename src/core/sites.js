// Сопоставление сайта с allowlist/blocklist (FR-07, FR-35).

/**
 * Совпадает ли origin с шаблоном 'https://chatgpt.com' или 'https://*.example.com'.
 * @param {string} pattern
 * @param {string} origin
 */
export function matchOrigin(pattern, origin) {
  let p;
  let o;
  try {
    o = new URL(origin);
    p = new URL(pattern.replace('://*.', '://wildcard.'));
  } catch {
    return false;
  }
  if (p.protocol !== o.protocol || p.port !== o.port) return false;
  if (pattern.includes('://*.')) {
    const base = p.hostname.slice('wildcard.'.length);
    return o.hostname === base || o.hostname.endsWith('.' + base);
  }
  return p.hostname === o.hostname;
}

/**
 * Разрешён ли сайт режимом siteMode (без учёта interceptEnabled).
 * @param {{siteMode: string, allowlist: string[], blocklist: string[]}} settings
 * @param {string} origin
 */
export function isOriginAllowed(settings, origin) {
  if (settings.blocklist.some((p) => matchOrigin(p, origin))) return false;
  if (settings.siteMode === 'all') return true;
  return settings.allowlist.some((p) => matchOrigin(p, origin));
}

/** Перехват активен на origin: тумблер включён И сайт разрешён (FR-07). */
export function isInterceptActive(settings, origin) {
  return !!settings.interceptEnabled && isOriginAllowed(settings, origin);
}
