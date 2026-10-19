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
import { extractPdfNode } from './support/pdf.js';

const load = (n) => JSON.parse(readFileSync(new URL(`../../schemas/${n}`, import.meta.url), 'utf8'));
const mappingSchema = load('mapping.schema.json');
const protocolSchema = load('protocol.schema.json');
const { validate } = createValidator({ 'mapping.schema.json': mappingSchema, 'protocol.schema.json': protocolSchema });
const checkMapping = (m) => validate(mappingSchema, m);
/** Сообщение валидно по схеме своего типа И по корневой oneOf. */
const declineFx = JSON.parse(readFileSync(new URL('../fixtures/deanon-decline.json', import.meta.url), 'utf8'));
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
    // FR-37: DEANON {decline: true} → DEANON_RESULT {declined[]} (карта — из фикстуры склонения)
    await send({ type: MSG.DEANON, requestId: 'r6d', mappingRef: declineFx.mapping, text: 'Письмо [ФИО_1]у и от [ФИО_2].', decline: true });
    expect(out.find((m) => m.requestId === 'r6d').declined.map((d) => d.case)).toEqual(['dat', 'gen']);
    // WP10-B: карта сессии для восстановления файла на странице
    await send({ type: MSG.GET_MAPPING, requestId: 'g1', docId: ent.docId });
    expect(out.find((m) => m.requestId === 'g1')).toMatchObject({ type: MSG.MAPPING, mapping: end.mapping });
    await send({ type: MSG.LIST_SESSIONS, requestId: 'r7' });
    await upload('e1', new TextEncoder().encode('это не docx, а просто текст достаточной длины'), 'x.docx');
    await send({ type: MSG.CATALOG_CHANGED, requestId: 'c1' });
    await send({ type: MSG.MODEL_CHANGED, requestId: 'm1', modelId: 'rubert-tiny2-ner-ruen' });
    await send({ type: MSG.MODEL_CHANGED, requestId: 'm2' });
    expect(out.filter((m) => m.requestId === 'm1' || m.requestId === 'm2').map((m) => m.type)).toEqual(['ACK', 'ACK']);
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
      'MODEL_CHANGED',
      'GET_MAPPING',
      'MAPPING',
    ]) {
      expect(types.has(t), `в прогоне нет ${t}`).toBe(true);
    }
    for (const m of [...sent, ...out]) expect(checkMessage(m), `${m.type}`).toEqual([]);
    expect(JSON.stringify(out.filter((m) => m.type === MSG.SESSIONS))).not.toContain('@');
  });

  it('PDF (версия 0.3): стадия pdf, ENTITIES kind, RESULT_BEGIN .anon.md + mime, предупреждение и коды отказов валидны', async () => {
    const out = [];
    const sent = [];
    const host = createHost({ post: (_c, msg) => out.push(msg), extractPdf: extractPdfNode });
    const settings = defaultSettings();
    const send = async (msg) => {
      sent.push(msg);
      await host.handle('c1', { settings, ...msg });
    };
    const upload = async (requestId, data, name) => {
      const msgs = [];
      postChunked((m) => msgs.push(m), { requestId, kind: 'FILE', bytes: data, meta: { name, sha256: null, origin: 'http://test.invalid' } });
      for (const m of msgs) await send(m);
      await send({ type: MSG.ANALYZE, requestId });
    };
    const pdf = (n) => new Uint8Array(readFileSync(new URL(`../fixtures/pdf/${n}.pdf`, import.meta.url)));
    await upload('p1', pdf('mixed'), 'договор.pdf');
    const ent = out.find((m) => m.type === MSG.ENTITIES);
    expect(ent.kind).toBe('pdf');
    expect(ent.warnings.map((w) => w.code)).toContain('PDF_PAGES_NO_TEXT');
    await send({ type: MSG.APPLY, requestId: 'p2', docId: ent.docId, decisions: [] });
    expect(out.find((m) => m.type === MSG.RESULT_BEGIN)).toMatchObject({ name: 'договор.anon.md', mime: 'text/markdown' });
    await upload('p3', pdf('scan'), 'scan.pdf');
    await upload('p4', pdf('empty'), 'empty.pdf');
    await upload('p5', buildSampleDocx().bytes, 'notpdf.pdf');
    expect(out.filter((m) => m.type === MSG.ERROR).map((m) => m.code)).toEqual(['PDF_NO_TEXT', 'PDF_EMPTY', 'PDF_INVALID']);
    expect(out.some((m) => m.type === MSG.PROGRESS && m.stage === 'pdf')).toBe(true);
    for (const m of [...sent, ...out]) expect(checkMessage(m), `${m.type}`).toEqual([]);
  }, 30000);

  it('OPEN_OPTIONS (0.4): раздел из перечня валиден, чужой раздел и сообщение без раздела — нет', () => {
    for (const section of ['categories', 'companies', 'ner']) expect(checkMessage({ type: MSG.OPEN_OPTIONS, requestId: 'o1', section }), section).toEqual([]);
    expect(checkMessage({ type: MSG.OPEN_OPTIONS, requestId: 'o2', section: 'data' })).not.toEqual([]);
    expect(checkMessage({ type: MSG.OPEN_OPTIONS, requestId: 'o3' })).not.toEqual([]);
    expect(checkMessage({ type: MSG.ACK, requestId: 'o1' })).toEqual([]);
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
      { type: 'DEANON', requestId: 'r', mappingRef: 'd1', text: 'x', decline: 'да' },
      { type: 'MODEL_CHANGED', requestId: 'r', modelId: 'Bad Id' },
      { type: 'MODEL_CHANGED' },
      { type: 'GET_MAPPING', requestId: 'r' },
      { type: 'GET_MAPPING', requestId: 'r', docId: '' },
      { type: 'MAPPING', requestId: 'r', docId: 'd1' },
      { type: 'MAPPING', requestId: 'r', docId: 'd1', mapping: { entries: [] } },
      {
        type: 'DEANON_RESULT',
        requestId: 'r',
        text: 'x',
        unresolved: [],
        replaced: 1,
        declined: [{ start: 0, end: 1, case: 'dative', original: 'a', text: 'x' }],
      },
    ]) {
      expect(validate(protocolSchema, bad), JSON.stringify(bad)).not.toEqual([]);
    }
  });
});

// WP10-C: сообщения встроенной модели NER (client → bg MODEL_BOOTSTRAP, bg → offscreen MODEL_INSTALL, ответ MODEL_INSTALLED)
describe('schemas/protocol.schema.json: встроенная модель (WP10-C)', () => {
  const SHA = '0123456789abcdef'.repeat(4);
  it('сообщения реального хоста и клиента валидны', async () => {
    const out = [];
    const host = createHost({
      post: (_c, m) => out.push(m),
      readPackageFile: async () => new Uint8Array([1]),
      modelStore: {
        listInstalled: async () => [],
        inspectPack: async () => ({ manifest: { id: 'rubert-tiny2-ner-ruen' }, packSha256: SHA, verified: true }),
        install: async () => ({ version: '1.0.0', bytes: 29000000 }),
      },
    });
    const install = {
      type: MSG.MODEL_INSTALL,
      requestId: 'mi1',
      url: 'chrome-extension://abcdefghijklmnop/models/docx-anonymizer-ner-rubert-tiny2-ner-ruen-1.0.0.zip',
      id: 'rubert-tiny2-ner-ruen',
      sha256: SHA,
      version: '1.0.0',
      extensionVersion: '0.3.0',
    };
    await host.handle('bootstrap', install);
    await host.handle('bootstrap', { ...install, requestId: 'mi2', sha256: 'f'.repeat(64) }); // → failed/MISMATCH
    const msgs = [{ type: MSG.MODEL_BOOTSTRAP, requestId: 'b1' }, install, ...out];
    expect(out.map((m) => m.status)).toEqual(['installed', 'failed']);
    for (const m of msgs) expect(checkMessage(m), m.type).toEqual([]);
  });

  it('отвергает испорченные', () => {
    const ok = { type: 'MODEL_INSTALL', requestId: 'r', url: 'chrome-extension://x/models/a.zip', id: 'test-pack', sha256: SHA };
    expect(validate(protocolSchema, ok)).toEqual([]);
    for (const bad of [
      { ...ok, url: 'https://example.invalid/a.zip' },
      { ...ok, sha256: 'XYZ' },
      { ...ok, id: 'Bad Id' },
      { type: 'MODEL_INSTALLED', requestId: 'r', status: 'done', id: 'test-pack', sha256: SHA },
      { type: 'MODEL_INSTALLED', requestId: 'r', status: 'installed', id: 'test-pack' },
      { type: 'MODEL_BOOTSTRAP' },
    ]) {
      expect(validate(protocolSchema, bad), JSON.stringify(bad)).not.toEqual([]);
    }
  });
});
