// WP3: перехват на сайте, панель и popup. Страница — локальная (tests/e2e/pages/intercept-basic.html),
// отдаётся через page.route под origin http://intercept.test, внешней сети нет.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from './fixtures.js';
import { makeDocx, para, run, unzipText } from '../helpers/docx.js';

const ORIGIN = 'http://intercept.test';
const PAGE_HTML = readFileSync(resolve('tests/e2e/pages/intercept-basic.html'), 'utf8');
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const EMAIL_A = 'ivan.petrov@example.com';
const EMAIL_B = 'maria.sidorova@example.org';

const docxBytes = () => Buffer.from(makeDocx(para(run(`Связь: ${EMAIL_A}, запасной адрес ${EMAIL_B}. Срок поставки — 10 дней.`))));
const docxFile = (name = 'договор.docx') => ({ name, mimeType: DOCX_MIME, buffer: docxBytes() });

async function setup(context, extensionId, { enabled = true } = {}) {
  await context.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE_HTML }));
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await setSettings(ext, enabled);
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
    const page = await setup(context, extensionId);
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

  test('multiple: [a.docx, b.pdf, c.docx] → [a.anon.docx, b.pdf, c.anon.docx], вкладки по файлам (FR-06)', async ({ context, extensionId }) => {
    const page = await setup(context, extensionId);
    await page.setInputFiles('#multi', [
      docxFile('a.docx'),
      { name: 'b.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') },
      docxFile('c.docx'),
    ]);
    await expect(page.getByTestId('file-tab')).toHaveCount(2);
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
    const page = await setup(context, extensionId);
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
    const page = await setup(context, extensionId);
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
  const emails = Array.from({ length: 9 }, (_, i) => `contact${i + 1}@client-${i + 1}.example.com`);
  const buf = Buffer.from(makeDocx(para(run(`Договор поставки. Контакты сторон: ${emails.join('; ')}. Срок поставки — 10 дней.`))));
  const page = await setup(context, extensionId);
  await page.setViewportSize({ width: 1100, height: 780 });
  await page.setInputFiles('#single', { name: 'Договор поставки №14.docx', mimeType: DOCX_MIME, buffer: buf });
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
  const pop = await context.newPage();
  await pop.setViewportSize({ width: 340, height: 420 });
  await pop.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await pop.waitForTimeout(500);
  await pop.screenshot({ path: `${process.env.E2E_SHOTS}/popup.png` });
});
