// FR-21–FR-23: база знаний сторон — фикстура kb-forms.json, зоны сторон, ИП.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { registerNames, analyzeParagraphs, allOnSettings, commercialSettings, docFromParagraphs } from './helpers.js';
import { findPartyZones } from '../../../src/core/detect/names/kb.js';
import { defaultSettings } from '../../../src/core/settings.js';
import { NEVER_MASK_ORGS } from '../../../src/core/detect/names/lexicon.js';
import { BUILTIN_STOPLIST, stopKey } from '../../../src/core/ner/stoplist.js';

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

  // К11 (WP11-D, решение владельца 1): было «варианты в теле не ищутся (только правила)» и ожидалось одно вхождение.
  // Одиночная фамилия лица с полным ФИО в документе — его вариант, иначе «Иванову» уходила в чат открытой.
  it('лицо вне зон: одиночная фамилия в теле — вариант того же лица (одна метка)', async () => {
    registerNames();
    const paras = [
      'ДОГОВОР',
      '1. Предмет',
      'Генеральный директор: Иванов Пётр Сергеевич',
      'Иванову передать',
      ...Array.from({ length: 10 }, () => 'Пункт без имён.'),
    ];
    const r = await analyzeParagraphs(paras, allOnSettings());
    expect(r.entities.filter((e) => e.category === 'PERSON').map((e) => e.text)).toEqual(['Иванов Пётр Сергеевич', 'Иванову']);
    expect(r.groups.filter((g) => g.category === 'PERSON')).toHaveLength(1);
  });
});

describe('ИП (FR-21)', () => {
  beforeEach(() => registerNames());

  // Политика 0.4 (решение владельца 1): ИП — имя человека, PERSON в обоих режимах; COMPANY для ИП нет (К11: было COMPANY)
  for (const [mode, settings] of [
    ['обычный режим', undefined],
    ['коммерческий режим', commercialSettings()],
  ]) {
    it(`«ИП Иванов И.И.» → PERSON с «ИП » в keepPrefix; «Иванов И.И.» дальше — та же метка (${mode})`, async () => {
      const r = await analyzeParagraphs(
        ['ДОГОВОР', '1. Предмет', 'Акт подписал Иванов И.И. без замечаний.', 'Реквизиты сторон', 'ИП Иванов И.И., ИНН 500400123402'],
        settings,
      );
      const ents = r.entities.filter((e) => e.category === 'PERSON' || e.category === 'COMPANY');
      expect(ents.map((e) => [e.category, e.text, e.keepPrefix])).toEqual([
        ['PERSON', 'Иванов И.И.', 0],
        ['PERSON', 'ИП Иванов И.И.', 3],
      ]);
      const persons = r.groups.filter((g) => g.category === 'PERSON');
      expect(persons).toHaveLength(1);
      expect(persons[0].occurrences).toHaveLength(2);
    });
  }

  it('«Индивидуальный предприниматель Петров Пётр Петрович» → PERSON, форма с пробелом в keepPrefix; падежи — та же метка', async () => {
    const form = 'Индивидуальный предприниматель ';
    const r = await analyzeParagraphs([`${form}Петров Пётр Петрович, ИНН 500400123402`, '1. Исполнитель в лице Петрова Петра Петровича оказывает услуги.']);
    const ents = r.entities.filter((e) => e.category === 'PERSON' || e.category === 'COMPANY');
    expect(ents.map((e) => [e.category, e.text, e.keepPrefix])).toEqual([
      ['PERSON', `${form}Петров Пётр Петрович`, form.length],
      ['PERSON', 'Петрова Петра Петровича', 0],
    ]);
    expect(r.groups.filter((g) => g.category === 'PERSON')).toHaveLength(1);
  });

  it('обычный режим: «ООО «Ромашка»» не находится, «Петров П.П.» рядом — находится (К1, contracts §8.1)', async () => {
    const r = await analyzeParagraphs(['ООО «Ромашка» и Петров П.П. подписали акт.']);
    expect(r.entities.map((e) => [e.category, e.text])).toEqual([['PERSON', 'Петров П.П.']]);
  });

  it('госорганы и банки из списка не трогаются при govEntities: true, и находятся при false', async () => {
    const t = ['ПАО Сбербанк и АО «Ромашка»'];
    const on = await analyzeParagraphs(t, allOnSettings());
    expect(on.entities.filter((e) => e.category === 'COMPANY').map((e) => e.text)).toEqual(['АО «Ромашка»']);
    const off = await analyzeParagraphs(t, allOnSettings({ govEntities: false }));
    expect(off.entities.filter((e) => e.category === 'COMPANY').map((e) => e.text)).toEqual(['ПАО Сбербанк', 'АО «Ромашка»']);
  });

  it('выключенная COMPANY не выдаётся; PERSON выключить нельзя (политика 0.4, К1)', async () => {
    const s = allOnSettings();
    s.categories.PERSON = false;
    s.categories.COMPANY = false;
    const r = await analyzeParagraphs(['ООО «Ромашка», в лице Иванова Петра Сергеевича'], s);
    expect(r.entities.map((e) => [e.category, e.text])).toEqual([['PERSON', 'Иванова Петра Сергеевича']]);
    // выключенная коммерческая группа — то же, что выключенная COMPANY
    const off = await analyzeParagraphs(['ООО «Ромашка», в лице Иванова Петра Сергеевича']);
    expect(off.entities.map((e) => [e.category, e.text])).toEqual([['PERSON', 'Иванова Петра Сергеевича']]);
  });
});

// Ревью WP11-A: правило «родовое слово + название» не отбирает спан у лица; бренд владельца не маскируется (решение 6)
describe('родовое слово + название (политика 0.4) и бренд владельца', () => {
  beforeEach(() => registerNames());
  const pc = (r) =>
    r.entities
      .filter((e) => e.category === 'PERSON' || e.category === 'COMPANY')
      .map((e) => [e.category, e.text, e.text.slice(e.keepPrefix, e.text.length - e.keepSuffix)]);

  for (const [mode, settings] of [
    ['обычный режим', undefined],
    ['коммерческий режим', commercialSettings()],
  ]) {
    it(`лица после родового слова остаются лицами, как в 0.3 (${mode})`, async () => {
      for (const [text, want] of [
        ['В компании Петрова П.П. работают 5 человек.', [['PERSON', 'Петрова П.П.', 'Петрова П.П.']]],
        ['Генеральный директор компании Сидоров Иван Петрович подписал акт.', [['PERSON', 'Сидоров Иван Петрович', 'Сидоров Иван Петрович']]],
        ['Бюро Иванова И.И. оказало услуги.', [['PERSON', 'Иванова И.И.', 'Иванова И.И.']]],
        ['Сайт сделала студия Артемия Лебедева в срок.', [['PERSON', 'Артемия Лебедева', 'Артемия Лебедева']]],
        ['Сайт сделала Студия Артемия Лебедева в срок.', [['PERSON', 'Артемия Лебедева', 'Артемия Лебедева']]],
      ]) {
        const r = await analyzeParagraphs([text], settings);
        expect(pc(r), text).toEqual(want);
      }
    });

    it(`бренд владельца не маскируется ни правилами, ни базой сторон, ни списком (${mode})`, async () => {
      const paras = [
        'Студия Sitimlab подготовила предложение.',
        'Sitimlab работает с 2020 года.',
        'ООО «Ситимлаб» и ООО «Ромашка» заключили договор.',
        'Передать Ситимлабу документы.',
      ];
      const r = await analyzeParagraphs(paras, {
        ...(settings || defaultSettings()),
        maskedCompanies: [{ name: 'Sitimlab' }, { name: 'Вектор', aliases: ['Ситимлаб'] }],
      });
      expect(pc(r).filter(([, , core]) => /sitimlab|ситимлаб/i.test(core))).toEqual([]);
      expect(r.entities.filter((e) => /sitimlab|ситимлаб/i.test(e.text))).toEqual([]);
    });
  }

  it('бренд владельца — единый список: он же в стоп-списке модельных организаций', () => {
    for (const w of NEVER_MASK_ORGS) expect(BUILTIN_STOPLIST.has(stopKey(w)), w).toBe(true);
    expect(BUILTIN_STOPLIST.has(stopKey('Sitimlab'))).toBe(true);
  });

  it('коммерческий режим: «Студия Ромашка», «Агентство «Вектор»», «Агентство Smith & Co» — COMPANY с родовым словом в keepPrefix; обычный — нет', async () => {
    const paras = [
      'Сайт сделала Студия Ромашка в срок.',
      'Рекламу ведёт Агентство «Вектор».',
      'Агентство Smith & Co оказало услуги.',
      'Работы выполнило агентство «Альфа».',
    ];
    const r = await analyzeParagraphs(paras, commercialSettings());
    expect(pc(r)).toEqual([
      ['COMPANY', 'Студия Ромашка', 'Ромашка'],
      ['COMPANY', 'Агентство «Вектор»', 'Вектор'],
      ['COMPANY', 'Агентство Smith & Co', 'Smith & Co'],
      ['COMPANY', 'агентство «Альфа»', 'Альфа'],
    ]);
    expect(pc(await analyzeParagraphs(paras))).toEqual([]);
  });
});
