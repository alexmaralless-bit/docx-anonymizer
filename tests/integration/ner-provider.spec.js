// WP9 (К7, К8): ONNX-провайдер NER на реальной модели. Гейт — переменная NER_MODEL_DIR (модель в git не хранится):
//   NER_MODEL_DIR=models-src/rubert-tiny2-ner-ruen npx vitest run tests/integration/ner-provider.spec.js
// Каталог — исходник пакета (pack.src.json) или распакованный пакет (pack.json). ORT — onnxruntime-web (сборка для Node,
// тот же WASM, одна нить; спайк S5 — docs/contracts.md §6.7).
// Проверяется: span-F1 по классам на синтетических корпусах eval-{ru,en}.json при пороге пакета (eval-ru — и абзацами
// по 5 предложений: в документе модель видит поток, а не отдельные предложения); документ-уровень
// (модель находит лицо, которого нет у правил и словаря, и не теряет сущностей правил); холодная init() ≤ 5 с; без сети.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadOrt, dirFiles, evalCorpus } from '../../scripts/bench-ner.mjs';
import { createOnnxNerProvider } from '../../src/core/ner/onnx-provider.js';
import { parseDocx, analyze, defaultSettings, registerBuiltinDetectors, getDetectors } from '../../src/core/index.js';
import { makeDocx, para, run } from '../helpers/docx.js';

const DIR = process.env.NER_MODEL_DIR ? resolve(process.env.NER_MODEL_DIR) : '';
const corpus = (lang) => JSON.parse(readFileSync(new URL(`../fixtures/ner/eval-${lang}.json`, import.meta.url), 'utf8'));
/** Абзацы по k подряд идущих предложений корпуса через пробел; золотые офсеты сдвигаются. */
function paragraphs(c, k) {
  const sentences = [];
  for (let i = 0; i + k <= c.sentences.length; i += k) {
    let text = '';
    const spans = [];
    for (const s of c.sentences.slice(i, i + k)) {
      const off = text ? text.length + 1 : 0;
      text = text ? `${text} ${s.text}` : s.text;
      for (const g of s.spans) spans.push({ ...g, start: g.start + off, end: g.end + off });
    }
    sentences.push({ text, spans });
  }
  return { ...c, sentences };
}
const fmt = (r) =>
  Object.entries(r.byLabel)
    .map(([l, m]) => `${l} P ${m.precision.toFixed(3)} R ${m.recall.toFixed(3)} F1 ${m.f1.toFixed(3)}`)
    .join('; ');

describe.skipIf(!DIR)('ONNX-провайдер NER на реальной модели (NER_MODEL_DIR)', () => {
  let ort;
  let files;
  let manifest;
  let provider;
  let threshold;
  let coldMs;

  beforeAll(async () => {
    ort = await loadOrt();
    files = dirFiles(DIR);
    manifest = files.manifest();
    threshold = manifest.recommendedThreshold ?? 0.6;
    provider = createOnnxNerProvider({ files, ort, modelId: manifest.id });
    const t0 = performance.now();
    await provider.init();
    coldMs = performance.now() - t0;
  }, 60000);
  afterAll(() => provider?.dispose());

  it('S5: onnxruntime-web работает под vitest/Node; холодная init() ≤ 5 с (К7)', () => {
    expect(typeof ort.InferenceSession.create).toBe('function');
    console.log(`[ner] ${manifest.id}@${manifest.version}: холодная init ${Math.round(coldMs)} мс, порог ${threshold}`);
    expect(coldMs).toBeLessThanOrEqual(5000);
  });

  it('eval-ru.json: span-F1 PER ≥ 0.80, ORG ≥ 0.65 (К8)', async () => {
    const c = corpus('ru');
    expect(c.sentences.length).toBeGreaterThanOrEqual(200);
    const r = await evalCorpus(provider, c, threshold);
    console.log(`[ner] eval-ru: ${fmt(r)}\n[ner] confusion ${JSON.stringify(r.confusion)}`);
    expect(r.byLabel.PER.f1).toBeGreaterThanOrEqual(0.8);
    expect(r.byLabel.ORG.f1).toBeGreaterThanOrEqual(0.65);
  }, 120000);

  it('eval-ru абзацами по 5 предложений: span-F1 PER ≥ 0.80, ORG ≥ 0.65 (К8; модель обучена на предложениях)', async () => {
    const c = paragraphs(corpus('ru'), 5);
    expect(c.sentences.length).toBeGreaterThanOrEqual(40);
    const r = await evalCorpus(provider, c, threshold);
    console.log(`[ner] eval-ru ×5: ${fmt(r)}`);
    expect(r.byLabel.PER.f1).toBeGreaterThanOrEqual(0.8);
    expect(r.byLabel.ORG.f1).toBeGreaterThanOrEqual(0.65);
    // для сравнения: без нарезки потока на предложения (splitSentences: false) — только в лог
    const whole = createOnnxNerProvider({ files, ort, modelId: manifest.id, splitSentences: false });
    try {
      console.log(`[ner] eval-ru ×5, splitSentences:false: ${fmt(await evalCorpus(whole, c, threshold))}`);
    } finally {
      whole.dispose();
    }
  }, 120000);

  it('eval-en.json: span-F1 PER ≥ 0.75 (К8)', async () => {
    const c = corpus('en');
    expect(c.sentences.length).toBeGreaterThanOrEqual(100);
    const r = await evalCorpus(provider, c, threshold);
    console.log(`[ner] eval-en: ${fmt(r)}\n[ner] confusion ${JSON.stringify(r.confusion)}`);
    expect(r.byLabel.PER.f1).toBeGreaterThanOrEqual(0.75);
  }, 120000);

  it('документ: модель находит лицо, которого нет у правил и словаря, и не теряет ни одной сущности правил (К8)', async () => {
    const paras = [
      'ДОГОВОР ПОСТАВКИ № 15/2026',
      'ООО «Ромашка», ИНН 7736050003, в лице генерального директора Иванова Петра Сергеевича, действующего на основании Устава, ' +
        'именуемое в дальнейшем «Поставщик», и ООО «Вектор-М» в лице директора Сидоровой Анны Викторовны, именуемое «Покупатель», заключили настоящий договор.',
      'Ответственным за приёмку назначен Пётр Сидоров.',
      'Груз сопровождает экспедитор Кравчук; Иванов обязуется передать документы не позднее 10 числа.',
      'Электронная почта: info@romashka.ru, тел. +7 (495) 123-45-67.',
    ];
    if (!getDetectors().length) registerBuiltinDetectors();
    const bytes = makeDocx(paras.map((t) => para(run(t))).join(''));
    const settings = { ...defaultSettings(), nerThreshold: threshold };
    const base = await analyze(parseDocx(bytes), settings, {});
    const withNer = await analyze(parseDocx(bytes), settings, { nerProvider: provider });
    expect(withNer.warnings.map((w) => w.code)).not.toContain('NER_FAILED');
    const key = (e) => `${e.category}|${e.streamId}|${e.start}|${e.end}`;
    const nerKeys = new Set(withNer.entities.map(key));
    expect(base.entities.length).toBeGreaterThanOrEqual(8); // правила и словарь отработали
    const lost = base.entities.filter((e) => !nerKeys.has(key(e)));
    expect(lost.map((e) => `${e.category}:${e.text}`)).toEqual([]);
    const baseKeys = new Set(base.entities.map(key));
    const added = withNer.entities.filter((e) => !baseKeys.has(key(e)) && e.category === 'PERSON');
    console.log(`[ner] документ: правила ${base.entities.length} вхождений, с моделью ${withNer.entities.length}; новые PERSON: ${added.length}`);
    expect(added.length).toBeGreaterThanOrEqual(1);
    expect(added.every((e) => e.source === 'ner')).toBe(true);
    // «Пётр Сидоров» найден (правилами или моделью)
    expect(withNer.groups.some((g) => g.category === 'PERSON' && /Сидоров/.test(g.value) && !/Анн/.test(g.value))).toBe(true);
  }, 60000);

  it('detect не обращается к сети (глобальный fetch подменён на бросающий)', async () => {
    const spy = vi.fn(() => {
      throw new Error('сеть запрещена');
    });
    vi.stubGlobal('fetch', spy);
    try {
      const p = createOnnxNerProvider({ files, ort, modelId: manifest.id });
      await p.init();
      const spans = await p.detect('Ответственным за приёмку назначен Пётр Сидоров из Казани.', { language: 'ru' });
      expect(spans.some((s) => s.label === 'PER')).toBe(true);
      p.dispose();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  }, 60000);
});
