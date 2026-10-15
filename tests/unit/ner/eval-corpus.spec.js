// WP9 (К8): корпус оценки NER воспроизводим генератором (scripts/gen-ner-eval.mjs, фиксированный сид) и корректен:
// ≥ 200 / ≥ 100 предложений, спаны внутри текста, без пересечений, метки PER/ORG/LOC, все три класса представлены.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildNerEval } from '../../../scripts/gen-ner-eval.mjs';

const load = (lang) => JSON.parse(readFileSync(new URL(`../../fixtures/ner/eval-${lang}.json`, import.meta.url), 'utf8'));

describe('корпус оценки NER', () => {
  const built = buildNerEval();
  for (const [lang, min] of [
    ['ru', 200],
    ['en', 100],
  ]) {
    it(`eval-${lang}.json = вывод генератора; ≥ ${min} предложений; спаны корректны`, () => {
      const fx = load(lang);
      expect(fx.sentences).toEqual(built[lang].sentences);
      expect(fx.sentences.length).toBeGreaterThanOrEqual(min);
      const by = { PER: 0, ORG: 0, LOC: 0 };
      for (const s of fx.sentences) {
        let prevEnd = 0;
        for (const sp of s.spans) {
          expect(['PER', 'ORG', 'LOC']).toContain(sp.label);
          expect(sp.start).toBeGreaterThanOrEqual(prevEnd);
          expect(sp.end).toBeLessThanOrEqual(s.text.length);
          const v = s.text.slice(sp.start, sp.end);
          expect(v.trim()).toBe(v);
          expect(v).toMatch(/\p{Lu}/u);
          prevEnd = sp.end;
          by[sp.label]++;
        }
      }
      for (const n of Object.values(by)) expect(n).toBeGreaterThanOrEqual(40);
      expect(new Set(fx.sentences.map((s) => s.text)).size).toBe(fx.sentences.length);
    });
  }
});
