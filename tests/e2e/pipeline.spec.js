// Конвейер расширения без UI: страница расширения → порт → background → offscreen → Web Worker (ядро) → обратно.
// Заменяет прежний e2e через dev-блок popup (#dev-file): тот блок убирает WP3, тест от него не зависит.
import { test, expect } from './fixtures.js';
import { buildSampleDocx } from '../../scripts/make-sample.mjs';
import { installClient, runPipeline } from './helpers/client.js';
import { parseDocx } from '../../src/core/index.js';
import { captureAllRequests, externalRequests, offscreenRequests } from './helpers/network.js';

test('файл проходит ANALYZE → APPLY, результат — .anon.docx без адресов, сети нет', async ({ context, extensionId }) => {
  const { bytes, gold } = buildSampleDocx();

  // все цели браузера: страница, service worker, offscreen-документ и его воркер (К6)
  const net = await captureAllRequests(context);

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await installClient(page);
  const run = await runPipeline(page, { name: 'договор.docx', bytes });

  expect(run.resultName).toBe('договор.anon.docx');
  expect(run.ent.stats.virtualTextLength).toBeGreaterThan(2000);
  expect(run.stages).toEqual(expect.arrayContaining(['receiving', 'unzip', 'parse', 'detect']));
  const emails = run.ent.entities.filter((e) => e.category === 'EMAIL').map((e) => e.value);
  for (const v of [gold.email1, gold.email2, gold.email3, gold.emailOld]) expect(emails).toContain(v);

  // результат — валидный docx без найденных значений
  const out = parseDocx(Buffer.from(run.b64, 'base64'));
  const text = out.streams.map((s) => s.text).join('\n');
  for (const v of emails) expect(text, v).not.toContain(v);
  expect(text).toMatch(/\[EMAIL_\d+\]/);
  // маппинг: плейсхолдеры → значения, но только в ответе, не в storage (FR-29)
  expect(run.mapping.entries.some((e) => e.category === 'EMAIL' && e.original === gold.email1)).toBe(true);
  const stored = await page.evaluate(() => chrome.storage.local.get(null));
  expect(JSON.stringify(stored)).not.toContain(gold.email1);

  const urls = await net.stop();
  expect(externalRequests(urls), 'NFR-01: сетевые запросы из расширения').toEqual([]);
  expect(
    urls.filter((u) => !/^(chrome-extension|chrome|data|blob|about):/.test(u)),
    'NFR-01: прочие схемы',
  ).toEqual([]);
  expect(offscreenRequests(urls)).toEqual(expect.arrayContaining([expect.stringMatching(/\/offscreen\/worker\.js$/)]));
});

test('не-docx отклоняется с кодом NOT_DOCX', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await installClient(page);
  const code = await page.evaluate(async () => {
    const client = window.__docx.connectClient();
    try {
      await client.analyzeFile({ name: 'x.docx', bytes: new TextEncoder().encode('это не zip') });
      return 'ok';
    } catch (e) {
      return e.code;
    } finally {
      client.port.disconnect();
    }
  });
  expect(code).toBe('NOT_DOCX');
});
