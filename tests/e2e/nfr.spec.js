// NFR-01: расширение не делает сетевых запросов наружу — ни со страниц расширения, ни из content script на тестовом сайте,
// ни из service worker, offscreen-документа и его воркера (К6: запись через CDP браузера, helpers/network.js).
import { test, expect } from './fixtures.js';
import { buildSampleDocx } from '../../scripts/make-sample.mjs';
import { installClient, runPipeline } from './helpers/client.js';
import { openChat, writeTemp, enableIntercept } from './helpers/chat.js';
import { captureAllRequests, externalRequests, offscreenRequests } from './helpers/network.js';

test('NFR-01: за весь сценарий нет запросов, кроме локального тестового сайта', async ({ context, extensionId, site }) => {
  const { bytes } = buildSampleDocx();
  const net = await captureAllRequests(context);

  await enableIntercept(context, extensionId, site);
  const chat = await openChat(context, site);
  // файл выбирается, но панель не трогаем: достаточно, что content script и background живы
  await chat.setInputFiles('#multi-input', writeTemp('nfr.docx', bytes)).catch(() => {});

  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await installClient(ext);
  await runPipeline(ext, { name: 'nfr.docx', bytes });
  await chat.waitForTimeout(500);

  const urls = await net.stop();
  // chrome:// — ресурсы самого Chromium (тема, шрифты), не расширения
  const foreign = urls.filter((u) => !u.startsWith(site.origin) && !/^(chrome-extension|chrome|data|blob|about):/.test(u));
  expect(foreign, 'запросы наружу').toEqual([]);
  expect(externalRequests(urls, [site.origin]), 'http(s) вне тестового сайта').toEqual([]);
  // запись не пустая: видны тестовый сайт и offscreen-документ с воркером
  expect(urls.some((u) => u.startsWith(site.origin))).toBe(true);
  expect(offscreenRequests(urls)).toEqual(
    expect.arrayContaining([expect.stringMatching(/\/offscreen\/offscreen\.html$/), expect.stringMatching(/\/offscreen\/worker\.js$/)]),
  );
});
