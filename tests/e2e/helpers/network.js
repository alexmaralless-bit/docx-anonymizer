// Наблюдение за сетью ВСЕХ контекстов расширения (NFR-01, К6): страницы, service worker, offscreen-документ и его
// dedicated worker. context.on('request') Playwright видит только страницы — запросов offscreen.html, worker.js и
// vendor/*.wasm в нём нет. Поэтому подключаемся к браузерной CDP-цели напрямую: фикстура запускает Chromium с
// --remote-debugging-port=0, порт берём из <профиль>/DevToolsActivePort. Target.setAutoAttach (flatten,
// waitForDebuggerOnStart) на браузере и рекурсивно на каждой присоединённой цели: новая цель стоит на паузе, пока
// не включён Network, поэтому ранние запросы (загрузка offscreen.html, скрипт воркера) не теряются.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { earlyCaptures, profileDirs } from '../fixtures.js';

/** Интерфейс самого Chromium (омнибокс и т.п.) — не расширение и не тестовые страницы. */
const SKIP_TYPES = new Set(['browser_ui']);

/**
 * Начинает запись запросов всех целей браузера контекста. Если фикстура запустила контекст с earlyCapture, первый
 * вызов возвращает запись, подключённую до загрузки расширения (ничего не пропущено с самого старта).
 * @param {import('@playwright/test').BrowserContext} context  контекст из фикстуры tests/e2e/fixtures.js
 * @returns {Promise<{urls: string[], targets: {type: string, url: string}[], stop: () => Promise<string[]>}>}
 *   urls — живой список URL (Network.requestWillBeSent), targets — присоединённые цели (для диагностики)
 */
export async function captureAllRequests(context) {
  // запись, начатая фикстурой до загрузки расширения (earlyCapture), — первому вызову
  const early = earlyCaptures.get(context);
  if (early) {
    earlyCaptures.delete(context);
    return early;
  }
  const dir = profileDirs.get(context);
  if (!dir) throw new Error('captureAllRequests: контекст создан не фикстурой tests/e2e/fixtures.js');
  const portFile = join(dir, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 50));
  const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');

  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((ok, bad) => {
    ws.onopen = ok;
    ws.onerror = () => bad(new Error('captureAllRequests: нет соединения с CDP браузера'));
  });

  const urls = [];
  const targets = [];
  const pending = new Map();
  const setups = new Set();
  let seq = 0;
  let closed = false;
  const send = (method, params = {}, sessionId) =>
    new Promise((ok, bad) => {
      if (closed) return bad(new Error('closed'));
      const id = ++seq;
      pending.set(id, { ok, bad, method });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  const autoAttach = (sessionId) => send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);

  async function onAttached({ sessionId, targetInfo, waitingForDebugger }) {
    try {
      if (!SKIP_TYPES.has(targetInfo.type)) {
        targets.push({ type: targetInfo.type, url: targetInfo.url });
        // Не у всех целей есть Network/Target (например, tab) — ошибки домена не мешают остальным
        await send('Network.enable', {}, sessionId).catch(() => {});
        await autoAttach(sessionId).catch(() => {});
      }
    } finally {
      if (waitingForDebugger) await send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
    }
  }

  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (p) m.error ? p.bad(new Error(`${p.method}: ${m.error.message}`)) : p.ok(m.result);
      return;
    }
    if (m.method === 'Network.requestWillBeSent') urls.push(m.params.request.url);
    else if (m.method === 'Target.attachedToTarget') {
      const job = onAttached(m.params);
      setups.add(job);
      job.finally(() => setups.delete(job));
    }
  };
  ws.onclose = () => {
    closed = true;
    for (const p of pending.values()) p.bad(new Error('closed'));
    pending.clear();
  };

  await autoAttach();
  // события attachedToTarget уже существующих целей приходят до ответа setAutoAttach — дожидаемся их Network.enable
  while (setups.size) await Promise.all([...setups]);

  return {
    urls,
    targets,
    async stop() {
      while (setups.size) await Promise.all([...setups]);
      ws.close();
      return urls;
    },
  };
}

/** URL, ушедшие по http(s) не на разрешённые origin (по умолчанию — никакие). */
export function externalRequests(urls, allowedOrigins = []) {
  return urls.filter((u) => /^https?:/i.test(u) && !allowedOrigins.some((o) => u === o || u.startsWith(o + '/')));
}

/**
 * Запросы offscreen-документа и его воркера (offscreen.html/js, worker.js, vendor/*.wasm, models/*.zip встроенной модели — WP10-C)
 * — доказательство, что запись их видит.
 */
export function offscreenRequests(urls) {
  return urls.filter((u) => /^chrome-extension:\/\/[^/]+\/(offscreen\/|vendor\/|models\/)/.test(u));
}
