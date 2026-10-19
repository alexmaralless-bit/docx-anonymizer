// Фикстура Playwright: Chromium с распакованным расширением из dist-e2e/ (ТЗ §9.3).
// headless — новый headless Chromium (поддерживает расширения); E2E_HEADED=1 — с окном.
// dist-e2e/ — сборка `node scripts/build.mjs --e2e`: в манифесте есть host_permissions <all_urls>, потому что нативный диалог
// chrome.permissions.request Playwright нажать не может (К9). Content script регистрируется динамически при установке.
import { test as base, chromium } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const DIST = resolve('dist-e2e');
/**
 * Встроенная модель NER (WP10-C): описание из dist-e2e/models/index.json полной сборки
 * (`node scripts/build.mjs --e2e --with-model=<zip>`) или null — лёгкая. Гейт tests/e2e/bundled-model.spec.js; при полной
 * сборке модель ставится сама, поэтому сценарии ручного импорта (model-pack, ner) пропускаются.
 * @type {{file: string, id: string, version: string, sha256: string, size: number} | null}
 */
export const BUNDLED = (() => {
  const p = join(DIST, 'models/index.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8'))[0] || null : null;
})();
/** Каталог профиля каждого контекста: в нём Chromium пишет DevToolsActivePort (helpers/network.js, К6). */
export const profileDirs = new WeakMap();

export const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    if (!existsSync(join(DIST, 'manifest.json'))) throw new Error('Сначала npm run build:e2e');
    const userDataDir = mkdtempSync(join(tmpdir(), 'docx-anon-e2e-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: !process.env.E2E_HEADED,
      // порт CDP на 127.0.0.1 (случайный): helpers/network.js слушает через него сеть offscreen-документа и воркеров
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--remote-debugging-port=0'],
    });
    profileDirs.set(context, userDataDir);
    await use(context);
    await context.close();
  },
  // Локальный статический сервер тестовых страниц (tests/e2e/pages), без внешней сети.
  // site.origin — 'http://127.0.0.1:<порт>'; site.url('chat.html') — полный адрес.
  // eslint-disable-next-line no-empty-pattern
  site: async ({}, use) => {
    const root = resolve('tests/e2e/pages');
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };
    const server = createServer((req, res) => {
      const name = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'chat.html';
      const file = resolve(root, name);
      if (!file.startsWith(root + '/') || !existsSync(file)) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': types[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream' }).end(readFileSync(file));
    });
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await use({ origin, url: (path = 'chat.html') => `${origin}/${path}` });
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
  },
  extensionId: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    // background/site-access.js регистрирует content script на onInstalled асинхронно: страницы, открытые раньше, остались бы без него
    await base
      .expect(async () => {
        const ids = await sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id));
        base.expect(ids).toContain('intercept');
      })
      .toPass({ timeout: 10000, intervals: [50, 100, 250] });
    await use(new URL(sw.url()).host);
  },
});

export const expect = test.expect;
