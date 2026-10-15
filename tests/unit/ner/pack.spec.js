// Пакет модели NER (WP8, К5): разбор pack.json, сверка файлов с хешами, схема schemas/model-pack.schema.json.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parsePackManifest, verifyPackFiles, packZipName, compareVersions, PACK_ID_RE } from '../../../src/core/ner/pack.js';
import { KNOWN_PACKS, findKnownPack } from '../../../src/core/ner/known-packs.js';
import { createPendingNerProvider } from '../../../src/core/ner/pending-provider.js';
import { sha256Hex } from '../../../src/core/hash.js';
import { sha256Hex as protocolSha } from '../../../src/shared/protocol.js';
import { VALIDATORS } from '../../../src/core/settings.js';
import { createValidator } from '../../helpers/jsonschema.js';

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const schema = load('../../../schemas/model-pack.schema.json');
const valid = load('../../fixtures/ner/pack.valid.json');
const { validate } = createValidator();
const enc = (s) => new TextEncoder().encode(s);
// Содержимое файлов, под которые посчитаны хеши фикстуры pack.valid.json
const FILES = {
  'model.onnx': enc('fake-onnx'),
  'vocab.txt': enc('[PAD]\n[UNK]\n[CLS]\n[SEP]\n'),
  'config.json': enc('{}'),
  LICENSE: enc('MIT'),
  NOTICE: enc('fake notice'),
};
const clone = () => structuredClone(valid);

describe('parsePackManifest', () => {
  it('валидный манифест (объект, JSON-строка, байты) принимается; фикстура проходит JSON Schema', () => {
    expect(parsePackManifest(clone())).toEqual({ ok: true, manifest: valid });
    expect(parsePackManifest(JSON.stringify(valid)).ok).toBe(true);
    expect(parsePackManifest(enc(JSON.stringify(valid))).ok).toBe(true);
    expect(validate(schema, valid)).toEqual([]);
    // recommendedThreshold необязателен
    const m = clone();
    delete m.recommendedThreshold;
    expect(parsePackManifest(m).ok).toBe(true);
    expect(validate(schema, m)).toEqual([]);
  });

  const MUTATIONS = [
    ['kind', (m) => (m.kind = 'something-else'), 'kind'],
    ['schemaVersion 2', (m) => (m.schemaVersion = 2), 'schemaVersion'],
    ['id с /', (m) => (m.id = 'a/b'), 'id'],
    ['id с заглавными', (m) => (m.id = 'Bad Id'), 'id'],
    ['версия не semver', (m) => (m.version = '1.0'), 'version'],
    ['path ../x', (m) => (m.files[0].path = '../x'), 'files[0].path'],
    ['path с каталогом', (m) => (m.files[0].path = 'dir/x'), 'files[0].path'],
    ['path pack.json', (m) => (m.files[0].path = 'pack.json'), 'files[0].path'],
    ['повтор path', (m) => (m.files[1].path = m.files[0].path), 'files[1].path'],
    ['model.file не в files', (m) => (m.model.file = 'other.onnx'), 'model.file'],
    ['vocab не в files', (m) => (m.tokenizer.vocab = 'vocab2.txt'), 'tokenizer.vocab'],
    ['labels[0] !== O', (m) => (m.labels = ['B-PER', 'O']), 'labels'],
    ['неизвестная метка', (m) => m.labels.push('PERSON'), 'labels'],
    ['maxLen 20', (m) => (m.tokenizer.maxLen = 20), 'tokenizer.maxLen'],
    ['maxLen 1024', (m) => (m.tokenizer.maxLen = 1024), 'tokenizer.maxLen'],
    ['stride ≥ maxLen/2', (m) => (m.tokenizer.stride = 64), 'tokenizer.stride'],
    ['tokenizer.type', (m) => (m.tokenizer.type = 'bpe'), 'tokenizer.type'],
    ['лишний ключ в корне', (m) => (m.extra = 1), 'extra'],
    ['лишний ключ в tokenizer', (m) => (m.tokenizer.extra = 1), 'tokenizer.extra'],
    ['sha не hex', (m) => (m.files[0].sha256 = 'z'.repeat(64)), 'files[0].sha256'],
    ['size отрицательный', (m) => (m.files[0].size = -1), 'files[0].size'],
    ['нет license', (m) => delete m.license, 'license'],
    ['task', (m) => (m.task = 'ner'), 'task'],
    ['indexType', (m) => (m.model.indexType = 'float32'), 'model.indexType'],
    ['нет inputs.mask', (m) => delete m.model.inputs.mask, 'model.inputs.mask'],
    ['recommendedThreshold > 1', (m) => (m.recommendedThreshold = 2), 'recommendedThreshold'],
    ['languages пуст', (m) => (m.languages = []), 'languages'],
    ['minExtensionVersion', (m) => (m.minExtensionVersion = 'latest'), 'minExtensionVersion'],
    ['source с объектом', (m) => (m.source.nested = { a: 1 }), 'source.nested'],
  ];
  for (const [name, mutate, field] of MUTATIONS) {
    it(`отклоняет: ${name}`, () => {
      const m = clone();
      mutate(m);
      expect(parsePackManifest(m)).toEqual({ ok: false, error: field });
    });
  }

  it('схема отклоняет те же мутации, что выражаются в JSON Schema', () => {
    // stride < maxLen/2 и связи «model.file ∈ files» схема не выражает — их проверяет только код;
    // prefixItems и additionalProperties-схему не понимает минимальный валидатор тестов (tests/helpers/jsonschema.js)
    const codeOnly = new Set([
      'stride ≥ maxLen/2',
      'model.file не в files',
      'vocab не в files',
      'повтор path',
      'path pack.json',
      'labels[0] !== O',
      'source с объектом',
    ]);
    for (const [name, mutate] of MUTATIONS) {
      if (codeOnly.has(name)) continue;
      const m = clone();
      mutate(m);
      expect(validate(schema, m), name).not.toEqual([]);
    }
  });

  it('source допускает массивы строк (датасеты)', () => {
    const m = clone();
    m.source.data = ['unimelb-nlp/wikiann:ru', 'unimelb-nlp/wikiann:en'];
    expect(parsePackManifest(m).ok).toBe(true);
    expect(validate(schema, m)).toEqual([]);
  });

  it('не JSON → error json; не объект → ошибка корня', () => {
    expect(parsePackManifest('{oops')).toEqual({ ok: false, error: 'json' });
    expect(parsePackManifest(new Uint8Array([0xff, 0xfe]))).toEqual({ ok: false, error: 'json' });
    expect(parsePackManifest([]).ok).toBe(false);
    expect(parsePackManifest(null).ok).toBe(false);
  });

  it('minExtensionVersion сравнивается с версией расширения', () => {
    const m = clone();
    m.minExtensionVersion = '0.2.0';
    expect(parsePackManifest(m, { extensionVersion: '0.1.0' })).toEqual({ ok: false, error: 'minExtensionVersion' });
    expect(parsePackManifest(m, { extensionVersion: '0.2.0' }).ok).toBe(true);
    expect(parsePackManifest(m, { extensionVersion: '1.0.0' }).ok).toBe(true);
    expect(compareVersions('0.10.0', '0.9.1')).toBe(1);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(0);
  });
});

describe('verifyPackFiles', () => {
  it('файлы совпадают с манифестом; pack.json в записях допустим', async () => {
    expect(await verifyPackFiles(valid, { ...FILES, 'pack.json': enc('{}') })).toEqual({ ok: true });
  });
  it('сообщает path для отсутствующего, лишнего, другого размера и другого хеша', async () => {
    const noNotice = { ...FILES };
    delete noNotice.NOTICE;
    expect(await verifyPackFiles(valid, noNotice)).toEqual({ ok: false, error: 'MISSING_FILE', path: 'NOTICE' });
    expect(await verifyPackFiles(valid, { ...FILES, 'evil.bin': enc('x') })).toEqual({ ok: false, error: 'EXTRA_FILE', path: 'evil.bin' });
    expect(await verifyPackFiles(valid, { ...FILES, 'dir/': new Uint8Array() })).toEqual({ ok: false, error: 'EXTRA_FILE', path: 'dir/' });
    expect(await verifyPackFiles(valid, { ...FILES, 'model.onnx': enc('fake-onnx!') })).toEqual({ ok: false, error: 'SIZE_MISMATCH', path: 'model.onnx' });
    expect(await verifyPackFiles(valid, { ...FILES, 'model.onnx': enc('FAKE-ONNX') })).toEqual({ ok: false, error: 'HASH_MISMATCH', path: 'model.onnx' });
  });
  it('принимает свою функцию хеширования', async () => {
    const seen = [];
    const r = await verifyPackFiles(valid, FILES, {
      digest: async (b) => {
        seen.push(b.length);
        return sha256Hex(b);
      },
    });
    expect(r.ok).toBe(true);
    expect(seen).toHaveLength(valid.files.length);
  });
});

describe('прочее', () => {
  it('packZipName', () => {
    expect(packZipName(valid)).toBe('docx-anonymizer-ner-fixture-ner-ruen-1.0.0.zip');
  });
  it('sha256Hex: ядро и реэкспорт протокола — одна функция', async () => {
    expect(protocolSha).toBe(sha256Hex);
    expect(await sha256Hex(enc('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('KNOWN_PACKS: формат записей; неизвестный хеш → null', () => {
    for (const p of KNOWN_PACKS) {
      expect(p.id).toMatch(PACK_ID_RE);
      expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(findKnownPack('0'.repeat(64))).toBeNull();
  });
  it('валидатор настройки nerModel совпадает с PACK_ID_RE', () => {
    for (const id of ['ab', 'rubert-tiny2-ner-ruen', 'a'.repeat(41), 'a'.repeat(42), 'a', '-ab', 'Ab', 'a_b', 'a/b']) {
      expect(VALIDATORS.nerModel(id), id).toBe(PACK_ID_RE.test(id));
    }
  });
  it('временный провайдер (до WP9): init читает pack.json и сообщает MODEL_LOAD_FAILED', async () => {
    const reads = [];
    const files = {
      read: async (p) => {
        reads.push(p);
        return enc(JSON.stringify(valid));
      },
    };
    const p = createPendingNerProvider({ files, modelId: valid.id });
    await expect(p.init()).rejects.toMatchObject({ code: 'MODEL_LOAD_FAILED' });
    expect(reads).toEqual(['pack.json']);
    const broken = createPendingNerProvider({ files: { read: async () => Promise.reject(new Error('нет файла')) }, modelId: 'x1' });
    await expect(broken.init()).rejects.toMatchObject({ code: 'MODEL_LOAD_FAILED' });
    expect(await p.detect('Иванов', { language: 'ru' })).toEqual([]);
  });
});
