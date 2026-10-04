// Фикстура Playwright: Chromium с распакованным расширением из dist/ (ТЗ §9.3).
// headless — новый headless Chromium (поддерживает расширения); E2E_HEADED=1 — с окном.
import { test as base, chromium } from '@playwright/test';
import { existsSync, mkdtempSync } from 'node:fs';
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
  extensionId: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await use(new URL(sw.url()).host);
  },
});

export const expect = test.expect;
