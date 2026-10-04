// WP4: страница настроек — FR-42 (сохранение ≤ 200 мс), siteMode с подтверждением, валидация, свои категории и regex-guard.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test, expect } from './fixtures.js';

const stored = (page) => page.evaluate(async () => (await chrome.storage.local.get('settings')).settings);

async function openOptions(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.evaluate(() => chrome.storage.local.set({ settings: { uiLanguage: 'ru' } })); // язык браузера в headless — en
  await page.reload();
  await expect(page.getByTestId('intercept-enabled')).toBeVisible();
  return page;
}

test('изменение настройки попадает в storage.local за ≤ 200 мс', async ({ context, extensionId }) => {
  const page = await openOptions(context, extensionId);
  const before = await stored(page);
  expect(before?.interceptEnabled ?? false).toBe(false);
  const t0 = Date.now();
  await page.locator('label.switch', { has: page.getByTestId('intercept-enabled') }).click();
  await page.waitForFunction(async () => (await chrome.storage.local.get('settings')).settings?.interceptEnabled === true, null, {
    polling: 10,
    timeout: 2000,
  });
  expect(Date.now() - t0).toBeLessThan(200);

  await page.getByTestId('mode').selectOption('mask');
  await page.getByTestId('cat-AMOUNT').check({ force: true });
  await expect.poll(async () => (await stored(page)).mode).toBe('mask');
  expect((await stored(page)).categories.AMOUNT).toBe(true);
  await page.reload();
  await expect(page.getByTestId('mode')).toHaveValue('mask');
});

test('siteMode=all требует подтверждения; origin проверяется; невалидное не сохраняется', async ({ context, extensionId }) => {
  const page = await openOptions(context, extensionId);
  await page.getByTestId('site-mode').selectOption('all');
  await page.getByTestId('dlg-cancel').click();
  await expect(page.getByTestId('site-mode')).toHaveValue('allowlist');
  expect((await stored(page))?.siteMode ?? 'allowlist').toBe('allowlist');
  await page.getByTestId('site-mode').selectOption('all');
  await page.getByTestId('dlg-ok').click();
  await expect.poll(async () => (await stored(page)).siteMode).toBe('all');

  await page.getByTestId('blocklist-input').fill('не-адрес');
  await page.getByTestId('blocklist-add').click();
  await expect(page.getByTestId('blocklist-input')).toHaveClass(/invalid/);
  expect((await stored(page)).blocklist).toEqual([]);
  await page.getByTestId('blocklist-input').fill('https://mail.example.com/');
  await page.getByTestId('blocklist-add').click();
  await expect.poll(async () => (await stored(page)).blocklist).toEqual(['https://mail.example.com']);

  await page.getByTestId('max-size').fill('500');
  await expect(page.getByTestId('max-size')).toHaveClass(/invalid/);
  expect((await stored(page)).maxFileSizeMB).toBe(50);
  await page.getByTestId('max-size').fill('20');
  await expect.poll(async () => (await stored(page)).maxFileSizeMB).toBe(20);
});

test('свои категории: regex-guard блокирует (a+)+$, принимает ЗК-\\d{4}/\\d{2}; подсветка; импорт', async ({ context, extensionId }) => {
  const page = await openOptions(context, extensionId);
  await page.getByTestId('cc-new').click();
  const dlg = page.getByTestId('cc-dialog');
  await dlg.locator('[data-f="label.ru"]').fill('Заказ');
  await dlg.locator('[data-f="placeholderPrefix.ru"]').fill('заказ');
  await page.getByTestId('kind-pattern').check({ force: true });

  await dlg.locator('[data-f="pattern.regex"]').fill('(a+)+$');
  await page.getByTestId('cc-save').click();
  await expect(dlg.locator('[data-err="pattern.regex"]')).toContainText('слишком медленный');
  expect(((await stored(page))?.customCategories ?? []).length).toBe(0);

  await dlg.locator('[data-f="pattern.regex"]').fill('ЗК-\\d{4}/\\d{2}');
  await page.getByTestId('cc-test-text').fill('Заказы ЗК-2024/01 и ЗК-2025/12, но не ЗК-24/01.');
  await expect(page.getByTestId('cc-preview-count')).toHaveText('Найдено: 2');
  await expect(page.getByTestId('cc-preview').locator('mark')).toHaveText(['ЗК-2024/01', 'ЗК-2025/12']);
  await page.getByTestId('cc-save').click();
  await expect(dlg).toHaveCount(0);
  await expect.poll(async () => (await stored(page)).customCategories.length).toBe(1);
  const cc = (await stored(page)).customCategories[0];
  expect(cc).toMatchObject({ kind: 'pattern', placeholderPrefix: { ru: 'ЗАКАЗ' }, pattern: { regex: 'ЗК-\\d{4}/\\d{2}', flags: 'u' } });
  await expect(page.getByTestId('cc-item')).toHaveCount(1);

  // экспорт → удаление → импорт восстанавливает id
  const dir = resolve('test-output');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'e2e.categories.json');
  writeFileSync(file, JSON.stringify({ kind: 'docx-anonymizer-categories', version: 1, categories: [cc] }));
  await page.getByTestId('cc-item').getByRole('button', { name: 'Удалить' }).click();
  await page.getByTestId('dlg-ok').click();
  await expect.poll(async () => (await stored(page)).customCategories.length).toBe(0);
  await page.getByTestId('cc-import-file').setInputFiles(file);
  await expect.poll(async () => (await stored(page)).customCategories.map((c) => c.id)).toEqual([cc.id]);

  await page.screenshot({ path: join(dir, 'options.png'), fullPage: true });
});
