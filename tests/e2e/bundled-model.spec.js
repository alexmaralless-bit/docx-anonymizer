// WP10-C (К15, К17): полная сборка — модель NER из архива расширения ставится сама при установке, без сети и без импорта.
// Гейт — dist-e2e/models/index.json (полная e2e-сборка):
//   flock <lock> sh -c 'node scripts/build.mjs --e2e --with-model=release/docx-anonymizer-ner-rubert-tiny2-ner-ruen-1.1.0.zip && npx playwright test bundled-model.spec.js'
// Сценарий: чистый профиль → ≤ 30 с nerModel и bundledModelSha выставлены → файлы в OPFS → карточка «проверенный пакет» →
// анализ даёт source:'ner' → повторный bootstrap файлы не переписывает → удаление не возвращает модель само → «Восстановить»
// → «Сбросить настройки» модель не трогает. Второй сценарий — копия сборки с испорченным zip: «не удалось ({код})», «Повторить».
// Третий (версия 0.4, WP11-C3, К9) — обновление поверх 1.0.0, гейт NER_PACK_PREV (путь к zip прежнего пакета того же id):
//   flock <lock> sh -c 'node scripts/build.mjs --e2e --with-model=release/docx-anonymizer-ner-rubert-tiny2-ner-ruen-1.1.0.zip &&
//     NER_PACK_PREV=release/docx-anonymizer-ner-rubert-tiny2-ner-ruen-1.0.0.zip npx playwright test bundled-model.spec.js'
import { createHash } from 'node:crypto';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

test.describe('автоустановка', () => {
  // запись сети подключается до загрузки расширения — снимок после автоустановки обязан содержать чтение zip (К17)
  test.use({ earlyCapture: true });

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
    // К17: снимок записи сразу после автоустановки — чтение zip видно именно в ней, а не только в «Восстановить» ниже;
    // запись подключена до загрузки расширения (earlyCapture), окна без записи нет (docs/contracts.md §6.8)
    const urlsAtInstall = [...net.urls];
    expect(urlsAtInstall).toContain(`chrome-extension://${extensionId}/models/${BUNDLED.file}`);
    // запись видела и самые ранние запросы: загрузку offscreen-документа и скрипта воркера
    for (const f of ['offscreen.html', 'offscreen.js', 'worker.js']) expect(urlsAtInstall).toContain(`chrome-extension://${extensionId}/offscreen/${f}`);
    expect(externalRequests(urlsAtInstall), 'NFR-01: http(s)-запросы при автоустановке').toEqual([]);
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

    // «Сбросить настройки»: модель и состояние автоустановки — состояние браузера, не настройка (не сбрасываются)
    await page.getByTestId('config-reset').click();
    await page.getByTestId('dlg-ok').click();
    await expect(page.getByTestId('ner-status')).toHaveAttribute('data-state', 'installed');
    const afterReset = await stored(page);
    expect(afterReset).toMatchObject({ nerModel: BUNDLED.id, bundledModelSha: BUNDLED.sha256, bundledModelError: '' });

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
});

test.describe('испорченный zip встроенной модели', () => {
  // Копия полной сборки с одним инвертированным байтом в середине zip: sha пакета и файлов не сходятся → MODEL_INSTALLED failed
  const BROKEN = join(tmpdir(), `docx-anon-e2e-broken-model-${process.pid}`);
  test.use({ extensionDir: BROKEN });
  test.beforeAll(() => {
    if (!BUNDLED) return;
    rmSync(BROKEN, { recursive: true, force: true });
    cpSync(DIST, BROKEN, { recursive: true });
    const zip = join(BROKEN, 'models', BUNDLED.file);
    const bytes = readFileSync(zip);
    bytes[bytes.length >> 1] ^= 0xff;
    writeFileSync(zip, bytes);
  });
  test.afterAll(() => rmSync(BROKEN, { recursive: true, force: true }));

  test('карточка: «не удалось ({код})», импорт включён, «Повторить»; popup — ссылка; сброс настроек ошибку не стирает', async ({ context, extensionId }) => {
    test.setTimeout(120000);
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options/options.html`);
    await expect.poll(async () => (await stored(page)).bundledModelError, { timeout: 30000, intervals: [100, 250, 500] }).toMatch(/^[A-Z_]+$/);
    const s = await stored(page);
    expect(s).toMatchObject({ nerModel: '', bundledModelSha: '' });
    const code = s.bundledModelError;
    await page.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, uiLanguage: 'ru' } });
    });
    await page.reload();
    const status = page.getByTestId('ner-status');
    await expect(status).toHaveAttribute('data-state', 'failed');
    await expect(status).toContainText(`Не удалось установить встроенную модель (${code})`);
    await expect(page.getByTestId('ner-import')).toBeEnabled();
    await expect(page.getByTestId('ner-retry')).toBeVisible();
    await expect(page.getByTestId('ner-restore')).toBeHidden();

    // popup: не «устанавливается…», а ссылка на карточку
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    const hint = popup.getByTestId('ner-hint');
    await expect(hint).toBeVisible();
    await expect(hint).toHaveAttribute('data-state', 'failed');
    await expect(hint.locator('a#open-ner')).toBeVisible();
    await popup.close();

    // «Повторить»: ошибка стирается, попытка идёт заново и снова кончается тем же кодом (zip всё ещё испорчен)
    const seen = [];
    await page.exposeFunction('__seenError', (v) => seen.push(v));
    await page.evaluate(() => chrome.storage.onChanged.addListener((ch) => ch.settings && window.__seenError(ch.settings.newValue?.bundledModelError ?? null)));
    await page.getByTestId('ner-retry').click();
    await expect.poll(() => seen.includes(''), { timeout: 10000 }).toBe(true);
    await expect(status).toHaveAttribute('data-state', 'failed', { timeout: 30000 });
    await expect.poll(async () => (await stored(page)).bundledModelError, { timeout: 30000 }).toBe(code);
    await expect(page.getByTestId('ner-retry')).toBeEnabled();

    // «Сбросить настройки» не стирает состояние автоустановки: карточка не возвращается к вечному «устанавливается…»
    await page.getByTestId('config-reset').click();
    await page.getByTestId('dlg-ok').click();
    await expect(status).toHaveAttribute('data-state', 'failed');
    expect((await stored(page)).bundledModelError).toBe(code);
  });
});

// Обновление встроенной модели (версия 0.4, WP11-C3, К9): профиль, где стоит прежний пакет того же id (1.0.0 — импорт через
// настройки или полный архив 0.3) и bundledModelSha = его sha, после обновления расширения до полной сборки с 1.1.0 получает
// 1.1.0 сам: новый sha → план install → MODEL_INSTALL → в OPFS один слот с 1.1.0, bundledModelSha = sha 1.1.0, сети нет.
// Обновление — повторная команда CDP Extensions.loadUnpacked того же каталога (как кнопка «Обновить» на chrome://extensions:
// onInstalled с reason 'update'); поэтому сценарий идёт с earlyCapture — расширение загружено той же командой.
// chrome.runtime.reload() под Playwright не подходит: расширение после него остаётся выгруженным (ERR_BLOCKED_BY_CLIENT).
const PREV = process.env.NER_PACK_PREV ? resolve(process.env.NER_PACK_PREV) : '';

/** Все слоты пакетов в OPFS models/: [{name, version, packSha256, installing}] (installed.json и маркер .installing). */
const opfsSlots = (page) =>
  page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    let models;
    try {
      models = await root.getDirectoryHandle('models');
    } catch {
      return [];
    }
    const out = [];
    for await (const [name, dir] of models.entries()) {
      if (dir.kind !== 'directory') continue;
      const names = [];
      for await (const [n] of dir.entries()) names.push(n);
      let info = {};
      if (names.includes('installed.json')) info = JSON.parse(await (await (await dir.getFileHandle('installed.json')).getFile()).text());
      out.push({ name, version: info.version ?? null, packSha256: info.packSha256 ?? null, installing: names.includes('.installing') });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  });

test.describe('обновление поверх прежней версии', () => {
  test.skip(!PREV, 'нужен NER_PACK_PREV — путь к zip прежней версии встроенного пакета (1.0.0)');
  test.use({ earlyCapture: true });

  test('прежний пакет из настроек и его sha в профиле → после обновления 1.1.0 ставится сам, один слот, без сети', async ({
    context,
    extensionId,
    extensionDir,
  }) => {
    test.setTimeout(180000);
    const prevZip = readFileSync(PREV);
    const prevSha = createHash('sha256').update(prevZip).digest('hex');
    const prevManifest = JSON.parse(new TextDecoder().decode(unzipSync(new Uint8Array(prevZip))['pack.json']));
    expect(prevManifest.id, 'NER_PACK_PREV — тот же id, что у встроенного пакета').toBe(BUNDLED.id);
    expect(prevSha).not.toBe(BUNDLED.sha256);
    const net = await captureAllRequests(context);

    // 1. Свежий профиль: встроенный пакет ставится сам (первый сценарий); ждём итога, чтобы импорт не гонялся с автоустановкой
    let page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options/options.html`);
    await expect.poll(async () => (await stored(page)).bundledModelSha, { timeout: 30000, intervals: [100, 250, 500] }).toBe(BUNDLED.sha256);

    // 2. Импорт прежней версии через настройки (как tests/e2e/model-pack.spec.js): пакет из KNOWN_PACKS — без подтверждения
    await page.getByTestId('ner-import-file').setInputFiles(PREV);
    await expect
      .poll(async () => (await opfsSlots(page)).map((x) => [x.version, x.packSha256, x.installing]), { timeout: 60000, intervals: [250, 500] })
      .toEqual([[prevManifest.version, prevSha, false]]);
    await expect(page.getByTestId('ner-status')).toContainText(prevManifest.version);
    // профиль «как после 0.3»: обработан прежний встроенный пакет, выбран тот же id
    await page.evaluate(async (sha) => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, bundledModelSha: sha, bundledModelError: '' } });
    }, prevSha);
    expect(await stored(page)).toMatchObject({ nerModel: BUNDLED.id, bundledModelSha: prevSha });
    const urlsBefore = net.urls.length;

    // 3. Обновление расширения: повторная загрузка каталога → onInstalled {reason: 'update'} → план install (новый sha)
    const t0 = Date.now();
    const cdp = await context.browser().newBrowserCDPSession();
    await cdp.send('Extensions.loadUnpacked', { path: resolve(extensionDir) });
    await cdp.detach();
    page = await context.newPage();
    await expect(async () => {
      await page.goto(`chrome-extension://${extensionId}/options/options.html`);
    }).toPass({ timeout: 15000, intervals: [250, 500, 1000] });
    await expect.poll(async () => (await stored(page)).bundledModelSha, { timeout: 30000, intervals: [100, 250, 500] }).toBe(BUNDLED.sha256);
    const updateMs = Date.now() - t0;

    // 4. Итог: установлен 1.1.0 (встроенный), в OPFS один слот без маркера, настройки на новом sha, ошибки нет
    expect(await stored(page)).toMatchObject({ nerModel: BUNDLED.id, bundledModelSha: BUNDLED.sha256, bundledModelError: '' });
    const after = await opfsSlots(page);
    expect(after.map((x) => [x.version, x.packSha256, x.installing])).toEqual([[BUNDLED.version, BUNDLED.sha256, false]]);
    await expect(page.getByTestId('ner-status')).toContainText(BUNDLED.version);
    await expect(page.getByTestId('ner-status')).toHaveAttribute('data-state', 'installed');
    console.log(`[bundled-model-e2e] обновление ${prevManifest.version} → ${BUNDLED.version}: ${updateMs} мс до bundledModelSha; слот ${after[0].name}`);

    // сеть: ни одного http(s); после обновления воркер читал zip нового пакета из архива расширения
    const urls = await net.stop();
    expect(externalRequests(urls), 'NFR-01: http(s)-запросы').toEqual([]);
    expect(urls.slice(urlsBefore)).toContain(`chrome-extension://${extensionId}/models/${BUNDLED.file}`);
  });
});
