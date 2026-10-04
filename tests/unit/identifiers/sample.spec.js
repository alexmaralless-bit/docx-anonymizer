// Приёмка WP1: на образце договора все идентификаторы найдены с верной категорией и точными смещениями.
import { describe, it, expect, beforeAll } from 'vitest';
import { buildSampleDocx } from '../../../scripts/make-sample.mjs';
import { parseDocx, analyze, findOccurrences, defaultSettings, clearDetectors, registerDetector, registerDocumentDetector } from '../../../src/core/index.js';
import { register } from '../../../src/core/detect/identifiers/index.js';

const CATEGORY = {
  inn: 'INN',
  kpp: 'KPP',
  ogrn: 'OGRN',
  bik: 'BIK',
  rs: 'ACCOUNT',
  ks: 'ACCOUNT',
  snils: 'SNILS',
  passport: 'PASSPORT',
  phone: 'PHONE',
  email: 'EMAIL',
  url: 'URL',
};
const categoryOf = (key) => CATEGORY[key.replace(/\d+$/, '').replace(/Old$/, '')];

let doc;
let gold;
let analysis;

beforeAll(async () => {
  clearDetectors();
  register({ registerDetector, registerDocumentDetector });
  const s = buildSampleDocx();
  gold = s.gold;
  doc = parseDocx(s.bytes);
  analysis = await analyze(doc, defaultSettings());
});

describe('образец договора: детекторы идентификаторов', () => {
  const keys = Object.keys(buildSampleDocx().gold).filter((k) => categoryOf(k));

  for (const key of keys) {
    it(`${key}: все вхождения найдены как ${categoryOf(key)} с точными смещениями`, () => {
      const value = gold[key];
      const occ = findOccurrences(doc, value);
      expect(occ.length, `вхождения ${key} в документе`).toBeGreaterThan(0);
      for (const o of occ) {
        const e = analysis.entities.find((x) => x.streamId === o.streamId && x.start === o.start && x.end === o.end);
        expect(e, `${key} @${o.streamId}:${o.start}`).toBeTruthy();
        expect(e.category).toBe(categoryOf(key));
        expect(e.text).toBe(value);
        expect(doc.streamById.get(o.streamId).text.slice(e.start, e.end)).toBe(value);
      }
    });
  }

  it('все найденные сущности лежат строго в границах потока', () => {
    for (const e of analysis.entities) {
      const s = doc.streamById.get(e.streamId);
      expect(s.text.slice(e.start, e.end)).toBe(e.text);
    }
  });

  it('паспорт: серия/номер, орган выдачи и код подразделения — одна сущность (один плейсхолдер)', () => {
    const g = analysis.groups.filter((x) => x.category === 'PASSPORT');
    expect(g.length).toBe(1);
    const texts = g[0].occurrences.map((o) => o.text);
    expect(texts).toContain('45 05 123456');
    expect(texts).toContain('ОВД района Арбат г. Москвы');
    expect(texts).toContain('770-001');
  });

  it('счета с БИК из соседнего абзаца имеют уровень validated', () => {
    for (const key of ['rs1', 'rs2', 'ks']) {
      const e = analysis.entities.find((x) => x.text === gold[key]);
      expect(e.confidence, key).toBe('validated');
    }
  });

  it('e-mail: все четыре адреса образца, включая удалённый и mailto', () => {
    const emails = new Set(analysis.entities.filter((e) => e.category === 'EMAIL').map((e) => e.text));
    for (const k of ['email1', 'email2', 'email3', 'emailOld']) expect(emails.has(gold[k]), k).toBe(true);
  });
});

describe('повторяющиеся подстроки (дефект 5)', () => {
  it('«ИНН 7736050003 7736050003» — два вхождения с верными смещениями', async () => {
    const { detect } = await import('./helper.js');
    const text = 'ИНН 7736050003 7736050003';
    const r = detect(text).filter((e) => e.category === 'INN');
    expect(r.map((e) => [e.start, e.end])).toEqual([
      [4, 14],
      [15, 25],
    ]);
    const text2 = 'ИНН 7736050003, а также ИНН 7736050003 и 7736050003';
    expect(
      detect(text2)
        .filter((e) => e.category === 'INN')
        .map((e) => e.start),
    ).toEqual([4, 28, 41]);
  });
});
