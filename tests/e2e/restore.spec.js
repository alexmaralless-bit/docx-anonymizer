// WP4: страница «Восстановить» — восстановление текста по маппингу из файла, подсветка нераспознанного; WP6 — склонение ФИО (FR-37).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test, expect } from './fixtures.js';

const fx = JSON.parse(readFileSync(resolve('tests/fixtures/deanon.json'), 'utf8'));

test('восстановление текста по маппингу из файла', async ({ context, extensionId }) => {
  const dir = resolve('test-output');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'e2e.mapping.json');
  writeFileSync(file, JSON.stringify(fx.mapping));

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/restore/restore.html`);
  await page.evaluate(() => chrome.storage.local.set({ settings: { uiLanguage: 'ru' } })); // язык браузера в headless — en
  await page.reload();
  await expect(page.getByTestId('source-file')).toBeChecked(); // недавних обработок нет
  await page.getByTestId('restore-input').fill('Договор с ООО «[КОМПАНИЯ_1]» подписал **[ФИО_1]**, ИНН ИНН_1. Неизвестно: [ФИО_9].');
  await page.getByTestId('mapping-file').setInputFiles(file);
  await expect(page.getByTestId('file-info')).toContainText('Загружено записей');
  await page.getByTestId('restore-run').click();
  await expect(page.getByTestId('restore-output')).toContainText('Договор с ООО «Ромашка-Трейд» подписал **Иванов Пётр Сергеевич**, ИНН 7736050003.');
  await expect(page.getByTestId('unresolved-mark')).toHaveText('[ФИО_9]');
  await expect(page.getByTestId('restore-unresolved')).toContainText('Не найдено в карте: 1');
  await expect(page.getByTestId('restore-stat')).toHaveText('Заменено: 3');
  await page.screenshot({ path: join(dir, 'restore.png'), fullPage: true });
});

test('склонение ФИО по контексту и его отключение (FR-37)', async ({ context, extensionId }) => {
  const dir = resolve('test-output');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'e2e-decline.mapping.json');
  writeFileSync(file, JSON.stringify(fx.mapping));

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/restore/restore.html`);
  await page.evaluate(() => chrome.storage.local.set({ settings: { uiLanguage: 'ru' } })); // язык браузера в headless — en
  await page.reload();
  await expect(page.getByTestId('restore-decline')).toBeChecked(); // по умолчанию включено
  await page.getByTestId('restore-input').fill('Письмо [ФИО_1]у и от [ФИО_2].');
  await page.getByTestId('mapping-file').setInputFiles(file);
  await expect(page.getByTestId('file-info')).toContainText('Загружено записей');
  await page.getByTestId('restore-run').click();
  await expect(page.getByTestId('restore-output')).toHaveText('Письмо Иванову Петру Сергеевичу и от Петровой Анны Ивановны.');
  await expect(page.getByTestId('declined-mark')).toHaveCount(2);
  await expect(page.getByTestId('declined-mark').first()).toHaveAttribute('title', /дательный.*Иванов Пётр Сергеевич/);
  await expect(page.getByTestId('restore-stat')).toContainText('склонено: 2');

  await page.getByTestId('restore-decline').uncheck();
  await page.getByTestId('restore-run').click();
  await expect(page.getByTestId('restore-output')).toHaveText('Письмо Иванов Пётр Сергеевичу и от Петрова Анна Ивановна.');
  await expect(page.getByTestId('declined-mark')).toHaveCount(0);
  await expect(page.getByTestId('restore-stat')).toHaveText('Заменено: 2');
});

test('без карты — понятное сообщение', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/restore/restore.html`);
  await page.evaluate(() => chrome.storage.local.set({ settings: { uiLanguage: 'ru' } })); // язык браузера в headless — en
  await page.reload();
  await page.getByTestId('restore-input').fill('[ФИО_1]');
  await page.getByTestId('restore-run').click();
  await expect(page.getByTestId('restore-error')).toContainText('Выберите обработку или загрузите файл карты');
});
