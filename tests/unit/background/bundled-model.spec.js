// Background: автоустановка встроенной модели NER (версия 0.3, WP10-C, К15) на фейковом chrome (как tests/unit/router.spec.js).
// Слушатели вешаются синхронно; лёгкая сборка и уже обработанный sha не поднимают offscreen; install шлёт MODEL_INSTALL
// в offscreen с clientId 'bootstrap'; ответ MODEL_INSTALLED пишет настройки (или только sha, если выбран свой пакет).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MSG, TARGET } from '../../../src/shared/protocol.js';
import { SETTINGS_KEY } from '../../../src/core/settings.js';

const offscreen = vi.hoisted(() => ({ hasDocument: vi.fn(), ensureOffscreen: vi.fn() }));
vi.mock('../../../src/background/offscreen-manager.js', () => offscreen);

const { initBundledModel, bootstrapBundledModel } = await import('../../../src/background/bundled-model.js');

const SHA = 'c'.repeat(64);
const BUNDLED = { file: 'docx-anonymizer-ner-test-pack-1.0.0.zip', id: 'test-pack', version: '1.0.0', sha256: SHA, size: 42 };

function event() {
  const listeners = [];
  return { listeners, addListener: (fn) => listeners.push(fn), fire: (...a) => listeners.forEach((fn) => fn(...a)) };
}
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Фейковый chrome: runtime (события, sendMessage, getURL) и storage.local с настоящим состоянием. */
function fakeChrome(stored = {}) {
  let data = { [SETTINGS_KEY]: stored };
  return {
    runtime: {
      onInstalled: event(),
      onStartup: event(),
      onMessage: event(),
      sendMessage: vi.fn(async () => undefined),
      getURL: (p) => `chrome-extension://extid/${p}`,
    },
    storage: {
      local: {
        get: vi.fn(async (k) => ({ [k]: data[k] })),
        set: vi.fn(async (o) => {
          data = { ...data, ...o };
        }),
      },
    },
    get settings() {
      return data[SETTINGS_KEY];
    },
  };
}

describe('background: встроенная модель NER', () => {
  let chrome;
  const setup = (stored, bundled = BUNDLED) => {
    chrome = fakeChrome(stored);
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('__BUNDLED_MODEL__', bundled);
    vi.stubGlobal('__VERSION__', '0.3.0');
    initBundledModel(chrome);
  };
  const reply = (msg) => chrome.runtime.onMessage.fire({ target: TARGET.BACKGROUND, clientId: 'bootstrap', msg });
  const installMsg = () => chrome.runtime.sendMessage.mock.calls.find((c) => c[0]?.msg?.type === MSG.MODEL_INSTALL)?.[0];

  beforeEach(() => {
    offscreen.hasDocument.mockReset().mockResolvedValue(false);
    offscreen.ensureOffscreen.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('слушатели onInstalled, onStartup, onMessage вешаются синхронно', () => {
    setup({});
    expect(chrome.runtime.onInstalled.listeners).toHaveLength(1);
    expect(chrome.runtime.onStartup.listeners).toHaveLength(1);
    expect(chrome.runtime.onMessage.listeners).toHaveLength(1);
  });

  it('лёгкая сборка (none) и уже обработанный sha (skip): offscreen не поднимается', async () => {
    setup({}, null);
    chrome.runtime.onInstalled.fire({ reason: 'install' });
    chrome.runtime.onStartup.fire();
    await flush();
    expect(await bootstrapBundledModel()).toBe('none');
    setup({ nerModel: '', bundledModelSha: SHA });
    chrome.runtime.onInstalled.fire({ reason: 'update' });
    await flush();
    expect(offscreen.ensureOffscreen).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('свой пакет пользователя (foreign) и chrome_update: offscreen не поднимается', async () => {
    setup({ nerModel: 'my' });
    chrome.runtime.onInstalled.fire({ reason: 'install' });
    await flush();
    setup({});
    chrome.runtime.onInstalled.fire({ reason: 'chrome_update' });
    await flush();
    expect(offscreen.ensureOffscreen).not.toHaveBeenCalled();
  });

  it('install: onInstalled → offscreen и MODEL_INSTALL с url собственного пакета; ответ installed → nerModel и sha', async () => {
    setup({});
    chrome.runtime.onInstalled.fire({ reason: 'install' });
    await flush();
    expect(offscreen.ensureOffscreen).toHaveBeenCalled();
    const sent = installMsg();
    expect(sent).toMatchObject({ target: 'offscreen', clientId: 'bootstrap' });
    expect(sent.msg).toMatchObject({
      type: MSG.MODEL_INSTALL,
      url: `chrome-extension://extid/models/${BUNDLED.file}`,
      id: 'test-pack',
      sha256: SHA,
      version: '1.0.0',
      extensionVersion: '0.3.0',
    });
    expect(chrome.storage.local.set).not.toHaveBeenCalledWith(expect.objectContaining({ [SETTINGS_KEY]: expect.objectContaining({ bundledModelSha: SHA }) }));
    reply({ type: MSG.MODEL_INSTALLED, requestId: sent.msg.requestId, status: 'installed', id: 'test-pack', sha256: SHA, version: '1.0.0', bytes: 10, ms: 5 });
    await flush();
    expect(chrome.settings).toMatchObject({ nerModel: 'test-pack', bundledModelSha: SHA });
  });

  it('onStartup тоже запускает план; present → те же настройки', async () => {
    setup({ nerModel: 'test-pack', bundledModelSha: '' });
    chrome.runtime.onStartup.fire();
    await flush();
    expect(installMsg()).toBeTruthy();
    reply({ type: MSG.MODEL_INSTALLED, requestId: 'x', status: 'present', id: 'test-pack', sha256: SHA });
    await flush();
    expect(chrome.settings).toMatchObject({ nerModel: 'test-pack', bundledModelSha: SHA });
  });

  it('пока шла установка, пользователь выбрал свой пакет → пишется только bundledModelSha', async () => {
    setup({ nerModel: 'my', bundledModelSha: '' });
    reply({ type: MSG.MODEL_INSTALLED, requestId: 'x', status: 'installed', id: 'test-pack', sha256: SHA, ms: 1 });
    await flush();
    expect(chrome.settings).toMatchObject({ nerModel: 'my', bundledModelSha: SHA });
  });

  it('failed → bundledModelError с кодом, nerModel и sha не меняются; в лог — только код', async () => {
    setup({});
    reply({ type: MSG.MODEL_INSTALLED, requestId: 'x', status: 'failed', id: 'test-pack', sha256: SHA, code: 'HASH_MISMATCH' });
    await flush();
    expect(chrome.settings).toMatchObject({ nerModel: '', bundledModelSha: '', bundledModelError: 'HASH_MISMATCH' });
    expect(console.warn).toHaveBeenCalledWith('[bundled-model] HASH_MISMATCH');
  });

  it('ERROR хоста → bundledModelError (INTERNAL для кода не по формату)', async () => {
    setup({});
    reply({ type: MSG.ERROR, requestId: 'x', code: 'INTERNAL', message: 'x' });
    await flush();
    expect(chrome.settings).toMatchObject({ bundledModelSha: '', bundledModelError: 'INTERNAL' });
    expect(console.warn).toHaveBeenCalledWith('[bundled-model] INTERNAL');
  });

  it('успех после неудачи стирает bundledModelError', async () => {
    setup({ bundledModelError: 'QUOTA' });
    reply({ type: MSG.MODEL_INSTALLED, requestId: 'x', status: 'installed', id: 'test-pack', sha256: SHA, ms: 1 });
    await flush();
    expect(chrome.settings).toMatchObject({ nerModel: 'test-pack', bundledModelSha: SHA, bundledModelError: '' });
  });

  it('новая попытка (в том числе «Повторить» = force) стирает прежний код до MODEL_INSTALL', async () => {
    setup({ bundledModelError: 'HASH_MISMATCH' });
    chrome.runtime.sendMessage.mockImplementation(async () => {
      expect(chrome.settings.bundledModelError).toBe('');
    });
    expect(await bootstrapBundledModel({ force: true })).toBe('install');
    expect(installMsg()).toBeTruthy();
    expect(chrome.settings.bundledModelError).toBe('');
  });

  it('offscreen недоступен и после повтора → bundledModelError = HOST_UNAVAILABLE', async () => {
    setup({});
    offscreen.ensureOffscreen.mockRejectedValue(new Error('no offscreen'));
    expect(await bootstrapBundledModel()).toBe('install');
    expect(chrome.settings).toMatchObject({ bundledModelError: 'HOST_UNAVAILABLE', bundledModelSha: '' });
    expect(console.warn).toHaveBeenCalledWith('[bundled-model] HOST_UNAVAILABLE');
  });

  it('ответ чужого sha (устаревший запрос) и сообщения других клиентов игнорируются', async () => {
    setup({});
    reply({ type: MSG.MODEL_INSTALLED, requestId: 'x', status: 'installed', id: 'test-pack', sha256: 'd'.repeat(64) });
    chrome.runtime.onMessage.fire({ target: TARGET.BACKGROUND, clientId: 'c1_x', msg: { type: MSG.MODEL_INSTALLED, status: 'installed', sha256: SHA } });
    await flush();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('два вызова подряд → один sendMessage; force трактует skip как install', async () => {
    setup({});
    const [a, b] = [bootstrapBundledModel(), bootstrapBundledModel()];
    expect(await a).toBe('install');
    expect(await b).toBe('install');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);

    setup({ nerModel: '', bundledModelSha: SHA });
    chrome.runtime.sendMessage.mockClear();
    expect(await bootstrapBundledModel()).toBe('skip');
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(await bootstrapBundledModel({ force: true })).toBe('install');
    expect(installMsg()).toBeTruthy();
  });

  it('force во время прогона без force не теряется: после него — второй прогон с force', async () => {
    setup({ nerModel: '', bundledModelSha: SHA });
    let release;
    chrome.storage.local.get.mockImplementationOnce((k) => new Promise((ok) => (release = () => ok({ [k]: chrome.settings }))));
    const plain = bootstrapBundledModel(); // skip: этот sha уже обработан
    const forced = bootstrapBundledModel({ force: true });
    const forced2 = bootstrapBundledModel({ force: true });
    expect(forced2).toBe(forced); // ждущие force объединяются
    release();
    expect(await plain).toBe('skip');
    expect(await forced).toBe('install');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(installMsg()).toBeTruthy();
  });

  it('force во время force-прогона объединяется с ним', async () => {
    setup({ nerModel: '', bundledModelSha: SHA });
    const [a, b] = [bootstrapBundledModel({ force: true }), bootstrapBundledModel({ force: true })];
    expect(b).toBe(a);
    expect(await a).toBe('install');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('onInstalled: migrateStoredSettings до MODEL_INSTALL; при __BUNDLED_MODEL__ = null миграция тоже идёт', async () => {
    const old = { schemaVersion: 1, nerThreshold: 0.6 };
    for (const bundled of [BUNDLED, null]) {
      setup({ ...old }, bundled);
      const order = [];
      const realSet = chrome.storage.local.set.getMockImplementation();
      chrome.storage.local.set.mockImplementation(async (o) => {
        order.push(`set:${o[SETTINGS_KEY].schemaVersion}:${o[SETTINGS_KEY].nerThreshold}`);
        await realSet(o);
      });
      chrome.runtime.sendMessage.mockImplementation(async (m) => {
        order.push(m.msg.type);
      });
      chrome.runtime.onInstalled.fire({ reason: 'install' });
      await flush();
      expect(order, String(!!bundled)).toEqual(bundled ? ['set:3:0.7', MSG.MODEL_INSTALL] : ['set:3:0.7']);
      if (!bundled) expect(offscreen.ensureOffscreen).not.toHaveBeenCalled();
      offscreen.ensureOffscreen.mockClear();
    }
  });

  it('offscreen не принял сообщение → одна повторная попытка', async () => {
    setup({});
    chrome.runtime.sendMessage.mockRejectedValueOnce(new Error('no receiver'));
    await bootstrapBundledModel();
    expect(offscreen.ensureOffscreen).toHaveBeenCalledTimes(2);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2);
  });
});
