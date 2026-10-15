// WP7, К1: словарный детектор ФИО — фикстура PERSON-dict.json (позитивы точно, ноль ложных на негативах),
// выключатель dictNames: «только словарные» позитивы не находятся, негативы по-прежнему пусты.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { registerNames, analyzeParagraphs, allOnSettings } from './helpers.js';
import { findPersonsByDict, atSentenceStart } from '../../../src/core/detect/names/person-dict.js';

const fx = JSON.parse(readFileSync(new URL('../../fixtures/categories/PERSON-dict.json', import.meta.url), 'utf8'));
const persons = (r) => r.entities.filter((e) => e.category === 'PERSON');

describe('фикстура PERSON-dict (К1)', () => {
  beforeEach(() => registerNames());

  it('≥ 40 позитивов и ≥ 40 негативов', () => {
    expect(fx.positive.length).toBeGreaterThanOrEqual(40);
    expect(fx.negative.length).toBeGreaterThanOrEqual(40);
  });

  it.each(fx.positive.map((p) => [p.text, p]))('находит: %s', async (_t, p) => {
    const r = await analyzeParagraphs([p.text], allOnSettings());
    expect(persons(r).map((e) => e.text)).toEqual(p.expect);
    // словарные вхождения — уровень kb (не сторона)
    if (p.dictOnly) for (const e of persons(r)) expect(e.confidence).toBe('kb');
  });

  it.each(fx.negative.map((t) => [t]))('не находит: %s', async (t) => {
    const r = await analyzeParagraphs([t], allOnSettings());
    expect(persons(r).map((e) => e.text)).toEqual([]);
  });
});

describe('dictNames: false', () => {
  beforeEach(() => registerNames());
  const off = () => allOnSettings({ dictNames: false });

  it.each(fx.positive.filter((p) => p.dictOnly).map((p) => [p.text, p]))('только словарный позитив не находится: %s', async (_t, p) => {
    const r = await analyzeParagraphs([p.text], off());
    const found = persons(r).map((e) => e.text);
    for (const x of p.expect) expect(found).not.toContain(x);
  });

  it.each(fx.positive.filter((p) => !p.dictOnly).map((p) => [p.text, p]))('позитив правил находится и без словаря: %s', async (_t, p) => {
    const r = await analyzeParagraphs([p.text], off());
    expect(persons(r).map((e) => e.text)).toEqual(p.expect);
  });

  it('негативы по-прежнему пусты', async () => {
    for (const t of fx.negative) {
      const r = await analyzeParagraphs([t], off());
      expect(
        persons(r).map((e) => e.text),
        t,
      ).toEqual([]);
    }
  });
});

describe('findPersonsByDict: шаблоны и проверки', () => {
  const texts = (t, opts) => findPersonsByDict(t, opts).map((s) => t.slice(s.start, s.end));

  it('спаны правил (opts.skip) не пересекаются', () => {
    const t = 'Отчёт подготовила Зульфия Хасанова.';
    const i = t.indexOf('Зульфия');
    expect(texts(t, { skip: [{ start: i, end: i + 3 }] })).toEqual([]);
  });

  it('разбор пары и fm содержит леммы и признак dict', () => {
    const [p] = findPersonsByDict('Документы передать Зульфие Хасановой.');
    expect(p.dict).toBe(true);
    expect(p.parse).toMatchObject({ kind: 'pair', lemma: { first: 'зульфия', surname: 'хасанова', gender: 'f' } });
    const [m] = findPersonsByDict('согласовать с Ефимом Борисовичем');
    expect(m.parse).toMatchObject({ kind: 'fm', lemma: { first: 'ефим', patronymic: 'борисович', gender: 'm' } });
  });

  it('фамилия только по суффиксу: нужно согласование рода и падежа', () => {
    expect(texts('Заявку подал Ефим Шмелькин.')).toEqual(['Ефим Шмелькин']);
    expect(texts('Заявку подал Ефим Шмелькиной.')).toEqual([]);
  });

  it('имя-омоним: только со словарной фамилией, согласованием и не в начале предложения', () => {
    expect(texts('Отчёт подготовила Вера Павловская.')).toEqual(['Вера Павловская']);
    expect(texts('Вера Павловская подготовила отчёт.')).toEqual([]);
    expect(texts('Отчёт подготовила Вера Павловскому.')).toEqual([]);
  });

  it('заголовок: только сильное имя и словарная фамилия', () => {
    expect(texts('Список Участников Прохор Шмелькин')).toEqual([]);
    expect(texts('Список Участников Прохор Шевчук')).toEqual(['Прохор Шевчук']);
  });

  it('начало предложения: после точки, двоеточия, нумерации и кавычек', () => {
    expect(atSentenceStart('Иван', 0)).toBe(true);
    expect(atSentenceStart('Конец. Иван', 7)).toBe(true);
    expect(atSentenceStart('1.2. Иван', 5)).toBe(true);
    expect(atSentenceStart('Итог: «Иван', 7)).toBe(true);
    expect(atSentenceStart('передать Ивану', 9)).toBe(false);
    expect(atSentenceStart('пункт 3 Иван', 8)).toBe(false);
  });

  it('два сильных имени подряд — не пара', () => {
    expect(texts('пришли Анна Мария и другие')).toEqual([]);
  });
});

describe('документ third-persons (К8): третьи лица без лейблов', () => {
  beforeEach(() => registerNames());

  it('все записанные формы найдены, падежи одного лица — одна группа, негативы не тронуты', async () => {
    const { buildFixtures } = await import('../../../scripts/gen-fixtures.mjs');
    const { parseDocx } = await import('../../../src/core/docx/model.js');
    const { analyze } = await import('../../../src/core/detect/runner.js');
    const f = buildFixtures().find((x) => x.name === 'third-persons');
    const res = await analyze(parseDocx(f.bytes), allOnSettings());
    const groups = res.groups.filter((g) => g.category === 'PERSON');
    const groupOf = (t) => groups.find((g) => g.occurrences.some((o) => o.text === t));
    for (const { value } of f.gold.filter((x) => x.category === 'PERSON')) expect(groupOf(value), value).toBeTruthy();
    expect(groupOf('Зульфие Хасановой')).toBe(groupOf('Зульфия Хасанова'));
    expect(groupOf('Прохору Шевчуку')).toBe(groupOf('Прохора Шевчука'));
    const all = groups.flatMap((g) => g.occurrences.map((o) => o.text)).join(' | ');
    for (const neg of ['Ивана Петрова', 'Лада Веста', 'Иван Купала', 'Торговый Дом', 'Альфа Банк', 'Порядок Приёмки']) expect(all).not.toContain(neg);
    // без словаря третьи лица вне курируемого списка имён не находятся
    const off = await analyze(parseDocx(f.bytes), allOnSettings({ dictNames: false }));
    const offTexts = off.entities.filter((e) => e.category === 'PERSON').map((e) => e.text);
    expect(offTexts).not.toContain('Зульфие Хасановой');
    expect(offTexts).not.toContain('Brenda Collins');
  });
});

describe('латинские названия фирм — не лица (ревью WP-N1)', () => {
  beforeEach(() => registerNames());
  const texts = (t) => findPersonsByDict(t).map((s) => t.slice(s.start, s.end));
  const fill = (n) => Array.from({ length: n }, (_, i) => `${i + 1}. Стороны соблюдают условия пункта ${i + 1}.`);
  const pc = (r) => r.entities.filter((e) => e.category === 'PERSON' || e.category === 'COMPANY').map((e) => `${e.category}:${e.text}`);

  it('хвост названия после пары и «<Слово> of» перед ней', () => {
    expect(texts('The Guarantor is Brenda Collins Holdings.')).toEqual([]);
    expect(texts('Advisory services by Wesley Barnes & Co. are excluded.')).toEqual([]);
    expect(texts('Fees are paid to Wesley Barnes, LLP within ten days.')).toEqual([]);
    expect(texts('Fees are paid to Wesley Barnes and Partners within ten days.')).toEqual([]);
    expect(texts('The Fund of Brenda Collins is the Lender.')).toEqual([]);
    expect(texts('The Lender is Oliver International.')).toEqual([]);
    // перечисление лиц и хвост без заглавной — лица
    expect(texts('Copies to Wesley Barnes and Brenda Collins.')).toEqual(['Wesley Barnes', 'Brenda Collins']);
    expect(texts('Signed on behalf of Brenda Collins by the agent.')).toEqual(['Brenda Collins']);
  });

  it('«Clifford Chance» при «Clifford Chance LLP» в другом абзаце — COMPANY, не PERSON', async () => {
    const r = await analyzeParagraphs(
      ['Legal counsel to the Lenders: Clifford Chance LLP.', 'The opinion was issued by Clifford Chance on the Closing Date.'],
      allOnSettings(),
    );
    expect(pc(r)).toEqual(['COMPANY:Clifford Chance LLP', 'COMPANY:Clifford Chance']);
    expect(r.groups.filter((g) => g.category === 'COMPANY')).toHaveLength(1);
  });

  it('пара, совпадающая с названием компании без ОПФ или его началом, — вхождение компании (и не сторона)', async () => {
    for (const [company, mention] of [
      ['Brenda Collins LLP', 'Brenda Collins'],
      ['Wesley Barnes Legal LLP', 'Wesley Barnes'],
      ['ООО «Зульфия Хасанова»', 'Зульфия Хасанова'],
    ]) {
      // компания в середине документа — не в зоне сторон
      const r = await analyzeParagraphs([...fill(5), `Консультант: ${company}.`, `Заключение подготовила ${mention} в срок.`, ...fill(8)], allOnSettings());
      expect(pc(r), mention).toEqual([`COMPANY:${company}`, `COMPANY:${mention}`]);
      const g = r.groups.filter((x) => x.category === 'COMPANY');
      expect(g, mention).toHaveLength(1);
    }
  });

  it('пара правил после настоящего лейбла остаётся лицом', async () => {
    const r = await analyzeParagraphs([...fill(5), 'Counsel: Oliver Hart LLP.', 'Signed by Oliver Hart.', ...fill(8)], allOnSettings());
    expect(pc(r)).toEqual(['COMPANY:Oliver Hart LLP', 'PERSON:Oliver Hart']);
  });
});

describe('«Имя Отчество» правил — запись fm (ревью WP-N1)', () => {
  beforeEach(() => registerNames());

  it.each([true, false])('три падежные формы «Ольга Петровна» — одна группа (dictNames: %s)', async (dictNames) => {
    const r = await analyzeParagraphs(
      ['Вопросы решать с Ольгой Петровной в рабочее время.', 'Ольга Петровна подтвердила получение.', 'Акт передан Ольге Петровне лично.'],
      allOnSettings({ dictNames }),
    );
    const groups = r.groups.filter((g) => g.category === 'PERSON');
    expect(groups).toHaveLength(1);
    expect(groups[0].occurrences.map((o) => o.text)).toEqual(['Ольгой Петровной', 'Ольга Петровна', 'Ольге Петровне']);
  });

  it('несогласованное по роду «отчество» остаётся парой «Имя Фамилия»', async () => {
    const r = await analyzeParagraphs(['Акт подписала Анна Петрович.'], allOnSettings());
    const p = r.entities.filter((e) => e.category === 'PERSON');
    expect(p.map((e) => e.text)).toEqual(['Анна Петрович']);
  });
});
