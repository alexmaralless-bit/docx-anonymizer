// Доступ к сайтам через опциональные host-разрешения (К9 из docs/concept-0.2.md, FR-07, FR-35).
// В манифесте только optional_host_permissions: ["<all_urls>"]; доступ к конкретному сайту выдаёт пользователь
// через chrome.permissions.request. Источник истины о выданном доступе — chrome.permissions, не настройки.
// Чистые функции (паттерны) отделены от обёрток над chrome.permissions; обёртки принимают api для тестов.

export const ALL_URLS = '<all_urls>';

// Шаблон из настроек: 'https://host', 'https://*.host', 'http://127.0.0.1:8080' (см. isOriginPattern в core/settings.js)
const ORIGIN_PATTERN_RE = /^(https?):\/\/((?:\*\.)?[^/\s*]+)$/i;
// Match pattern Chrome для одного origin: 'https://host/*'
const MATCH_RE = /^(https?):\/\/((?:\*\.)?[^/\s*]+)\/\*$/i;

/**
 * Шаблон origin из настроек → match pattern Chrome (host-permission с путём `/*`). Порт и `*.` сохраняются.
 * 'https://chatgpt.com' → 'https://chatgpt.com/*'; 'https://*.example.com' → 'https://*.example.com/*'.
 * @param {string} originPattern
 * @returns {string|null} null — шаблон не распознан
 */
export function toMatchPattern(originPattern) {
  if (originPattern === ALL_URLS) return ALL_URLS;
  const m = ORIGIN_PATTERN_RE.exec(
    String(originPattern || '')
      .trim()
      .replace(/\/+$/, ''),
  );
  return m ? `${m[1].toLowerCase()}://${m[2].toLowerCase()}/*` : null;
}

/**
 * Обратное преобразование: 'https://host/*' → 'https://host'. Для '<all_urls>' и чужих схем — null.
 * @param {string} match
 * @returns {string|null}
 */
export function originFromPattern(match) {
  const m = MATCH_RE.exec(String(match || ''));
  return m ? `${m[1].toLowerCase()}://${m[2].toLowerCase()}` : null;
}

/**
 * Какие host-разрешения нужны текущим настройкам: режим «все сайты» — '<all_urls>', иначе — сайты allowlist (без дублей).
 * @param {{siteMode: string, allowlist: string[]}} settings
 * @returns {string[]}
 */
export function desiredPatterns(settings) {
  if (settings.siteMode === 'all') return [ALL_URLS];
  return [...new Set((settings.allowlist || []).map(toMatchPattern).filter(Boolean))];
}

/**
 * Запрос доступа. ВАЖНО: chrome.permissions.request работает только из жеста пользователя — вызывайте синхронно
 * в обработчике клика, до любого await. Функция вызывает request синхронно и никогда не отклоняется.
 * @param {string[]} patterns
 * @returns {Promise<boolean>} true — доступ выдан (или уже был)
 */
export function requestOrigins(patterns, api = globalThis.chrome) {
  const origins = patterns.filter(Boolean);
  if (!origins.length) return Promise.resolve(true);
  try {
    return Promise.resolve(api.permissions.request({ origins })).then(Boolean, () => false);
  } catch {
    return Promise.resolve(false);
  }
}

/**
 * Отзыв доступа. Ошибки (например, попытка снять обязательное разрешение в e2e-сборке) глотаются.
 * @param {string[]} patterns
 * @returns {Promise<boolean>}
 */
export async function removeOrigins(patterns, api = globalThis.chrome) {
  const origins = patterns.filter(Boolean);
  if (!origins.length) return true;
  try {
    return Boolean(await api.permissions.remove({ origins }));
  } catch {
    return false;
  }
}

/**
 * Есть ли у расширения постоянный доступ к origin (activeTab сюда не входит).
 * @param {string} origin 'https://chatgpt.com'
 * @returns {Promise<boolean>}
 */
export async function hasOriginAccess(origin, api = globalThis.chrome) {
  const pattern = toMatchPattern(origin);
  if (!pattern) return false;
  try {
    return Boolean(await api.permissions.contains({ origins: [pattern] }));
  } catch {
    return false;
  }
}
