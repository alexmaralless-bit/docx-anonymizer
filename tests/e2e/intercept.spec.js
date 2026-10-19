// WP3: перехват на сайте, панель и popup. Страница — локальная (tests/e2e/pages/intercept-basic.html),
// отдаётся через page.route под origin http://intercept.test, внешней сети нет.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, BUNDLED } from './fixtures.js';
import { makeDocx, para, run, unzipText } from '../helpers/docx.js';

const ORIGIN = 'http://intercept.test';
const PAGE_HTML = readFileSync(resolve('tests/e2e/pages/intercept-basic.html'), 'utf8');
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const EMAIL_A = 'ivan.petrov@example.com';
const EMAIL_B = 'maria.sidorova@example.org';

const docxBytes = () => Buffer.from(makeDocx(para(run(`Связь: ${EMAIL_A}, запасной адрес ${EMAIL_B}. Срок поставки — 10 дней.`))));
const docxFile = (name = 'договор.docx') => ({ name, mimeType: DOCX_MIME, buffer: docxBytes() });

async function setup(context, extensionId, { enabled = true, extra = {} } = {}) {
  await context.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE_HTML }));
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await setSettings(ext, enabled, extra);
  await ext.close();
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/`);
  return page;
}

async function setSettings(ext, enabled, extra = {}) {
  await ext.evaluate(
    async ({ enabled, origin, extra }) => {
      await chrome.storage.local.set({ __e2eOpenShadow: true, settings: { interceptEnabled: enabled, allowlist: [origin], uiLanguage: 'ru', ...extra } });
    },
    { enabled, origin: ORIGIN, extra },
  );
}

const dump = (page) => page.evaluate(() => window.__dump());
const textOf = (item) => Object.values(unzipText(Buffer.from(item.b64, 'base64'))).join('\n');

test.describe('перехват на сайте', () => {
  test('выключен по умолчанию: файл идёт на сайт как есть, панели нет (FR-07)', async ({ context, extensionId }) => {
    const page = await setup(context, extensionId, { enabled: false });
    await page.setInputFiles('#single', docxFile());
    await expect.poll(async () => (await dump(page)).length).toBe(1);
    expect((await dump(page))[0].name).toBe('договор.docx');
    expect(await page.evaluate(() => document.querySelector('docx-anonymizer-root'))).toBeNull();
  });

  test('input: панель, снятие галочки, «Анонимизировать» → сайт получает *.anon.docx', async ({ context, extensionId }) => {
    const page = await setup(context, extensionId, { extra: { hintMappingShown: true } }); // подсказка о ключе (WP10-D) — отдельный тест
    await page.setInputFiles('#single', docxFile());
    await expect(page.getByTestId('pv-summary')).toContainText('Найдено', { timeout: 30000 });
    expect(await dump(page)).toEqual([]); // до решения сайт ничего не получил
    // снимаем галочку с одного адреса — он должен остаться в файле
    const row = page.locator('.pv-row', { hasText: EMAIL_B });
    await row.getByTestId('pv-check').uncheck();
    await expect(page.getByTestId('btn-anonymize')).toBeEnabled();
    await page.getByTestId('btn-anonymize').click();
    await expect(page.getByTestId('done-title')).toBeVisible({ timeout: 30000 });
    const got = await dump(page);
    expect(got).toHaveLength(1);
    expect(got[0].name).toBe('договор.anon.docx');
    expect(got[0].type).toBe(DOCX_MIME);
    const txt = textOf(got[0]);
    expect(txt).not.toContain(EMAIL_A);
    expect(txt).toContain(EMAIL_B);
    expect(txt).toMatch(/\[EMAIL_1\]|\[ПОЧТА_1\]|\[E-?MAIL_1\]|\[[^\]]+_1\]/);
    expect(await page.evaluate(() => window.__events)).toBe(1);
    // повторная загрузка того же файла: решения восстановлены
    await page.getByTestId('btn-done-close').click();
    await page.setInputFiles('#single', { ...docxFile('другой.docx') });
    await expect(page.getByTestId('pv-summary')).toBeVisible({ timeout: 30000 });
    await page.getByTestId('btn-cancel').click();
  });

  test('«Отправить оригинал» требует подтверждения и передаёт файл без изменений', async ({ context, extensionId }) => {
    const page = await setup(context, extensionId);
    await page.setInputFiles('#single', docxFile());
    await expect(page.getByTestId('pv-summary')).toBeVisible({ timeout: 30000 });
    await page.getByTestId('btn-original').click();
    await expect(page.getByTestId('confirm')).toBeVisible();
    expect(await dump(page)).toEqual([]);
    await page.getByTestId('btn-original-confirm').click();
    await expect.poll(async () => (await dump(page)).length).toBe(1);
    const got = (await dump(page))[0];
    expect(got.name).toBe('договор.docx');
    expect(textOf(got)).toContain(EMAIL_A);
    await expect(page.locator('docx-anonymizer-root')).toHaveCount(0);
  });

  test('«Отмена» и Esc: сайт ничего не получает', async ({ context, extensionId }) => {
    const page = await setup(context, extensionId);
    await page.setInputFiles('#single', docxFile());
    await expect(page.getByTestId('pv-summary')).toBeVisible({ timeout: 30000 });
    await page.getByTestId('btn-cancel').click();
    await expect(page.locator('docx-anonymizer-root')).toHaveCount(0);
    expect(await dump(page)).toEqual([]);
    expect(await page.evaluate(() => document.getElementById('single').value)).toBe('');

    await page.setInputFiles('#single', docxFile());
    await expect(page.getByTestId('pv-summary')).toBeVisible({ timeout: 30000 });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('confirm')).toBeVisible();
    await page.getByTestId('btn-confirm-cancel').click();
    await expect(page.locator('docx-anonymizer-root')).toHaveCount(0);
    expect(await dump(page)).toEqual([]);
  });

  test('multiple: [a.docx, b.pdf, c.docx] → [a.anon.docx, b.pdf, c.anon.docx], вкладки по файлам (FR-06), PDF без текста — как есть', async ({
    context,
    extensionId,
  }) => {
    const page = await setup(context, extensionId);
    await page.setInputFiles('#multi', [
      docxFile('a.docx'),
      { name: 'b.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') },
      docxFile('c.docx'),
    ]);
    // версия 0.3: PDF тоже перехватывается — без текстового слоя он получает вкладку с ошибкой и уходит «как есть» (К11)
    await expect(page.getByTestId('file-tab')).toHaveCount(3);
    await page.getByTestId('file-tab').nth(1).click();
    await expect(page.locator('.fview.active [data-testid="error-message"]')).toBeVisible({ timeout: 40000 });
    await page.locator('.fview.active [data-testid="btn-asis"]').click();
    await expect(page.getByTestId('btn-anonymize')).toBeEnabled({ timeout: 40000 });
    await page.getByTestId('btn-anonymize').click();
    await expect(page.getByTestId('done-title')).toBeVisible({ timeout: 30000 });
    const got = await dump(page);
    expect(got.map((g) => g.name)).toEqual(['a.anon.docx', 'b.pdf', 'c.anon.docx']);
    expect(got[1].type).toBe('application/pdf');
    expect(await page.evaluate(() => window.__events)).toBe(1);
    // сквозная нумерация: одно значение в двух файлах — один плейсхолдер
    const a = textOf(got[0]).match(/\[[^\]]+_\d+\]/g);
    const c = textOf(got[2]).match(/\[[^\]]+_\d+\]/g);
    expect(a).toEqual(c);
  });

  test('файл без .docx проходит без панели', async ({ context, extensionId }) => {
    const page = await setup(context, extensionId);
    await page.setInputFiles('#single', { name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('привет') });
    await expect.poll(async () => (await dump(page)).length).toBe(1);
    expect(await page.evaluate(() => document.querySelector('docx-anonymizer-root'))).toBeNull();
  });

  test('динамический input и input в open shadow root', async ({ context, extensionId }) => {
    const page = await setup(context, extensionId, { extra: { hintMappingShown: true } });
    await page.click('#add-dynamic');
    await page.setInputFiles('#dynamic', docxFile('dyn.docx'));
    await expect(page.getByTestId('btn-anonymize')).toBeEnabled({ timeout: 30000 });
    await page.getByTestId('btn-anonymize').click();
    await expect(page.getByTestId('done-title')).toBeVisible({ timeout: 30000 });
    await page.getByTestId('btn-done-close').click();
    await page.setInputFiles('#shadow-input', docxFile('sh.docx'));
    await expect(page.getByTestId('btn-anonymize')).toBeEnabled({ timeout: 30000 });
    await page.getByTestId('btn-anonymize').click();
    await expect(page.getByTestId('done-title')).toBeVisible({ timeout: 30000 });
    const got = await dump(page);
    expect(got.map((g) => `${g.via}:${g.name}`)).toEqual(['dynamic:dyn.anon.docx', 'shadow:sh.anon.docx']);
  });

  test('drag&drop (FR-02) и вставка (FR-03)', async ({ context, extensionId }) => {
    const page = await setup(context, extensionId, { extra: { hintMappingShown: true } });
    const b64 = docxBytes().toString('base64');
    await page.evaluate(
      ({ b64, mime }) => {
        const dt = new DataTransfer();
        dt.items.add(window.__make('перетащенный.docx', mime, b64));
        document.getElementById('dropzone').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      },
      { b64, mime: DOCX_MIME },
    );
    await expect(page.getByTestId('btn-anonymize')).toBeEnabled({ timeout: 30000 });
    expect(await dump(page)).toEqual([]);
    await page.getByTestId('btn-anonymize').click();
    await expect(page.getByTestId('done-title')).toBeVisible({ timeout: 30000 });
    await page.getByTestId('btn-done-close').click();
    await page.evaluate(
      ({ b64, mime }) => {
        const dt = new DataTransfer();
        dt.items.add(window.__make('вставленный.docx', mime, b64));
        document.getElementById('pastezone').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      },
      { b64, mime: DOCX_MIME },
    );
    await expect(page.getByTestId('btn-anonymize')).toBeEnabled({ timeout: 30000 });
    await page.getByTestId('btn-anonymize').click();
    await expect(page.getByTestId('done-title')).toBeVisible({ timeout: 30000 });
    const got = await dump(page);
    expect(got.map((g) => `${g.via}:${g.name}`)).toEqual(['drop:перетащенный.anon.docx', 'paste:вставленный.anon.docx']);
    expect(textOf(got[0])).not.toContain(EMAIL_A);
  });

  test('ошибка: не .docx по содержимому — решение за пользователем, без автоматической отправки', async ({ context, extensionId }) => {
    const page = await setup(context, extensionId);
    await page.setInputFiles('#single', { name: 'битый.docx', mimeType: DOCX_MIME, buffer: Buffer.from('это не zip') });
    await expect(page.getByTestId('error-message')).toContainText('повреждён', { timeout: 30000 });
    await expect(page.getByTestId('btn-anonymize')).toBeDisabled();
    expect(await dump(page)).toEqual([]);
    await page.getByTestId('btn-original').click();
    await page.getByTestId('btn-original-confirm').click();
    await expect.poll(async () => (await dump(page)).length).toBe(1);
    expect((await dump(page))[0].name).toBe('битый.docx');
  });

  test('настройки применяются без перезагрузки страницы (FR-34); панель не создаётся, пока выключено', async ({ context, extensionId }) => {
    const page = await setup(context, extensionId, { enabled: false });
    const ext = await context.newPage();
    await ext.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await setSettings(ext, true);
    await page.waitForTimeout(500);
    await page.setInputFiles('#single', docxFile());
    await expect(page.getByTestId('pv-summary')).toBeVisible({ timeout: 30000 });
    await page.getByTestId('btn-cancel').click();
    await setSettings(ext, false);
    await page.waitForTimeout(500);
    await page.setInputFiles('#single', docxFile('снова.docx'));
    await expect.poll(async () => (await dump(page)).length).toBe(1);
    expect(await page.evaluate(() => document.querySelector('docx-anonymizer-root'))).toBeNull();
  });

  test('вкладка «Текст»: выделение → «Анонимизировать как» (FR-31)', async ({ context, extensionId }) => {
    const page = await setup(context, extensionId);
    await page.setInputFiles('#single', docxFile());
    await expect(page.getByTestId('pv-summary')).toBeVisible({ timeout: 30000 });
    await page.getByTestId('pv-tab-text').click();
    await expect(page.locator('.pv-mark').first()).toBeVisible();
    // выделяем «Срок поставки» внутри панели и сообщаем компоненту о mouseup
    await page.evaluate(() => {
      const root = document.querySelector('docx-anonymizer-root').shadowRoot;
      const p = root.querySelector('.pv-p');
      const node = [...p.childNodes].find((n) => n.nodeType === 3 && n.textContent.includes('Срок поставки'));
      const start = node.textContent.indexOf('Срок поставки');
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + 'Срок поставки'.length);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      root.querySelector('.pv-text').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await page.getByTestId('pv-sel-category').selectOption('PERSON');
    await page.getByTestId('pv-sel-apply').click();
    await page.getByTestId('pv-tab-entities').click();
    await expect(page.locator('.pv-row .val', { hasText: 'Срок поставки' })).toBeVisible({ timeout: 10000 });
    await page.getByTestId('btn-anonymize').click();
    await expect(page.getByTestId('done-title')).toBeVisible({ timeout: 30000 });
    const txt = textOf((await dump(page))[0]);
    expect(txt).not.toContain('Срок поставки');
    expect(txt).not.toContain(EMAIL_A);
  });
});

// WP10-D (К16): ключ восстановления — в меню «Ещё»; одноразовая подсказка при закрытии без сохранения
test.describe('экран «готово»: меню «Ещё» и подсказка о ключе восстановления', () => {
  async function anonymizeOnce(page, name = 'договор.docx') {
    await page.setInputFiles('#single', docxFile(name));
    await expect(page.getByTestId('btn-anonymize')).toBeEnabled({ timeout: 30000 });
    await page.getByTestId('btn-anonymize').click();
    await expect(page.getByTestId('done-title')).toBeVisible({ timeout: 30000 });
  }

  test('ключ скачивается из меню «Ещё»; после сохранения «Закрыть» закрывает без подсказки', async ({ context, extensionId }) => {
    const page = await setup(context, extensionId);
    await anonymizeOnce(page);
    await expect(page.getByTestId('btn-download-mapping')).toBeHidden();
    await expect(page.getByTestId('btn-download-result')).toHaveClass(/btn-primary/);
    await expect(page.getByTestId('btn-more')).toHaveAttribute('aria-expanded', 'false');
    await page.getByTestId('btn-more').click();
    await expect(page.getByTestId('more-menu')).toBeVisible();
    await expect(page.getByTestId('btn-more')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('btn-download-mapping')).toHaveText('Сохранить ключ восстановления');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('btn-download-mapping').click()]);
    expect(dl.suggestedFilename()).toBe('договор.mapping.json');
    const json = JSON.parse(readFileSync(await dl.path(), 'utf8'));
    expect(Array.isArray(json.entries)).toBe(true);
    expect(json.entries.length).toBeGreaterThan(0);
    await expect(page.getByTestId('more-menu')).toBeHidden();
    await page.getByTestId('btn-done-close').click();
    await expect(page.locator('docx-anonymizer-root')).toHaveCount(0);
    await expect(page.getByTestId('mapping-hint')).toHaveCount(0);
  });

  test('без сохранения — подсказка один раз, флаг в настройках; Esc и клик вне закрывают меню, не панель', async ({ context, extensionId }) => {
    const page = await setup(context, extensionId);
    await anonymizeOnce(page);
    await page.getByTestId('btn-more').click();
    await expect(page.getByTestId('more-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('more-menu')).toBeHidden();
    await expect(page.getByTestId('done-title')).toBeVisible();
    await expect(page.getByTestId('btn-more')).toBeFocused(); // фокус возвращается на кнопку меню
    await page.getByTestId('btn-more').click();
    await expect(page.getByTestId('more-menu')).toBeVisible();
    await page.getByTestId('done-title').click();
    await expect(page.getByTestId('more-menu')).toBeHidden();
    await expect(page.getByTestId('done-title')).toBeVisible();

    await page.getByTestId('btn-done-close').click();
    await expect(page.getByTestId('mapping-hint')).toBeVisible();
    await expect(page.getByTestId('mapping-hint')).toContainText('Сохранить ключ восстановления?');
    await expect(page.getByTestId('btn-hint-save')).toBeVisible();
    await page.getByTestId('btn-hint-ok').click();
    await expect(page.locator('docx-anonymizer-root')).toHaveCount(0);
    const ext = await context.newPage();
    await ext.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await expect.poll(() => ext.evaluate(async () => (await chrome.storage.local.get('settings')).settings?.hintMappingShown)).toBe(true);
    await ext.close();

    await page.reload();
    await anonymizeOnce(page, 'второй.docx');
    await page.getByTestId('btn-done-close').click();
    await expect(page.locator('docx-anonymizer-root')).toHaveCount(0);
    await expect(page.getByTestId('mapping-hint')).toHaveCount(0);
  });

  // «×» и Esc на экране «готово» ведут себя как «Закрыть»: подсказка не обходится
  for (const [how, close] of [
    ['Esc', (page) => page.keyboard.press('Escape')],
    ['«×»', (page) => page.getByTestId('panel-close').click()],
  ]) {
    test(`${how} на экране «готово» без сохранения ключа → подсказка; повторно — закрывает панель`, async ({ context, extensionId }) => {
      const page = await setup(context, extensionId);
      await anonymizeOnce(page);
      await close(page);
      await expect(page.getByTestId('mapping-hint')).toBeVisible();
      await expect(page.locator('docx-anonymizer-root')).toHaveCount(1);
      await close(page);
      await expect(page.locator('docx-anonymizer-root')).toHaveCount(0);
    });
  }
});

test('popup: тумблер перехвата сохраняется в настройках, статус сайта (FR-42)', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  const toggle = page.locator('#intercept-toggle');
  await expect(toggle).not.toBeChecked();
  await toggle.check({ force: true });
  await expect.poll(() => page.evaluate(async () => (await chrome.storage.local.get('settings')).settings?.interceptEnabled)).toBe(true);
  await expect(page.getByTestId('site-status')).toBeVisible();
  await expect(page.getByTestId('recent-list')).toBeAttached();
});

test('бейдж ON на разрешённом сайте и тултип (FR-43)', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  await page.bringToFront();
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  await expect
    .poll(
      () =>
        sw.evaluate(async (origin) => {
          const [tab] = await chrome.tabs.query({ url: `${origin}/*` });
          return [await chrome.action.getBadgeText({ tabId: tab.id }), await chrome.action.getTitle({ tabId: tab.id })];
        }, ORIGIN),
      { timeout: 10000 },
    )
    .toEqual(['ON', 'DOCX Anonymizer — перехват включён на intercept.test']);
});

test('скриншоты панели для портфолио (E2E_SHOTS=каталог)', async ({ context, extensionId }) => {
  test.skip(!process.env.E2E_SHOTS, 'только по запросу');
  const buf = readFileSync(resolve('tests/fixtures/sample-contract.docx'));
  const page = await setup(context, extensionId);
  await page.setViewportSize({ width: 1100, height: 780 });
  await page.setInputFiles('#single', { name: 'Договор поставки.docx', mimeType: DOCX_MIME, buffer: buf });
  await expect(page.getByTestId('btn-anonymize')).toBeEnabled({ timeout: 30000 });
  await page.screenshot({ path: `${process.env.E2E_SHOTS}/panel-entities.png` });
  await page.getByTestId('pv-tab-text').click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${process.env.E2E_SHOTS}/panel-text.png` });
  await page.getByTestId('pv-tab-entities').click();
  await page.getByTestId('btn-original').click();
  await page.screenshot({ path: `${process.env.E2E_SHOTS}/panel-confirm.png` });
  await page.getByTestId('btn-confirm-back').click();
  await page.getByTestId('btn-anonymize').click();
  await expect(page.getByTestId('done-title')).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: `${process.env.E2E_SHOTS}/panel-done.png` });
  const got = await dump(page);
  writeFileSync(`${process.env.E2E_SHOTS}/sample.docx`, buf);
  writeFileSync(`${process.env.E2E_SHOTS}/sample.anon.docx`, Buffer.from(got[0].b64, 'base64'));
  const pop = await context.newPage();
  await pop.setViewportSize({ width: 340, height: 420 });
  await pop.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await pop.waitForTimeout(500);
  await pop.screenshot({ path: `${process.env.E2E_SHOTS}/popup.png` });
  const opt = await context.newPage();
  await opt.setViewportSize({ width: 1100, height: 900 });
  await opt.goto(`chrome-extension://${extensionId}/options/options.html`);
  await opt.evaluate(() =>
    chrome.storage.local.set({ settings: { interceptEnabled: true, allowlist: ['https://chatgpt.com', 'https://claude.ai'], uiLanguage: 'ru' } }),
  );
  await opt.reload();
  await opt.waitForTimeout(600);
  await opt.screenshot({ path: `${process.env.E2E_SHOTS}/options.png`, fullPage: true });
});

// WP10-C (К16): лёгкая сборка без модели — закрываемая подсказка о модели NER в панели; закрыта — до перезагрузки страницы не возвращается
test('панель: подсказка «установите модель NER», «×» убирает, второй файл — без подсказки', async ({ context, extensionId }) => {
  test.skip(!!BUNDLED, 'полная сборка: модель встроена');
  const page = await setup(context, extensionId, { extra: { hintMappingShown: true } });
  await page.setInputFiles('#single', docxFile());
  await expect(page.getByTestId('pv-summary')).toBeVisible({ timeout: 30000 });
  const hint = page.getByTestId('ner-hint');
  await expect(hint).toBeVisible();
  await expect(hint).toContainText('Установите модель NER в настройках расширения');
  await page.getByTestId('ner-hint-close').click();
  await expect(hint).toHaveCount(0);
  await expect(page.getByTestId('pv-summary')).toBeVisible(); // панель на месте
  await page.getByTestId('btn-cancel').click();
  await expect(page.locator('docx-anonymizer-root')).toHaveCount(0);

  await page.setInputFiles('#single', docxFile('второй.docx'));
  await expect(page.getByTestId('pv-summary')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('ner-hint')).toHaveCount(0);
  await page.getByTestId('btn-cancel').click();
  await expect(page.locator('docx-anonymizer-root')).toHaveCount(0);

  // с установленной моделью подсказки нет и на новой странице
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await setSettings(ext, true, { hintMappingShown: true, nerModel: 'some-pack' });
  await ext.close();
  await page.reload();
  await page.setInputFiles('#single', docxFile('третий.docx'));
  await expect(page.getByTestId('pv-summary')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('ner-hint')).toHaveCount(0);
});

// Политика 0.4 (Ц1, Ц3, К3; contracts §8): организации — по желанию, список компаний, «Маскировать всегда», подсказка один раз
test.describe('политика маскирования 0.4: список компаний и организации', () => {
  const companyDocx = (name = 'поставка.docx') => ({
    name,
    mimeType: DOCX_MIME,
    buffer: Buffer.from(
      makeDocx(
        para(run(`ООО «Ромашка» поставляет товар. Связь: ${EMAIL_A}.`)) +
          para(run('Счёт выставлен Ромашке, копия — АО «Вектор».')) +
          para(run('Срок поставки — 10 дней.')),
      ),
    ),
  });
  const stored = (ext) => ext.evaluate(async () => (await chrome.storage.local.get('settings')).settings);

  test('обычный режим: организаций нет, компания из списка — строка «из списка», маскируется во всех падежах', async ({ context, extensionId }) => {
    const page = await setup(context, extensionId, { extra: { hintMappingShown: true, maskedCompanies: [{ name: 'Ромашка', aliases: [] }] } });
    await page.setInputFiles('#single', companyDocx());
    await expect(page.getByTestId('pv-summary')).toBeVisible({ timeout: 30000 });
    const row = page.locator('.pv-row', { hasText: 'Организация' });
    await expect(row).toHaveCount(1); // «Вектор» не из списка — в обычном режиме не предлагается
    await expect(row.getByTestId('pv-source-list')).toHaveText('из списка');
    await expect(row.getByTestId('pv-mask-always')).toHaveCount(0);
    await expect(row).toContainText('2 вхожд.');
    await page.getByTestId('btn-anonymize').click();
    await expect(page.getByTestId('done-title')).toBeVisible({ timeout: 30000 });
    const txt = textOf((await dump(page))[0]);
    expect(txt).not.toContain('Ромашк');
    expect(txt).toContain('ООО «[КОМПАНИЯ_1]»');
    expect(txt).toContain('АО «Вектор»');
    expect(txt).not.toContain(EMAIL_A);
  });

  test('коммерческий режим: «Маскировать всегда» пишет компанию в список; ⊘ у компании из списка — исключение по записи', async ({ context, extensionId }) => {
    const page = await setup(context, extensionId, {
      extra: { hintMappingShown: true, commercial: true, maskedCompanies: [{ name: 'Ромашка', aliases: [] }] },
    });
    await page.setInputFiles('#single', companyDocx());
    await expect(page.getByTestId('pv-summary')).toBeVisible({ timeout: 30000 });
    // по значению строки (.val): в контексте строки «Вектор» есть «Ромашке»
    const rowOf = (v) => page.locator('.pv-row', { has: page.locator('.val', { hasText: v }) });
    const vector = rowOf('Вектор');
    await expect(vector).toHaveCount(1);
    await expect(vector.getByTestId('pv-source-list')).toHaveCount(0);
    await vector.getByTestId('pv-mask-always').click();
    await expect(page.locator('.pv-toast')).toContainText('добавлена в список компаний');
    const ext = await context.newPage();
    await ext.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await expect
      .poll(async () => (await stored(ext)).maskedCompanies)
      .toEqual([
        { name: 'Ромашка', aliases: [] },
        { name: 'Вектор', aliases: [] },
      ]);
    // компания из списка: кнопки нет, ⊘ кладёт в исключения canonical записи
    const romashka = rowOf('Ромашк');
    await expect(romashka.getByTestId('pv-source-list')).toBeVisible();
    await expect(romashka.getByTestId('pv-mask-always')).toHaveCount(0);
    await romashka.getByTestId('pv-ignore').click();
    await expect.poll(async () => (await stored(ext)).exclusions).toEqual([{ value: 'ромашка', category: 'COMPANY' }]);
    await ext.close();
    await page.getByTestId('btn-cancel').click();
  });

  test('вкладка «Текст»: «Организация» + «запомнить» пополняет список компаний', async ({ context, extensionId }) => {
    const page = await setup(context, extensionId, { extra: { hintMappingShown: true } });
    await page.setInputFiles('#single', companyDocx());
    await expect(page.getByTestId('pv-summary')).toBeVisible({ timeout: 30000 });
    await page.getByTestId('pv-tab-text').click();
    await expect(page.locator('.pv-p').first()).toBeVisible();
    await page.evaluate(() => {
      const root = document.querySelector('docx-anonymizer-root').shadowRoot;
      const p = [...root.querySelectorAll('.pv-p')].find((x) => x.textContent.includes('Вектор'));
      const node = [...p.childNodes].find((n) => n.nodeType === 3 && n.textContent.includes('Вектор'));
      const start = node.textContent.indexOf('Вектор');
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + 'Вектор'.length);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      root.querySelector('.pv-text').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await expect(page.getByTestId('pv-sel-remember')).toBeHidden(); // по умолчанию выбрана не «Организация»
    await page.getByTestId('pv-sel-category').selectOption('COMPANY');
    await page.getByTestId('pv-sel-remember').check();
    await page.getByTestId('pv-sel-apply').click();
    await page.getByTestId('pv-tab-entities').click();
    await expect(page.locator('.pv-row .val', { hasText: 'Вектор' })).toBeVisible({ timeout: 10000 });
    const ext = await context.newPage();
    await ext.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await expect.poll(async () => (await stored(ext)).maskedCompanies).toEqual([{ name: 'Вектор', aliases: [] }]);
    await ext.close();
    await page.getByTestId('btn-cancel').click();
  });

  test('подсказка о политике (orgPolicyHintPending) показана один раз и снимает флаг', async ({ context, extensionId }) => {
    const page = await setup(context, extensionId, { extra: { hintMappingShown: true, orgPolicyHintPending: true } });
    await page.setInputFiles('#single', docxFile());
    await expect(page.getByTestId('pv-summary')).toBeVisible({ timeout: 30000 });
    const hint = page.getByTestId('org-policy-hint');
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('по желанию');
    const ext = await context.newPage();
    await ext.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await expect.poll(async () => (await stored(ext)).orgPolicyHintPending).toBe(false);
    await ext.close();
    // «Открыть настройки» — вкладку открывает background (MSG.OPEN_OPTIONS) сразу на разделе «Что маскируется»
    const [opened] = await Promise.all([context.waitForEvent('page'), page.getByTestId('org-policy-hint-open').click()]);
    await opened.waitForLoadState();
    expect(opened.url()).toBe(`chrome-extension://${extensionId}/options/options.html#categories`);
    await expect(opened.getByTestId('commercial')).toBeAttached();
    await opened.close();
    await page.getByTestId('org-policy-hint-close').click();
    await expect(hint).toHaveCount(0);
    await page.getByTestId('btn-cancel').click();
    await expect(page.locator('docx-anonymizer-root')).toHaveCount(0);
    await page.setInputFiles('#single', docxFile('второй.docx'));
    await expect(page.getByTestId('pv-summary')).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId('org-policy-hint')).toHaveCount(0);
    await page.getByTestId('btn-cancel').click();
  });
});
