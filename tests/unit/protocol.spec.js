import { describe, it, expect } from 'vitest';
import {
  MSG,
  CHUNK_CHARS,
  bytesToBase64,
  base64ToBytes,
  splitBase64,
  ChunkAssembler,
  postChunked,
  createClient,
  base64DecodedLength,
} from '../../src/shared/protocol.js';

/** Пара связанных фейковых портов */
function portPair() {
  const mk = () => ({ listeners: [], dl: [], onMessage: null, onDisconnect: null });
  const a = mk();
  const b = mk();
  const wire = (self, other) => ({
    postMessage: (m) => queueMicrotask(() => other.listeners.forEach((f) => f(structuredClone(m)))),
    onMessage: { addListener: (f) => self.listeners.push(f) },
    onDisconnect: { addListener: (f) => self.dl.push(f) },
    disconnect: () => other.dl.forEach((f) => f()),
  });
  return [wire(a, b), wire(b, a)];
}

describe('protocol: base64 и чанки', () => {
  it('bytesToBase64 ⇄ base64ToBytes на случайных данных', () => {
    const bytes = new Uint8Array(200001).map((_, i) => (i * 7919) & 255);
    const b64 = bytesToBase64(bytes);
    expect(b64).toBe(Buffer.from(bytes).toString('base64'));
    expect(Buffer.from(/** @type {Uint8Array} */ (base64ToBytes(b64))).equals(Buffer.from(bytes))).toBe(true);
    expect(base64DecodedLength(b64)).toBe(bytes.length);
  });

  it('чанки кратны 4 и собираются в буфер фиксированного размера', () => {
    const bytes = new Uint8Array(CHUNK_CHARS * 2).map((_, i) => i & 255); // > 2 чанков base64
    const msgs = [];
    const n = postChunked((m) => msgs.push(m), { requestId: 'r1', kind: 'FILE', bytes, meta: { name: 'a.docx' } });
    expect(n).toBe(3);
    expect(msgs[0]).toMatchObject({ type: 'FILE_BEGIN', requestId: 'r1', size: bytes.length, chunks: 3, name: 'a.docx' });
    const asm = new ChunkAssembler(msgs[0]);
    // порядок прихода не важен
    for (const m of [msgs[3], msgs[1], msgs[2]]) asm.add(m.index, m.data);
    expect(asm.complete).toBe(true);
    expect(Buffer.from(asm.result()).equals(Buffer.from(bytes))).toBe(true);
  });

  it('ошибки сборки: повтор, лишний индекс, неполный файл', () => {
    const asm = new ChunkAssembler({ size: 3, chunks: 1 });
    expect(() => asm.result()).toThrow();
    asm.add(0, 'AAAA');
    expect(() => asm.add(0, 'AAAA')).toThrow();
    expect(() => asm.add(1, 'AAAA')).toThrow();
    expect(splitBase64('')).toEqual(['']);
  });
});

describe('protocol: клиент', () => {
  it('analyzeFile → ENTITIES с прогрессом; apply → байты из RESULT_*; ERROR → reject', async () => {
    const [clientPort, serverPort] = portPair();
    const received = [];
    let asm;
    serverPort.onMessage.addListener((m) => {
      received.push(m.type);
      if (m.type === MSG.FILE_BEGIN) asm = new ChunkAssembler(m);
      if (m.type === MSG.FILE_CHUNK) asm.add(m.index, m.data);
      if (m.type === MSG.ANALYZE) {
        serverPort.postMessage({ type: MSG.PROGRESS, requestId: m.requestId, stage: 'detect', percent: 50 });
        serverPort.postMessage({ type: MSG.ENTITIES, requestId: m.requestId, docId: 'd1', entities: [], stats: { size: asm.result().length } });
      }
      if (m.type === MSG.APPLY) {
        postChunked((x) => serverPort.postMessage(x), {
          requestId: m.requestId,
          kind: 'RESULT',
          bytes: new Uint8Array([1, 2, 3]),
          meta: { name: 'a.anon.docx' },
        });
        serverPort.postMessage({ type: MSG.RESULT_END, requestId: m.requestId, mapping: { entries: [] } });
      }
      if (m.type === MSG.DEANON) serverPort.postMessage({ type: MSG.ERROR, requestId: m.requestId, code: 'INTERNAL', message: 'нет маппинга' });
    });
    const client = createClient(clientPort);
    const stages = [];
    const ent = await client.analyzeFile({ name: 'a.docx', bytes: new Uint8Array([9, 8, 7, 6]), onProgress: (s, p) => stages.push(`${s}:${p}`) });
    expect(ent).toMatchObject({ type: 'ENTITIES', docId: 'd1', stats: { size: 4 } });
    expect(stages).toEqual(['detect:50']);
    const res = await client.apply({ docId: 'd1', decisions: [] });
    expect([...res.bytes]).toEqual([1, 2, 3]);
    expect(res.name).toBe('a.anon.docx');
    await expect(client.request(MSG.DEANON, { text: 'x' })).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(received).toEqual(['FILE_BEGIN', 'FILE_CHUNK', 'ANALYZE', 'APPLY', 'DEANON']);
    expect(client.pendingCount).toBe(0);
  });

  it('разрыв порта → HOST_UNAVAILABLE для ожидающих запросов', async () => {
    const [clientPort, serverPort] = portPair();
    const client = createClient(clientPort);
    const p = client.request(MSG.LIST_SESSIONS);
    serverPort.disconnect();
    await expect(p).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
  });
});

describe('protocol: GET_MAPPING / MAPPING (WP10-B)', () => {
  it('request(GET_MAPPING) резолвится на терминальном MAPPING; тип есть в схеме', async () => {
    const { readFileSync } = await import('node:fs');
    const { TERMINAL } = await import('../../src/shared/protocol.js');
    expect(TERMINAL.has(MSG.MAPPING)).toBe(true);
    const [clientPort, serverPort] = portPair();
    serverPort.onMessage.addListener((m) => {
      if (m.type === MSG.GET_MAPPING) serverPort.postMessage({ type: MSG.MAPPING, requestId: m.requestId, docId: m.docId, mapping: { entries: [] } });
    });
    const client = createClient(clientPort);
    const r = await client.request(MSG.GET_MAPPING, { docId: 'd1' });
    expect(r).toMatchObject({ type: 'MAPPING', docId: 'd1', mapping: { entries: [] } });
    expect(client.pendingCount).toBe(0);
    const schema = JSON.parse(readFileSync(new URL('../../schemas/protocol.schema.json', import.meta.url), 'utf8'));
    for (const t of ['GET_MAPPING', 'MAPPING']) {
      expect(schema.$defs[t].properties.type.const).toBe(t);
      expect(schema.oneOf).toContainEqual({ $ref: `#/$defs/${t}` });
    }
  });
});

describe('protocol: MODEL_CHANGED (WP8)', () => {
  it('тип есть в MSG и в схеме протокола; ответ — терминальный ACK', async () => {
    const { readFileSync } = await import('node:fs');
    const { TERMINAL } = await import('../../src/shared/protocol.js');
    expect(MSG.MODEL_CHANGED).toBe('MODEL_CHANGED');
    expect(TERMINAL.has(MSG.ACK)).toBe(true);
    const schema = JSON.parse(readFileSync(new URL('../../schemas/protocol.schema.json', import.meta.url), 'utf8'));
    expect(schema.$defs.MODEL_CHANGED.properties.type.const).toBe('MODEL_CHANGED');
    expect(schema.oneOf).toContainEqual({ $ref: '#/$defs/MODEL_CHANGED' });
  });
});

describe('protocol: встроенная модель NER (WP10-C)', () => {
  it('MODEL_BOOTSTRAP, MODEL_INSTALL, MODEL_INSTALLED объявлены и есть в схеме; MODEL_INSTALLED терминальный', async () => {
    const { readFileSync } = await import('node:fs');
    const { TERMINAL } = await import('../../src/shared/protocol.js');
    const schema = JSON.parse(readFileSync(new URL('../../schemas/protocol.schema.json', import.meta.url), 'utf8'));
    for (const t of ['MODEL_BOOTSTRAP', 'MODEL_INSTALL', 'MODEL_INSTALLED']) {
      expect(MSG[t]).toBe(t);
      expect(schema.$defs[t].properties.type.const).toBe(t);
      expect(schema.oneOf).toContainEqual({ $ref: `#/$defs/${t}` });
    }
    expect(TERMINAL.has('MODEL_INSTALLED')).toBe(true);
    expect(TERMINAL.has('MODEL_INSTALL')).toBe(false);
  });
});
