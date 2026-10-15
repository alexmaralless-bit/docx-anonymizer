// К9: доступ к сайтам. Content script не объявлен в манифесте — background регистрирует его через chrome.scripting
// по выданным host-разрешениям. e2e-сборка (dist-e2e/) получает <all_urls> при установке: нативный диалог
// chrome.permissions.request Playwright нажать не может, поэтому запрос здесь сразу возвращает true (ручной чек-лист — README).
import { test, expect } from './fixtures.js';

const stored = (page) => page.evaluate(async () => (await chrome.storage.local.get('settings')).settings);

test('content script зарегистрирован динамически: id intercept, <all_urls>, все кадры, document_start', async ({ context, extensionId }) => {
  expect(extensionId).toBeTruthy();
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const scripts = await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts());
  expect(scripts).toHaveLength(1);
  expect(scripts[0]).toMatchObject({ id: 'intercept', js: ['content.js'], matches: ['<all_urls>'], allFrames: true, runAt: 'document_start' });
  const manifest = await sw.evaluate(() => chrome.runtime.getManifest());
  expect(manifest).not.toHaveProperty('content_scripts');
  expect(manifest.optional_host_permissions).toEqual(['<all_urls>']);
  expect(await sw.evaluate(() => chrome.permissions.getAll())).toMatchObject({ origins: ['<all_urls>'] });
});

test('добавление сайта в настройках: запрос доступа без ошибки, allowlist сохранён', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.evaluate(() => chrome.storage.local.set({ settings: { uiLanguage: 'ru', allowlist: ['https://claude.ai'] } }));
  await page.reload();
  await page.getByTestId('allowlist-input').fill('https://chat.example.test/');
  await page.getByTestId('allowlist-add').click();
  await expect.poll(async () => (await stored(page)).allowlist).toEqual(['https://claude.ai', 'https://chat.example.test']);
  // requestOrigins резолвится true (доступ уже есть) — подсказки об отказе нет
  await page.waitForTimeout(200);
  await expect(page.getByTestId('allowlist-access')).toHaveText('');
  expect(await page.evaluate(() => chrome.permissions.contains({ origins: ['https://chat.example.test/*'] }))).toBe(true);
  await expect(page.getByTestId('allowlist-box')).toContainText('https://chat.example.test');
});
