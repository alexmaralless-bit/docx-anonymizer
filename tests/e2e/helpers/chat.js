// Хелперы e2e: тестовая страница чата, имитация drop/paste, настройки расширения, разбор принятых файлов.
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Записывает файл в test-output/e2e-files/ и возвращает путь (для setInputFiles). */
export function writeTemp(name, bytes) {
  const dir = resolve('test-output', 'e2e-files');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const mimeOf = (name) => (name.endsWith('.docx') ? DOCX_MIME : name.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');

/** Открывает тестовую страницу чата и ждёт её готовности. */
export async function openChat(context, site, path = 'chat.html') {
  const page = await context.newPage();
  await page.goto(site.url(path));
  await page.waitForFunction(() => Boolean(window.__chat));
  return page;
}

/** Что страница реально получила: [{name,size,type,sha256,source}] в порядке получения. */
export const received = (page) => page.evaluate(() => window.__chat.received.map((r) => ({ ...r })));

/** Ждёт, пока страница получит n файлов. */
export const waitReceived = async (page, n, timeout = 30000) => {
  await page.waitForFunction((k) => window.__chat.received.length >= k, n, { timeout });
  return received(page);
};

/** Содержимое принятого страницей файла (Buffer). */
export async function receivedBytes(page, index) {
  return Buffer.from(await page.evaluate((i) => window.__chat.fileBase64(i), index), 'base64');
}

/** Файлы для DataTransfer: [{name, bytes: Buffer}] → сериализуемый вид. */
const toPayload = (files) => files.map((f) => ({ name: f.name, type: f.type || mimeOf(f.name), b64: Buffer.from(f.bytes).toString('base64') }));

/**
 * Имитация перетаскивания файлов на элемент (dragenter → dragover → drop с DataTransfer).
 * События синтетические (isTrusted=false): Playwright не умеет настоящий drop файлов в Chromium.
 */
export async function dropFiles(page, selector, files) {
  await page.evaluate(
    ({ selector, payload }) => {
      const dt = new DataTransfer();
      for (const f of payload) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
      const el = document.querySelector(selector);
      for (const type of ['dragenter', 'dragover', 'drop'])
        el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, composed: true }));
    },
    { selector, payload: toPayload(files) },
  );
}

/** Имитация вставки файла из буфера (paste с clipboardData.files). */
export async function pasteFiles(page, selector, files) {
  await page.evaluate(
    ({ selector, payload }) => {
      const dt = new DataTransfer();
      for (const f of payload) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
      const el = document.querySelector(selector);
      el.focus();
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true }));
    },
    { selector, payload: toPayload(files) },
  );
}

/**
 * Настройки расширения через страницу расширения (chrome.storage.local).
 * patch сливается с уже сохранёнными настройками; недостающие поля достроит migrateSettings.
 * `__e2eOpenShadow: true` в chrome.storage.local — КОНТРАКТ с WP3: панель создаётся с `mode: 'open'`, чтобы Playwright видел её содержимое
 * (в боевом режиме — closed). Ключ может записать только страница расширения, веб-страница — нет.
 */
export async function setExtensionSettings(context, extensionId, patch, { openShadow = true } = {}) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await page.evaluate(
    async ({ patch, openShadow }) => {
      const { settings = {} } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { uiLanguage: 'ru', ...settings, ...patch }, __e2eOpenShadow: openShadow });
    },
    { patch, openShadow },
  );
  await page.close();
}

/** Включить перехват на origin тестового сайта (siteMode: allowlist с одним origin). */
export const enableIntercept = (context, extensionId, site) =>
  setExtensionSettings(context, extensionId, { interceptEnabled: true, siteMode: 'allowlist', allowlist: [site.origin], blocklist: [] });

/**
 * КОНТРАКТ DOM панели (согласован с WP3, взят из его реализации; тесты, зависящие от него, помечены wp3Test).
 *   хост:      <docx-anonymizer-root>  (в e2e — open shadow root при __e2eOpenShadow, в боевом режиме closed)
 *   внутри:    [data-testid="panel"]              корень панели
 *              [data-testid="btn-anonymize"]      «Анонимизировать и загрузить»
 *              [data-testid="btn-original"]       «Загрузить оригинал» (открывает подтверждение)
 *              [data-testid="btn-original-confirm"]  подтверждение отправки оригинала
 *              [data-testid="btn-cancel"]         «Отмена»
 *              [data-testid="pv-summary"]         «Найдено N, включено M»
 *              [data-testid="pv-rows"] .pv-row    строки сущностей
 *              [data-testid="file-tab"]           вкладка файла (несколько файлов)
 *              [data-testid="done-title"]         экран «готово» после подстановки
 *              [data-testid="btn-done-close"]     «Закрыть» на экране «готово» (может показать подсказку о ключе, WP10-D)
 *              [data-testid="btn-download-result"]  «Скачать результат» (основная кнопка экрана «готово»)
 *              [data-testid="btn-more"]           «Ещё ▾» — открывает меню (есть, если карта замен доступна)
 *              [data-testid="more-menu"]          меню «Ещё»
 *              [data-testid="btn-download-mapping"]  пункт меню «Сохранить ключ восстановления» (.mapping.json)
 *              [data-testid="mapping-hint"]       одноразовая подсказка о ключе восстановления (флаг hintMappingShown)
 *              [data-testid="btn-hint-ok"]        «Понятно» — закрыть панель без сохранения
 *              [data-testid="btn-hint-save"]      «Сохранить» — скачать ключ и закрыть панель
 *              [data-testid="error-message"]      ошибка
 */
export const PANEL_HOST = 'docx-anonymizer-root';
/**
 * Локаторы панели внутри scope (Page или FrameLocator).
 * @param {import('@playwright/test').Page | import('@playwright/test').FrameLocator} scope
 */
export const panel = (scope) => {
  const host = scope.locator(PANEL_HOST);
  const t = (id) => host.locator(`[data-testid="${id}"]`);
  return {
    host,
    root: t('panel'),
    anonymize: t('btn-anonymize'),
    original: t('btn-original'),
    originalConfirm: t('btn-original-confirm'),
    cancel: t('btn-cancel'),
    summary: t('pv-summary'),
    rows: host.locator('.pv-row'),
    tabs: t('file-tab'),
    done: t('done-title'),
    doneClose: t('btn-done-close'),
    downloadResult: t('btn-download-result'),
    more: t('btn-more'),
    moreMenu: t('more-menu'),
    downloadMapping: t('btn-download-mapping'),
    mappingHint: t('mapping-hint'),
    hintOk: t('btn-hint-ok'),
    hintSave: t('btn-hint-save'),
    error: t('error-message'),
  };
};

/** Панель, появившаяся либо на верхней странице, либо в кадре #frame (iframe того же origin). */
export async function findPanel(page, timeout = 30000) {
  const scopes = [page, page.frameLocator('#frame')];
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const scope of scopes) if ((await scope.locator(PANEL_HOST).count()) > 0) return panel(scope);
    await page.waitForTimeout(100);
  }
  throw new Error('панель не появилась ни на странице, ни в кадре');
}
