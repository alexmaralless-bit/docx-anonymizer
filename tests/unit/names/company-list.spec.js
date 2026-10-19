// Список компаний для маскирования (0.4, К3, contracts §8.2): падежи, ОПФ и кавычки, другой алфавит, псевдонимы,
// одна метка, исключения, DOCX и текстовая модель PDF. Данные вымышленные.
import { describe, it, expect, beforeEach } from 'vitest';
import { registerNames, analyzeParagraphs, commercialSettings } from './helpers.js';
import { defaultSettings } from '../../../src/core/settings.js';
import { analyze } from '../../../src/core/detect/runner.js';
import { fromText } from '../../../src/core/text/model.js';
import { companyCore, wordPattern } from '../../../src/core/detect/names/company-list.js';

const listSettings = (maskedCompanies, patch = {}) => ({ ...defaultSettings(), maskedCompanies, ...patch });
const companies = (r) => r.entities.filter((e) => e.category === 'COMPANY');
const texts = (r) => companies(r).map((e) => e.text);
const cores = (r) => companies(r).map((e) => e.text.slice(e.keepPrefix, e.text.length - e.keepSuffix));

describe('ядро названия и шаблон слова', () => {
  it('companyCore снимает ОПФ, латинскую ОПФ и внешние кавычки', () => {
    expect(companyCore('ООО «Ромашка»')).toBe('Ромашка');
    expect(companyCore('Общество с ограниченной ответственностью "Ромашка-Трейд"')).toBe('Ромашка-Трейд');
    expect(companyCore('Romashka LLC')).toBe('Romashka');
    expect(companyCore('  Ромашка  ')).toBe('Ромашка');
    expect(companyCore('АО «Торговый дом «Ромашка»»')).toBe('Торговый дом «Ромашка»');
  });

  it('wordPattern: основа + окончание для кириллицы ≥ 5 букв, иначе точное слово', () => {
    const re = (w) => new RegExp(`^${wordPattern(w)}$`, 'iu');
    for (const f of ['Ромашка', 'Ромашки', 'Ромашке', 'Ромашку', 'Ромашкой', 'РОМАШКИ']) expect(re('Ромашка').test(f), f).toBe(true);
    for (const f of ['Ромашкаус', 'Ромаш', 'Ромашкин']) expect(re('Ромашка').test(f), f).toBe(false);
    for (const f of ['Вектор', 'Вектора', 'Вектором', 'Векторе']) expect(re('Вектор').test(f), f).toBe(true);
    expect(re('Вектор').test('Вектра')).toBe(false);
    expect(re('Бета').test('Беты')).toBe(false); // ≤ 4 букв — точно
    expect(re('Romashka').test('Romashki')).toBe(false); // латиница — точно
    expect(re('Ёлка-Стиль'.split('-')[1]).test('Стилем')).toBe(true);
    // слово названия из нескольких слов: короткое тоже склоняется («Цветочного дома»)
    expect(new RegExp(`^${wordPattern('дом', true)}$`, 'iu').test('дома')).toBe(true);
  });
});

describe('детектор company-list (К3)', () => {
  beforeEach(() => registerNames());

  it('все падежи, с ОПФ и без, в кавычках и без; одна метка; работает при выключенной коммерческой группе', async () => {
    const r = await analyzeParagraphs(
      [
        'ООО «Ромашка», ИНН указан ниже.',
        'Документы Ромашки переданы.',
        'Счёт выставлен Ромашке.',
        'Договор с Ромашкой продлён.',
        'Поставщик: «Ромашка».',
        'Общество с ограниченной ответственностью «Ромашка» уведомлено.',
      ],
      listSettings([{ name: 'Ромашка', aliases: [] }]),
    );
    expect(texts(r)).toEqual(['ООО «Ромашка»', 'Ромашки', 'Ромашке', 'Ромашкой', '«Ромашка»', 'Общество с ограниченной ответственностью «Ромашка»']);
    expect(cores(r)).toEqual(['Ромашка', 'Ромашки', 'Ромашке', 'Ромашкой', 'Ромашка', 'Ромашка']);
    expect(companies(r).every((e) => e.source === 'list' && e.confidence === 'labeled')).toBe(true);
    const g = r.groups.filter((x) => x.category === 'COMPANY');
    expect(g).toHaveLength(1);
    expect(g[0].occurrences).toHaveLength(6);
    expect(g[0].source).toBe('list');
  });

  it('другой алфавит и псевдоним — та же метка; «Ромашка-Трейд» — отдельная запись со своими падежами', async () => {
    const r = await analyzeParagraphs(
      ['Romashka LLC is the supplier.', 'Счёт от «Цветочного дома» принят.', 'АО «Ромашка-Трейд» и Ромашка-Трейда — одно лицо.'],
      listSettings([
        { name: 'ООО «Ромашка»', aliases: ['Цветочный дом'] },
        { name: 'Ромашка-Трейд', aliases: [] },
      ]),
    );
    expect(texts(r)).toEqual(['Romashka LLC', '«Цветочного дома»', 'АО «Ромашка-Трейд»', 'Ромашка-Трейда']);
    const g = r.groups.filter((x) => x.category === 'COMPANY');
    expect(g).toHaveLength(2);
    expect(g[0].occurrences.map((o) => o.text)).toEqual(['Romashka LLC', '«Цветочного дома»']);
  });

  it('кириллица ищется по латинскому названию из списка', async () => {
    const r = await analyzeParagraphs(['Работы выполняет ООО «Ромашка».'], listSettings([{ name: 'Romashka' }]));
    expect(texts(r)).toEqual(['ООО «Ромашка»']);
  });

  it('границы слова: «Ромашкаус», «Ромашка-Трейд» для «Ромашка», адрес почты и домен — не совпадают', async () => {
    const r = await analyzeParagraphs(
      ['Ромашкаус поставляет товар.', 'ООО «Ромашка-Трейд» — другое лицо.', 'Пишите на romashka@example.ru и sales.romashka.example.'],
      listSettings([{ name: 'Ромашка' }, { name: 'Romashka' }]),
    );
    expect(texts(r)).toEqual([]);
  });

  it('3-буквенное название — только точное слово; строчное написание названия с заглавной — не название', async () => {
    const r = await analyzeParagraphs(
      ['Работы выполняет ООО «Рог». Рога и копыта не включены.', 'На лугу растёт ромашка.'],
      listSettings([{ name: 'Рог' }, { name: 'Ромашка' }]),
    );
    expect(texts(r)).toEqual(['ООО «Рог»']);
  });

  it('название из списка маскируется в начале предложения, после «:», в пункте и в ячейке — даже общее слово (К3, ревью WP11-A)', async () => {
    const r = await analyzeParagraphs(
      ['Поставщик: Ромашка, ИНН 7736050003.', 'Ромашка обязуется поставить товар.', '1. Ромашка передаёт товар.', 'Ромашка', 'Старт работ — 1 марта.'],
      listSettings([{ name: 'Ромашка' }, { name: 'Старт' }]),
    );
    const comp = r.entities.filter((e) => e.category === 'COMPANY').map((e) => e.text);
    expect(comp).toEqual(['Ромашка', 'Ромашка', 'Ромашка', 'Ромашка', 'Старт']);
    expect(new Set(r.groups.filter((g) => g.category === 'COMPANY').map((g) => g.placeholder)).size).toBe(2);
  });

  it('бренд владельца в списке игнорируется (решение 6): ни название, ни псевдоним', async () => {
    const r = await analyzeParagraphs(
      ['Студия Sitimlab и ООО «Ситимлаб» подготовили КП для ООО «Ромашка».'],
      listSettings([{ name: 'Sitimlab' }, { name: 'Ромашка', aliases: ['Ситимлаб'] }]),
    );
    expect(cores(r)).toEqual(['Ромашка']);
  });

  it('exclusions снимают находку списка (FR-32 после детекторов)', async () => {
    const r = await analyzeParagraphs(
      ['ООО «Ромашка» и ООО «Вектор» подписали акт.'],
      listSettings([{ name: 'Ромашка' }, { name: 'Вектор' }], { exclusions: [{ value: 'ромашка', category: 'COMPANY' }] }),
    );
    expect(cores(r)).toEqual(['Вектор']);
  });

  it('коммерческий режим: правило и список дают одну метку на компанию', async () => {
    const r = await analyzeParagraphs(
      ['ООО «Ромашка» и ООО «Вектор» подписали акт.', 'Уведомление направлено Ромашке.'],
      commercialSettings({ maskedCompanies: [{ name: 'Ромашка' }] }),
    );
    const g = r.groups.filter((x) => x.category === 'COMPANY');
    expect(g.map((x) => x.occurrences.map((o) => o.text))).toEqual([['ООО «Ромашка»', 'Ромашке'], ['ООО «Вектор»']]);
    // название правил из списка — source 'list' (строка «из списка» в панели), остальные организации — правила
    expect(g.map((x) => x.source)).toEqual(['list', 'rule']);
  });

  it('пустой список — ничего; без списка в обычном режиме COMPANY нет', async () => {
    const r = await analyzeParagraphs(['ООО «Ромашка» подписало акт.']);
    expect(texts(r)).toEqual([]);
  });

  it('текстовая модель PDF (fromText): ячейки и колонтитул, одна метка', async () => {
    const doc = fromText(
      [
        { kind: 'header', text: 'ООО «Ромашка» — Договор № 7' },
        { kind: 'h1', text: 'Договор поставки' },
        { kind: 'p', text: 'Поставщик обязуется передать товар Ромашке в срок.' },
        { kind: 'cell', text: 'АО «Ромашка»', table: { index: 0, cols: 2 } },
        { kind: 'cell', text: 'ИНН 7707123458', table: { index: 0, cols: 2 } },
      ],
      { name: 'a.pdf' },
    );
    const r = await analyze(doc, listSettings([{ name: 'Ромашка' }]));
    expect(texts(r).sort()).toEqual(['АО «Ромашка»', 'ООО «Ромашка»', 'Ромашке'].sort());
    expect(r.groups.filter((x) => x.category === 'COMPANY')).toHaveLength(1);
  });
});
