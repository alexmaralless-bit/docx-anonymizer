// Схемы schemas/*.json: маппинг и все сообщения протокола (в обе стороны), пойманные на реальном прогоне хоста.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHost } from '../../src/offscreen/host.js';
import { MSG, postChunked } from '../../src/shared/protocol.js';
import { buildFixtures } from '../../scripts/gen-fixtures.mjs';
import { buildSampleDocx } from '../../scripts/make-sample.mjs';
import { defaultSettings, mergeMappings } from '../../src/core/index.js';
import { createValidator } from '../helpers/jsonschema.js';
import { anonymize } from './support/pipeline.js';

const load = (n) => JSON.parse(readFileSync(new URL(`../../schemas/${n}`, import.meta.url), 'utf8'));
const mappingSchema = load('mapping.schema.json');
const protocolSchema = load('protocol.schema.json');
const { validate } = createValidator({ 'mapping.schema.json': mappingSchema, 'protocol.schema.json': protocolSchema });
const checkMapping = (m) => validate(mappingSchema, m);
/** Сообщение валидно по схеме своего типа И по корневой oneOf. */
const checkMessage = (m) => [...validate({ $ref: `#/$defs/${m.type}` }, m, protocolSchema), ...validate(protocolSchema, m)];

describe('schemas/mapping.schema.json', () => {
  it('маппинги всех фикстур (placeholder / mask / delete) валидны', async () => {
    for (const f of buildFixtures()) {
      for (const mode of ['placeholder', 'mask', 'delete']) {
        const { mapping } = await anonymize(f.bytes, { gold: f.gold, apply: { mode } });
        expect(checkMapping(mapping), `${f.name}/${mode}`).toEqual([]);
      }
    }
  });

  it('склеенный маппинг нескольких файлов валиден', async () => {
    const [a, b] = buildFixtures();
    const ma = (await anonymize(a.bytes, { gold: a.gold })).mapping;
    const mb = (await anonymize(b.bytes, { gold: b.gold })).mapping;
    expect(checkMapping(mergeMappings([ma, mb]))).toEqual([]);
  });

  it('отвергает испорченные маппинги', async () => {
    const { mapping } = await anonymize(buildFixtures()[0].bytes, { gold: buildFixtures()[0].gold });
    const clone = () => structuredClone(mapping);
    const bad = [
      (m) => delete m.entries[0].token,
      (m) => (m.schemaVersion = 2),
      (m) => (m.mode = 'redact'),
      (m) => (m.entries[0].occurrences = 0),
      (m) => (m.entries[0].extra = 1),
      (m) => (m.createdAt = 'вчера'),
      (m) => (m.documents = []),
      (m) => (m.entries[0].variants = 'нет'),
    ];
    for (const [i, mutate] of bad.entries()) {
      const m = clone();
      mutate(m);
      expect(checkMapping(m), `мутация ${i}`).not.toEqual([]);
    }
  });
});

describe('schemas/protocol.schema.json', () => {
  it('все сообщения полного сценария хоста валидны (клиент → хост и хост → клиент)', async () => {
    const out = [];
    const sent = [];
    const host = createHost({ post: (_c, msg) => out.push(msg) });
    const settings = defaultSettings();
    const send = async (msg) => {
      sent.push(msg); // это то, что шлёт клиент (без добавляемого background поля settings)
      await host.handle('c1', { settings, ...msg });
    };
    const { bytes } = buildSampleDocx();
    const upload = async (requestId, data, name) => {
      const msgs = [];
      postChunked((m) => msgs.push(m), { requestId, kind: 'FILE', bytes: data, meta: { name, sha256: null, origin: 'http://test.invalid' } });
      for (const m of msgs) await send(m);
      await send({ type: MSG.ANALYZE, requestId });
    };

    await send({ type: MSG.BATCH_BEGIN, requestId: 'b1', batchId: 'batch-1' });
    await upload('r1', bytes, 'договор.docx');
    const ent = out.find((m) => m.type === MSG.ENTITIES);
    expect(ent.entities.length).toBeGreaterThan(0);
    await send({ type: MSG.GET_TEXT, requestId: 'r2', docId: ent.docId, from: 0, count: 5 });
    await send({ type: MSG.ADD_ENTITY, requestId: 'r3', docId: ent.docId, category: 'COMPANY', text: 'Ромашка', replaceAll: true });
    const ent2 = out.filter((m) => m.type === MSG.ENTITIES).pop();
    await send({
      type: MSG.APPLY,
      requestId: 'r4',
      docId: ent.docId,
      mode: 'placeholder',
      decisions: [{ entityId: ent2.entities[0].id, action: 'skip' }],
      options: { keepMetadata: false },
    });
    const end = out.find((m) => m.type === MSG.RESULT_END);
    await send({ type: MSG.DEANON, requestId: 'r5', mappingRef: ent.docId, text: 'Пишите на [EMAIL_1] и [EMAIL_99]' });
    await send({ type: MSG.DEANON, requestId: 'r6', mappingRef: end.mapping, text: '[EMAIL_1]' });
    await send({ type: MSG.LIST_SESSIONS, requestId: 'r7' });
    await upload('e1', new TextEncoder().encode('это не docx, а просто текст достаточной длины'), 'x.docx');
    await send({ type: MSG.CATALOG_CHANGED, requestId: 'c1' });
    await send({ type: MSG.CANCEL, requestId: 'cx' });
    await send({ type: MSG.DISCARD, requestId: 'd1', docId: ent.docId });
    await send({ type: MSG.BATCH_END, requestId: 'b2', batchId: 'batch-1' });

    const types = new Set([...out, ...sent].map((m) => m.type));
    for (const t of [
      'FILE_BEGIN',
      'FILE_CHUNK',
      'ANALYZE',
      'PROGRESS',
      'ENTITIES',
      'TEXT',
      'RESULT_BEGIN',
      'RESULT_CHUNK',
      'RESULT_END',
      'DEANON_RESULT',
      'SESSIONS',
      'ERROR',
      'ACK',
      'APPLY',
      'DEANON',
      'ADD_ENTITY',
      'GET_TEXT',
    ]) {
      expect(types.has(t), `в прогоне нет ${t}`).toBe(true);
    }
    for (const m of [...sent, ...out]) expect(checkMessage(m), `${m.type}`).toEqual([]);
    expect(JSON.stringify(out.filter((m) => m.type === MSG.SESSIONS))).not.toContain('@');
  });

  it('отвергает испорченные сообщения', () => {
    const base = { type: 'FILE_BEGIN', requestId: 'r1', name: 'a.docx', size: 10, chunks: 1 };
    expect(checkMessage(base)).toEqual([]);
    for (const bad of [
      { ...base, size: -1 },
      { ...base, chunks: 0 },
      { ...base, name: undefined },
      { type: 'ERROR', requestId: 'r', code: 'WEIRD', message: 'x' },
      { type: 'PROGRESS', requestId: 'r', stage: 'почему-то', percent: 5 },
      { type: 'PROGRESS', requestId: 'r', stage: 'parse', percent: 120 },
      { type: 'RESULT_CHUNK', requestId: 'r', index: 0, data: 'не base64!' },
      { type: 'UNKNOWN', requestId: 'r' },
    ]) {
      expect(validate(protocolSchema, bad), JSON.stringify(bad)).not.toEqual([]);
    }
  });
});
