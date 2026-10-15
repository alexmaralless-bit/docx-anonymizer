// WP9: ONNX-провайдер NER (core/ner/onnx-provider.js) на подменном onnxruntime — без модели: загрузка пакета и ошибки
// MODEL_LOAD_FAILED (NFR-13), батчи и окна, метка первого субтокена, выбор окна по центру, пре-фильтр, dispose, без сети.
// Проверка на реальной модели — tests/integration/ner-provider.spec.js (гейт NER_MODEL_DIR).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createOnnxNerProvider } from '../../../src/core/ner/onnx-provider.js';

const enc = (s) => new TextEncoder().encode(s);
const valid = JSON.parse(readFileSync(new URL('../../fixtures/ner/pack.valid.json', import.meta.url), 'utf8'));
const LABELS = ['O', 'B-PER', 'I-PER', 'B-ORG', 'I-ORG', 'B-LOC', 'I-LOC'];
const VOCAB = [
  '[PAD]',
  '[UNK]',
  '[CLS]',
  '[SEP]',
  'Иван',
  'Петров',
  '##а',
  'и',
  'в',
  'Москве',
  'договор',
  'подписал',
  '.',
  'ООО',
  '«',
  '»',
  'Ромашка',
  'слово',
];
const id = (t) => VOCAB.indexOf(t);
/** Метка «модели» для id: Иван/Петров → PER, Ромашка → ORG, Москве → LOC; ##а продолжает слово. */
const LABEL_BY_ID = { [id('Иван')]: 1, [id('Петров')]: 2, [id('Ромашка')]: 3, [id('Москве')]: 5 };

function fakeOrt({ inputNames = ['input_ids', 'attention_mask', 'token_type_ids'], createError = null, labelFor = null } = {}) {
  const calls = { create: 0, run: [], release: 0 };
  class Tensor {
    constructor(type, data, dims) {
      Object.assign(this, { type, data, dims });
    }
  }
  const InferenceSession = {
    async create(bytes, opts) {
      calls.create++;
      calls.createOpts = opts;
      if (createError) throw createError;
      return {
        inputNames,
        outputNames: ['logits'],
        async run(feeds) {
          const ids = feeds.input_ids;
          const [B, L] = ids.dims;
          calls.run.push({ B, L, type: ids.type, mask: Array.from(feeds.attention_mask.data, Number), ids: Array.from(ids.data, Number) });
          const out = new Float32Array(B * L * LABELS.length);
          for (let i = 0; i < B * L; i++) {
            const tok = Number(ids.data[i]);
            const lab = labelFor ? labelFor(i % L, tok, Math.floor(i / L)) : (LABEL_BY_ID[tok] ?? 0);
            out[i * LABELS.length + lab] = 8;
          }
          return { logits: new Tensor('float32', out, [B, L, LABELS.length]) };
        },
        async release() {
          calls.release++;
        },
      };
    },
  };
  return { ort: { InferenceSession, Tensor }, calls };
}

function packFiles(manifestPatch = {}, { config = JSON.stringify({ id2label: Object.fromEntries(LABELS.map((l, i) => [i, l])) }) } = {}) {
  const manifest = {
    ...valid,
    ...manifestPatch,
    tokenizer: { ...valid.tokenizer, ...(manifestPatch.tokenizer || {}) },
    model: { ...valid.model, ...(manifestPatch.model || {}) },
  };
  const files = {
    'pack.json': enc(JSON.stringify(manifest)),
    'vocab.txt': enc(VOCAB.join('\n') + '\n'),
    'config.json': enc(config),
    'model.onnx': new Uint8Array([1, 2, 3]),
  };
  const reads = [];
  return {
    reads,
    files: {
      read: async (p) => {
        reads.push(p);
        if (!(p in files)) throw new Error('нет файла');
        return files[p];
      },
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('createOnnxNerProvider: загрузка', () => {
  it('init один раз (общий промис): pack.json → vocab → config → модель; сессия wasm', async () => {
    const { ort, calls } = fakeOrt();
    const { files, reads } = packFiles();
    const p = createOnnxNerProvider({ files, ort, modelId: valid.id });
    expect(p.name).toBe(`onnx:${valid.id}`);
    await Promise.all([p.init(), p.init()]);
    await p.init();
    expect(calls.create).toBe(1);
    expect(reads).toEqual(['pack.json', 'vocab.txt', 'config.json', 'model.onnx']);
    expect(calls.createOpts).toEqual({ executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  });

  it('ошибки загрузки → CoreError MODEL_LOAD_FAILED; после сбоя следующий init пробует снова', async () => {
    const cases = [
      { files: { read: async () => Promise.reject(new Error('нет')) } },
      { files: { read: async () => enc('{не json') } },
      { files: packFiles({ tokenizer: { unk: '[НЕТ]' } }).files },
      { files: packFiles().files, ort: fakeOrt({ createError: new Error('protobuf parsing failed') }).ort },
      { files: packFiles().files, ort: fakeOrt({ inputNames: ['input_ids', 'token_type_ids'] }).ort },
      { files: packFiles({}, { config: JSON.stringify({ id2label: { 0: 'O', 1: 'B-PER' } }) }).files },
    ];
    for (const c of cases) {
      const p = createOnnxNerProvider({ files: c.files, ort: c.ort || fakeOrt().ort, modelId: 'm' });
      const err = await p.init().catch((e) => e);
      expect(err).toMatchObject({ name: 'CoreError', code: 'MODEL_LOAD_FAILED' });
      await expect(p.detect('Иван', { language: 'ru' })).rejects.toMatchObject({ code: 'MODEL_LOAD_FAILED' });
    }
    // неудачная модель отпускает сессию
    const bad = fakeOrt({ inputNames: ['x'] });
    await createOnnxNerProvider({ files: packFiles().files, ort: bad.ort, modelId: 'm' })
      .init()
      .catch(() => {});
    expect(bad.calls.release).toBe(1);
    // повтор после сбоя
    let fail = true;
    const { files } = packFiles();
    const flaky = { read: async (path) => (fail && path === 'model.onnx' ? Promise.reject(new Error('io')) : files.read(path)) };
    const { ort, calls } = fakeOrt();
    const p = createOnnxNerProvider({ files: flaky, ort, modelId: 'm' });
    await expect(p.init()).rejects.toMatchObject({ code: 'MODEL_LOAD_FAILED' });
    fail = false;
    await p.init();
    expect(calls.create).toBe(1);
  });

  it('config.json без id2label — метки из pack.json', async () => {
    const { ort } = fakeOrt();
    const p = createOnnxNerProvider({ files: packFiles({}, { config: '{"model_type":"bert"}' }).files, ort, modelId: 'm' });
    const text = 'Иван Петров';
    expect(await p.detect(text, { language: 'ru' })).toEqual([{ start: 0, end: 11, label: 'PER', score: expect.any(Number) }]);
  });
});

describe('createOnnxNerProvider: detect', () => {
  it('спаны с офсетами исходного текста, метка — по первому субтокену, score ≈ 1; тензоры int64 + маска', async () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('сеть запрещена');
    });
    const { ort, calls } = fakeOrt();
    const p = createOnnxNerProvider({ files: packFiles().files, ort, modelId: 'm' });
    const text = 'Иван Петрова подписал договор в Москве с ООО «Ромашка».';
    const spans = await p.detect(text, { language: 'ru' });
    expect(spans.map((s) => [text.slice(s.start, s.end), s.label])).toEqual([
      ['Иван Петрова', 'PER'],
      ['Москве', 'LOC'],
      ['ООО «Ромашка»', 'ORG'], // ОПФ и кавычки — по соглашению каталога (FR-18)
    ]);
    for (const s of spans) expect(s.score).toBeGreaterThan(0.99);
    expect(calls.run).toHaveLength(1);
    expect(calls.run[0].type).toBe('int64');
    expect(calls.run[0].ids[0]).toBe(id('[CLS]'));
    expect(calls.run[0].mask.every((m) => m === 1)).toBe(true);
  });

  it('пустой текст и текст без слов — без вызова модели', async () => {
    const { ort, calls } = fakeOrt();
    const p = createOnnxNerProvider({ files: packFiles().files, ort, modelId: 'm' });
    expect(await p.detect('', { language: 'ru' })).toEqual([]);
    expect(await p.detect('  \n ', { language: 'ru' })).toEqual([]);
    expect(calls.run).toHaveLength(0);
  });

  it('длинный поток: окна maxLen с перекрытием, батчи по batchSize с [PAD] до самого длинного, int32 по indexType', async () => {
    const { ort, calls } = fakeOrt();
    const p = createOnnxNerProvider({
      files: packFiles({ tokenizer: { maxLen: 64, stride: 8 }, model: { indexType: 'int32' } }).files,
      ort,
      modelId: 'm',
      batchSize: 3,
    });
    const words = Array.from({ length: 400 }, (_, i) => (i % 50 === 7 ? 'Иван' : i % 50 === 8 ? 'Петров' : 'слово'));
    words[399] = 'Москве';
    const text = words.join(' ');
    const spans = await p.detect(text, { language: 'ru' });
    expect(spans.filter((s) => s.label === 'PER')).toHaveLength(8);
    expect(spans.at(-1)).toMatchObject({ label: 'LOC', end: text.length });
    expect(p.stats.windows).toBe(8); // 62 слова в окне, шаг 54
    expect(calls.run.map((r) => r.B)).toEqual([3, 3, 2]);
    expect(calls.run.every((r) => r.type === 'int32' && r.L <= 64)).toBe(true);
    const last = calls.run.at(-1);
    expect(last.ids.slice(last.L)).toContain(id('[PAD]'));
    expect(last.mask.filter((m) => m === 0).length).toBeGreaterThan(0);
  });

  it('в перекрытии берётся предсказание окна, чей центр ближе к слову', async () => {
    // maxLen 64 → 62 слова в окне; stride 20 → окна [0, 62) и [42, 104), центры 30.5 и 72.5.
    // «Иван» — слова 20 (только первое окно), 45 (ближе к центру первого, позиция 46), 58 (ближе ко второму, позиция 17)
    const words = Array.from({ length: 104 }, (_, i) => ([20, 45, 58].includes(i) ? 'Иван' : 'слово'));
    const text = words.join(' ');
    const at = (spans) => spans.map((s) => text.slice(0, s.start).split(' ').length - 1);
    const files = packFiles({ tokenizer: { maxLen: 64, stride: 20 } }).files;
    // «модель» A: PER только в первой половине окна (позиция < 32)
    const a = createOnnxNerProvider({ files, ort: fakeOrt({ labelFor: (pos, tok) => (tok === id('Иван') && pos < 32 ? 1 : 0) }).ort, modelId: 'm' });
    expect(at(await a.detect(text, { language: 'ru' }))).toEqual([20, 58]);
    expect(a.stats.windows).toBe(2);
    // «модель» B: PER только во второй половине окна
    const b = createOnnxNerProvider({ files, ort: fakeOrt({ labelFor: (pos, tok) => (tok === id('Иван') && pos >= 32 ? 1 : 0) }).ort, modelId: 'm' });
    expect(at(await b.detect(text, { language: 'ru' }))).toEqual([45]);
  });

  it('пре-фильтр: окно без слов с заглавной буквы не считается; skipLowercaseWindows:false — считается', async () => {
    const text = Array.from({ length: 130 }, () => 'слово').join(' ') + ' Иван';
    const a = fakeOrt();
    const p = createOnnxNerProvider({ files: packFiles({ tokenizer: { maxLen: 64, stride: 8 } }).files, ort: a.ort, modelId: 'm' });
    expect(await p.detect(text, { language: 'ru' })).toHaveLength(1);
    expect(p.stats.skippedWindows).toBe(2);
    expect(p.stats.windows).toBe(1);
    const b = fakeOrt();
    const q = createOnnxNerProvider({
      files: packFiles({ tokenizer: { maxLen: 64, stride: 8 } }).files,
      ort: b.ort,
      modelId: 'm',
      skipLowercaseWindows: false,
    });
    expect(await q.detect(text, { language: 'ru' })).toHaveLength(1);
    expect(q.stats.skippedWindows).toBe(0);
    expect(q.stats.windows).toBe(3);
  });

  it('maxLen ограничивается параметром (митигация), но не больше пакетного', async () => {
    const { ort, calls } = fakeOrt();
    const p = createOnnxNerProvider({ files: packFiles().files, ort, modelId: 'm', maxLen: 32, skipLowercaseWindows: false });
    await p.detect(Array.from({ length: 100 }, () => 'слово').join(' '), { language: 'ru' });
    expect(Math.max(...calls.run.map((r) => r.L))).toBeLessThanOrEqual(32);
  });

  it('splitSentences (по умолчанию): каждое предложение — свои окна; false — одно окно на поток', async () => {
    const text = 'Иван Петров подписал договор в Москве. Иван подписал договор в Москве.';
    const a = fakeOrt();
    const p = createOnnxNerProvider({ files: packFiles().files, ort: a.ort, modelId: 'm' });
    const spans = await p.detect(text, { language: 'ru' });
    expect(p.stats.windows).toBe(2);
    expect(spans.map((s) => [text.slice(s.start, s.end), s.label])).toEqual([
      ['Иван Петров', 'PER'],
      ['Москве', 'LOC'],
      ['Иван', 'PER'],
      ['Москве', 'LOC'],
    ]);
    const b = fakeOrt();
    const q = createOnnxNerProvider({ files: packFiles().files, ort: b.ort, modelId: 'm', splitSentences: false });
    expect(await q.detect(text, { language: 'ru' })).toEqual(spans);
    expect(q.stats.windows).toBe(1);
  });

  it('dispose во время detect → CoreError MODEL_LOAD_FAILED, не TypeError; следующий detect загружает заново', async () => {
    const files = packFiles({ tokenizer: { maxLen: 64, stride: 8 } }).files;
    const text = Array.from({ length: 400 }, (_, i) => (i % 50 === 7 ? 'Иван' : 'слово')).join(' ');
    // 1) между батчами: «модель» вызывает dispose на первом run
    let p;
    const { ort, calls } = fakeOrt({
      labelFor: (pos, tok) => {
        p.dispose();
        return LABEL_BY_ID[tok] ?? 0;
      },
    });
    p = createOnnxNerProvider({ files, ort, modelId: 'm', batchSize: 2 });
    const err = await p.detect(text, { language: 'ru' }).catch((e) => e);
    expect(err).toMatchObject({ name: 'CoreError', code: 'MODEL_LOAD_FAILED' });
    expect(calls.run).toHaveLength(1);
    await Promise.resolve();
    expect(calls.release).toBe(1);
    // 2) сразу после вызова detect (до окончания init)
    const b = fakeOrt();
    const q = createOnnxNerProvider({ files: packFiles().files, ort: b.ort, modelId: 'm' });
    await q.init();
    const pending = q.detect('Иван', { language: 'ru' });
    q.dispose();
    await expect(pending).rejects.toMatchObject({ code: 'MODEL_LOAD_FAILED' });
    expect(await q.detect('Иван', { language: 'ru' })).toHaveLength(1);
    // 3) во время загрузки: сессия освобождается, а не остаётся жить без владельца
    const c = fakeOrt();
    const r = createOnnxNerProvider({ files: packFiles().files, ort: c.ort, modelId: 'm' });
    const loading = r.init();
    r.dispose();
    await expect(loading).rejects.toMatchObject({ code: 'MODEL_LOAD_FAILED' });
    expect(c.calls.release).toBe(1);
    expect(await r.detect('Иван', { language: 'ru' })).toHaveLength(1);
    expect(c.calls.create).toBe(2);
  });

  it('dispose освобождает сессию; следующий detect загружает модель заново', async () => {
    const { ort, calls } = fakeOrt();
    const p = createOnnxNerProvider({ files: packFiles().files, ort, modelId: 'm' });
    await p.init();
    p.dispose();
    await Promise.resolve();
    expect(calls.release).toBe(1);
    expect(await p.detect('Иван', { language: 'ru' })).toHaveLength(1);
    expect(calls.create).toBe(2);
  });
});
