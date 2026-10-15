// Доступ к сайтам (К9): паттерны host-разрешений, план регистрации content script и синхронизация с фейковым chrome.
import { describe, it, expect } from 'vitest';
import { ALL_URLS, desiredPatterns, hasOriginAccess, originFromPattern, removeOrigins, requestOrigins, toMatchPattern } from '../../src/shared/permissions.js';
import { SCRIPT_ID, createSiteAccess, planRegistration } from '../../src/background/site-access.js';

function event() {
  const listeners = [];
  return {
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => listeners.splice(listeners.indexOf(fn), 1),
    fire: (...args) => Promise.all(listeners.map((fn) => fn(...args))),
    get count() {
      return listeners.length;
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Фейковый chrome: разрешения, зарегистрированные скрипты, вкладки; считает вызовы. */
function fakeChrome({ origins = [], tabs = [], failTabs = [], answer = true } = {}) {
  const state = { origins: [...origins], scripts: [], calls: [] };
  const log = (name, arg) => state.calls.push([name, structuredClone(arg)]);
  const later = (v) => new Promise((r) => setTimeout(() => r(v), 1)); // асинхронно, как настоящий API
  const covers = (p) => state.origins.includes(ALL_URLS) || state.origins.includes(p);
  const api = {
    permissions: {
      getAll: () => later({ permissions: ['storage'], origins: [...state.origins] }),
      contains: ({ origins: o }) => later(o.every(covers)),
      request: ({ origins: o }) => {
        log('request', o);
        if (answer) for (const p of o) if (!state.origins.includes(p)) state.origins.push(p);
        return later(answer);
      },
      remove: ({ origins: o }) => {
        log('remove', o);
        state.origins = state.origins.filter((p) => !o.includes(p));
        return later(true);
      },
      onAdded: event(),
      onRemoved: event(),
    },
    scripting: {
      getRegisteredContentScripts: ({ ids } = {}) => later(structuredClone(state.scripts.filter((s) => !ids || ids.includes(s.id)))),
      registerContentScripts: (list) => {
        log('register', list);
        for (const s of list) {
          if (state.scripts.some((x) => x.id === s.id)) return Promise.reject(new Error(`Duplicate script ID '${s.id}'`));
          state.scripts.push(structuredClone(s));
        }
        return later();
      },
      updateContentScripts: (list) => {
        log('update', list);
        for (const s of list)
          Object.assign(
            state.scripts.find((x) => x.id === s.id),
            structuredClone(s),
          );
        return later();
      },
      unregisterContentScripts: ({ ids }) => {
        log('unregister', ids);
        state.scripts = state.scripts.filter((s) => !ids.includes(s.id));
        return later();
      },
      executeScript: (inj) => {
        log('executeScript', inj);
        return failTabs.includes(inj.target.tabId) ? Promise.reject(new Error('Cannot access contents of the page')) : later([{ result: undefined }]);
      },
    },
    tabs: {
      query: ({ url }) => {
        log('tabs.query', url);
        return later(tabs.filter((t) => url.includes(ALL_URLS) || url.some((p) => t.url.startsWith(p.replace('/*', '/')))));
      },
    },
    runtime: { onInstalled: event(), onStartup: event() },
  };
  const count = (name) => state.calls.filter(([n]) => n === name).length;
  return { api, state, count };
}

describe('паттерны host-разрешений', () => {
  it('origin ↔ match pattern: обычный сайт, *. для поддоменов, порт, http', () => {
    const cases = [
      ['https://chatgpt.com', 'https://chatgpt.com/*'],
      ['https://*.example.com', 'https://*.example.com/*'],
      ['http://127.0.0.1:8080', 'http://127.0.0.1:8080/*'],
      ['https://*.corp.example:8443', 'https://*.corp.example:8443/*'],
    ];
    for (const [origin, match] of cases) {
      expect(toMatchPattern(origin)).toBe(match);
      expect(originFromPattern(match)).toBe(origin);
    }
  });

  it('хвостовой слэш и регистр нормализуются; мусор и чужие схемы → null; <all_urls> сохраняется', () => {
    expect(toMatchPattern('HTTPS://ChatGPT.com/')).toBe('https://chatgpt.com/*');
    expect(toMatchPattern(ALL_URLS)).toBe(ALL_URLS);
    for (const bad of ['', 'chatgpt.com', 'ftp://x.ru', 'https://x.ru/path', 'https://*']) expect(toMatchPattern(bad), bad).toBeNull();
    for (const bad of [ALL_URLS, '*://*/*', 'https://x.ru/a/*', 'file:///*']) expect(originFromPattern(bad), bad).toBeNull();
  });

  it('desiredPatterns: режим all → <all_urls>; allowlist → паттерны сайтов без дублей', () => {
    expect(desiredPatterns({ siteMode: 'all', allowlist: ['https://a.ru'] })).toEqual([ALL_URLS]);
    expect(desiredPatterns({ siteMode: 'allowlist', allowlist: ['https://a.ru', 'https://*.b.ru', 'https://a.ru', 'https://a.ru/'] })).toEqual([
      'https://a.ru/*',
      'https://*.b.ru/*',
    ]);
    expect(desiredPatterns({ siteMode: 'allowlist', allowlist: [] })).toEqual([]);
  });

  it('requestOrigins вызывает permissions.request синхронно (жест пользователя) и не отклоняется', async () => {
    const { api, count } = fakeChrome();
    const p = requestOrigins(['https://a.ru/*'], api);
    expect(count('request')).toBe(1); // до первого await
    expect(await p).toBe(true);
    expect(await requestOrigins([], api)).toBe(true);
    const denied = fakeChrome({ answer: false });
    expect(await requestOrigins(['https://a.ru/*'], denied.api)).toBe(false);
    const throwing = { permissions: { request: () => Promise.reject(new Error('This function must be called during a user gesture')) } };
    expect(await requestOrigins(['https://a.ru/*'], throwing)).toBe(false);
    const syncThrow = {
      permissions: {
        request: () => {
          throw new Error('boom');
        },
      },
    };
    expect(await requestOrigins(['https://a.ru/*'], syncThrow)).toBe(false);
  });

  it('removeOrigins глотает ошибку снятия обязательного разрешения; hasOriginAccess — через permissions.contains', async () => {
    const { api, state } = fakeChrome({ origins: ['https://a.ru/*'] });
    expect(await hasOriginAccess('https://a.ru', api)).toBe(true);
    expect(await hasOriginAccess('https://b.ru', api)).toBe(false);
    expect(await hasOriginAccess('не-адрес', api)).toBe(false);
    expect(await removeOrigins(['https://a.ru/*'], api)).toBe(true);
    expect(state.origins).toEqual([]);
    const required = { permissions: { remove: () => Promise.reject(new Error('You cannot remove required permissions.')) } };
    expect(await removeOrigins([ALL_URLS], required)).toBe(false);
    const all = fakeChrome({ origins: [ALL_URLS] });
    expect(await hasOriginAccess('https://b.ru', all.api)).toBe(true);
  });
});

describe('planRegistration', () => {
  it('нет доступа: none или unregister', () => {
    expect(planRegistration([], null)).toEqual({ op: 'none', matches: [] });
    expect(planRegistration([], ['https://a.ru/*'])).toEqual({ op: 'unregister', matches: [] });
  });
  it('доступ появился: register; совпадает: none; изменился: update', () => {
    expect(planRegistration(['https://a.ru/*'], null)).toEqual({ op: 'register', matches: ['https://a.ru/*'] });
    expect(planRegistration(['https://b.ru/*', 'https://a.ru/*'], ['https://a.ru/*', 'https://b.ru/*']).op).toBe('none');
    expect(planRegistration(['https://a.ru/*', 'https://b.ru/*'], ['https://a.ru/*'])).toEqual({ op: 'update', matches: ['https://a.ru/*', 'https://b.ru/*'] });
  });
  it('<all_urls> поглощает остальные; чужие схемы отбрасываются', () => {
    expect(planRegistration(['https://a.ru/*', ALL_URLS], null)).toEqual({ op: 'register', matches: [ALL_URLS] });
    expect(planRegistration([ALL_URLS, 'https://a.ru/*'], [ALL_URLS]).op).toBe('none');
    expect(planRegistration(['chrome://favicon/*'], null).op).toBe('none');
    expect(planRegistration(['https://a.ru/*', 'https://a.ru/*'], null).matches).toEqual(['https://a.ru/*']);
  });
});

describe('createSiteAccess', () => {
  it('sync регистрирует скрипт с нужной формой и идемпотентен', async () => {
    const { api, state, count } = fakeChrome({ origins: ['https://a.ru/*'] });
    const sa = createSiteAccess(api);
    expect((await sa.sync()).op).toBe('register');
    expect(state.scripts).toEqual([
      { id: SCRIPT_ID, js: ['content.js'], matches: ['https://a.ru/*'], allFrames: true, runAt: 'document_start', persistAcrossSessions: true },
    ]);
    expect((await sa.sync()).op).toBe('none');
    expect(count('register')).toBe(1);
    expect(count('update')).toBe(0);
  });

  it('sync сериализован: два параллельных вызова → одна регистрация, без ошибки дубликата', async () => {
    const { api, state, count } = fakeChrome({ origins: [ALL_URLS] });
    const sa = createSiteAccess(api);
    const [a, b] = await Promise.all([sa.sync(), sa.sync()]);
    expect([a.op, b.op]).toEqual(['register', 'none']);
    expect(count('register')).toBe(1);
    expect(state.scripts[0].matches).toEqual([ALL_URLS]);
  });

  it('ошибка одного sync не ломает очередь', async () => {
    const { api, count } = fakeChrome({ origins: ['https://a.ru/*'] });
    const getAll = api.permissions.getAll;
    let failures = 1;
    api.permissions.getAll = () => (failures-- > 0 ? Promise.reject(new Error('fail')) : getAll());
    const sa = createSiteAccess(api);
    const first = sa.sync();
    await expect(first).rejects.toThrow('fail');
    expect((await sa.sync()).op).toBe('register');
    expect(count('register')).toBe(1);
  });

  it('init вешает слушатели; onInstalled регистрирует', async () => {
    const { api, state } = fakeChrome({ origins: ['https://a.ru/*'] });
    createSiteAccess(api).init();
    expect([api.runtime.onInstalled.count, api.runtime.onStartup.count, api.permissions.onAdded.count, api.permissions.onRemoved.count]).toEqual([1, 1, 1, 1]);
    await api.runtime.onInstalled.fire({ reason: 'install' });
    expect(state.scripts.map((s) => s.matches)).toEqual([['https://a.ru/*']]);
    await api.runtime.onStartup.fire();
    expect(state.scripts).toHaveLength(1);
  });

  it('onAdded → update и executeScript по одному разу на вкладку с allFrames; ошибка вкладки не прерывает', async () => {
    const tabs = [
      { id: 1, url: 'https://b.ru/chat' },
      { id: 2, url: 'https://b.ru/other' },
      { id: 3, url: 'https://c.ru/' },
      { id: 4, url: 'https://b.ru/x' },
    ];
    const { api, state, count, calls = state.calls } = fakeChrome({ origins: ['https://a.ru/*'], tabs, failTabs: [1] });
    const sa = createSiteAccess(api);
    sa.init();
    await sa.sync();
    state.origins.push('https://b.ru/*');
    await api.permissions.onAdded.fire({ origins: ['https://b.ru/*'] });
    expect(count('update')).toBe(1);
    expect(state.scripts[0].matches).toEqual(['https://a.ru/*', 'https://b.ru/*']);
    const injected = calls.filter(([n]) => n === 'executeScript').map(([, inj]) => inj);
    expect(injected.map((i) => i.target.tabId).sort()).toEqual([1, 2, 4]);
    for (const i of injected) expect(i).toEqual({ target: { tabId: i.target.tabId, allFrames: true }, files: ['content.js'] });
    // update идёт раньше внедрения
    expect(calls.findIndex(([n]) => n === 'update')).toBeLessThan(calls.findIndex(([n]) => n === 'executeScript'));
  });

  it('inject: пустой список — без запросов; сбой tabs.query → 0', async () => {
    const { api, count } = fakeChrome();
    const sa = createSiteAccess(api);
    expect(await sa.inject([])).toBe(0);
    expect(count('tabs.query')).toBe(0);
    api.tabs.query = () => Promise.reject(new Error('no'));
    expect(await sa.inject(['https://a.ru/*'])).toBe(0);
  });

  it('onRemoved → unregister, когда доступа не осталось; update, когда остался', async () => {
    const { api, state, count } = fakeChrome({ origins: ['https://a.ru/*', 'https://b.ru/*'] });
    const sa = createSiteAccess(api);
    sa.init();
    await sa.sync();
    state.origins = ['https://a.ru/*'];
    await api.permissions.onRemoved.fire({ origins: ['https://b.ru/*'] });
    expect(state.scripts[0].matches).toEqual(['https://a.ru/*']);
    state.origins = [];
    await api.permissions.onRemoved.fire({ origins: ['https://a.ru/*'] });
    expect(count('unregister')).toBe(1);
    expect(state.scripts).toEqual([]);
    await tick();
  });
});
