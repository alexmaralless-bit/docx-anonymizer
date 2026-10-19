// WP4: страница «Восстановить» — восстановление текста по маппингу из файла, подсветка нераспознанного; WP6 — склонение ФИО (FR-37).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test, expect } from './fixtures.js';
import { buildSampleDocx } from '../../scripts/make-sample.mjs';
import { installClient, runPipeline } from './helpers/client.js';
import { writeTemp } from './helpers/chat.js';
import { captureAllRequests, externalRequests } from './helpers/network.js';
import { parseDocx, restoreDocx } from '../../src/core/index.js';
import { makeDocx, para, run as wrun } from '../helpers/docx.js';

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

// WP10-B (FR-36а, К10, К14): файл от ИИ — .md/.txt и .docx восстанавливаются в файл «имя.restored.*»; ?docId= предвыбирает сессию.
const TOKEN_RE = /\[[\p{L}][\p{L}_ -]*?[ _-]\d+\]/gu;

async function openRestore(context, extensionId, query = '') {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/restore/restore.html${query}`);
  await page.evaluate(() => chrome.storage.local.set({ settings: { uiLanguage: 'ru' } })); // язык браузера в headless — en
  await page.reload();
  await expect(page.getByTestId('restore-run')).toBeVisible();
  return page;
}

/** Файл → ANALYZE → APPLY через порт расширения; сессия остаётся в offscreen. */
async function pipeline(context, extensionId, name, bytes) {
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await installClient(ext);
  const r = await runPipeline(ext, { name, bytes });
  await ext.close();
  return r;
}

test('файл от ИИ .md + карта из файла → answer.restored.md со склонением', async ({ context, extensionId }) => {
  const mappingPath = writeTemp('e2e-file.mapping.json', JSON.stringify(fx.mapping));
  const answer = writeTemp('answer.md', '# Итог\n\nДоговор с ООО «[КОМПАНИЯ_1]» подписан. Письмо [ФИО_1]у отправлено, копия — [EMAIL_1].\n');
  const page = await openRestore(context, extensionId);
  await expect(page.getByTestId('restore-download')).toBeDisabled();
  await page.getByTestId('restore-mode-file').check({ force: true });
  await page.getByTestId('ai-file').setInputFiles(answer);
  await expect(page.getByTestId('ai-file-info')).toContainText('Загружен файл answer.md');
  await page.getByTestId('mapping-file').setInputFiles(mappingPath);
  await expect(page.getByTestId('file-info')).toContainText('Загружено записей');
  await page.getByTestId('restore-run').click();
  await expect(page.getByTestId('restore-output')).toContainText('Договор с ООО «Ромашка-Трейд» подписан. Письмо Иванову Петру Сергеевичу отправлено');
  await expect(page.getByTestId('declined-mark')).toHaveCount(1);
  await expect(page.getByTestId('restore-download')).toBeEnabled();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('restore-download').click()]);
  expect(dl.suggestedFilename()).toBe('answer.restored.md');
  const text = readFileSync(await dl.path(), 'utf8');
  expect(text).toContain('Ромашка-Трейд');
  expect(text).toContain('Иванову Петру Сергеевичу');
  expect(text.startsWith('# Итог')).toBe(true);
  // новый файл от ИИ — прежний результат больше не скачивается, пока не нажать «Восстановить»
  await page.getByTestId('ai-file').setInputFiles(writeTemp('answer2.txt', 'Подписал [ФИО_2].'));
  await expect(page.getByTestId('restore-download')).toBeDisabled();
  await page.getByTestId('restore-run').click();
  await expect(page.getByTestId('restore-download')).toBeEnabled();
  // смена режима склонения или источника карты тоже сбрасывает результат
  await page.getByTestId('restore-decline').uncheck();
  await expect(page.getByTestId('restore-download')).toBeDisabled();
});

test('.anon.docx из конвейера + сессия по ?docId= → договор.restored.docx без плейсхолдеров', async ({ context, extensionId }) => {
  const { bytes, gold } = buildSampleDocx();
  const net = await captureAllRequests(context); // К17: восстановление файла — без сетевых запросов
  const run = await pipeline(context, extensionId, 'договор.docx', bytes);
  expect(run.resultName).toBe('договор.anon.docx');
  const anonBytes = Buffer.from(run.b64, 'base64');
  const anonPath = writeTemp('договор.anon.docx', anonBytes);
  const n = parseDocx(anonBytes).streams.reduce((k, s) => k + (s.text.match(TOKEN_RE)?.length || 0), 0);
  expect(n).toBeGreaterThan(10);
  expect(restoreDocx(anonBytes, run.mapping).replaced).toBe(n); // то же ядро, что и на странице

  const page = await openRestore(context, extensionId, `?docId=${encodeURIComponent(run.ent.docId)}`);
  await expect(page.getByTestId('source-session')).toBeChecked();
  await expect(page.locator(`[data-testid="session-radio"][value="${run.ent.docId}"]`)).toBeChecked();
  await page.getByTestId('restore-mode-file').check({ force: true });
  await page.getByTestId('ai-file').setInputFiles(anonPath);
  await expect(page.getByTestId('ai-file-info')).toContainText('договор.anon.docx');
  await page.getByTestId('restore-run').click();
  await expect(page.getByTestId('restore-docx-summary')).toBeVisible();
  await expect(page.getByTestId('restore-stat')).toHaveText(new RegExp(`^Заменено: ${n}(\\s|$)`));
  await expect(page.getByTestId('restore-unresolved')).toContainText('Все метки восстановлены');
  await expect(page.getByTestId('restore-copy')).toBeDisabled();
  // паспорт: под [ПАСПОРТ_1] в исходнике были ещё орган выдачи и код подразделения — предупреждение (FR-36а)
  await expect(page.getByTestId('restore-warning')).toHaveCount(1);
  await expect(page.getByTestId('restore-warning')).toContainText('[ПАСПОРТ_1]');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('restore-download').click()]);
  expect(dl.suggestedFilename()).toBe('договор.restored.docx');
  const restored = parseDocx(readFileSync(await dl.path()));
  const text = restored.streams.map((s) => s.text).join('\n');
  for (const v of [gold.person1, gold.company1, gold.inn1, gold.inn2, gold.email1, gold.email2, gold.email3, gold.phone1, gold.url1])
    expect(text, v).toContain(v);
  expect(text).not.toContain('[EMAIL_');
  expect(text).not.toMatch(new RegExp(TOKEN_RE.source, 'u'));
  await page.screenshot({ path: join(resolve('test-output'), 'restore-docx.png'), fullPage: true });
  expect(externalRequests(await net.stop()), 'NFR-01: сетевые запросы').toEqual([]);
});

test('?docId= неизвестной сессии → выбрана самая свежая, без ошибки', async ({ context, extensionId }) => {
  await pipeline(context, extensionId, 'первый.docx', makeDocx(para(wrun('Пишите на first.person@example.com'))));
  const second = await pipeline(context, extensionId, 'второй.docx', makeDocx(para(wrun('Пишите на second.person@example.org'))));
  const page = await openRestore(context, extensionId, '?docId=unknown');
  await expect(page.getByTestId('source-session')).toBeChecked();
  await expect(page.getByTestId('session-radio')).toHaveCount(2);
  await expect(page.locator(`[data-testid="session-radio"][value="${second.ent.docId}"]`)).toBeChecked();
  await expect(page.getByTestId('restore-error')).toHaveText('');
  // текст по карте сессии (GET_MAPPING): адрес второго файла восстанавливается
  await page.getByTestId('restore-input').fill('Ответ: [EMAIL_1].');
  await page.getByTestId('restore-run').click();
  await expect(page.getByTestId('restore-output')).toHaveText('Ответ: second.person@example.org.');
});

test('сессия без карты и исчезнувшая сессия — разные сообщения (ERROR.reason)', async ({ context, extensionId }) => {
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await installClient(ext);
  // только ANALYZE, без APPLY: сессия есть, карты нет
  const docId = await ext.evaluate(
    async (b64) => {
      const client = window.__docx.connectClient();
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const ent = await client.analyzeFile({ name: 'черновик.docx', bytes, origin: 'http://test.invalid' });
      client.port.disconnect();
      return ent.docId;
    },
    Buffer.from(makeDocx(para(wrun('Пишите на draft.person@example.com')))).toString('base64'),
  );
  const page = await openRestore(context, extensionId, `?docId=${encodeURIComponent(docId)}`);
  await page.getByTestId('restore-input').fill('Ответ: [EMAIL_1].');
  await page.getByTestId('restore-run').click();
  await expect(page.getByTestId('restore-error')).toContainText('ещё нет карты замен');
  // сессию убрали (DISCARD) — «обработка больше недоступна»
  await ext.evaluate(async (id) => {
    const client = window.__docx.connectClient();
    await client.request(window.__docx.MSG.DISCARD, { docId: id });
    client.port.disconnect();
  }, docId);
  await ext.close();
  await page.getByTestId('restore-run').click();
  await expect(page.getByTestId('restore-error')).toContainText('больше недоступна');
});
