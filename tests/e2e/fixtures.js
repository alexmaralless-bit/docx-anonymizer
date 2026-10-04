// Фикстура Playwright: Chromium с распакованным расширением из dist/ (ТЗ §9.3).
// headless — новый headless Chromium (поддерживает расширения); E2E_HEADED=1 — с окном.
import { test as base, chromium } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const DIST = resolve('dist');

export const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    if (!existsSync(join(DIST, 'manifest.json'))) throw new Error('Сначала npm run build');
    const userDataDir = mkdtempSync(join(tmpdir(), 'docx-anon-e2e-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: !process.env.E2E_HEADED,
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    });
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
    await use(new URL(sw.url()).host);
  },
});

export const expect = test.expect;
