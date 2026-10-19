// WP10-C (К15, К17): полная сборка — модель NER из архива расширения ставится сама при установке, без сети и без импорта.
// Гейт — dist-e2e/models/index.json (полная e2e-сборка):
//   flock <lock> sh -c 'node scripts/build.mjs --e2e --with-model=release/docx-anonymizer-ner-rubert-tiny2-ner-ruen-1.0.0.zip && npx playwright test bundled-model.spec.js'
// Сценарий: чистый профиль → ≤ 30 с nerModel и bundledModelSha выставлены → файлы в OPFS → карточка «проверенный пакет» →
// анализ даёт source:'ner' → повторный bootstrap файлы не переписывает → удаление не возвращает модель само → «Восстановить».
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { test, expect, BUNDLED, DIST } from './fixtures.js';
import { buildSampleDocx, esc } from '../../scripts/make-sample.mjs';
import { installClient, runPipeline } from './helpers/client.js';
import { captureAllRequests, externalRequests, offscreenRequests } from './helpers/network.js';

test.skip(!BUNDLED, 'нужна полная e2e-сборка: node scripts/build.mjs --e2e --with-model=<zip>');

/** Образец + абзац с третьим лицом без метки (как tests/e2e/ner.spec.js). */
function sampleWithThirdPerson(extra) {
  const files = unzipSync(buildSampleDocx().bytes);
  const xml = new TextDecoder().decode(files['word/document.xml']);
  const p = `<w:p><w:r><w:t xml:space="preserve">${esc(extra)}</w:t></w:r></w:p>`;
  const i = xml.lastIndexOf('<w:sectPr');
  files['word/document.xml'] = strToU8(xml.slice(0, i) + p + xml.slice(i));
  return zipSync(files);
}

const stored = (page) => page.evaluate(async () => (await chrome.storage.local.get('settings')).settings || {});
/** Файлы активного слота models/<id>/ в OPFS: {имя: размер}; installedAt из installed.json. */
const opfsSlot = (page, id) =>
  page.evaluate(async (id) => {
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle('models')).getDirectoryHandle(id);
    const files = {};
    for await (const [name, h] of dir.entries()) files[name] = (await h.getFile()).size;
    const installed = JSON.parse(await (await (await dir.getFileHandle('installed.json')).getFile()).text());
    return { files, installedAt: installed.installedAt, verified: installed.verified, packSha256: installed.packSha256 };
  }, id);

test('полная сборка: модель ставится сама, без сети; повторный запуск не переписывает; удаление и «Восстановить»', async ({ context, extensionId }) => {
  test.setTimeout(180000);
  const t0 = Date.now();
  // Время установки из ответа хоста MODEL_INSTALLED.ms — background пишет его в лог (только число, без значений документа)
  const installLogs = [];
  const listen = (w) =>
    w.on('console', (m) => {
      const r = /\[bundled-model\] installed in (\d+) ms/.exec(m.text());
      if (r) installLogs.push(Number(r[1]));
    });
  context.serviceWorkers().forEach(listen);
  context.on('serviceworker', listen); // service worker мог перезапуститься
  const net = await captureAllRequests(context);
  const manifest = JSON.parse(new TextDecoder().decode(unzipSync(new Uint8Array(readFileSync(join(DIST, 'models', BUNDLED.file))))['pack.json']));

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  // ≤ 30 с после загрузки расширения (К15): без импорта и скачивания
  await expect.poll(async () => (await stored(page)).nerModel, { timeout: 30000, intervals: [100, 250, 500] }).toBe(BUNDLED.id);
  const installedAfterMs = Date.now() - t0;
  const s1 = await stored(page);
  expect(s1.bundledModelSha).toBe(BUNDLED.sha256);

  // файлы пакета в OPFS: все из pack.json нужных размеров, установка завершена
  const slot = await opfsSlot(page, BUNDLED.id);
  for (const f of manifest.files) expect(slot.files[f.path], f.path).toBe(f.size);
  expect(Object.keys(slot.files)).toContain('pack.json'); // toHaveProperty понял бы точку как путь
  expect(Object.keys(slot.files)).not.toContain('.installing');
  expect(slot.verified).toBe(true);
  expect(slot.packSha256).toBe(BUNDLED.sha256);

  // карточка: «проверенный пакет», онбординга нет
  await page.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, uiLanguage: 'ru' } });
  });
  await page.reload();
  const status = page.getByTestId('ner-status');
  await expect(status).toContainText('проверенный пакет');
  await expect(status).toHaveAttribute('data-state', 'installed');
  await expect(page.getByTestId('ner-remove')).toBeVisible();
  await expect(page.getByTestId('ner-onboarding')).toBeHidden();
  await expect(page.getByTestId('ner-restore')).toBeHidden();

  // popup: строки «модель не установлена» нет
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await expect(popup.getByTestId('site-status')).not.toBeEmpty(); // init() popup отработал
  await expect(popup.getByTestId('ner-hint')).toBeHidden();

  // анализ: модель встроенного пакета работает в воркере
  await installClient(popup);
  const r = await runPipeline(popup, { name: 'bundled-ner.docx', bytes: sampleWithThirdPerson('Груз сопровождает экспедитор Кравчук, его сменит Лаптев.') });
  expect(r.ent.warnings.map((w) => w.code)).not.toContain('NER_FAILED');
  expect(r.ent.entities.filter((e) => e.source === 'ner').length).toBeGreaterThanOrEqual(1);

  // идемпотентность: тот же sha уже стоит → MODEL_BOOTSTRAP (force) отвечает ACK, хост — present, файлы не переписаны
  const ack = await popup.evaluate(async () => {
    const c = window.__docx.connectClient();
    try {
      return (await c.request(window.__docx.MSG.MODEL_BOOTSTRAP)).type;
    } finally {
      c.port.disconnect();
    }
  });
  expect(ack).toBe('ACK');
  await page.waitForTimeout(2000);
  expect((await opfsSlot(page, BUNDLED.id)).installedAt).toBe(slot.installedAt);
  expect((await stored(page)).nerModel).toBe(BUNDLED.id);

  // удаление пользователем: модель не возвращается сама, sha остаётся «обработан», кнопка «Восстановить»
  await page.getByTestId('ner-remove').click();
  await page.getByTestId('dlg-ok').click();
  await expect.poll(async () => (await stored(page)).nerModel).toBe('');
  expect((await stored(page)).bundledModelSha).toBe(BUNDLED.sha256);
  const restore = page.getByTestId('ner-restore');
  await expect(restore).toBeVisible();
  await expect(status).toContainText('не установлена');
  await page.waitForTimeout(1000);
  expect((await stored(page)).nerModel).toBe('');

  const tRestore = Date.now();
  await restore.click();
  await expect.poll(async () => (await stored(page)).nerModel, { timeout: 30000, intervals: [100, 250, 500] }).toBe(BUNDLED.id);
  const restoreMs = Date.now() - tRestore;
  await expect(status).toContainText('проверенный пакет', { timeout: 10000 });
  await expect(restore).toBeHidden();
  const again = await opfsSlot(page, BUNDLED.id);
  for (const f of manifest.files) expect(again.files[f.path], f.path).toBe(f.size);
  expect(again.installedAt).toBeGreaterThan(slot.installedAt);

  console.log(
    `[bundled-model-e2e] автоустановка: nerModel через ≤ ${installedAfterMs} мс после старта теста; восстановление ${restoreMs} мс; ` +
      `MODEL_INSTALLED.ms: ${installLogs.length ? installLogs.join(', ') : 'лог service worker недоступен'}; пакет ${BUNDLED.size} байт`,
  );

  // сеть (К17): ни одного http(s)-запроса; запись видит чтение zip модели из пакета расширения
  const urls = await net.stop();
  expect(externalRequests(urls), 'NFR-01: http(s)-запросы').toEqual([]);
  expect(urls).toContain(`chrome-extension://${extensionId}/models/${BUNDLED.file}`);
  expect(offscreenRequests(urls)).toEqual(expect.arrayContaining([expect.stringMatching(/\/models\/[^/]+\.zip$/)]));
});
