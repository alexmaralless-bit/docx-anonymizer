// Хост ядра (то, что крутится в Web Worker offscreen) — полный протокол без браузера.
import { describe, it, expect } from 'vitest';
import { createHost, makeResultName } from '../../src/offscreen/host.js';
import { MSG, postChunked, ChunkAssembler } from '../../src/shared/protocol.js';
import { buildSampleDocx } from '../../scripts/make-sample.mjs';
import { parseDocx, defaultSettings, CoreError } from '../../src/core/index.js';
import { buildFixtures } from '../../scripts/gen-fixtures.mjs';

function setup() {
  const out = [];
  const host = createHost({ post: (clientId, msg) => out.push({ clientId, ...msg }) });
  const settings = defaultSettings();
  async function send(msg) {
    await host.handle('c1', { settings, ...msg });
  }
  async function upload(requestId, bytes, name = 'договор.docx') {
    const msgs = [];
    postChunked((m) => msgs.push(m), { requestId, kind: 'FILE', bytes, meta: { name } });
    for (const m of msgs) await send(m);
    await send({ type: MSG.ANALYZE, requestId });
    return out.filter((m) => m.requestId === requestId);
  }
  return { host, out, send, upload };
}

describe('host: протокол §5.4 в воркере', () => {
  it('файл → ENTITIES → APPLY → RESULT_* → DEANON; повторная загрузка восстанавливает решения', async () => {
    const { out, send, upload } = setup();
    const { bytes, gold } = buildSampleDocx();
    const msgs = await upload('r1', bytes);
    const ent = msgs.find((m) => m.type === MSG.ENTITIES);
    expect(msgs.some((m) => m.type === MSG.PROGRESS && m.stage === 'receiving')).toBe(true);
    expect(ent).toBeTruthy();
    expect(ent.stats.virtualTextLength).toBeGreaterThan(2000);
    // временный детектор EMAIL (WP1 заменит) находит все адреса
    const emails = ent.entities.filter((e) => e.category === 'EMAIL');
    expect(emails.map((e) => e.value).sort()).toEqual([gold.email3, gold.email2, gold.emailOld, gold.email1].sort());
    // авторы правок и комментариев — PERSON от ядра (FR-11); остальные PERSON находит WP2
    expect(ent.entities.filter((e) => e.category === 'PERSON').map((e) => e.value)).toEqual(expect.arrayContaining([gold.author1, gold.author2]));
    expect(emails[0].occurrences[0].context).toContain('⟦');
    const skipped = emails[0];

    await send({ type: MSG.APPLY, requestId: 'r2', docId: ent.docId, decisions: [{ entityId: skipped.id, action: 'skip' }] });
    const res = out.filter((m) => m.requestId === 'r2');
    const begin = res.find((m) => m.type === MSG.RESULT_BEGIN);
    expect(begin.name).toBe('договор.anon.docx');
    const asm = new ChunkAssembler(begin);
    for (const m of res.filter((x) => x.type === MSG.RESULT_CHUNK)) asm.add(m.index, m.data);
    const result = parseDocx(asm.result());
    const text = result.streams.map((s) => s.text).join('\n');
    expect(text).toContain(skipped.value); // пропущенная сущность осталась
    for (const e of emails.slice(1)) expect(text).not.toContain(e.value);
    const end = res.find((m) => m.type === MSG.RESULT_END);
    expect(end.mapping.entries).toHaveLength(ent.entities.length - 1);

    await send({ type: MSG.DEANON, requestId: 'r3', mappingRef: ent.docId, text: 'Пишите на [EMAIL_2] и [EMAIL_9]' });
    const de = out.find((m) => m.requestId === 'r3');
    expect(de.type).toBe(MSG.DEANON_RESULT);
    expect(de.text).toContain('@');
    expect(de.unresolved.map((u) => u.text)).toEqual(['[EMAIL_9]']);
    expect(de.declined).toEqual([]); // склонение (FR-37) — только по просьбе клиента
    const author = ent.entities.find((e) => e.category === 'PERSON' && e.value === gold.author1);
    const tok = end.mapping.entries.find((e) => e.value === author.value)?.token;
    await send({ type: MSG.DEANON, requestId: 'r3d', mappingRef: ent.docId, text: `Письмо от ${tok}`, decline: true });
    const dd = out.find((m) => m.requestId === 'r3d');
    expect(dd.declined.map((d) => [d.case, d.original])).toEqual([['gen', author.value]]); // «Петров Олег» → «Петрова Олега»
    expect(dd.text.slice(dd.declined[0].start, dd.declined[0].end)).toBe(dd.declined[0].text);

    const again = await upload('r4', bytes);
    expect(again.find((m) => m.type === MSG.ENTITIES).restoredDecisions).toBe(true);

    await send({ type: MSG.LIST_SESSIONS, requestId: 'r5' });
    const list = out.find((m) => m.requestId === 'r5');
    expect(list.sessions).toHaveLength(1);
    expect(JSON.stringify(list.sessions)).not.toContain('@'); // индекс без значений
  });

  it('ADD_ENTITY: пользователь добавляет значение — найдены все вхождения', async () => {
    const { out, send, upload } = setup();
    const { bytes, gold } = buildSampleDocx();
    const ent = (await upload('r1', bytes)).find((m) => m.type === MSG.ENTITIES);
    await send({ type: MSG.ADD_ENTITY, requestId: 'r2', docId: ent.docId, category: 'COMPANY', text: gold.company1, replaceAll: true });
    const upd = out.find((m) => m.requestId === 'r2' && m.type === MSG.ENTITIES);
    const comp = upd.entities.find((e) => e.category === 'COMPANY');
    expect(comp.source).toBe('user');
    expect(comp.occurrences.length).toBeGreaterThanOrEqual(4);
  });

  it('ошибки: NOT_DOCX, TOO_LARGE, неизвестная сессия', async () => {
    const { out, send, upload } = setup();
    const bad = await upload('e1', new TextEncoder().encode('это не docx, а просто текст достаточной длины'));
    expect(bad.find((m) => m.type === MSG.ERROR)).toMatchObject({ code: 'NOT_DOCX' });
    await send({ type: MSG.FILE_BEGIN, requestId: 'e2', name: 'x.docx', size: 51 * 1024 * 1024, chunks: 1 });
    expect(out.find((m) => m.requestId === 'e2')).toMatchObject({ type: MSG.ERROR, code: 'TOO_LARGE' });
    await send({ type: MSG.APPLY, requestId: 'e3', docId: 'nope' });
    expect(out.find((m) => m.requestId === 'e3')).toMatchObject({ type: MSG.ERROR, code: 'INTERNAL' });
  });

  it('makeResultName', () => {
    expect(makeResultName('договор.docx')).toBe('договор.anon.docx');
    expect(makeResultName('A.DOCM', '.x')).toBe('A.x.DOCM');
  });
});

// WP8: фабрика провайдера NER по settings.nerModel, кэш, MODEL_CHANGED, сбой загрузки модели → NER_FAILED (К5, NFR-13)
describe('host: провайдер NER из пакета модели', () => {
  function nerSetup(settingsPatch, makeProvider) {
    const out = [];
    const created = [];
    const disposed = [];
    const host = createHost({
      post: (_c, msg) => out.push(msg),
      createNerProvider: (s) => {
        const p = makeProvider ? makeProvider(s) : { name: 'fake', init: async () => {}, detect: async () => [] };
        p.dispose = () => disposed.push(s.nerModel);
        created.push(s.nerModel);
        return p;
      },
    });
    const settings = { ...defaultSettings(), ...settingsPatch };
    const send = (msg) => host.handle('c1', { settings, ...msg });
    async function upload(requestId, bytes, name = 'договор.docx') {
      const msgs = [];
      postChunked((m) => msgs.push(m), { requestId, kind: 'FILE', bytes, meta: { name } });
      for (const m of msgs) await send(m);
      await send({ type: MSG.ANALYZE, requestId });
      return out.filter((m) => m.requestId === requestId);
    }
    return { out, created, disposed, send, upload };
  }
  const docs = () => [buildSampleDocx().bytes, ...buildFixtures().map((f) => f.bytes)];

  it('один провайдер на модель; MODEL_CHANGED → ACK, освобождение и новый провайдер при следующем анализе', async () => {
    const { created, disposed, send, upload, out } = nerSetup({ nerModel: 'test-model' });
    const [a, b, c] = docs();
    const r1 = await upload('r1', a);
    const r2 = await upload('r2', b);
    expect(created).toEqual(['test-model']);
    for (const r of [r1, r2]) {
      expect(r.some((m) => m.type === MSG.PROGRESS && m.stage === 'ner')).toBe(true);
      expect(r.find((m) => m.type === MSG.ENTITIES).warnings.map((w) => w.code)).not.toContain('NER_FAILED');
    }
    // ADD_ENTITY переанализирует тем же провайдером
    const docId = r1.find((m) => m.type === MSG.ENTITIES).docId;
    await send({ type: MSG.ADD_ENTITY, requestId: 'r2a', docId, category: 'COMPANY', text: 'Ромашка', replaceAll: true });
    expect(created).toHaveLength(1);

    await send({ type: MSG.MODEL_CHANGED, requestId: 'm1', modelId: 'test-model' });
    expect(out.find((m) => m.requestId === 'm1')).toEqual({ type: MSG.ACK, requestId: 'm1' });
    expect(disposed).toEqual(['test-model']);
    await upload('r3', c);
    expect(created).toEqual(['test-model', 'test-model']);
  });

  it('смена nerModel в настройках создаёт новый провайдер и освобождает прежний', async () => {
    const out = [];
    const created = [];
    const disposed = [];
    const host = createHost({
      post: (_c, m) => out.push(m),
      createNerProvider: (s) => (
        created.push(s.nerModel),
        { name: 'x', init: async () => {}, detect: async () => [], dispose: () => disposed.push(s.nerModel) }
      ),
    });
    const [a, b] = docs();
    for (const [rid, bytes, nerModel] of [
      ['r1', a, 'model-a'],
      ['r2', b, 'model-b'],
    ]) {
      const settings = { ...defaultSettings(), nerModel };
      const msgs = [];
      postChunked((m) => msgs.push(m), { requestId: rid, kind: 'FILE', bytes, meta: { name: 'x.docx' } });
      for (const m of msgs) await host.handle('c1', { settings, ...m });
      await host.handle('c1', { settings, type: MSG.ANALYZE, requestId: rid });
    }
    expect(created).toEqual(['model-a', 'model-b']);
    expect(disposed).toEqual(['model-a']);
  });

  it("nerModel '' или nerEnabled:false → фабрика не вызывается, этапа ner и NER_FAILED нет", async () => {
    for (const patch of [{ nerModel: '' }, { nerModel: 'test-model', nerEnabled: false }]) {
      const { created, upload } = nerSetup(patch);
      const r = await upload('r1', buildSampleDocx().bytes);
      expect(created).toEqual([]);
      expect(r.some((m) => m.type === MSG.PROGRESS && m.stage === 'ner')).toBe(false);
      expect(r.find((m) => m.type === MSG.ENTITIES).warnings.map((w) => w.code)).not.toContain('NER_FAILED');
    }
  });

  it('сбой загрузки модели (MODEL_LOAD_FAILED) → предупреждение NER_FAILED, не ERROR; EMAIL по-прежнему найден', async () => {
    const { upload } = nerSetup({ nerModel: 'broken-model' }, () => ({
      name: 'broken',
      init: async () => {
        throw new CoreError('MODEL_LOAD_FAILED', 'нет модели');
      },
      detect: async () => [],
    }));
    const { bytes, gold } = buildSampleDocx();
    const r = await upload('r1', bytes);
    expect(r.some((m) => m.type === MSG.ERROR)).toBe(false);
    const ent = r.find((m) => m.type === MSG.ENTITIES);
    expect(ent.warnings).toContainEqual({ code: 'NER_FAILED', details: { reason: 'MODEL_LOAD_FAILED' } });
    expect(ent.entities.filter((e) => e.category === 'EMAIL').map((e) => e.value)).toEqual(expect.arrayContaining([gold.email1, gold.email2]));
  });

  it('сбой инференса → NER_FAILED с причиной INFERENCE_FAILED', async () => {
    const { upload } = nerSetup({ nerModel: 'flaky-model' }, () => ({
      name: 'flaky',
      init: async () => {},
      detect: async () => {
        throw new Error('oom');
      },
    }));
    const ent = (await upload('r1', buildSampleDocx().bytes)).find((m) => m.type === MSG.ENTITIES);
    expect(ent.warnings).toContainEqual({ code: 'NER_FAILED', details: { reason: 'INFERENCE_FAILED' } });
  });

  it('env.nerProvider (тесты) имеет приоритет над фабрикой', async () => {
    const out = [];
    let calls = 0;
    const host = createHost({
      post: (_c, m) => out.push(m),
      nerProvider: { name: 'fixed', init: async () => {}, detect: async () => (calls++, []) },
      createNerProvider: () => {
        throw new Error('не должна вызываться');
      },
    });
    const settings = defaultSettings();
    const msgs = [];
    postChunked((m) => msgs.push(m), { requestId: 'r1', kind: 'FILE', bytes: buildSampleDocx().bytes, meta: { name: 'x.docx' } });
    for (const m of msgs) await host.handle('c1', { settings, ...m });
    await host.handle('c1', { settings, type: MSG.ANALYZE, requestId: 'r1' });
    expect(out.find((m) => m.type === MSG.ENTITIES)).toBeTruthy();
    expect(calls).toBeGreaterThan(0);
  });
});
