// PDF с текстовым слоем (версия 0.3): К9 (перехват → .anon.md), К5 (отказы через экран ошибки, «Загрузить как есть»),
// К7/К17 (pdf.js, CMaps и шрифты — только из пакета, ни одного http(s)-запроса), К6 (время анализа), К10 (восстановление
// ответа по карте PDF-сессии со склонением). Тестовая страница-чат — tests/e2e/pages/chat.html, фикстуры — tests/fixtures/pdf/.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test, expect } from './fixtures.js';
import { buildSampleDocx } from '../../scripts/make-sample.mjs';
import { common } from '../../src/ui/i18n/common.js';
import { openChat, waitReceived, receivedBytes, writeTemp, sha256, setExtensionSettings, enableIntercept, panel, received } from './helpers/chat.js';
import { captureAllRequests, externalRequests, offscreenRequests } from './helpers/network.js';
import { installClient, runPipeline } from './helpers/client.js';

const DIR = resolve('tests/fixtures/pdf');
const pdf = (n) => readFileSync(join(DIR, `${n}.pdf`));
const SAMPLE = pdf('sample-contract');
const gold = JSON.parse(readFileSync(join(DIR, 'sample-contract.gold.json'), 'utf8'));
const EMAILS = gold.filter((g) => /^email/.test(g.key)).map((g) => g.value);

/** Включённый перехват на тестовом сайте; подсказка о ключе восстановления (WP10-D) не мешает сценариям. */
async function setup(context, extensionId, site, extra = {}) {
  await enableIntercept(context, extensionId, site);
  await setExtensionSettings(context, extensionId, { hintMappingShown: true, uiLanguage: 'ru', ...extra });
  return openChat(context, site);
}

const attach = async (page, files) => {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#attach-btn')]);
  await chooser.setFiles(files);
};

test.describe('PDF: перехват и результат (К9)', () => {
  test('sample-contract.pdf через скрытый input → панель → «Анонимизировать» → страница получает .anon.md; сеть — только пакет (К7)', async ({
    context,
    extensionId,
    site,
  }) => {
    const net = await captureAllRequests(context);
    const page = await setup(context, extensionId, site);
    await attach(page, writeTemp('sample-contract.pdf', SAMPLE));
    const ui = panel(page);
    await expect(ui.summary).toContainText('Найдено', { timeout: 60000 });
    await expect(ui.host.locator('[data-testid="pdf-note"]')).toContainText('.md');
    await ui.anonymize.click();
    const [r] = await waitReceived(page, 1, 60000);
    expect(r.name).toBe('sample-contract.anon.md');
    expect(r.type).toBe('text/markdown');
    const text = (await receivedBytes(page, 0)).toString('utf8');
    expect(text).toMatch(/\[EMAIL_\d+\]/);
    for (const v of EMAILS) expect(text, v).not.toContain(v);
    expect(text).toContain('| --- | --- |');
    // «Скачать результат» на экране «готово» отдаёт тот же .anon.md
    await expect(ui.done).toBeVisible();
    const [dl] = await Promise.all([page.waitForEvent('download'), ui.downloadResult.click()]);
    expect(dl.suggestedFilename()).toBe('sample-contract.anon.md');
    expect(readFileSync(await dl.path(), 'utf8')).toBe(text);

    const urls = await net.stop();
    expect(externalRequests(urls, [site.origin]), 'http(s) вне тестового сайта').toEqual([]);
    expect(urls.filter((u) => !u.startsWith(site.origin) && !/^(chrome-extension|chrome|data|blob|about):/.test(u))).toEqual([]);
    expect(urls.filter((u) => u.startsWith('blob:'))).toEqual([]); // pdf.js не уходит в blob-воркер
    const ext = offscreenRequests(urls);
    expect(ext).toEqual(
      expect.arrayContaining([expect.stringMatching(/\/vendor\/pdfjs\/pdf\.mjs$/), expect.stringMatching(/\/vendor\/pdfjs\/pdf\.worker\.mjs$/)]),
    );
  });

  test('«Отправить оригинал» → подтверждение → страница получает исходный PDF', async ({ context, extensionId, site }) => {
    const page = await setup(context, extensionId, site);
    await page.setInputFiles('#multi-input', writeTemp('оригинал.pdf', SAMPLE));
    const ui = panel(page);
    await expect(ui.summary).toBeVisible({ timeout: 60000 });
    await ui.original.click();
    await ui.originalConfirm.click();
    const [r] = await waitReceived(page, 1);
    expect(r.name).toBe('оригинал.pdf');
    expect(r.sha256).toBe(sha256(SAMPLE));
  });

  test('[a.pdf, b.docx] → [a.anon.md, b.anon.docx]', async ({ context, extensionId, site }) => {
    const page = await setup(context, extensionId, site);
    await page.setInputFiles('#multi-input', [writeTemp('a.pdf', SAMPLE), writeTemp('b.docx', buildSampleDocx().bytes)]);
    const ui = panel(page);
    await expect(ui.tabs).toHaveCount(2);
    await expect(ui.anonymize).toBeEnabled({ timeout: 60000 });
    await ui.anonymize.click();
    const list = await waitReceived(page, 2, 60000);
    expect(list.map((x) => x.name)).toEqual(['a.anon.md', 'b.anon.docx']);
    expect(list[0].type).toBe('text/markdown');
  });

  test("pdfMode: 'text' → .anon.txt (text/plain); pdfMode: 'off' → PDF проходит как есть, панели нет", async ({ context, extensionId, site }) => {
    let page = await setup(context, extensionId, site, { pdfMode: 'text' });
    await page.setInputFiles('#multi-input', writeTemp('t.pdf', SAMPLE));
    // заметка называет расширение результата по pdfMode (FR-54)
    await expect(panel(page).host.locator('[data-testid="pdf-note"]')).toContainText('.txt', { timeout: 60000 });
    await panel(page).anonymize.click({ timeout: 60000 });
    const [r] = await waitReceived(page, 1, 60000);
    expect([r.name, r.type]).toEqual(['t.anon.txt', 'text/plain']);
    await page.close();

    page = await setup(context, extensionId, site, { pdfMode: 'off' });
    await page.setInputFiles('#multi-input', writeTemp('off.pdf', SAMPLE));
    const [o] = await waitReceived(page, 1);
    expect(o.name).toBe('off.pdf');
    expect(o.sha256).toBe(sha256(SAMPLE));
    await expect(panel(page).host).toHaveCount(0);
  });
});

test.describe('PDF: отказы и предупреждения (К5)', () => {
  test('скан → «похоже, это скан»; «Загрузить как есть» → «Анонимизировать» → исходные байты', async ({ context, extensionId, site }) => {
    const page = await setup(context, extensionId, site);
    const scan = pdf('scan');
    await page.setInputFiles('#multi-input', writeTemp('скан.pdf', scan));
    const ui = panel(page);
    await expect(ui.error).toContainText('скан', { timeout: 60000 });
    await expect(ui.anonymize).toBeDisabled(); // без явного решения файл не уходит
    expect(await received(page)).toEqual([]);
    await ui.host.locator('[data-testid="btn-asis"]').click();
    await expect(ui.anonymize).toBeEnabled();
    await expect(ui.anonymize).toHaveText('Загрузить'); // все файлы — как есть: замен не будет
    await ui.anonymize.click();
    const [r] = await waitReceived(page, 1);
    expect(r.name).toBe('скан.pdf');
    expect(r.sha256).toBe(sha256(scan));
  });

  test('с паролем, пустой, не PDF с расширением .pdf — свои сообщения на вкладках', async ({ context, extensionId, site }) => {
    const page = await setup(context, extensionId, site);
    await page.setInputFiles('#multi-input', [
      writeTemp('enc.pdf', pdf('encrypted')),
      writeTemp('empty.pdf', pdf('empty')),
      writeTemp('notpdf.pdf', buildSampleDocx().bytes),
    ]);
    const ui = panel(page);
    await expect(ui.tabs).toHaveCount(3);
    const want = [common.ru['err.PDF_ENCRYPTED'], common.ru['err.PDF_EMPTY'], common.ru['err.PDF_INVALID']];
    for (let i = 0; i < 3; i++) {
      await ui.tabs.nth(i).click();
      await expect(ui.host.locator('.fview.active [data-testid="error-message"]')).toHaveText(want[i], { timeout: 60000 });
    }
  });

  test('смешанный документ — предупреждение с номерами страниц, текст обработан', async ({ context, extensionId, site }) => {
    const page = await setup(context, extensionId, site);
    await page.setInputFiles('#multi-input', writeTemp('mixed.pdf', pdf('mixed')));
    const ui = panel(page);
    await expect(ui.summary).toBeVisible({ timeout: 60000 });
    await expect(ui.host.locator('.warn')).toContainText('Страница 2 не содержит текста');
  });
});

test.describe('PDF: конвейер через клиент протокола', () => {
  test('время анализа, стадия pdf, имя результата (К6)', async ({ context, extensionId }) => {
    const ext = await context.newPage();
    await ext.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await installClient(ext);
    const cold = await runPipeline(ext, { name: 'договор.pdf', bytes: SAMPLE });
    const perf = await runPipeline(ext, { name: 'perf-50p.pdf', bytes: pdf('perf-50p') });
    console.log(`PDF: холодный анализ sample-contract (с загрузкой pdf.js) ${cold.analyzeMs.toFixed(0)} мс; perf-50p ${perf.analyzeMs.toFixed(0)} мс`);
    expect(cold.stages).toEqual(expect.arrayContaining(['pdf', 'detect']));
    expect(cold.resultName).toBe('договор.anon.md');
    expect(cold.analyzeMs).toBeLessThan(5000);
    expect(perf.analyzeMs).toBeLessThan(15000);
  });

  test('повёрнутая страница (/Rotate 270) и «дикие» PDF в воркере Chromium: текст есть, gold не утекает (ревью WP10-A)', async ({ context, extensionId }) => {
    const ext = await context.newPage();
    await ext.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await installClient(ext);
    for (const n of ['rotated', 'wild-mono', 'wild-landscape', 'wild-2col']) {
      const run = await runPipeline(ext, { name: `${n}.pdf`, bytes: pdf(n) });
      const text = Buffer.from(run.b64, 'base64').toString('utf8');
      const g = JSON.parse(readFileSync(join(DIR, `${n}.gold.json`), 'utf8'));
      expect(text.length, n).toBeGreaterThan(500);
      expect(text, n).toMatch(/\[ФИО_\d+\]/u);
      expect(run.ent.warnings ?? [], n).toEqual([]);
      expect(
        g.filter((x) => text.toLowerCase().includes(x.value.toLowerCase())).map((x) => x.key),
        n,
      ).toEqual([]);
    }
  });

  test('восстановление ответа по карте PDF-сессии со склонением (К10)', async ({ context, extensionId }) => {
    const ext = await context.newPage();
    await ext.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await installClient(ext);
    const run = await runPipeline(ext, { name: 'третьи-лица.pdf', bytes: pdf('third-persons') });
    expect(run.resultName).toBe('третьи-лица.anon.md');
    // ФИО из трёх слов (форма из текста, например «Сафиной Гульнары Рашитовны»)
    const person = run.mapping.entries.find((e) => e.category === 'PERSON' && /^[А-ЯЁ][а-яё]+ [А-ЯЁ][а-яё]+ [А-ЯЁ][а-яё]+$/.test(e.value));
    expect(person, 'ФИО из трёх слов в карте').toBeTruthy();

    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/restore/restore.html`);
    await page.evaluate(() => chrome.storage.local.set({ settings: { uiLanguage: 'ru' } }));
    await page.reload();
    await page.getByTestId('source-session').check({ force: true });
    await page.locator(`[data-testid="session-radio"][value="${run.ent.docId}"]`).check();
    await page.getByTestId('restore-input').fill(`Письмо ${person.token}у отправлено.`);
    await page.getByTestId('restore-run').click();
    await expect(page.getByTestId('declined-mark')).toHaveCount(1);
    await expect(page.getByTestId('restore-output')).not.toContainText(person.token);
    await expect(page.getByTestId('restore-output')).toContainText('отправлено');
  });
});
