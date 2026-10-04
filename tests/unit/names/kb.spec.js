// FR-21–FR-23: база знаний сторон — фикстура kb-forms.json, зоны сторон, ИП.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { registerNames, analyzeParagraphs, allOnSettings, docFromParagraphs } from './helpers.js';
import { findPartyZones } from '../../../src/core/detect/names/kb.js';

const fx = JSON.parse(readFileSync(new URL('../../fixtures/kb-forms.json', import.meta.url), 'utf8'));
const core = (o) => o.text.slice(o.keepPrefix, o.text.length - o.keepSuffix);
const has = (o, t) => o.text === t || core(o) === t;

describe('kb-forms.json (FR-23)', () => {
  beforeEach(() => registerNames());

  it.each(fx.cases.map((c) => [c.name, c]))('%s', async (_n, c) => {
    const paras = ['ДОГОВОР', ...(c.preamble || []), '1. Предмет договора', ...c.body, 'Реквизиты сторон', ...c.block];
    const r = await analyzeParagraphs(paras, allOnSettings());
    const groups = r.groups.filter((g) => g.category === c.main.category);
    const main = groups.find((g) => g.occurrences.some((o) => has(o, c.main.text)));
    expect(main, `нет группы для ${c.main.text}`).toBeTruthy();
    for (const f of c.found) {
      const inMain = main.occurrences.filter((o) => has(o, f));
      expect(inMain.length, `вариант «${f}» не в группе «${c.main.text}»`).toBeGreaterThan(0);
      for (const g of groups)
        if (g !== main)
          expect(
            g.occurrences.some((o) => has(o, f)),
            `«${f}» в чужой группе`,
          ).toBe(false);
    }
    if (c.foundCount) expect(main.occurrences.filter((o) => o.text === c.found[0] || core(o) === c.found[0]).length - 1).toBe(c.foundCount);
    for (const nf of c.notFound || []) {
      const hit = r.entities.some((e) => (e.category === 'PERSON' || e.category === 'COMPANY') && (e.text === nf || core(e) === nf));
      expect(hit, `«${nf}» не должно находиться`).toBe(false);
    }
    for (const ng of c.notInGroup || [])
      expect(
        main.occurrences.some((o) => has(o, ng)),
        `«${ng}» не должно быть в группе`,
      ).toBe(false);
  });
});

describe('зоны сторон (FR-22)', () => {
  it('заголовок блока реквизитов и преамбула до «1.»', () => {
    const doc = docFromParagraphs(['ДОГОВОР', 'ООО «А», в лице …', '1. Предмет', 'текст', '5. РЕКВИЗИТЫ И ПОДПИСИ СТОРОН', 'ООО «А»', 'ИНН']);
    const z = findPartyZones(doc);
    const pids = doc.paragraphs.map((p) => p.pid);
    expect([...z.preamble]).toEqual(pids.slice(0, 2));
    expect([...z.block]).toEqual(pids.slice(5));
  });

  it('без заголовка: последние 25 % параграфов', () => {
    const paras = Array.from({ length: 12 }, (_, i) => `${i + 1}. Пункт`);
    const doc = docFromParagraphs(paras);
    const z = findPartyZones(doc);
    expect(z.block.size).toBe(3);
  });

  it('сторона вне зон: варианты в теле не ищутся (только правила)', async () => {
    registerNames();
    const paras = [
      'ДОГОВОР',
      '1. Предмет',
      'Генеральный директор: Иванов Пётр Сергеевич',
      'Иванову передать',
      ...Array.from({ length: 10 }, () => 'Пункт без имён.'),
    ];
    const r = await analyzeParagraphs(paras, allOnSettings());
    expect(r.entities.filter((e) => e.category === 'PERSON').map((e) => e.text)).toEqual(['Иванов Пётр Сергеевич']);
  });
});

describe('ИП (FR-21)', () => {
  beforeEach(() => registerNames());

  it('«ИП Иванов И.И.» → COMPANY целиком с ОПФ в keepPrefix; ФИО отдельно не выделяется', async () => {
    const r = await analyzeParagraphs(['ДОГОВОР', '1. Предмет', 'Реквизиты сторон', 'ИП Иванов И.И., ИНН 500400123402']);
    const ents = r.entities.filter((e) => e.category === 'PERSON' || e.category === 'COMPANY');
    expect(ents.map((e) => [e.category, e.text, e.keepPrefix])).toEqual([['COMPANY', 'ИП Иванов И.И.', 3]]);
  });

  it('госорганы и банки из списка не трогаются при govEntities: true, и находятся при false', async () => {
    const t = ['ПАО Сбербанк и АО «Ромашка»'];
    const on = await analyzeParagraphs(t, allOnSettings());
    expect(on.entities.filter((e) => e.category === 'COMPANY').map((e) => e.text)).toEqual(['АО «Ромашка»']);
    const off = await analyzeParagraphs(t, allOnSettings({ govEntities: false }));
    expect(off.entities.filter((e) => e.category === 'COMPANY').map((e) => e.text)).toEqual(['ПАО Сбербанк', 'АО «Ромашка»']);
  });

  it('выключенные PERSON/COMPANY не выдаются', async () => {
    const s = allOnSettings();
    s.categories.PERSON = false;
    s.categories.COMPANY = false;
    const r = await analyzeParagraphs(['ООО «Ромашка», в лице Иванова Петра Сергеевича'], s);
    expect(r.entities).toEqual([]);
  });
});
