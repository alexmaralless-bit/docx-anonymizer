// Хост ядра (то, что крутится в Web Worker offscreen) — полный протокол без браузера.
import { describe, it, expect } from 'vitest';
import { createHost, makeResultName } from '../../src/offscreen/host.js';
import { MSG, postChunked, ChunkAssembler } from '../../src/shared/protocol.js';
import { buildSampleDocx } from '../../scripts/make-sample.mjs';
import { parseDocx, defaultSettings, CoreError } from '../../src/core/index.js';
import { buildFixtures } from '../../scripts/gen-fixtures.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractPdfNode } from './support/pdf.js';

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

  it('GET_MAPPING (WP10-B): до APPLY — ошибка, после — карта последнего применения; неизвестная сессия — ошибка', async () => {
    const { out, send, upload } = setup();
    const { bytes } = buildSampleDocx();
    const ent = (await upload('r1', bytes)).find((m) => m.type === MSG.ENTITIES);
    await send({ type: MSG.GET_MAPPING, requestId: 'g1', docId: ent.docId });
    const before = out.find((m) => m.requestId === 'g1');
    expect(before).toMatchObject({ type: MSG.ERROR, code: 'INTERNAL' });
    expect(before.message).toMatch(/Маппинг не найден/);
    await send({ type: MSG.APPLY, requestId: 'r2', docId: ent.docId, decisions: [] });
    const end = out.find((m) => m.requestId === 'r2' && m.type === MSG.RESULT_END);
    await send({ type: MSG.GET_MAPPING, requestId: 'g2', docId: ent.docId });
    const got = out.find((m) => m.requestId === 'g2');
    expect(got.type).toBe(MSG.MAPPING);
    expect(got.docId).toBe(ent.docId);
    expect(got.mapping).toEqual(end.mapping);
    await send({ type: MSG.GET_MAPPING, requestId: 'g3', docId: 'нет-такой' });
    expect(out.find((m) => m.requestId === 'g3')).toMatchObject({ type: MSG.ERROR, code: 'INTERNAL' });
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

describe('host: PDF (версия 0.3)', () => {
  const PDF_DIR = join(process.cwd(), 'tests/fixtures/pdf');
  const pdf = (n) => new Uint8Array(readFileSync(join(PDF_DIR, `${n}.pdf`)));

  function pdfSetup(env = {}) {
    const out = [];
    const host = createHost({ post: (_c, msg) => out.push(msg), extractPdf: extractPdfNode, ...env });
    const base = defaultSettings();
    async function upload(requestId, bytes, name, settings = base) {
      const msgs = [];
      postChunked((m) => msgs.push(m), { requestId, kind: 'FILE', bytes, meta: { name } });
      for (const m of msgs) await host.handle('c1', { settings, ...m });
      await host.handle('c1', { settings, type: MSG.ANALYZE, requestId });
      return out.filter((m) => m.requestId === requestId);
    }
    async function apply(requestId, docId, settings = base) {
      await host.handle('c1', { settings, type: MSG.APPLY, requestId, docId, decisions: [] });
      const res = out.filter((m) => m.requestId === requestId);
      const begin = res.find((m) => m.type === MSG.RESULT_BEGIN);
      const asm = new ChunkAssembler(begin);
      for (const m of res.filter((x) => x.type === MSG.RESULT_CHUNK)) asm.add(m.index, m.data);
      return { begin, text: new TextDecoder().decode(asm.result()), end: res.find((m) => m.type === MSG.RESULT_END) };
    }
    return { out, host, upload, apply };
  }

  it('PDF → стадия pdf, ENTITIES kind:pdf → RESULT_BEGIN договор.anon.md text/markdown; повтор по sha — прежняя сессия', async () => {
    const { upload, apply } = pdfSetup();
    const msgs = await upload('p1', pdf('sample-contract'), 'договор.pdf');
    expect(msgs.filter((m) => m.type === MSG.PROGRESS).map((m) => m.stage)).toEqual(expect.arrayContaining(['receiving', 'pdf', 'parse', 'detect']));
    expect(msgs.some((m) => m.type === MSG.PROGRESS && m.stage === 'unzip')).toBe(false);
    const ent = msgs.find((m) => m.type === MSG.ENTITIES);
    expect(ent.kind).toBe('pdf');
    expect(ent.entities.some((e) => e.category === 'EMAIL')).toBe(true);
    expect(ent.entities.find((e) => e.category === 'EMAIL').occurrences[0].part).toBe('word/document.xml');
    const { begin, text, end } = await apply('p2', ent.docId);
    expect(begin.name).toBe('договор.anon.md');
    expect(begin.mime).toBe('text/markdown');
    expect(text).toMatch(/\[EMAIL_\d+\]/);
    expect(text).not.toContain('info@romashka.ru');
    expect(end.mapping.documents[0]).toMatchObject({ name: 'договор.pdf', resultName: 'договор.anon.md' });
    const again = await upload('p3', pdf('sample-contract'), 'копия.pdf');
    const ent2 = again.find((m) => m.type === MSG.ENTITIES);
    expect(ent2.restoredDecisions).toBe(true);
    expect(ent2.docId).toBe(ent.docId);
  }, 30000);

  it("pdfMode: 'text' → .anon.txt и text/plain; DOCX — MIME .docx", async () => {
    const { upload, apply } = pdfSetup();
    const settings = { ...defaultSettings(), pdfMode: 'text' };
    const ent = (await upload('t1', pdf('ip-contract'), 'a.pdf', settings)).find((m) => m.type === MSG.ENTITIES);
    const { begin, text } = await apply('t2', ent.docId, settings);
    expect(begin.name).toBe('a.anon.txt');
    expect(begin.mime).toBe('text/plain');
    expect(text).not.toContain('| --- |');
    const d = (await upload('t3', buildSampleDocx().bytes, 'b.docx')).find((m) => m.type === MSG.ENTITIES);
    expect(d.kind).toBe('docx');
    const r = await apply('t4', d.docId);
    expect(r.begin.mime).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  }, 30000);

  it('смешанный документ — предупреждение PDF_PAGES_NO_TEXT с номерами страниц', async () => {
    const { upload } = pdfSetup();
    const ent = (await upload('m1', pdf('mixed'), 'mixed.pdf')).find((m) => m.type === MSG.ENTITIES);
    expect(ent.warnings).toContainEqual({ code: 'PDF_PAGES_NO_TEXT', count: 1, details: { pages: [2] } });
  }, 30000);

  it('отказы: скан, пустой, с паролем, .pdf без сигнатуры, нет extractPdf', async () => {
    const { upload } = pdfSetup();
    const code = async (id, bytes, name) => (await upload(id, bytes, name)).find((m) => m.type === MSG.ERROR)?.code;
    expect(await code('e1', pdf('scan'), 'scan.pdf')).toBe('PDF_NO_TEXT');
    expect(await code('e2', pdf('empty'), 'empty.pdf')).toBe('PDF_EMPTY');
    if (existsSyncSafe(join(PDF_DIR, 'encrypted.pdf'))) expect(await code('e3', pdf('encrypted'), 'enc.pdf')).toBe('PDF_ENCRYPTED');
    expect(await code('e4', buildSampleDocx().bytes, 'notpdf.pdf')).toBe('PDF_INVALID');
    const bare = pdfSetup({ extractPdf: undefined });
    const err = (await bare.upload('e5', pdf('ip-contract'), 'a.pdf')).find((m) => m.type === MSG.ERROR);
    expect(err.code).toBe('INTERNAL');
    // документ с сигнатурой PDF и именем .docx — тоже PDF
    expect((await upload('e6', pdf('ip-contract'), 'странное.docx')).find((m) => m.type === MSG.ENTITIES).kind).toBe('pdf');
  }, 30000);

  it("makeResultName с ext: 'a.pdf' → 'a.anon.md', без расширения → 'документ.anon.txt'", () => {
    expect(makeResultName('a.pdf', '.anon', { ext: '.md' })).toBe('a.anon.md');
    expect(makeResultName('A.PDF', '.x', { ext: '.txt' })).toBe('A.x.txt');
    expect(makeResultName('документ', '.anon', { ext: '.txt' })).toBe('документ.anon.txt');
  });
});

function existsSyncSafe(p) {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}

// WP10-C (К15): установка встроенной модели NER из архива расширения — MODEL_INSTALL → MODEL_INSTALLED.
// Хранилище и чтение файла — фейки (OPFS и fetch собственного пакета есть только в браузере; e2e bundled-model.spec.js).
describe('host: MODEL_INSTALL (встроенная модель)', () => {
  const SHA = 'f'.repeat(64);
  const URL_OK = 'chrome-extension://extid/models/docx-anonymizer-ner-test-pack-1.0.0.zip';
  const msg = (extra = {}) => ({
    type: MSG.MODEL_INSTALL,
    requestId: 'mi1',
    url: URL_OK,
    id: 'test-pack',
    sha256: SHA,
    version: '1.0.0',
    extensionVersion: '0.3.0',
    ...extra,
  });

  function installSetup({ installed = [], inspect = {}, read } = {}) {
    const out = [];
    const calls = { read: 0, inspect: 0, install: [], created: 0, disposed: 0 };
    const modelStore = {
      listInstalled: async () => installed,
      inspectPack: async () => {
        calls.inspect++;
        return { manifest: { id: 'test-pack', version: '1.0.0' }, packSha256: SHA, verified: true, bytes: 100, ...inspect };
      },
      install: async (bytes, opts) => {
        calls.install.push(opts);
        installed.push({ id: 'test-pack', packSha256: SHA }); // как OPFS: после установки пакет виден в listInstalled
        return { id: 'test-pack', version: '1.0.0', bytes: 100, packSha256: SHA, verified: true };
      },
    };
    const host = createHost({
      post: (clientId, m) => out.push({ clientId, ...m }),
      modelStore,
      readPackageFile:
        read ||
        (async () => {
          calls.read++;
          return new Uint8Array([1, 2, 3]);
        }),
      createNerProvider: () => {
        calls.created++;
        return { name: 'fake', init: async () => {}, detect: async () => [], dispose: () => calls.disposed++ };
      },
    });
    return { host, out, calls };
  }

  it('тот же sha уже установлен → present, файл пакета не читается', async () => {
    const { host, out, calls } = installSetup({ installed: [{ id: 'test-pack', packSha256: SHA }] });
    await host.handle('bootstrap', msg());
    expect(out).toEqual([
      { clientId: 'bootstrap', type: MSG.MODEL_INSTALLED, requestId: 'mi1', status: 'present', id: 'test-pack', sha256: SHA, version: '1.0.0' },
    ]);
    expect(calls.read).toBe(0);
    expect(calls.install).toEqual([]);
  });

  it('проверенный пакет → installed (bytes, ms); чужие пакеты не удаляются, установка с verified', async () => {
    const installed = [{ id: 'my-own', packSha256: 'a'.repeat(64) }];
    const { host, out, calls } = installSetup({ installed });
    await host.handle('bootstrap', msg());
    expect(installed.map((m) => m.id)).toEqual(['my-own', 'test-pack']);
    const r = out.find((m) => m.type === MSG.MODEL_INSTALLED);
    expect(r).toMatchObject({ clientId: 'bootstrap', status: 'installed', id: 'test-pack', sha256: SHA, version: '1.0.0', bytes: 100 });
    expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(calls.read).toBe(1);
    expect(calls.install).toEqual([{ verified: true, extensionVersion: '0.3.0' }]);
  });

  it('непроверенный пакет → failed/UNVERIFIED; другой sha или id → failed/MISMATCH; ничего не ставится', async () => {
    for (const [inspect, code] of [
      [{ verified: false }, 'UNVERIFIED'],
      [{ packSha256: 'e'.repeat(64) }, 'MISMATCH'],
      [{ manifest: { id: 'other-pack', version: '1.0.0' } }, 'MISMATCH'],
    ]) {
      const { host, out, calls } = installSetup({ inspect });
      await host.handle('bootstrap', msg());
      expect(
        out.find((m) => m.type === MSG.MODEL_INSTALLED),
        code,
      ).toMatchObject({ status: 'failed', code, id: 'test-pack', sha256: SHA });
      expect(calls.install).toEqual([]);
    }
  });

  it('адрес не из собственного пакета (настоящий readPackageFile) → failed/IO; ошибка хранилища → failed с её кодом', async () => {
    const { readPackageFile } = await import('../../src/offscreen/package-fetch.js');
    const { ModelStoreError } = await import('../../src/shared/model-store.js');
    const a = installSetup({ read: readPackageFile });
    await a.host.handle('bootstrap', msg({ url: 'https://example.invalid/pack.zip' }));
    expect(a.out.find((m) => m.type === MSG.MODEL_INSTALLED)).toMatchObject({ status: 'failed', code: 'IO' });
    const b = installSetup({
      read: async () => {
        throw new ModelStoreError('QUOTA');
      },
    });
    await b.host.handle('bootstrap', msg());
    expect(b.out.find((m) => m.type === MSG.MODEL_INSTALLED)).toMatchObject({ status: 'failed', code: 'QUOTA' });
  });

  it('без modelStore (сборка без установки) → ERROR, хост жив', async () => {
    const out = [];
    const host = createHost({ post: (_c, m) => out.push(m) });
    await host.handle('bootstrap', msg());
    expect(out[0]).toMatchObject({ type: MSG.ERROR, requestId: 'mi1', code: 'INTERNAL' });
  });

  it('после installed кэш провайдера NER сброшен: следующий анализ создаёт новый провайдер', async () => {
    const { host, out, calls } = installSetup();
    const settings = { ...defaultSettings(), nerModel: 'test-pack' };
    const analyze = async (requestId, bytes) => {
      const msgs = [];
      postChunked((m) => msgs.push(m), { requestId, kind: 'FILE', bytes, meta: { name: 'договор.docx' } });
      for (const m of msgs) await host.handle('c1', { settings, ...m });
      await host.handle('c1', { settings, type: MSG.ANALYZE, requestId });
    };
    const [a, b] = [buildSampleDocx().bytes, buildFixtures()[0].bytes];
    await analyze('r1', a);
    expect(calls.created).toBe(1);
    await host.handle('bootstrap', msg());
    expect(out.find((m) => m.type === MSG.MODEL_INSTALLED).status).toBe('installed');
    expect(calls.disposed).toBe(1);
    await analyze('r2', b);
    expect(calls.created).toBe(2);
  });

  it('два MODEL_INSTALL подряд выполняются по очереди: второй видит установленный пакет → present', async () => {
    const { host, out, calls } = installSetup();
    const p1 = host.handle('bootstrap', msg({ requestId: 'a' }));
    const p2 = host.handle('bootstrap', msg({ requestId: 'b' }));
    await Promise.all([p1, p2]);
    expect(out.find((m) => m.requestId === 'a').status).toBe('installed');
    expect(out.find((m) => m.requestId === 'b').status).toBe('present');
    expect(calls.install).toHaveLength(1);
  });
});
