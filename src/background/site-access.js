// Регистрация content script по выданным host-разрешениям (К9 из docs/concept-0.2.md, FR-01, FR-07).
// Статического content_scripts в манифесте нет: скрипт регистрируется через chrome.scripting только для origin,
// к которым пользователь выдал доступ (источник истины — chrome.permissions.getAll().origins). Включение сайта
// в настройках доступа не даёт; content.js сам проверяет allowlist/blocklist (isInterceptActive).
// Слушатели вешаются синхронно при старте service worker (init из background/index.js) — иначе MV3 не разбудит воркер.
import { ALL_URLS } from '../shared/permissions.js';

export const SCRIPT_ID = 'intercept';

const SCRIPT = Object.freeze({
  id: SCRIPT_ID,
  js: ['content.js'],
  allFrames: true,
  runAt: 'document_start',
  persistAcrossSessions: true,
});

// Паттерны, которые годятся для content script (permissions.getAll может вернуть и другие схемы)
const SCRIPTABLE_RE = /^(https?|\*):\/\//;

/**
 * Что сделать с регистрацией, чтобы она совпала с выданными разрешениями. Чистая функция.
 * '<all_urls>' поглощает остальные паттерны.
 * @param {string[]} granted паттерны из chrome.permissions.getAll().origins
 * @param {string[]|null} registered matches зарегистрированного скрипта или null, если его нет
 * @returns {{op: 'none'|'register'|'update'|'unregister', matches: string[]}}
 */
export function planRegistration(granted, registered) {
  const list = (granted || []).filter((p) => p === ALL_URLS || SCRIPTABLE_RE.test(p));
  const matches = list.includes(ALL_URLS) ? [ALL_URLS] : [...new Set(list)].sort();
  if (!matches.length) return { op: registered ? 'unregister' : 'none', matches };
  if (!registered) return { op: 'register', matches };
  const same = registered.length === matches.length && [...registered].sort().every((p, i) => p === matches[i]);
  return { op: same ? 'none' : 'update', matches };
}

/**
 * @param {typeof chrome} [api]
 */
export function createSiteAccess(api = globalThis.chrome) {
  let chain = Promise.resolve();

  async function doSync() {
    const { origins = [] } = await api.permissions.getAll();
    const regs = await api.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
    const current = (regs || []).find((r) => r.id === SCRIPT_ID);
    const plan = planRegistration(origins, current ? current.matches || [] : null);
    if (plan.op === 'register') await api.scripting.registerContentScripts([{ ...SCRIPT, matches: plan.matches }]);
    else if (plan.op === 'update') await api.scripting.updateContentScripts([{ ...SCRIPT, matches: plan.matches }]);
    else if (plan.op === 'unregister') await api.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
    return plan;
  }

  /** Привести регистрацию к выданным разрешениям. Вызовы выполняются строго по очереди (события приходят пачками). */
  function sync() {
    const run = chain.then(doSync);
    chain = run.catch(() => {});
    return run;
  }

  /**
   * Внедрить content script в уже открытые вкладки (регистрация действует только на новые загрузки).
   * Ошибки отдельных вкладок (chrome://, закрыта, нет доступа) не прерывают остальные.
   * @param {string[]} patterns
   * @returns {Promise<number>} во сколько вкладок пытались внедрить
   */
  async function inject(patterns) {
    if (!patterns || !patterns.length) return 0;
    let tabs;
    try {
      tabs = await api.tabs.query({ url: patterns });
    } catch {
      return 0;
    }
    const ids = [...new Set((tabs || []).map((tb) => tb.id).filter((id) => id != null))];
    await Promise.all(
      ids.map((tabId) =>
        Promise.resolve()
          .then(() => api.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] }))
          .catch(() => {}),
      ),
    );
    return ids.length;
  }

  const safeSync = () =>
    sync().catch((e) => {
      console.warn('[docx-anonymizer] site-access sync failed:', e?.message || e); // без адресов и значений (NFR-14)
    });

  function init() {
    api.runtime.onInstalled.addListener(safeSync);
    api.runtime.onStartup?.addListener(safeSync);
    api.permissions.onAdded.addListener((p) => safeSync().then(() => inject(p?.origins || [])));
    api.permissions.onRemoved.addListener(safeSync);
  }

  return { sync, inject, init };
}
