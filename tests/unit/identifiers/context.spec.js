// Контекстные правила: ключ счёта по БИК в радиусе 500 символов (поток и документ), лейблы, границы, canonical паспорта.
import { describe, it, expect } from 'vitest';
import { detect } from './helper.js';
import { detectAccountByBikInDocument } from '../../../src/core/detect/identifiers/numeric.js';
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
