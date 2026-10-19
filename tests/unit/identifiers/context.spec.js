// Контекстные правила: ключ счёта по БИК в радиусе 500 символов (поток и документ), лейблы, границы, canonical паспорта.
import { describe, it, expect } from 'vitest';
import { detect } from './helper.js';
import { detectAccountByBikInDocument, detectInn, detectOgrn } from '../../../src/core/detect/identifiers/numeric.js';
import { goodsCodeContext } from '../../../src/core/detect/identifiers/labels.js';
import { columnHeaders, docxCells } from '../../../src/core/detect/tables.js';
import { analyze, parseDocx, fromText, defaultSettings, registerBuiltinDetectors, clearDetectors } from '../../../src/core/index.js';
import { makeDocx, para, run } from '../../helpers/docx.js';
import { normalizeValue, buildCatalog } from '../../../src/core/categories.js';

const BIK = '044525225';
// счёт с верным ключом к БИК 044525225 (веса 7-1-3 над «последние 3 цифры БИК + счёт»)
const ACC = (() => {
  const base = '40702810400000012345';
  const prefix = BIK.slice(6, 9);
  for (let k = 0; k < 10; k++) {
    const a = base.slice(0, 8) + k + base.slice(9);
    if ((prefix + a).split('').reduce((s, x, i) => s + ((Number(x) * [7, 1, 3][i % 3]) % 10), 0) % 10 === 0) return a;
  }
})();
const accounts = (text) => detect(text).filter((e) => e.category === 'ACCOUNT');

describe('ACCOUNT: ключ по БИК', () => {
  it('счёт без лейбла проходит, если БИК в радиусе 500 символов (до и после)', () => {
    expect(accounts(`БИК ${BIK}. ${'x'.repeat(300)} ${ACC}`).map((e) => e.level)).toEqual(['validated']);
    expect(accounts(`${ACC} ${'x'.repeat(300)} БИК ${BIK}`).map((e) => e.level)).toEqual(['validated']);
  });
  it('БИК дальше 500 символов — счёт без лейбла не находится', () => {
    expect(accounts(`БИК ${BIK}. ${'x'.repeat(600)} ${ACC}`)).toEqual([]);
    expect(accounts(`${ACC} ${'x'.repeat(600)} БИК ${BIK}`)).toEqual([]);
  });
  it('счёт с лейблом, но без БИК — labeled; с БИК и верным ключом — validated', () => {
    expect(accounts(`р/с ${ACC}`).map((e) => e.level)).toEqual(['labeled']);
    expect(accounts(`р/с ${ACC}, БИК ${BIK}`).map((e) => e.level)).toEqual(['validated']);
  });

  const stream = (id, part, text) => ({ id, part, type: 'live', text });
  const ctx = { catalog: buildCatalog({}) };
  it('документный детектор: БИК в соседнем абзаце/ячейке (та же часть), не дальше 500 символов', () => {
    const doc = { streams: [stream('a', 'word/document.xml', `Счёт ${ACC}`), stream('b', 'word/document.xml', `БИК ${BIK}`)] };
    const out = detectAccountByBikInDocument(doc, [], ctx);
    expect(out).toEqual([{ streamId: 'a', category: 'ACCOUNT', start: 5, end: 25, confidence: 'validated', source: 'rule', validator: 'account' }]);
    const far = {
      streams: [
        stream('a', 'word/document.xml', `Счёт ${ACC}`),
        stream('m', 'word/document.xml', 'y'.repeat(600)),
        stream('b', 'word/document.xml', `БИК ${BIK}`),
      ],
    };
    expect(detectAccountByBikInDocument(far, [], ctx)).toEqual([]);
    const other = { streams: [stream('a', 'word/document.xml', `Счёт ${ACC}`), stream('b', 'word/footer1.xml', `БИК ${BIK}`)] };
    expect(detectAccountByBikInDocument(other, [], ctx)).toEqual([]);
    const before = { streams: [stream('b', 'word/document.xml', `БИК ${BIK}`), stream('a', 'word/document.xml', `Счёт ${ACC}`)] };
    expect(detectAccountByBikInDocument(before, [], ctx).map((c) => c.streamId)).toEqual(['a']);
  });
});

describe('лейблы и границы', () => {
  it('ИНН рядом с «тел.» — PHONE, и наоборот', () => {
    const r = detect('тел. 7736050003; ИНН 7736050003');
    expect(r.map((e) => `${e.category}:${e.text}`)).toEqual(['PHONE:7736050003', 'INN:7736050003']);
  });
  it('цифровой идентификатор не часть более длинной последовательности', () => {
    expect(detect('12345 7736050003 9')).toHaveLength(1);
    expect(detect('177360500031')).toEqual([]);
    expect(detect('7736050003')).toHaveLength(1);
  });
  it('сущность не пересекает перенос строки; таб допустим', () => {
    for (const e of detect('ИНН 7736050003\n7736050003\tИНН\t7736050003')) expect(e.text).not.toContain('\n');
    expect(detect('ИНН\t7736050003').map((e) => e.text)).toEqual(['7736050003']);
  });
  it('лейбл дальше 40 символов не считается', () => {
    expect(detect(`ИНН ${'а'.repeat(50)} 7736050001`).filter((e) => e.category === 'INN')).toEqual([]);
  });
});

describe('PASSPORT: одна сущность из трёх вхождений', () => {
  it('canonical номера общий у органа выдачи и кода подразделения', () => {
    const r = detect('паспорт 45 05 123456, выдан ОВД района Арбат г. Москвы 12.03.2005, код подразделения 770-001').filter((e) => e.category === 'PASSPORT');
    expect(r).toHaveLength(3);
    const cat = buildCatalog({}).byId.get('PASSPORT');
    expect(r[0].canonical).toBeUndefined();
    expect(r[1].canonical).toBe('4505123456');
    expect(r[2].canonical).toBe('4505123456');
    expect(normalizeValue(cat, r[0].text)).toBe(normalizeValue(cat, r[1].canonical));
  });
});

// WP11-D (корпус жанров, УПД): КПП после «ИНН/КПП покупателя:», код ТН ВЭД с контрольной суммой ИНН
describe('KPP: «ИНН/КПП» со словами между меткой и номерами', () => {
  const kpps = (text) =>
    detect(text)
      .filter((e) => e.category === 'KPP')
      .map((e) => e.text);
  it('«ИНН/КПП покупателя: X/Y», «ИНН/КПП продавца», «ИНН / КПП: X / Y», «ИНН/КПП X / Y» — КПП найден', () => {
    expect(kpps('ИНН/КПП покупателя: 1690954450/169001001')).toEqual(['169001001']);
    expect(kpps('ИНН/КПП продавца 7736050003/773601001')).toEqual(['773601001']);
    expect(kpps('ИНН / КПП: 7736050003 / 773601001')).toEqual(['773601001']);
    expect(kpps('ИНН/КПП 7736050003 / 773601001')).toEqual(['773601001']);
    expect(kpps('ИНН/КПП 7736050003/773601001')).toEqual(['773601001']);
  });
  it('без «ИНН/КПП» второй номер через «/» — не КПП', () => {
    expect(kpps('Код 7736050003/773601001')).toEqual([]);
  });
});

describe('INN/OGRN: код товара — не идентификатор', () => {
  const S = { id: 's1', part: 'word/document.xml', pid: 'p1', type: 'live' };
  const ctx = (columnHeader) => ({ stream: { ...S, columnHeader }, language: 'ru', catalog: buildCatalog({}), settings: {} });
  it('ключевое слово сразу перед числом длины кода — ИНН с контрольной суммой не берётся', () => {
    for (const t of [
      'Код ТН ВЭД 8471300000',
      'ТН ВЭД ЕАЭС: 8471300000',
      'Артикул № 8471300000',
      'код товара — 8471300000',
      'HS code 8471300000',
      'SKU: 8471300000',
    ])
      expect(detectInn(t, ctx()), t).toEqual([]);
    const t = 'Код ТН ВЭД 8471300000 8528521000';
    expect(goodsCodeContext(t, 22, 32, {})).toBe(true);
  });
  it('ревью WP11-D: слово, «.» или «;» между ключевым словом и числом, ОКПД2/ОКВЭД, 12 цифр после ТН ВЭД — ИНН находится', () => {
    for (const t of [
      'Артикул смотрите в каталоге. Поставщик 7710140679 отгружает',
      'Арт. 15. Получатель 7707083893',
      'SKU 15; плательщик 7707083893',
      'Код товара см. приложение. Контрагент: 7707083893',
      'Код товара уточните у менеджера; плательщик 7704217370.',
      'ОКПД2 8471300000',
      'ОКВЭД 62.01, 7707083893',
      'ТН ВЭД 500100732259',
    ])
      expect(detectInn(t, ctx()).length, t).toBe(1);
    expect(detectInn('Арт. 4410, получатель — Беляев Олег Иванович, 500100732259.', ctx()).map((c) => c.confidence)).toEqual(['validated']);
  });
  it('заголовок столбца — только код товара («Код ТН ВЭД», «Артикул») — не ИНН; смешанный заголовок или со словом «ИНН» — ИНН', () => {
    expect(detectInn('8471300000', ctx('Код ТН ВЭД'))).toEqual([]);
    expect(detectInn('8471300000', ctx('Артикул'))).toEqual([]);
    expect(detectInn('8471300000', ctx('HS'))).toEqual([]);
    for (const h of ['ИНН контрагента', 'ИНН / ОКВЭД', 'Реквизиты (ИНН, ОКПД2)', 'Поставщик и артикул', undefined])
      expect(
        detectInn('7707083893', ctx(h)).map((c) => c.confidence),
        String(h),
      ).toEqual(['validated']);
    expect(detectInn('Иванов Иван, 500100732259', ctx('Артикул/Получатель'))).toHaveLength(1);
    // 12 цифр под «Код ТН ВЭД» — не код ТН ВЭД (10): ИНН
    expect(detectInn('500100732259', ctx('Код ТН ВЭД'))).toHaveLength(1);
  });
  it('настоящий ИНН с лейблом рядом с кодом товара остаётся; штрихкод EAN-13 — не ОГРН', () => {
    const t = 'ТН ВЭД 8471300000, поставщик ИНН 7736050003';
    expect(detectInn(t, ctx()).map((c) => c.start)).toEqual([t.indexOf('7736050003')]);
    expect(detectInn('ИНН 7736050003 (ОКВЭД 62.01)', ctx()).map((c) => c.confidence)).toEqual(['validated']);
    expect(detectOgrn('Штрихкод 4600000000002', ctx())).toEqual([]);
    expect(detectOgrn('4600000000002', ctx('EAN-13'))).toEqual([]);
    expect(detectOgrn('ОГРН 4600000000002', ctx('Штрихкод')).map((c) => c.confidence)).toEqual(['validated']);
  });

  const cell = (t, extra = '') => `<w:tc>${extra}${para(run(t))}</w:tc>`;
  const row = (...cells) => `<w:tr>${cells.join('')}</w:tr>`;
  it('columnHeaders: DOCX — заголовок столбца по сетке (w:gridSpan), вложенная таблица — своя; PDF — по doc.blocks', () => {
    const span2 = '<w:tcPr><w:gridSpan w:val="2"/></w:tcPr>';
    const inner = `<w:tbl>${row(cell('Артикул'))}${row(cell('8471300000'))}</w:tbl>`;
    const xml = `<w:tbl>${row(cell('Объединённая', span2), cell('Код ТН ВЭД'))}${row(cell('a'), cell('b'), cell('8471300000'))}${row(`<w:tc>${inner}</w:tc>`, cell('c'), cell('d'))}</w:tbl>`;
    const doc = parseDocx(makeDocx(xml));
    const pids = (t) => doc.paragraphs.filter((p) => doc.streamById.get(p.streams.live)?.text === t).map((p) => p.pid);
    const h = columnHeaders(doc);
    expect(h.get(pids('a')[0])).toBe('Объединённая');
    // столбец 1 в первой строке занят объединённой ячейкой (gridSpan 2) — своего заголовка нет
    expect(h.get(pids('b')[0])).toBeUndefined();
    expect(h.get(pids('d')[0])).toBe('Код ТН ВЭД');
    // внешняя таблица — «Код ТН ВЭД», вложенная — «Артикул»
    expect(pids('8471300000').map((pid) => h.get(pid))).toEqual(['Код ТН ВЭД', 'Артикул']);
    const cells = docxCells(doc.parts.get('word/document.xml').xml);
    expect(cells.map((c) => [c.table, c.row, c.col])).toEqual([
      [0, 0, 0],
      [0, 0, 2],
      [0, 1, 0],
      [0, 1, 1],
      [0, 1, 2],
      [0, 2, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 2, 1],
      [0, 2, 2],
    ]);
    const text = fromText([
      { kind: 'cell', text: 'Код ТН ВЭД', page: 1, table: { index: 0, row: 0, col: 0, cols: 2 } },
      { kind: 'cell', text: 'Наименование', page: 1, table: { index: 0, row: 0, col: 1, cols: 2 } },
      { kind: 'cell', text: '8471300000', page: 1, table: { index: 0, row: 1, col: 0, cols: 2 } },
      { kind: 'cell', text: 'Ноутбук', page: 1, table: { index: 0, row: 1, col: 1, cols: 2 } },
    ]);
    expect([...columnHeaders(text).values()]).toEqual(['Код ТН ВЭД', 'Наименование']);
  });

  it('analyze: DOCX-таблица УПД — код ТН ВЭД в столбце не становится ИНН, ИНН покупателя и КПП найдены', async () => {
    clearDetectors();
    registerBuiltinDetectors();
    const xml =
      para(run('ИНН/КПП покупателя: 1690954450/169001001')) +
      `<w:tbl>${row(cell('Код ТН ВЭД'), cell('Наименование'))}${row(cell('8471300000'), cell('Ноутбук'))}</w:tbl>`;
    const a = await analyze(parseDocx(makeDocx(xml)), defaultSettings());
    const got = a.groups.map((g) => `${g.category}:${g.value}`).sort();
    expect(got).toEqual(['INN:1690954450', 'KPP:169001001']);
  });
});
