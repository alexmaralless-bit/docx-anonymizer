// WP8 (К5, К6): пакет модели NER — импорт из файла в OPFS, проверка sha256, статус, проводка в воркер, удаление.
// Пакет фейковый (модели в репозитории нет): ONNX-провайдер (WP9) не может создать сессию из model.onnx → MODEL_LOAD_FAILED → NER_FAILED,
// сущности правил на месте. За весь сценарий — ни одного http(s)-запроса.
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { test, expect, BUNDLED } from './fixtures.js';
import { buildSampleDocx } from '../../scripts/make-sample.mjs';
import { buildFixtures } from '../../scripts/gen-fixtures.mjs';
import { installClient, runPipeline } from './helpers/client.js';
import { captureAllRequests, externalRequests, offscreenRequests } from './helpers/network.js';

// Полная сборка (WP10-C) ставит встроенную модель сама — сценарий «модели нет → импорт» проверяется на лёгкой
test.skip(!!BUNDLED, 'полная сборка: встроенная модель ставится сама (tests/e2e/bundled-model.spec.js)');

const ID = 'e2e-fake-ner';
const VERSION = '0.0.1';
const NAME = 'Фейковая модель e2e';

function fakePack({ tamper = false } = {}) {
  const files = {
    'model.onnx': new Uint8Array(4096).map((_, i) => (i * 13 + 5) & 0xff),
    'vocab.txt': strToU8('[PAD]\n[UNK]\n[CLS]\n[SEP]\nиванов\n'),
    'config.json': strToU8('{"model_type":"bert"}'),
    LICENSE: strToU8('MIT License (e2e fixture)'),
    NOTICE: strToU8('e2e fixture, not a model'),
  };
  const manifest = {
    kind: 'docx-anonymizer-model-pack',
    schemaVersion: 1,
    id: ID,
    version: VERSION,
    name: { ru: NAME, en: 'Fake e2e model' },
    languages: ['ru', 'en'],
    task: 'token-classification',
    labels: ['O', 'B-PER', 'I-PER', 'B-ORG', 'I-ORG', 'B-LOC', 'I-LOC'],
    tokenizer: {
      type: 'wordpiece',
      vocab: 'vocab.txt',
      lowercase: false,
      stripAccents: false,
      maxLen: 128,
      stride: 32,
      cls: '[CLS]',
      sep: '[SEP]',
      pad: '[PAD]',
      unk: '[UNK]',
    },
    model: { file: 'model.onnx', inputs: { ids: 'input_ids', mask: 'attention_mask', types: 'token_type_ids' }, output: 'logits', indexType: 'int64' },
    files: Object.entries(files).map(([path, b]) => ({ path, sha256: createHash('sha256').update(b).digest('hex'), size: b.length })),
    license: 'MIT',
    source: { note: 'e2e' },
    minExtensionVersion: '0.1.0',
  };
  if (tamper) files['model.onnx'] = files['model.onnx'].map((x) => x ^ 1); // размер тот же, хеш другой
  const zip = zipSync({ 'pack.json': strToU8(JSON.stringify(manifest)), ...files });
  return { manifest, buffer: Buffer.from(zip) };
}

const stored = (page) => page.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
const opfsFiles = (page, id) =>
  page.evaluate(async (id) => {
    const root = await navigator.storage.getDirectory();
    try {
      const dir = await (await root.getDirectoryHandle('models')).getDirectoryHandle(id);
      const out = {};
      for await (const [name, h] of dir.entries()) out[name] = (await h.getFile()).size;
      return out;
    } catch (e) {
      return e.name;
    }
  }, id);

test('импорт пакета модели → статус, OPFS, NER_FAILED в анализе; битый и чужой отклоняются; удаление; без сети', async ({ context, extensionId }) => {
  // сеть всех целей браузера, включая offscreen-документ и его воркер (К6)
  const net = await captureAllRequests(context);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.evaluate(() => chrome.storage.local.set({ settings: { uiLanguage: 'ru' } }));
  await page.reload();
  const status = page.getByTestId('ner-status');
  const msg = page.getByTestId('ner-msg');
  await expect(status).toContainText('не установлена');
  await expect(page.getByTestId('ner-remove')).toBeHidden();
  await expect(page.getByTestId('ner-releases-link')).toHaveAttribute('href', 'https://github.com/argmaster-dev/docx-anonymizer/releases');

  // Чужой zip (нет pack.json) и повреждённый пакет (хеш не сходится) — отклоняются с кодом, ничего не установлено
  const input = page.getByTestId('ner-import-file');
  await input.setInputFiles({ name: 'other.zip', mimeType: 'application/zip', buffer: Buffer.from(zipSync({ 'readme.txt': strToU8('x') })) });
  await expect(msg).toContainText('pack.json');
  await input.setInputFiles({ name: 'broken.zip', mimeType: 'application/zip', buffer: fakePack({ tamper: true }).buffer });
  await expect(msg).toContainText('контрольная сумма');
  await input.setInputFiles({ name: 'not-zip.zip', mimeType: 'application/zip', buffer: Buffer.from('просто текст') });
  await expect(msg).toContainText('не zip');
  await expect(status).toContainText('не установлена');
  expect(await opfsFiles(page, ID)).toBe('NotFoundError');

  // Корректный, но не из KNOWN_PACKS → подтверждение → установка
  const { manifest, buffer } = fakePack();
  await input.setInputFiles({ name: `docx-anonymizer-ner-${ID}-${VERSION}.zip`, mimeType: 'application/zip', buffer });
  await expect(page.locator('dialog[open]')).toContainText(NAME);
  await page.getByTestId('dlg-ok').click();
  await expect(status).toContainText(NAME);
  await expect(status).toContainText(VERSION);
  await expect(status).toContainText('не проверен');
  await expect(page.getByTestId('ner-remove')).toBeVisible();
  await expect.poll(async () => (await stored(page))?.nerModel, { timeout: 2000 }).toBe(ID);

  const files = await opfsFiles(page, ID);
  for (const f of manifest.files) expect(files[f.path], f.path).toBe(f.size);
  expect(files['pack.json']).toBeGreaterThan(0);
  expect(files['installed.json']).toBeGreaterThan(0);
  expect(files['.installing']).toBeUndefined();

  // Анализ: воркер берёт модель из OPFS (фейковый model.onnx → MODEL_LOAD_FAILED), правила работают (NFR-13)
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await installClient(ext);
  const { bytes, gold } = buildSampleDocx();
  const run = await runPipeline(ext, { name: 'ner.docx', bytes });
  expect(run.ent.warnings).toContainEqual({ code: 'NER_FAILED', details: { reason: 'MODEL_LOAD_FAILED' } });
  expect(run.stages).toContain('ner');
  expect(run.ent.entities.filter((e) => e.category === 'EMAIL').map((e) => e.value)).toEqual(expect.arrayContaining([gold.email1, gold.email2]));

  // Удаление: подтверждение → статус, настройка и каталог очищены
  await page.getByTestId('ner-remove').click();
  await page.getByTestId('dlg-ok').click();
  await expect(status).toContainText('не установлена');
  await expect(msg).toContainText('Модель удалена');
  await expect.poll(async () => (await stored(page))?.nerModel, { timeout: 2000 }).toBe('');
  expect(await opfsFiles(page, ID)).toBe('NotFoundError');

  // Без модели этапа NER нет и предупреждения тоже (другой файл: тот же SHA-256 вернул бы прежний анализ, §3.6)
  const again = await runPipeline(ext, { name: 'ner2.docx', bytes: buildFixtures()[0].bytes });
  expect(again.ent.warnings.map((w) => w.code)).not.toContain('NER_FAILED');

  const urls = await net.stop();
  expect(externalRequests(urls), 'NFR-01: http(s)-запросы').toEqual([]);
  // запись действительно видит offscreen-документ и воркер: иначе проверка выше была бы пустой. wasm ONNX Runtime воркер
  // запрашивает только в InferenceSession.create — после чтения pack.json, словаря и model.onnx из OPFS; значит,
  // MODEL_LOAD_FAILED выше — сбой создания сессии из фейкового model.onnx, а не чтения пакета.
  expect(offscreenRequests(urls)).toEqual(
    expect.arrayContaining([expect.stringMatching(/\/offscreen\/worker\.js$/), expect.stringMatching(/\/vendor\/ort-wasm-simd-threaded\.wasm$/)]),
  );
});
