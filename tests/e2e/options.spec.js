// WP4: страница настроек — FR-42 (сохранение ≤ 200 мс), siteMode с подтверждением, валидация, свои категории и regex-guard.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test, expect, BUNDLED } from './fixtures.js';

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

// Политика 0.4 (К1, Ц1): «Персональные данные» и «Идентификаторы» — без переключателей, «Коммерческая информация» —
// переключатель группы и прежние переключатели категорий внутри
test('«Что маскируется»: блоки «всегда» без переключателей; commercial по умолчанию выключен и включает cat-*', async ({ context, extensionId }) => {
  const page = await openOptions(context, extensionId);
  const pii = page.getByTestId('group-pii');
  const ids = page.getByTestId('group-ids');
  await expect(pii.getByTestId('always-PERSON')).toBeVisible();
  await expect(pii.getByTestId('always-PASSPORT')).toBeVisible();
  await expect(ids.getByTestId('always-INN')).toBeVisible();
  await expect(ids.getByTestId('always-ACCOUNT')).toBeVisible();
  await expect(pii.locator('input')).toHaveCount(0);
  await expect(ids.locator('input')).toHaveCount(0);
  await expect(page.getByTestId('cat-PERSON')).toHaveCount(0);
  await expect(page.getByTestId('cat-INN')).toHaveCount(0);

  const group = page.getByTestId('group-commercial');
  const commercial = page.getByTestId('commercial');
  await expect(commercial).not.toBeChecked();
  await expect(page.getByTestId('commercial-off-hint')).toBeVisible();
  for (const id of ['COMPANY', 'CONTRACT', 'AMOUNT']) await expect(group.getByTestId(`cat-${id}`)).toHaveCount(1);
  await page.locator('label.switch', { has: commercial }).click();
  await expect.poll(async () => (await stored(page)).commercial).toBe(true);
  await expect(page.getByTestId('commercial-off-hint')).toBeHidden();
  await page.locator('label.switch', { has: page.getByTestId('cat-COMPANY') }).click();
  await expect.poll(async () => (await stored(page)).categories.COMPANY).toBe(false);
  await page.reload();
  await expect(page.getByTestId('commercial')).toBeChecked();
  await expect(page.getByTestId('cat-COMPANY')).not.toBeChecked();
  // раздел в навигации
  await expect(page.locator('nav.nav a[href="#categories"]')).toHaveText('Что маскируется');
  await expect(page.locator('nav.nav a[href="#companies"]')).toBeVisible();
});

// Политика 0.4 (Ц3, К3): список компаний для маскирования — добавление, псевдонимы, предупреждение, удаление, экспорт/импорт
test('«Компании для маскирования»: добавление, псевдонимы, предупреждение о коротком названии, удаление, экспорт и импорт', async ({
  context,
  extensionId,
}) => {
  const page = await openOptions(context, extensionId);
  const name = page.getByTestId('company-name');
  await name.fill('Рог');
  await expect(page.getByTestId('company-short')).toBeVisible();
  await page.getByTestId('company-add').click();
  // бренд владельца (решение 6) — предупреждение: не маскируется никогда
  await name.fill('Студия Sitimlab');
  await expect(page.getByTestId('company-brand')).toBeVisible();
  await expect(page.getByTestId('company-short')).toBeHidden();
  await name.fill('ООО «Лунный свет»');
  await expect(page.getByTestId('company-short')).toBeHidden();
  await expect(page.getByTestId('company-brand')).toBeHidden();
  await name.press('Enter');
  await expect
    .poll(async () => (await stored(page)).maskedCompanies)
    .toEqual([
      { name: 'Рог', aliases: [] },
      { name: 'ООО «Лунный свет»', aliases: [] },
    ]);
  await expect(page.getByTestId('company-item')).toHaveCount(2);
  // повтор не добавляется
  await name.fill('рог');
  await page.getByTestId('company-add').click();
  await expect(page.getByTestId('company-item')).toHaveCount(2);

  await page.getByTestId('company-aliases-1').fill('Lunny Svet, Лунный свет плюс');
  await page.getByTestId('company-aliases-1').press('Tab');
  await expect.poll(async () => (await stored(page)).maskedCompanies[1].aliases).toEqual(['Lunny Svet', 'Лунный свет плюс']);

  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('companies-export').click()]);
  const file = JSON.parse(readFileSync(await dl.path(), 'utf8'));
  expect(file).toEqual({
    kind: 'docx-anonymizer-companies',
    version: 1,
    companies: [
      { name: 'Рог', aliases: [] },
      { name: 'ООО «Лунный свет»', aliases: ['Lunny Svet', 'Лунный свет плюс'] },
    ],
  });

  await page.getByTestId('company-remove-0').click();
  await expect.poll(async () => (await stored(page)).maskedCompanies.map((c) => c.name)).toEqual(['ООО «Лунный свет»']);
  await page.getByTestId('companies-import-file').setInputFiles({
    name: 'companies.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ ...file, companies: [...file.companies, { name: 'Вектор', aliases: ['Vector'] }] })),
  });
  await expect.poll(async () => (await stored(page)).maskedCompanies.map((c) => c.name)).toEqual(['ООО «Лунный свет»', 'Рог', 'Вектор']);
  await expect(page.getByTestId('companies-msg')).toContainText('Импортировано компаний: 3');
  await page.getByTestId('companies-import-file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"kind":"x"}') });
  await expect(page.getByTestId('companies-msg')).toContainText('Файл не принят');
  await page.reload();
  await expect(page.getByTestId('company-item')).toHaveCount(3);
});

test('NER: порог для организаций и стоп-список сохраняются (0.4, К10)', async ({ context, extensionId }) => {
  const page = await openOptions(context, extensionId);
  await expect(page.getByTestId('ner-threshold-org')).toHaveValue('0.85');
  await page.getByTestId('ner-threshold-org').fill('0.9');
  await expect.poll(async () => (await stored(page)).nerThresholdOrg).toBe(0.9);
  await page.getByTestId('ner-threshold-org').fill('2');
  await expect(page.getByTestId('ner-threshold-org')).toHaveClass(/invalid/);
  await page.getByTestId('ner-stoplist').fill('ЭДО\n  MVP \n\nЭДО');
  await page.getByTestId('ner-stoplist').press('Tab');
  await expect.poll(async () => (await stored(page)).nerStoplist).toEqual(['ЭДО', 'MVP']);
});

// WP10-C (К16): лёгкая сборка без модели — онбординг из трёх шагов в карточке «Модель NER», строка в popup со ссылкой на #ner
test('лёгкая сборка: онбординг модели NER в настройках и строка в popup → options.html#ner', async ({ context, extensionId }) => {
  test.skip(!!BUNDLED, 'полная сборка: модель встроена (tests/e2e/bundled-model.spec.js)');
  const page = await openOptions(context, extensionId);
  const onboarding = page.getByTestId('ner-onboarding');
  await expect(onboarding).toBeVisible();
  await expect(onboarding.locator('ol.steps > li')).toHaveCount(3);
  await expect(onboarding.getByTestId('ner-releases-link')).toHaveAttribute('href', /github\.com\/.+\/releases/);
  await expect(onboarding.getByTestId('ner-import')).toBeVisible();
  await expect(page.getByTestId('ner-status')).toHaveAttribute('data-state', 'none');
  await expect(page.getByTestId('ner-restore')).toBeHidden();
  await page.close();

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  const hint = popup.getByTestId('ner-hint');
  await expect(hint).toBeVisible();
  await expect(hint).toContainText('Модель NER не установлена');
  const [opened] = await Promise.all([context.waitForEvent('page'), hint.getByRole('link').click()]);
  await opened.waitForLoadState();
  expect(opened.url()).toBe(`chrome-extension://${extensionId}/options/options.html#ner`);
  await expect(opened.locator('#ner')).toBeInViewport();

  // модель выбрана — строки в popup нет (сама модель здесь не нужна: popup смотрит только на nerModel)
  await popup.evaluate(() => chrome.storage.local.set({ settings: { uiLanguage: 'ru', nerModel: 'some-pack' } }));
  await expect(hint).toBeHidden();
});
