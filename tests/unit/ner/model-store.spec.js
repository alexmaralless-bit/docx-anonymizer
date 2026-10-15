// Хранилище пакетов модели NER (WP8, К5) на поддельном OPFS: разбор zip в Map (имена свойств прототипа, __proto__,
// повторы), зарезервированные имена, предел размера, слоты переустановки — сбой записи оставляет прежнюю версию рабочей.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { zipSync, strToU8, strFromU8 } from 'fflate';
import * as store from '../../../src/shared/model-store.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const named = (name) => Object.assign(new Error(name), { name });

/** Поддельный OPFS: каталоги и файлы в памяти; fail.write/fail.remove — имя, на котором бросить. */
const fail = { write: null, remove: null };
class Dir {
  kind = 'directory';
  constructor(name) {
    this.name = name;
    this.c = new Map();
  }
  async getDirectoryHandle(n, o = {}) {
    let d = this.c.get(n);
    if (d && d.kind !== 'directory') throw named('TypeMismatchError');
    if (!d) {
      if (!o.create) throw named('NotFoundError');
      d = new Dir(n);
      this.c.set(n, d);
    }
    return d;
  }
  async getFileHandle(n, o = {}) {
    let f = this.c.get(n);
    if (f && f.kind !== 'file') throw named('TypeMismatchError');
    if (!f) {
      if (!o.create) throw named('NotFoundError');
      f = new FileH(n);
      this.c.set(n, f);
    }
    return f;
  }
  async removeEntry(n, o = {}) {
    const e = this.c.get(n);
    if (!e) throw named('NotFoundError');
    if (fail.remove === n) throw named('InvalidStateError');
    if (e.kind === 'directory' && e.c.size && !o.recursive) throw named('InvalidModificationError');
    this.c.delete(n);
  }
  async *entries() {
    yield* [...this.c];
  }
}
class FileH {
  kind = 'file';
  constructor(n) {
    this.name = n;
    this.data = new Uint8Array();
  }
  async createWritable() {
    const self = this;
    let pending = null;
    return {
      async write(b) {
        if (fail.write === self.name) throw named('QuotaExceededError');
        pending = new Uint8Array(b);
      },
      async close() {
        if (pending) self.data = pending; // как в OPFS: содержимое меняется только при close()
      },
      async abort() {},
    };
  }
  async getFile() {
    const d = this.data;
    return { size: d.length, text: async () => strFromU8(d), arrayBuffer: async () => d.slice().buffer };
  }
}

let root;
const hadStorage = Object.getOwnPropertyDescriptor(globalThis.navigator, 'storage');
beforeEach(() => {
  root = new Dir('');
  fail.write = fail.remove = null;
  Object.defineProperty(globalThis.navigator, 'storage', { value: { getDirectory: async () => root }, configurable: true });
});
afterAll(() => {
  if (hadStorage) Object.defineProperty(globalThis.navigator, 'storage', hadStorage);
  else delete globalThis.navigator.storage;
});

const models = () => root.c.get('models');
const slots = () => [...(models()?.c.keys() ?? [])].sort();

function packFiles(version = '1.0.0') {
  return {
    'model.onnx': new Uint8Array(1000).map((_, i) => (i + version.length * 7) & 0xff),
    'vocab.txt': strToU8(`[PAD]\n[UNK]\n[CLS]\n[SEP]\nv${version}\n`),
    LICENSE: strToU8('MIT'),
  };
}
function manifestFor(files, { id = 'store-pack', version = '1.0.0' } = {}) {
  return {
    kind: 'docx-anonymizer-model-pack',
    schemaVersion: 1,
    id,
    version,
    name: { ru: 'Тест', en: 'Test' },
    languages: ['ru'],
    task: 'token-classification',
    labels: ['O', 'B-PER', 'I-PER'],
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
    model: { file: 'model.onnx', inputs: { ids: 'input_ids', mask: 'attention_mask' }, output: 'logits', indexType: 'int64' },
    files: Object.entries(files).map(([path, b]) => ({ path, sha256: sha(b), size: b.length })),
    license: 'MIT',
    source: {},
    minExtensionVersion: '0.1.0',
  };
}
function pack(opts = {}) {
  const files = packFiles(opts.version);
  const manifest = manifestFor(files, opts);
  opts.mutate?.(manifest, files);
  return { manifest, files, zip: zipSync({ 'pack.json': strToU8(JSON.stringify(manifest)), ...files }) };
}

/**
 * zip без сжатия, собранный вручную: позволяет повторяющиеся имена, запись `__proto__` и «врущий» центральный каталог.
 * @param {{name: string, data: Uint8Array, cdSize?: number}[]} entries  cdSize — распакованный размер в центральном каталоге
 */
function rawZip(entries) {
  const enc = new TextEncoder();
  const parts = [];
  const cd = [];
  let off = 0;
  for (const e of entries) {
    const n = enc.encode(e.name);
    const lh = new Uint8Array(30 + n.length);
    const v = new DataView(lh.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint32(18, e.data.length, true);
    v.setUint32(22, e.data.length, true);
    v.setUint16(26, n.length, true);
    lh.set(n, 30);
    const ch = new Uint8Array(46 + n.length);
    const c = new DataView(ch.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint32(20, e.data.length, true);
    c.setUint32(24, e.cdSize ?? e.data.length, true);
    c.setUint16(28, n.length, true);
    c.setUint32(42, off, true);
    ch.set(n, 46);
    parts.push(lh, e.data);
    cd.push(ch);
    off += lh.length + e.data.length;
  }
  const cdLen = cd.reduce((a, b) => a + b.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdLen, true);
  ev.setUint32(16, off, true);
  const all = [...parts, ...cd, eocd];
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let p = 0;
  for (const a of all) {
    out.set(a, p);
    p += a.length;
  }
  return out;
}
const rawPack = (p, extra = []) =>
  rawZip([{ name: 'pack.json', data: strToU8(JSON.stringify(p.manifest)) }, ...Object.entries(p.files).map(([name, data]) => ({ name, data })), ...extra]);

const rejects = (promise) =>
  promise.then(
    () => {
      throw new Error('ожидалась ошибка');
    },
    (e) => e,
  );

describe('model-store: разбор и проверка пакета', () => {
  it('корректный пакет: inspectPack ничего не пишет, install кладёт файлы в слот <id>', async () => {
    const p = pack();
    const info = await store.inspectPack(p.zip);
    expect(info).toMatchObject({ manifest: { id: 'store-pack', version: '1.0.0' }, verified: false, bytes: 1000 + p.files['vocab.txt'].length + 3 });
    expect(root.c.size).toBe(0);
    const rec = await store.install(p.zip);
    expect(rec).toMatchObject({ id: 'store-pack', version: '1.0.0', verified: false });
    expect(slots()).toEqual(['store-pack']);
    expect([...models().c.get('store-pack').c.keys()].sort()).toEqual(['LICENSE', 'installed.json', 'model.onnx', 'pack.json', 'vocab.txt']);
    expect(await store.readFile('store-pack', 'model.onnx')).toEqual(p.files['model.onnx']);
    expect((await store.listInstalled()).map((m) => [m.id, m.version])).toEqual([['store-pack', '1.0.0']]);
  });

  it('объявлен файл с именем свойства прототипа, которого нет в zip → BAD_MANIFEST MISSING_FILE, не TypeError', async () => {
    for (const path of ['hasOwnProperty', 'toString', 'valueOf']) {
      const p = pack({ mutate: (m) => m.files.push({ path, sha256: sha(new Uint8Array()), size: 1 }) });
      const e = await rejects(store.inspectPack(p.zip));
      expect(e, path).toMatchObject({ name: 'ModelStoreError', code: 'BAD_MANIFEST', details: { path, reason: 'MISSING_FILE' } });
    }
  });

  it('запись zip __proto__/constructor/prototype и служебные имена → BAD_MANIFEST EXTRA_FILE', async () => {
    for (const name of ['__proto__', 'constructor', 'prototype', 'installed.json', 'INSTALLED.JSON', 'PACK.JSON']) {
      const e = await rejects(store.inspectPack(rawPack(pack(), [{ name, data: strToU8('{"verified":true}') }])));
      expect(e, name).toMatchObject({ code: 'BAD_MANIFEST', details: { path: name, reason: 'EXTRA_FILE' } });
    }
    expect(root.c.size).toBe(0);
  });

  it('повторяющаяся запись zip (вторая копия подменена или честная) → BAD_MANIFEST DUPLICATE_ENTRY', async () => {
    const p = pack();
    const bad = p.files['model.onnx'].map((x) => x ^ 1);
    for (const data of [bad, p.files['model.onnx']]) {
      const e = await rejects(store.inspectPack(rawPack(p, [{ name: 'model.onnx', data }])));
      expect(e).toMatchObject({ code: 'BAD_MANIFEST', details: { path: 'model.onnx', reason: 'DUPLICATE_ENTRY' } });
    }
  });

  it('pack.json объявляет зарезервированное имя → BAD_MANIFEST по полю files[i].path', async () => {
    for (const path of ['installed.json', '__proto__', 'constructor', 'Pack.json']) {
      const p = pack({ mutate: (m) => m.files.push({ path, sha256: sha(strToU8('x')), size: 1 }) });
      const e = await rejects(store.inspectPack(p.zip));
      expect(e, path).toMatchObject({ code: 'BAD_MANIFEST', details: { field: 'files[3].path' } });
    }
  });

  it('больше 512 МБ по центральному каталогу → TOO_LARGE (не BAD_ZIP), ничего не распаковано', async () => {
    const p = pack();
    const big = rawZip([
      { name: 'pack.json', data: strToU8(JSON.stringify(p.manifest)) },
      { name: 'model.onnx', data: p.files['model.onnx'], cdSize: store.MAX_PACK_BYTES },
    ]);
    expect(await rejects(store.inspectPack(big))).toMatchObject({ code: 'TOO_LARGE' });
    // сумма по нескольким записям тоже считается
    const half = store.MAX_PACK_BYTES / 2 + 1;
    const sum = rawZip([
      { name: 'a', data: new Uint8Array(1), cdSize: half },
      { name: 'b', data: new Uint8Array(1), cdSize: half },
    ]);
    expect(await rejects(store.inspectPack(sum))).toMatchObject({ code: 'TOO_LARGE' });
    expect(await rejects(store.inspectPack(strToU8('не zip')))).toMatchObject({ code: 'BAD_ZIP' });
    expect(store.MODEL_STORE_ERROR_CODES).toContain('TOO_LARGE');
  });
});

describe('model-store: переустановка через слоты', () => {
  it('сбой записи при переустановке оставляет прежнюю модель рабочей', async () => {
    const v1 = pack({ version: '1.0.0' });
    await store.install(v1.zip);
    fail.write = 'model.onnx';
    const e = await rejects(store.install(pack({ version: '1.1.0' }).zip));
    expect(e).toMatchObject({ code: 'QUOTA' });
    fail.write = null;
    expect(slots()).toEqual(['store-pack']); // недописанный слот удалён
    expect((await store.listInstalled()).map((m) => m.version)).toEqual(['1.0.0']);
    expect(await store.readFile('store-pack', 'model.onnx')).toEqual(v1.files['model.onnx']);
    expect(strFromU8(await store.readFile('store-pack', 'vocab.txt'))).toContain('v1.0.0');
    expect((await store.getManifest('store-pack')).version).toBe('1.0.0');
  });

  it('сбой записи и сбой очистки: недописанный слот с маркером не активен, прежняя версия читается', async () => {
    await store.install(pack({ version: '1.0.0' }).zip);
    fail.write = 'vocab.txt';
    fail.remove = 'store-pack.1';
    await rejects(store.install(pack({ version: '1.1.0' }).zip));
    fail.write = fail.remove = null;
    expect(slots()).toEqual(['store-pack', 'store-pack.1']);
    expect(models().c.get('store-pack.1').c.has('.installing')).toBe(true);
    expect((await store.listInstalled()).map((m) => m.version)).toEqual(['1.0.0']);
    expect(strFromU8(await store.readFile('store-pack', 'vocab.txt'))).toContain('v1.0.0');
    // свежая незавершённая установка не вычищается (может идти в другой вкладке)…
    expect(slots()).toEqual(['store-pack', 'store-pack.1']);
    // …а брошенная (маркер старше 10 минут) — вычищается
    const marker = models().c.get('store-pack.1').c.get('.installing');
    marker.data = strToU8(String(Date.now() - 11 * 60 * 1000));
    await store.listInstalled();
    expect(slots()).toEqual(['store-pack']);
  });

  it('успешная переустановка: новый слот активен, прежний удалён; следующая — снова в <id>', async () => {
    await store.install(pack({ version: '1.0.0' }).zip);
    const v2 = pack({ version: '1.1.0' });
    await store.install(v2.zip);
    expect(slots()).toEqual(['store-pack.1']);
    expect((await store.listInstalled()).map((m) => m.version)).toEqual(['1.1.0']);
    expect(await store.readFile('store-pack', 'model.onnx')).toEqual(v2.files['model.onnx']);
    await store.install(pack({ version: '1.2.0' }).zip);
    expect(slots()).toEqual(['store-pack']);
    expect((await store.getManifest('store-pack')).version).toBe('1.2.0');
  });

  it('не удалось удалить прежний слот после переключения: активна новая версия, listInstalled дочищает старую', async () => {
    await store.install(pack({ version: '1.0.0' }).zip);
    fail.remove = 'store-pack';
    await store.install(pack({ version: '1.1.0' }).zip);
    fail.remove = null;
    expect(slots()).toEqual(['store-pack', 'store-pack.1']);
    expect((await store.getManifest('store-pack')).version).toBe('1.1.0');
    expect((await store.listInstalled()).map((m) => m.version)).toEqual(['1.1.0']);
    expect(slots()).toEqual(['store-pack.1']);
  });

  it('remove удаляет оба слота; readFile при незавершённой установке → NOT_INSTALLED', async () => {
    await store.install(pack().zip);
    fail.remove = 'store-pack';
    await store.install(pack({ version: '2.0.0' }).zip);
    fail.remove = null;
    await store.remove('store-pack');
    expect(slots()).toEqual([]);
    expect(await store.listInstalled()).toEqual([]);
    fail.write = 'LICENSE';
    fail.remove = 'store-pack';
    await rejects(store.install(pack().zip));
    fail.write = fail.remove = null;
    expect(await rejects(store.readFile('store-pack', 'pack.json'))).toMatchObject({ code: 'NOT_INSTALLED', message: 'Пакет ещё устанавливается' });
    expect(await store.getManifest('store-pack')).toBeNull();
  });
});
