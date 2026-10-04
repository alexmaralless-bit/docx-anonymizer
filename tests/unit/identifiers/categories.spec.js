// FR-18: фикстуры tests/fixtures/categories/<ID>.json — ≥ 10 позитивных и ≥ 10 негативных примеров, 100 % совпадение.
// Прогон идёт через все детекторы идентификаторов + фильтр allowedLevels + разрешение пересечений FR-20.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { detect } from './helper.js';

const IDS = [
  'INN',
  'KPP',
  'OGRN',
  'BIK',
  'ACCOUNT',
  'CARD',
  'IBAN',
  'SWIFT',
  'SNILS',
  'PASSPORT',
  'SSN',
  'TAXID',
  'EMAIL',
  'PHONE',
  'URL',
  'BIRTHDATE',
  'CONTRACT',
  'AMOUNT',
];
const load = (id) => JSON.parse(readFileSync(new URL(`../../fixtures/categories/${id}.json`, import.meta.url), 'utf8'));

describe.each(IDS)('фикстура категории %s', (id) => {
  const fx = load(id);

  it('содержит ≥ 10 позитивных и ≥ 10 негативных примеров', () => {
    expect(fx.category).toBe(id);
    expect(fx.positive.length).toBeGreaterThanOrEqual(10);
    expect(fx.negative.length).toBeGreaterThanOrEqual(10);
  });

  it.each(fx.positive.map((p) => [p.text, p]))('находит: %j', (_t, p) => {
    const got = detect(p.text).filter((e) => e.category === id);
    expect(got.map((e) => ({ text: e.text, level: e.level }))).toEqual(p.expect);
    for (const e of got) expect(p.text.slice(e.start, e.end)).toBe(e.text); // смещения верны
  });

  it.each(fx.negative.map((n) => [n.text, n]))('не находит: %j', (_t, n) => {
    expect(detect(n.text).filter((e) => e.category === id)).toEqual([]);
  });
});
