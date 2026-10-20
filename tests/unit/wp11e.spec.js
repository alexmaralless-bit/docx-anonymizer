// WP11-E (финальная проверка 0.4.0): бренд владельца не маскируется ни одним путём (решение владельца 6) — правила, KB,
// список компаний, модель ORG/PER/LOC (стаб и, при NER_MODEL_DIR, модель 1.1.0); метка в соседней ячейке строки таблицы;
// индекс перед адресом; «г. …, ул. …, д. …» без метки; иностранные индексы и UK VAT; обращения, «Фамилия И.», имя лица,
// названного выше; LOC модели на имени; стоп-список ORG; код ТН ВЭД под заголовком из двух строк PDF. Данные вымышленные.
import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import { analyze, parseDocx, fromText, defaultSettings, registerBuiltinDetectors, clearDetectors, buildCatalog } from '../../src/core/index.js';
import { makeDocx, para, run } from '../helpers/docx.js';
import { tableHeaders } from '../../src/core/detect/tables.js';
import { findAddresses, detectAddress, addressTailEnd } from '../../src/core/detect/names/address.js';
import { detectTaxId, detectInn } from '../../src/core/detect/identifiers/numeric.js';
import { filterOrgSpans } from '../../src/core/ner/filters.js';
import { filterPersonLocSpans } from '../../src/core/ner/filters-pl.js';
import { findVocativeNames } from '../../src/core/detect/names/vocative.js';
import { loadNerProvider } from '../../scripts/eval-genres.mjs';

const MODEL_DIR = process.env.NER_MODEL_DIR ? resolve(process.env.NER_MODEL_DIR) : '';
const commercial = () => ({ ...defaultSettings(), commercial: true });
const P = (t) => para(run(t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')));
const tbl = (rows) => `<w:tbl>${rows.map((r) => `<w:tr>${r.map((c) => `<w:tc>${P(c)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`;
const docx = (body) => parseDocx(makeDocx(body));
const ents = (a) => a.entities.map((e) => `${e.category}:${e.text}`);

beforeAll(() => {
  clearDetectors();
  registerBuiltinDetectors();
});

/** Стаб NER: метка на каждое вхождение значения. */
const stub = (pairs) => ({
  name: 'stub',
  init: async () => {},
  detect: async (text) =>
    pairs.flatMap(([v, label]) => {
      const out = [];
      for (let i = text.indexOf(v); i >= 0; i = text.indexOf(v, i + 1)) out.push({ start: i, end: i + v.length, label, score: 0.99 });
      return out;
    }),
});

const BRAND_LINES = [
  'Коммерческое предложение подготовила Студия Sitimlab.',
  'Исполнитель — ООО «Sitimlab», ИНН 7700000000.',
  'Компания Ситимлаб благодарит за интерес; команда Ситимлаба на связи.',
  'Sitimlab Studio and Sitimlab LLC thank you.',
];
const BRAND_SPANS = ['Студия Sitimlab', 'ООО «Sitimlab»', 'Компания Ситимлаб', 'Ситимлаба', 'Sitimlab Studio', 'Sitimlab LLC', 'Sitimlab'];
const brandLeft = (a) => a.entities.filter((e) => /sitimlab|ситимлаб/iu.test(e.text)).map((e) => `${e.category}/${e.source}:${e.text}`);

describe('п. 1: бренд владельца не маскируется никогда', () => {
  it('filterOrgSpans: бренд в спане ORG — отброшен раньше ОПФ и родового слова; PER/LOC фильтр ORG не трогает', () => {
    for (const t of BRAND_LINES)
      for (const w of BRAND_SPANS) {
        const i = t.indexOf(w);
        if (i < 0) continue;
        expect(filterOrgSpans([{ start: i, end: i + w.length, label: 'ORG', score: 0.99 }], { text: t }), `${t} / ${w}`).toEqual([]);
      }
    const t = 'Студия Sitimlab и Иван Петров';
    const per = { start: t.indexOf('Иван'), end: t.length, label: 'PER', score: 0.99 };
    expect(filterOrgSpans([per], { text: t })).toEqual([per]);
  });

  it('правила, KB, список и стаб-модель ORG/PER/LOC: ни одной сущности с брендом в обоих режимах', async () => {
    const doc = docx(BRAND_LINES.map(P).join(''));
    for (const label of ['ORG', 'PER', 'LOC']) {
      const provider = stub(BRAND_SPANS.map((v) => [v, label]));
      for (const settings of [defaultSettings(), commercial(), { ...commercial(), maskedCompanies: [{ name: 'Sitimlab', aliases: ['Ситимлаб'] }] }]) {
        const a = await analyze(doc, settings, { nerProvider: provider });
        expect(brandLeft(a), `${label} ${settings.commercial ? 'commercial' : 'normal'}`).toEqual([]);
      }
    }
  });

  it.skipIf(!MODEL_DIR)(
    'реальная модель (NER_MODEL_DIR): бренд не маскируется в обоих режимах',
    async () => {
      const provider = await loadNerProvider(MODEL_DIR);
      try {
        const doc = docx(BRAND_LINES.map(P).join(''));
        for (const settings of [defaultSettings(), commercial()]) expect(brandLeft(await analyze(doc, settings, { nerProvider: provider }))).toEqual([]);
      } finally {
        provider?.dispose?.();
      }
    },
    60000,
  );
});

describe('п. 2–3: метка в соседней ячейке строки, индекс перед адресом', () => {
  const rows = [
    ['Дата рождения', '17.11.1993'],
    ['Паспорт', '4510 123456'],
    ['СНИЛС', '128-754-390 90'],
    ['Адрес регистрации', '614068, Пермь, Екатерининская, 163, кв. 47'],
    ['Телефон', '8 999 003 71 28'],
  ];
  it('tableHeaders: ячейка слева в строке — rowHeader (DOCX и PDF)', () => {
    const d = docx(tbl(rows));
    const h = tableHeaders(d);
    const pidOf = (t) => d.paragraphs.find((p) => d.streamById.get(p.streams.live)?.text === t).pid;
    expect(h.row.get(pidOf('17.11.1993'))).toBe('Дата рождения');
    expect(h.row.get(pidOf('Дата рождения'))).toBeUndefined();
    const t = fromText(rows.flatMap((r, i) => r.map((c, j) => ({ kind: 'cell', text: c, page: 1, table: { index: 0, row: i, col: j, cols: 2 } }))));
    expect([...tableHeaders(t).row.values()]).toEqual(rows.map((r) => r[0]));
  });

  it('analyze: значения под меткой строки найдены как помеченные — DOCX и PDF', async () => {
    const want = [
      'BIRTHDATE:17.11.1993',
      'PASSPORT:4510 123456',
      'SNILS:128-754-390 90',
      'ADDRESS:614068, Пермь, Екатерининская, 163, кв. 47',
      'PHONE:8 999 003 71 28',
    ];
    const a = await analyze(docx(tbl(rows)), defaultSettings());
    for (const w of want) expect(ents(a), w).toContain(w);
    const t = fromText(rows.flatMap((r, i) => r.map((c, j) => ({ kind: 'cell', text: c, page: 1, table: { index: 0, row: i, col: j, cols: 2 } }))));
    const b = await analyze(t, defaultSettings());
    for (const w of want) expect(ents(b), w).toContain(w);
    // без метки строки дата — не дата рождения
    expect(ents(await analyze(docx(tbl([['Срок', '17.11.1993']])), defaultSettings()))).toEqual([]);
  });

  it('индекс перед адресом входит в адрес; адрес под меткой строки — labeled; длинная ячейка слева — не метка', () => {
    expect(findAddresses('614068, Пермь, Екатерининская, 163, кв. 47').map((a) => a.start)).toEqual([0]);
    expect(detectAddress('Пермь, Комсомольский 34', { stream: { rowHeader: 'Адрес' } })).toEqual([
      { start: 0, end: 23, confidence: 'labeled', source: 'label' },
    ]);
    expect(
      detectAddress('ИНН/КПП 500400123402/500401001', { stream: { rowHeader: 'Поставщик: ООО «Ромашка», адрес и реквизиты указаны ниже в таблице' } }),
    ).toEqual([]);
  });
});

describe('п. 4–5: адреса без метки, иностранные индексы, UK VAT', () => {
  const found = (t) => findAddresses(t).map((a) => `${a.confidence}:${t.slice(a.start, a.end)}`);
  it('«г. …, ул. …, д. …» без метки и индекса — weak; без города или без дома — нет', () => {
    expect(found('Собрание собственников дома: г. Воронеж, ул. Липовая, д. 15.')).toEqual(['weak:г. Воронеж, ул. Липовая, д. 15']);
    expect(found('г. Москва, ул. Тверская, д. 7')).toEqual(['weak:г. Москва, ул. Тверская, д. 7']);
    for (const t of ['ул. Ленина, д. 1', 'г. Москва, ул. Тверская', 'г. Москва, 15 сентября 2026 г.']) expect(found(t), t).toEqual([]);
    expect(addressTailEnd('Воронеже, д. 15, кв. 3.', 8)).toBe('Воронеже, д. 15, кв. 3'.length);
  });
  it('«Улица N, NNNN[-NNN] Город[, Страна]»', () => {
    expect(found('of Strandveien 61, 0252 Oslo, Norway ("Halvorsen")')).toEqual(['weak:Strandveien 61, 0252 Oslo, Norway']);
    expect(found('Rua das Flores 112, 1200-195 Lisboa, Portugal · +44 7700 900431')).toEqual(['weak:Rua das Flores 112, 1200-195 Lisboa, Portugal']);
    for (const t of ['Section 12, 2026 Report', 'Invoice 2026, 1200 Items']) expect(found(t), t).toEqual([]);
  });
  it('UK VAT: с меткой — любой формат GB, без метки — только «GB 318 4471 26»', () => {
    const ctx = { catalog: buildCatalog({}), stream: {} };
    const got = (t) => detectTaxId(t, ctx).map((c) => t.slice(c.start, c.end));
    expect(got('VAT number GB 318 4471 26, having')).toEqual(['GB 318 4471 26']);
    expect(got('VAT No. GB318447126')).toEqual(['GB318447126']);
    expect(got('VAT reg. GB 318447126')).toEqual(['GB 318447126']);
    expect(got('the code GB 318 4471 26 here')).toEqual(['GB 318 4471 26']);
    expect(got('GB318447126 random')).toEqual([]);
  });
});

describe('п. 6–9: обращения, «Фамилия И.», имя лица, LOC на имени, стоп-список', () => {
  const names = (t) => findVocativeNames(t).map((v) => v.name);
  it('подпись реплики одним именем, «Спасибо, Ринат!», «…. Тамара, а…», цитата «> Олеся,», «потом Святослав.»', () => {
    expect(names('[09.10.2026 09:01] Ринат: Я до обеда, потом Святослав.')).toEqual(['Ринат', 'Святослав']);
    expect(names('[09:12] Святослав Еременко: Спасибо, Ринат!')).toEqual(['Ринат']);
    expect(names('Ок, возьму. Тамара, а кто подпишет?')).toEqual(['Тамара']);
    expect(names('> Олеся, здравствуйте.')).toEqual(['Олеся']);
    for (const t of [
      'Поддержка: Добрый день!',
      'Встреча прошла в Москве.',
      'г. Владимир, 14 августа 2026 года',
      'Счёт выставлен, Максим.',
      'Слава богу, всё хорошо.',
    ])
      expect(names(t), t).toEqual([]);
  });

  it('«Фамилия И.» с одним инициалом; имя одним словом у лица, названного полностью; «г. Владимир» — не имя', async () => {
    const a = await analyze(docx([P('Характеристику подписала Огурцова М. по запросу.')].join('')), defaultSettings());
    expect(ents(a)).toEqual(['PERSON:Огурцова М.']);
    const b = await analyze(docx([P('Participants: Victoria Ashdown, investor.'), P('Victoria presented the term sheet.')].join('')), defaultSettings());
    expect(ents(b)).toEqual(['PERSON:Victoria Ashdown', 'PERSON:Victoria']);
    expect(b.groups).toHaveLength(1);
    const c = await analyze(docx([P('г. Владимир, 14 августа 2026 года'), P('Займодавец: Сидоров Владимир Петрович.')].join('')), defaultSettings());
    expect(ents(c)).toEqual(['PERSON:Сидоров Владимир Петрович']);
  });

  it('LOC модели на имени из словаря вне адреса — PER; омоним и город — нет', () => {
    const t = '> Олеся, здравствуйте. Пишу из Самары.';
    const loc = (w) => ({ start: t.indexOf(w), end: t.indexOf(w) + w.length, label: 'LOC', score: 0.99 });
    expect(filterPersonLocSpans([loc('Олеся'), loc('Самары')], { text: t }).map((s) => `${s.label}:${t.slice(s.start, s.end)}`)).toEqual(['PER:Олеся']);
  });

  it('стоп-список ORG: KYC, AML, учёные степени, «Confidential Information»', () => {
    for (const [t, w] of [
      ['KYC is pending.', 'KYC'],
      ['AML checks passed.', 'AML'],
      ['MSc Computer Science, 2019', 'MSc Computer Science'],
      ['The Confidential Information secret clause applies.', 'Confidential Information secret'],
      ['Holds an MBA degree.', 'MBA'],
    ]) {
      const i = t.indexOf(w);
      expect(filterOrgSpans([{ start: i, end: i + w.length, label: 'ORG', score: 0.99 }], { text: t }), w).toEqual([]);
    }
  });
});

describe('п. 10: код ТН ВЭД под заголовком из двух строк PDF', () => {
  it('заголовок столбца — все строки до первой строки с цифрами («» + «ВЭД»); число 10 цифр — не ИНН', () => {
    const cells = [
      ['№', 'Наименование Код ТН', '', 'Кол-во'],
      ['', '', 'ВЭД', ''],
      ['1', 'Подшипник', '8471300000', '400'],
    ];
    const t = fromText(cells.flatMap((r, i) => r.map((c, j) => ({ kind: 'cell', text: c, page: 1, table: { index: 0, row: i, col: j, cols: 4 } }))));
    const h = tableHeaders(t);
    const pid = t.blocks.find((b) => b.text === '8471300000').pid;
    expect(h.column.get(pid)).toBe('ВЭД');
    const ctx = { stream: { columnHeader: 'ВЭД' }, catalog: buildCatalog({}) };
    expect(detectInn('8471300000', ctx)).toEqual([]);
    expect(detectInn('500100732259', ctx)).toHaveLength(1);
  });
});

// WP11-E, вторая часть (heldout4 финального ревьюера)
describe('WP11-E (2): европейский налоговый номер, лицо и телефон по меткам таблицы, петербургские и латинские адреса, Telegram', () => {
  const ctx = (h = {}) => ({ catalog: buildCatalog({}), stream: h });
  it('TAXID по меткам USt-IdNr., TVA, NIF, P.IVA с форматом страны', () => {
    const got = (t) => detectTaxId(t, ctx()).map((c) => t.slice(c.start, c.end));
    expect(got('USt-IdNr.: DE287415603')).toEqual(['DE287415603']);
    expect(got('USt-ID DE287415603')).toEqual(['DE287415603']);
    expect(got('TVA FR40303265045')).toEqual(['FR40303265045']);
    expect(got('P.IVA IT12345678901')).toEqual(['IT12345678901']);
    // без метки и с неверным форматом — нет
    expect(got('Ref DE287415603')).toEqual([]);
    expect(got('USt-IdNr.: DE2874')).toEqual([]);
  });

  const form = [
    ['Фамилия', 'Чернышева'],
    ['Имя', 'Ангелина'],
    ['Отчество', 'Вадимовна'],
    ['ФИО представителя', 'Лаптев Игорь Олегович'],
    ['Surname', 'Okonkwo'],
    ['Гражданство', 'Российская Федерация'],
  ];
  it('PERSON по метке строки: «Фамилия», «Имя», «Отчество», «Surname» — одно слово; «ФИО» — до трёх слов (DOCX и PDF)', async () => {
    const want = ['PERSON:Чернышева', 'PERSON:Ангелина', 'PERSON:Вадимовна', 'PERSON:Okonkwo'];
    const a = await analyze(docx(tbl(form)), defaultSettings());
    for (const w of want) expect(ents(a), w).toContain(w);
    expect(ents(a).filter((e) => e.includes('Российская'))).toEqual([]);
    const t = fromText(form.flatMap((r, i) => r.map((c, j) => ({ kind: 'cell', text: c, page: 1, table: { index: 0, row: i, col: j, cols: 2 } }))));
    const b = await analyze(t, defaultSettings());
    for (const w of want) expect(ents(b), w).toContain(w);
    // под меткой «Имя» — не одно слово: не берётся
    expect(ents(await analyze(docx(tbl([['Имя', 'не указано']])), defaultSettings()))).toEqual([]);
  });

  it('телефон без «+7» под заголовком столбца «Телефон»; без заголовка — нет', async () => {
    const rows = [
      ['Клиент', 'Телефон'],
      ['ООО «Ромашка»', '(999) 004-55-17'],
      ['ООО «Вектор»', '999 004-55-18'],
    ];
    const a = await analyze(docx(tbl(rows)), defaultSettings());
    expect(ents(a).filter((e) => e.startsWith('PHONE'))).toEqual(['PHONE:(999) 004-55-17', 'PHONE:999 004-55-18']);
    const b = await analyze(
      docx(
        tbl([
          ['Клиент', 'Код'],
          ['ООО «Ромашка»', '(999) 004-55-17'],
        ]),
      ),
      defaultSettings(),
    );
    expect(ents(b).filter((e) => e.startsWith('PHONE'))).toEqual([]);
  });

  const found = (t) => findAddresses(t).map((a) => `${a.confidence}:${t.slice(a.start, a.end)}`);
  it('«наб. реки Мойки», «наб. канала Грибоедова» — часть адреса', () => {
    expect(found('Адрес: 190000, г. Санкт-Петербург, наб. реки Мойки, д. 58, кв. 7')).toEqual([
      'labeled:190000, г. Санкт-Петербург, наб. реки Мойки, д. 58, кв. 7',
    ]);
    expect(found('г. Санкт-Петербург, наб. реки Мойки, д. 58, кв. 7')).toEqual(['weak:г. Санкт-Петербург, наб. реки Мойки, д. 58, кв. 7']);
    expect(found('г. Санкт-Петербург, наб. канала Грибоедова, д. 5')).toEqual(['weak:г. Санкт-Петербург, наб. канала Грибоедова, д. 5']);
  });
  it('российский адрес латиницей', () => {
    expect(found('Delivery: ul. Frezerovshchikov 8, office 12, 620017 Yekaterinburg, Russia.')).toEqual([
      'weak:ul. Frezerovshchikov 8, office 12, 620017 Yekaterinburg, Russia',
    ]);
    expect(found('per. Tuchkov 11/5, 199004 Saint Petersburg')).toEqual(['weak:per. Tuchkov 11/5, 199004 Saint Petersburg']);
  });

  it('подпись Telegram «Имя, [дата]», «Имя Ф., [дата]»; имя подписи в косвенном падеже — то же лицо', async () => {
    const t = (s) => findVocativeNames(s).map((v) => s.slice(v.start, v.end));
    expect(t('Арсений, [14.10.2026 10:11]')).toEqual(['Арсений']);
    expect(t('Валерия К., [14.10.2026 10:05]')).toEqual(['Валерия К.']);
    expect(t('Итак, [см. приложение]')).toEqual([]);
    const a = await analyze(docx([P('Арсений, [14.10.2026 10:11]'), P('Да, передам через Арсения.')].join('')), defaultSettings());
    expect(ents(a)).toEqual(['PERSON:Арсений', 'PERSON:Арсения']);
    expect(a.groups).toHaveLength(1);
  });

  it('ловушки модели: перечисление мест, «145000» после тире, «офис» без номера, «Пролетарским районным», роль стороны, «Роман, который»', () => {
    const keep = (text, pairs, extra = {}) =>
      filterPersonLocSpans(
        pairs.map(([w, label]) => ({ start: text.indexOf(w), end: text.indexOf(w) + w.length, label, score: 0.99 })),
        { text, ...extra },
      ).map((s) => `${s.label}:${text.slice(s.start, s.end)}`);
    const list = 'Новые направления четвёртого квартала: Москва, Тверь, Клин. Объём — 145000, Казань — 98000, Самара — 61000 тонно-километров.';
    expect(
      keep(list, [
        ['Москва', 'LOC'],
        ['Тверь', 'LOC'],
        ['Клин', 'PER'],
        ['Казань', 'LOC'],
        ['Самара', 'LOC'],
      ]),
    ).toEqual([]);
    expect(keep('Итак, Москва. Решили: офис остаётся здесь, переезд отменяем.', [['Москва', 'LOC']])).toEqual([]);
    expect(
      keep('Итак, Москва. Итог по региону — 12,4 млн руб., Санкт-Петербург, Казань и Пермь — без изменений.', [
        ['Москва', 'LOC'],
        ['Пермь', 'LOC'],
      ]),
    ).toEqual([]);
    expect(keep('2.3. Споры рассматриваются Пролетарским районным судом г. Тулы.', [['Пролетарским', 'LOC']])).toEqual([]);
    expect(keep('Деньги переданы без согласия Займодавца.', [['Займодавца', 'PER']])).toEqual([]);
    expect(keep('Роман, который мы обсуждали, — книга.', [['Роман', 'PER']])).toEqual([]);
    expect(keep('Хошимин', [['Хошимин', 'LOC']], { columnHeader: 'Город' })).toEqual([]);
    // а человек остаётся: фамилия-LOC вне перечисления, адрес с номером офиса
    expect(keep('На объект приезжал представитель подрядчика Лисицын.', [['Лисицын', 'LOC']])).toEqual(['PER:Лисицын']);
    expect(keep('Казань, проспект Победы, офис 4', [['Казань', 'LOC']])).toEqual(['LOC:Казань']);
  });
});
