// Маршрутизатор background (§5.1, WP8): MODEL_CHANGED без offscreen-документа подтверждается сразу, документ не
// поднимается; при живом документе сообщение уходит в offscreen как обычно.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MSG, PORT_NAME, TARGET } from '../../src/shared/protocol.js';

const offscreen = vi.hoisted(() => ({ hasDocument: vi.fn(), ensureOffscreen: vi.fn() }));
vi.mock('../../src/background/offscreen-manager.js', () => offscreen);
// WP10-C: установка встроенной модели — отдельный модуль; здесь проверяется только маршрутизация MODEL_BOOTSTRAP
const bundled = vi.hoisted(() => ({ bootstrapBundledModel: vi.fn(async () => 'install'), initBundledModel: vi.fn() }));
vi.mock('../../src/background/bundled-model.js', () => bundled);

const { initRouter } = await import('../../src/background/router.js');

function event() {
  const listeners = [];
  return { addListener: (fn) => listeners.push(fn), fire: (...a) => listeners.forEach((fn) => fn(...a)) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Фейковый chrome: runtime.onConnect/onMessage/sendMessage и storage.local для loadSettings. */
function fakeChrome() {
  const api = {
    runtime: { onConnect: event(), onMessage: event(), sendMessage: vi.fn(async () => undefined) },
    storage: { local: { get: vi.fn(async () => ({})) } },
  };
  return api;
}

function connect(chrome) {
  const port = { name: PORT_NAME, postMessage: vi.fn(), onMessage: event(), onDisconnect: event() };
  chrome.runtime.onConnect.fire(port);
  return port;
}

describe('router: MODEL_CHANGED', () => {
  let chrome;
  beforeEach(() => {
    chrome = fakeChrome();
    vi.stubGlobal('chrome', chrome);
    offscreen.hasDocument.mockReset();
    offscreen.ensureOffscreen.mockReset().mockResolvedValue(undefined);
    initRouter();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('offscreen-документа нет → ACK от background, ensureOffscreen и sendMessage не вызываются', async () => {
    offscreen.hasDocument.mockResolvedValue(false);
    const port = connect(chrome);
    port.onMessage.fire({ type: MSG.MODEL_CHANGED, requestId: 'r1', modelId: 'x1' });
    await tick();
    await tick();
    expect(port.postMessage).toHaveBeenCalledWith({ type: MSG.ACK, requestId: 'r1' });
    expect(offscreen.ensureOffscreen).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
  });

  it('документ есть → сообщение уходит в offscreen, ACK отвечает уже хост', async () => {
    offscreen.hasDocument.mockResolvedValue(true);
    const port = connect(chrome);
    const msg = { type: MSG.MODEL_CHANGED, requestId: 'r2', modelId: 'x1' };
    port.onMessage.fire(msg);
    await tick();
    await tick();
    expect(offscreen.ensureOffscreen).toHaveBeenCalledTimes(1);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ target: TARGET.OFFSCREEN, clientId: expect.any(String), msg });
    expect(port.postMessage).not.toHaveBeenCalled();
  });
});

describe('router: MODEL_BOOTSTRAP (WP10-C)', () => {
  let chrome;
  beforeEach(() => {
    chrome = fakeChrome();
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('__BUNDLED_MODEL__', { file: 'p.zip', id: 'test-pack', version: '1.0.0', sha256: 'e'.repeat(64), size: 1 });
    offscreen.hasDocument.mockReset().mockResolvedValue(false);
    offscreen.ensureOffscreen.mockReset().mockResolvedValue(undefined);
    bundled.bootstrapBundledModel.mockClear();
    initRouter();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('ACK сразу, установка — bootstrapBundledModel({force: true}); в offscreen само сообщение не уходит', async () => {
    const port = connect(chrome);
    port.onMessage.fire({ type: MSG.MODEL_BOOTSTRAP, requestId: 'b1' });
    await tick();
    await tick();
    expect(port.postMessage).toHaveBeenCalledWith({ type: MSG.ACK, requestId: 'b1' });
    expect(bundled.bootstrapBundledModel).toHaveBeenCalledWith({ force: true });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(offscreen.ensureOffscreen).not.toHaveBeenCalled();
  });

  it('сообщения хоста с clientId bootstrap router не пересылает ни одному порту', async () => {
    const port = connect(chrome);
    chrome.runtime.onMessage.fire({ target: TARGET.BACKGROUND, clientId: 'bootstrap', msg: { type: MSG.MODEL_INSTALLED, requestId: 'x' } });
    await tick();
    expect(port.postMessage).not.toHaveBeenCalled();
  });
});
