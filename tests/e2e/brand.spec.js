// Sitimlab: иконка, «Сделано в Sitimlab» со ссылкой на sitimlab.ru и справка — в меню и на страницах расширения.
// Ссылки только проверяются (адрес, target), по ним не ходим: сети в тестах нет.
// E2E_SHOTS=<каталог> — сохранить снимки меню и справки (docs/screenshots).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from './fixtures.js';

async function open(context, extensionId, path, lang = 'ru') {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${path}`);
  await page.evaluate((l) => chrome.storage.local.set({ settings: { uiLanguage: l } }), lang); // язык браузера в headless — en
  await page.reload();
  return page;
}

const PAGES = ['popup/popup.html', 'options/options.html', 'restore/restore.html', 'help/help.html'];

test('манифест: иконки 16/32/48/128, значок кнопки и адрес сайта студии', async ({ context, extensionId }) => {
  const page = await open(context, extensionId, 'popup/popup.html');
  const m = await page.evaluate(() => chrome.runtime.getManifest());
  expect(m.name).toBe('DOCX Anonymizer'); // название не меняется
  for (const size of ['16', '32', '48', '128']) {
    expect(m.icons[size]).toBe(`icons/icon-${size}.png`);
    expect(m.action.default_icon[size]).toBe(`icons/icon-${size}.png`);
    const dim = await page.evaluate(
      (src) =>
        new Promise((ok, no) => {
          const i = new Image();
          i.onload = () => ok([i.naturalWidth, i.naturalHeight]);
          i.onerror = () => no(new Error(src));
          i.src = src;
        }),
      `chrome-extension://${extensionId}/${m.icons[size]}`,
    );
    expect(dim).toEqual([Number(size), Number(size)]);
  }
  expect(m.homepage_url).toBe('https://sitimlab.ru');
});

for (const path of PAGES) {
  test(`${path}: «Сделано в Sitimlab» со ссылкой на sitimlab.ru`, async ({ context, extensionId }) => {
    const page = await open(context, extensionId, path);
    const link = page.getByTestId('made-by-link');
    await expect(link).toBeVisible();
    await expect(link).toHaveText('Sitimlab');
    await expect(link).toHaveAttribute('href', 'https://sitimlab.ru');
    await expect(link).toHaveAttribute('target', '_blank');
    expect(await link.getAttribute('rel')).toContain('noopener');
    await expect(link.locator('xpath=..')).toHaveText('Сделано в Sitimlab');
  });
}

for (const path of ['popup/popup.html', 'options/options.html', 'restore/restore.html']) {
  test(`${path}: ссылка «Справка» ведёт на страницу справки`, async ({ context, extensionId }) => {
    const page = await open(context, extensionId, path);
    const link = page.getByTestId('help-link');
    await expect(link).toHaveText('Справка');
    await expect(link).toHaveAttribute('target', '_blank');
    const href = await link.evaluate((a) => a.href);
    expect(href).toBe(`chrome-extension://${extensionId}/help/help.html`);
    const [help] = await Promise.all([context.waitForEvent('page'), link.click()]);
    await help.waitForLoadState();
    expect(help.url()).toBe(href);
    await expect(help.getByRole('heading', { level: 1 })).toHaveText('Справка');
  });
}

test('меню показывает иконку Sitimlab', async ({ context, extensionId }) => {
  const page = await open(context, extensionId, 'popup/popup.html');
  const logo = page.locator('img.logo');
  await expect(logo).toBeVisible();
  expect(await logo.evaluate((i) => [i.complete, i.naturalWidth])).toEqual([true, 48]);
});

test('справка: что делает, как пользоваться, данные не покидают компьютер', async ({ context, extensionId }) => {
  const page = await open(context, extensionId, 'help/help.html');
  await expect(page.getByTestId('help-what')).toContainText('перехватывает файл');
  await expect(page.getByTestId('help-what')).toContainText('плейсхолдерами');
  const steps = page.getByTestId('help-how').locator('ol > li');
  await expect(steps).toHaveCount(4);
  await expect(steps.nth(0)).toContainText('Перехват загрузки');
  await expect(steps.nth(3)).toContainText('Восстановить текст');
  await expect(page.getByTestId('help-privacy').getByRole('heading')).toHaveText('Данные не покидают ваш компьютер');
  await expect(page.getByTestId('help-privacy')).toContainText('ни одного сетевого запроса');
  await expect(page.getByTestId('help-check')).toContainText('просматривайте результат');
  await expect(page.locator('img').first()).toBeVisible();
});

test('справка и подпись на английском', async ({ context, extensionId }) => {
  const page = await open(context, extensionId, 'help/help.html', 'en');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Help');
  await expect(page.getByTestId('help-privacy').getByRole('heading')).toHaveText('Your data never leaves your computer');
  await expect(page.getByTestId('made-by-link').locator('xpath=..')).toHaveText('Made at Sitimlab');
});

test('страницы справки и подписи не делают запросов наружу', async ({ context, extensionId }) => {
  const urls = [];
  context.on('request', (req) => urls.push(req.url()));
  for (const path of PAGES) await open(context, extensionId, path);
  expect(urls.filter((u) => /^https?:/.test(u))).toEqual([]);
});

test('снимки меню и справки', async ({ context, extensionId }) => {
  test.skip(!process.env.E2E_SHOTS, 'задайте E2E_SHOTS=<каталог>');
  const dir = process.env.E2E_SHOTS;
  mkdirSync(dir, { recursive: true });
  const popup = await open(context, extensionId, 'popup/popup.html');
  await popup.setViewportSize({ width: 340, height: 420 });
  await popup.screenshot({ path: join(dir, 'popup.png') });
  const help = await open(context, extensionId, 'help/help.html');
  await help.setViewportSize({ width: 900, height: 1000 });
  await help.screenshot({ path: join(dir, 'help.png'), fullPage: true });
});
