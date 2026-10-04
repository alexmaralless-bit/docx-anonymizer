// FR-18: фикстуры категорий PERSON / COMPANY / ADDRESS — 100 % совпадение.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { registerNames, analyzeParagraphs, allOnSettings } from './helpers.js';

const load = (id) => JSON.parse(readFileSync(new URL(`../../fixtures/categories/${id}.json`, import.meta.url), 'utf8'));

for (const id of ['PERSON', 'COMPANY', 'ADDRESS']) {
  const fx = load(id);
  describe(`фикстура ${id}`, () => {
    beforeEach(() => registerNames());

    it('≥ 10 позитивных и ≥ 10 негативных', () => {
      expect(fx.positive.length).toBeGreaterThanOrEqual(10);
      expect(fx.negative.length).toBeGreaterThanOrEqual(10);
    });

    it.each(fx.positive.map((p) => [p.text, p]))('находит: %s', async (_t, p) => {
      const r = await analyzeParagraphs([p.text], allOnSettings());
      const found = r.entities.filter((e) => e.category === id);
      expect(found.map((e) => e.text)).toEqual(p.expect);
      if (p.cores) expect(found.map((e) => e.text.slice(e.keepPrefix, e.text.length - e.keepSuffix))).toEqual(p.cores);
    });

    it.each(fx.negative.map((t) => [t]))('не находит: %s', async (t) => {
      const r = await analyzeParagraphs([t], allOnSettings());
      expect(r.entities.filter((e) => e.category === id).map((e) => e.text)).toEqual([]);
    });
  });
}
