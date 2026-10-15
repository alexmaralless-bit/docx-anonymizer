// Упаковщик пакета модели NER (WP8): npm run pack:model. Временный models-src с фейковыми файлами — сети и модели не нужно.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildModelPack } from '../../scripts/pack-model.mjs';
import { parsePackManifest, verifyPackFiles } from '../../src/core/ner/pack.js';
import { createValidator } from '../helpers/jsonschema.js';

const schema = JSON.parse(readFileSync(new URL('../../schemas/model-pack.schema.json', import.meta.url), 'utf8'));
const fixture = JSON.parse(readFileSync(new URL('../fixtures/ner/pack.valid.json', import.meta.url), 'utf8'));
const ID = 'fake-ner';
let tmp;
let srcRoot;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'docx-anon-pack-model-'));
  srcRoot = join(tmp, 'models-src');
  const dir = join(srcRoot, ID);
  mkdirSync(dir, { recursive: true });
  const src = { ...fixture };
  delete src.files;
  writeFileSync(join(dir, 'pack.src.json'), JSON.stringify({ ...src, id: ID, version: '0.0.1' }, null, 2));
  const onnx = new Uint8Array(1024).map((_, i) => (i * 31 + 7) & 0xff);
  writeFileSync(join(dir, 'model.onnx'), onnx);
  writeFileSync(join(dir, 'vocab.txt'), '[PAD]\n[UNK]\n[CLS]\n[SEP]\nиванов\n##а\n');
  writeFileSync(join(dir, 'config.json'), '{"model_type":"bert"}');
  writeFileSync(join(dir, 'LICENSE'), 'MIT License (test)');
  writeFileSync(join(dir, 'NOTICE'), 'Test notice');
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('scripts/pack-model.mjs', () => {
  it('собирает пакет: имя, валидный pack.json, 5 файлов с верными sha256/size; две сборки побайтно равны', async () => {
    const a = buildModelPack({ srcDir: join(srcRoot, ID), outDir: join(tmp, 'out-a') });
    const b = buildModelPack({ srcDir: join(srcRoot, ID), outDir: join(tmp, 'out-b') });
    expect(a.name).toBe(`docx-anonymizer-ner-${ID}-0.0.1.zip`);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(b.sha256).toBe(a.sha256);
    expect(readFileSync(b.file).equals(readFileSync(a.file))).toBe(true);
    expect(createHash('sha256').update(readFileSync(a.file)).digest('hex')).toBe(a.sha256);

    const zip = unzipSync(new Uint8Array(readFileSync(a.file)));
    expect(Object.keys(zip).sort()).toEqual(['LICENSE', 'NOTICE', 'config.json', 'model.onnx', 'pack.json', 'vocab.txt']);
    const manifest = JSON.parse(strFromU8(zip['pack.json']));
    expect(parsePackManifest(manifest).ok).toBe(true);
    expect(createValidator().validate(schema, manifest)).toEqual([]);
    expect(manifest.files).toHaveLength(5);
    for (const f of manifest.files) {
      expect(zip[f.path].length, f.path).toBe(f.size);
      expect(createHash('sha256').update(zip[f.path]).digest('hex'), f.path).toBe(f.sha256);
    }
    expect(manifest.files.find((f) => f.path === 'model.onnx').size).toBe(1024);
    expect(await verifyPackFiles(manifest, zip)).toEqual({ ok: true });
  });

  it('CLI: отсутствующий каталог → ненулевой код; без --id → код 2; успешный запуск печатает sha256', () => {
    const run = (...args) => spawnSync(process.execPath, ['scripts/pack-model.mjs', ...args], { encoding: 'utf8' });
    const missing = run('--id=nope', `--src=${srcRoot}`, `--out=${join(tmp, 'cli')}`);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('nope');
    expect(run().status).toBe(2);
    const ok = run(`--id=${ID}`, `--src=${srcRoot}`, `--out=${join(tmp, 'cli')}`);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/sha256 [0-9a-f]{64}/);
  });

  it('неверный pack.src.json (stride ≥ maxLen/2, лишний files, вложенный каталог) — ошибка', () => {
    const bad = join(tmp, 'bad');
    mkdirSync(bad, { recursive: true });
    const src = { ...fixture };
    delete src.files;
    writeFileSync(join(bad, 'model.onnx'), 'x');
    writeFileSync(join(bad, 'vocab.txt'), 'x');
    writeFileSync(join(bad, 'pack.src.json'), JSON.stringify({ ...src, tokenizer: { ...src.tokenizer, stride: 64 } }));
    expect(() => buildModelPack({ srcDir: bad, outDir: join(tmp, 'bad-out') })).toThrow(/tokenizer\.stride/);
    writeFileSync(join(bad, 'pack.src.json'), JSON.stringify(fixture));
    expect(() => buildModelPack({ srcDir: bad, outDir: join(tmp, 'bad-out') })).toThrow(/files/);
    writeFileSync(join(bad, 'pack.src.json'), JSON.stringify(src));
    mkdirSync(join(bad, 'sub'));
    expect(() => buildModelPack({ srcDir: bad, outDir: join(tmp, 'bad-out') })).toThrow(/каталог/);
  });
});
