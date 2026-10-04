// NFR-01: расширение не делает сетевых запросов наружу — ни со страниц расширения, ни из content script на тестовом сайте.
import { test, expect } from './fixtures.js';
import { buildSampleDocx } from '../../scripts/make-sample.mjs';
import { installClient, runPipeline } from './helpers/client.js';
import { openChat, writeTemp, enableIntercept } from './helpers/chat.js';

test('NFR-01: за весь сценарий нет запросов, кроме локального тестового сайта', async ({ context, extensionId, site }) => {
  const { bytes } = buildSampleDocx();
  const urls = [];
  context.on('request', (req) => urls.push(req.url()));

  await enableIntercept(context, extensionId, site);
  const chat = await openChat(context, site);
  // файл выбирается, но панель не трогаем: достаточно, что content script и background живы
  await chat.setInputFiles('#multi-input', writeTemp('nfr.docx', bytes)).catch(() => {});

  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await installClient(ext);
  await runPipeline(ext, { name: 'nfr.docx', bytes });
  await chat.waitForTimeout(500);

  const foreign = urls.filter((u) => !u.startsWith(site.origin) && !/^(chrome-extension|data|blob|about):/.test(u));
  expect(foreign, 'запросы наружу').toEqual([]);
  // ни одного запроса, чьим источником были страницы расширения, на http(s)
  expect(urls.filter((u) => /^https?:/.test(u) && !u.startsWith(site.origin))).toEqual([]);
});
