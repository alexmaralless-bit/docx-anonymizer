// Сквозные сценарии на тестовой странице-чате (tests/e2e/pages/chat.html): страница записывает, какой файл она реально получила.
//
// Часть 1 — «страница и расширение по умолчанию»: перехват выключен → файл доходит как есть, панели нет (FR-07). Работает на фундаменте.
// Часть 2 — главный сценарий (выбор / drop / paste → панель → анонимизировать | оригинал | отмена); контракт DOM панели — helpers/chat.js.
//   До версии 0.2 эти тесты включались флагом E2E_WP3=1; теперь они идут всегда.
import { test, expect } from './fixtures.js';
import { buildSampleDocx } from '../../scripts/make-sample.mjs';
import { parseDocx } from '../../src/core/index.js';
import {
  openChat,
  received,
  waitReceived,
  receivedBytes,
  writeTemp,
  sha256,
  dropFiles,
  pasteFiles,
  enableIntercept,
  setExtensionSettings,
  panel,
  findPanel,
  PANEL_HOST,
} from './helpers/chat.js';

const wp3Test = test;
const { bytes: DOCX, gold } = buildSampleDocx();
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const hasRoot = (page) => page.evaluate((h) => document.querySelector(h) !== null, PANEL_HOST);

/** Способы «приложить файл» — каждый возвращает функцию, которая отправляет список файлов в страницу. */
const CHANNELS = {
  'скрытый input по кнопке': (page) => async (files) => {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#attach-btn')]);
    await chooser.setFiles(files);
  },
  'видимый input multiple': (page) => (files) => page.setInputFiles('#multi-input', files),
  'динамический input': (page) => async (files) => {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#dynamic-btn')]);
    await chooser.setFiles(files);
  },
  'input в open shadow root': (page) => (files) => page.setInputFiles('#shadow-input', files),
};

const mk = (name, bytes) => writeTemp(name, bytes);

test.describe('тестовая страница-чат, перехват выключен (по умолчанию)', () => {
  for (const [title, make] of Object.entries(CHANNELS)) {
    test(`${title}: файл доходит как есть, панели нет`, async ({ context, site }) => {
      const page = await openChat(context, site);
      await make(page)([mk('договор.docx', DOCX)]);
      const [r] = await waitReceived(page, 1);
      expect(r.name).toBe('договор.docx');
      expect(r.sha256).toBe(sha256(DOCX));
      expect(await hasRoot(page)).toBe(false);
    });
  }

  test('multiple: порядок и содержимое трёх файлов сохраняются', async ({ context, site }) => {
    const page = await openChat(context, site);
    await page.setInputFiles('#multi-input', [mk('a.docx', DOCX), mk('b.pdf', PDF), mk('c.docx', DOCX)]);
    const list = await waitReceived(page, 3);
    expect(list.map((x) => x.name)).toEqual(['a.docx', 'b.pdf', 'c.docx']);
    expect(list.map((x) => x.sha256)).toEqual([sha256(DOCX), sha256(PDF), sha256(DOCX)]);
  });

  test('iframe того же origin: файл из кадра доходит как есть', async ({ context, site }) => {
    const page = await openChat(context, site);
    await page.frameLocator('#frame').locator('#frame-input').setInputFiles(mk('кадр.docx', DOCX));
    const [r] = await waitReceived(page, 1);
    expect(r).toMatchObject({ name: 'кадр.docx', source: 'iframe-input', sha256: sha256(DOCX) });
  });

  test('drop и paste: страница получает файл', async ({ context, site }) => {
    const page = await openChat(context, site);
    await dropFiles(page, '#drop-zone', [{ name: 'drop.docx', bytes: DOCX }]);
    await pasteFiles(page, '#paste-zone', [{ name: 'paste.docx', bytes: DOCX }]);
    const list = await waitReceived(page, 2);
    expect(list.map((x) => [x.source, x.name, x.sha256])).toEqual([
      ['drop', 'drop.docx', sha256(DOCX)],
      ['paste', 'paste.docx', sha256(DOCX)],
    ]);
  });

  test('detached input: страница получает файл', async ({ context, site }) => {
    const page = await openChat(context, site);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#detached-btn')]);
    await chooser.setFiles(mk('detached.docx', DOCX));
    const [r] = await waitReceived(page, 1);
    expect(r.sha256).toBe(sha256(DOCX));
  });
});

test.describe('главный сценарий', () => {
  /** Содержимое принятого файла не содержит исходных адресов и содержит плейсхолдеры. */
  async function expectAnonymized(page, index) {
    const doc = parseDocx(await receivedBytes(page, index));
    const text = doc.streams.map((s) => s.text).join('\n');
    for (const v of [gold.email1, gold.email2, gold.email3, gold.emailOld]) expect(text, v).not.toContain(v);
    expect(text).toMatch(/\[EMAIL_\d+\]/);
  }

  for (const [title, make] of Object.entries(CHANNELS)) {
    wp3Test(`${title}: «Анонимизировать и загрузить» → страница получает *.anon.docx`, async ({ context, extensionId, site }) => {
      await enableIntercept(context, extensionId, site);
      const page = await openChat(context, site);
      await make(page)([mk('договор.docx', DOCX)]);
      const ui = panel(page);
      await expect(ui.root).toBeVisible({ timeout: 30000 });
      await expect(ui.summary).toContainText(/Найдено|Found/);
      expect(await received(page)).toEqual([]); // до решения пользователя страница ничего не получила
      await ui.anonymize.click();
      const [r] = await waitReceived(page, 1);
      expect(r.name).toBe('договор.anon.docx');
      expect(r.sha256).not.toBe(sha256(DOCX));
      await expectAnonymized(page, 0);
      await expect(ui.done).toBeVisible();
    });
  }

  wp3Test('«Загрузить оригинал» → страница получает исходный файл', async ({ context, extensionId, site }) => {
    await enableIntercept(context, extensionId, site);
    const page = await openChat(context, site);
    await page.setInputFiles('#multi-input', mk('договор.docx', DOCX));
    const ui = panel(page);
    await ui.original.click({ timeout: 30000 });
    await ui.originalConfirm.click(); // «Отправить оригинал?» — подтверждение
    const [r] = await waitReceived(page, 1);
    expect(r.name).toBe('договор.docx');
    expect(r.sha256).toBe(sha256(DOCX));
  });

  wp3Test('«Отмена» → страница ничего не получает, input очищен', async ({ context, extensionId, site }) => {
    await enableIntercept(context, extensionId, site);
    const page = await openChat(context, site);
    await page.setInputFiles('#multi-input', mk('договор.docx', DOCX));
    await panel(page).cancel.click({ timeout: 30000 });
    await page.waitForTimeout(500);
    expect(await received(page)).toEqual([]);
    expect(await page.$eval('#multi-input', (i) => i.files.length)).toBe(0);
    await expect(panel(page).host).toHaveCount(0);
  });

  wp3Test('[a.docx, b.pdf, c.docx] → [a.anon.docx, b.pdf, c.anon.docx], порядок сохранён', async ({ context, extensionId, site }) => {
    await enableIntercept(context, extensionId, site);
    const page = await openChat(context, site);
    await page.setInputFiles('#multi-input', [mk('a.docx', DOCX), mk('b.pdf', PDF), mk('c.docx', DOCX)]);
    await panel(page).anonymize.click({ timeout: 60000 });
    const list = await waitReceived(page, 3, 60000);
    expect(list.map((x) => x.name)).toEqual(['a.anon.docx', 'b.pdf', 'c.anon.docx']);
    expect(list[1].sha256).toBe(sha256(PDF)); // не-docx идёт без изменений
    await expectAnonymized(page, 0);
    await expectAnonymized(page, 2);
  });

  wp3Test('drop на зону чата → панель → анонимизированный файл', async ({ context, extensionId, site }) => {
    await enableIntercept(context, extensionId, site);
    const page = await openChat(context, site);
    await dropFiles(page, '#drop-zone', [{ name: 'drop.docx', bytes: DOCX }]);
    await panel(page).anonymize.click({ timeout: 30000 });
    const [r] = await waitReceived(page, 1);
    expect(r).toMatchObject({ name: 'drop.anon.docx', source: 'drop' });
    await expectAnonymized(page, 0);
  });

  wp3Test('paste файла → панель → анонимизированный файл', async ({ context, extensionId, site }) => {
    await enableIntercept(context, extensionId, site);
    const page = await openChat(context, site);
    await pasteFiles(page, '#paste-zone', [{ name: 'paste.docx', bytes: DOCX }]);
    await panel(page).anonymize.click({ timeout: 30000 });
    const [r] = await waitReceived(page, 1);
    expect(r).toMatchObject({ name: 'paste.anon.docx', source: 'paste' });
    await expectAnonymized(page, 0);
  });

  wp3Test('iframe того же origin: перехват работает внутри кадра', async ({ context, extensionId, site }) => {
    await enableIntercept(context, extensionId, site);
    const page = await openChat(context, site);
    await page.frameLocator('#frame').locator('#frame-input').setInputFiles(mk('кадр.docx', DOCX));
    await (await findPanel(page)).anonymize.click({ timeout: 30000 });
    const [r] = await waitReceived(page, 1);
    expect(r.name).toBe('кадр.anon.docx');
    await expectAnonymized(page, 0);
  });

  wp3Test('detached input (не добавлен в DOM) тоже перехватывается', async ({ context, extensionId, site }) => {
    test.skip(!process.env.E2E_WP3_DETACHED, 'включить E2E_WP3_DETACHED=1, если WP3 поддерживает такие input');
    await enableIntercept(context, extensionId, site);
    const page = await openChat(context, site);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#detached-btn')]);
    await chooser.setFiles(mk('detached.docx', DOCX));
    await panel(page).anonymize.click({ timeout: 30000 });
    const [r] = await waitReceived(page, 1);
    expect(r.name).toBe('detached.anon.docx');
  });

  test('тумблер выключен → document.querySelector("docx-anonymizer-root") === null и файл идёт как есть', async ({ context, extensionId, site }) => {
    await setExtensionSettings(context, extensionId, { interceptEnabled: false, siteMode: 'allowlist', allowlist: [site.origin] });
    const page = await openChat(context, site);
    await page.setInputFiles('#multi-input', mk('договор.docx', DOCX));
    const [r] = await waitReceived(page, 1);
    expect(r.sha256).toBe(sha256(DOCX));
    expect(await hasRoot(page)).toBe(false);
  });

  wp3Test('включение и выключение тумблера действуют без перезагрузки страницы', async ({ context, extensionId, site }) => {
    const page = await openChat(context, site);
    await page.setInputFiles('#multi-input', mk('до.docx', DOCX));
    expect((await waitReceived(page, 1))[0].name).toBe('до.docx'); // выключен — не перехвачено
    await enableIntercept(context, extensionId, site);
    await page.setInputFiles('#multi-input', mk('после.docx', DOCX));
    await panel(page).anonymize.click({ timeout: 30000 });
    expect((await waitReceived(page, 2))[1].name).toBe('после.anon.docx');
    await setExtensionSettings(context, extensionId, { interceptEnabled: false });
    await page.setInputFiles('#multi-input', mk('снова.docx', DOCX));
    expect((await waitReceived(page, 3))[2].name).toBe('снова.docx');
  });
});
