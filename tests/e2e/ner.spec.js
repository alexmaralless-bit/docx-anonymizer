// WP9 (К6, К7, К8): реальный пакет модели NER в расширении — импорт zip через настройки, анализ образца в воркере
// offscreen (onnxruntime-web, WASM, одна нить), сущности source:'ner', ни одного http(s)-запроса, время анализа.
// Гейт — переменная NER_PACK (путь к zip, `npm run pack:model -- --id=rubert-tiny2-ner-ruen`):
//   flock <lock> sh -c 'npm run build:e2e && NER_PACK=release/docx-anonymizer-ner-rubert-tiny2-ner-ruen-1.0.0.zip npx playwright test ner.spec.js'
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { test, expect } from './fixtures.js';
import { buildSampleDocx, esc } from '../../scripts/make-sample.mjs';
import { installClient, runPipeline } from './helpers/client.js';
import { findKnownPack } from '../../src/core/ner/known-packs.js';
import { bigDocument } from '../../scripts/bench-ner.mjs';
import { makeDocx, para, run } from '../helpers/docx.js';

const PACK = process.env.NER_PACK ? resolve(process.env.NER_PACK) : '';

/** Образец + абзац с третьим лицом без лейбла (голая фамилия — словарь и правила её не берут). */
function sampleWithThirdPerson(extra) {
  const files = unzipSync(buildSampleDocx().bytes);
  const xml = new TextDecoder().decode(files['word/document.xml']);
  const p = `<w:p><w:r><w:t xml:space="preserve">${esc(extra)}</w:t></w:r></w:p>`;
  const i = xml.lastIndexOf('<w:sectPr');
  files['word/document.xml'] = strToU8(xml.slice(0, i) + p + xml.slice(i));
  return zipSync(files);
}

test.skip(!PACK, 'нужен NER_PACK — путь к zip-пакету модели');

test('реальный пакет модели: импорт, анализ с NER в воркере, source:ner, без сети, время', async ({ context, extensionId }) => {
  test.setTimeout(180000);
  const urls = [];
  context.on('request', (r) => urls.push(r.url()));
  const zip = readFileSync(PACK);
  const sha = createHash('sha256').update(zip).digest('hex');
  const known = findKnownPack(sha);

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.evaluate(() => chrome.storage.local.set({ settings: { uiLanguage: 'ru' } }));
  await page.reload();
  const status = page.getByTestId('ner-status');
  await expect(status).toContainText('не установлена');
  await page.getByTestId('ner-import-file').setInputFiles(PACK);
  if (!known) {
    // пакет не из KNOWN_PACKS — установка после подтверждения
    await expect(page.locator('dialog[open]')).toBeVisible({ timeout: 60000 });
    await page.getByTestId('dlg-ok').click();
  }
  await expect(status).toContainText('rubert-tiny2', { ignoreCase: true, timeout: 120000 });
  await expect(status).toContainText(known ? 'проверенный пакет' : 'не проверен');
  console.log(`[ner-e2e] пакет ${sha.slice(0, 12)}… ${known ? `проверен (${known.id}@${known.version})` : 'не проверен'}`);

  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await installClient(ext);
  const cold = await runPipeline(ext, { name: 'ner-cold.docx', bytes: sampleWithThirdPerson('Груз сопровождает экспедитор Кравчук, его сменит Лаптев.') });
  expect(cold.ent.warnings.map((w) => w.code)).not.toContain('NER_FAILED');
  expect(cold.stages).toContain('ner');
  const ner = cold.ent.entities.filter((e) => e.source === 'ner');
  expect(ner.length).toBeGreaterThanOrEqual(1);
  expect(ner.map((e) => e.category)).toContain('PERSON');

  // тёплый анализ: модель уже в памяти воркера (другой файл — тот же SHA-256 вернул бы прежний анализ)
  const warm = await runPipeline(ext, { name: 'ner-warm.docx', bytes: sampleWithThirdPerson('Груз сопровождает экспедитор Кравчук.') });
  expect(warm.ent.warnings.map((w) => w.code)).not.toContain('NER_FAILED');
  console.log(
    `[ner-e2e] analyzeFile: холодный ${Math.round(cold.analyzeMs)} мс, тёплый ${Math.round(warm.analyzeMs)} мс; NER: ${ner.map((e) => `${e.category} «${e.value}»`).join(', ')}`,
  );
  expect(cold.analyzeMs).toBeLessThanOrEqual(10000);
  expect(warm.analyzeMs).toBeLessThanOrEqual(3000);

  // «20-страничный договор» (≈ 9 000 слов из корпуса eval-ru, абзацами) с NER в одну нить (NFR-03)
  const corpus = JSON.parse(readFileSync(resolve('tests/fixtures/ner/eval-ru.json'), 'utf8'));
  const paras = bigDocument(corpus);
  const big = await runPipeline(ext, { name: 'ner-20p.docx', bytes: makeDocx(paras.map((t) => para(run(esc(t)))).join('')) });
  expect(big.ent.warnings.map((w) => w.code)).not.toContain('NER_FAILED');
  console.log(`[ner-e2e] 20 страниц (${paras.join(' ').split(/\s+/).length} слов, ${paras.length} абзацев): analyzeFile ${Math.round(big.analyzeMs)} мс`);
  expect(big.analyzeMs).toBeLessThanOrEqual(15000);

  expect(urls.filter((u) => /^https?:/i.test(u))).toEqual([]);
});
