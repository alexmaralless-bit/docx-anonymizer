// Хост ядра (то, что крутится в Web Worker offscreen) — полный протокол без браузера.
import { describe, it, expect } from 'vitest';
import { createHost, makeResultName } from '../../src/offscreen/host.js';
import { MSG, postChunked, ChunkAssembler } from '../../src/shared/protocol.js';
import { buildSampleDocx } from '../../scripts/make-sample.mjs';
import { parseDocx, defaultSettings } from '../../src/core/index.js';

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
