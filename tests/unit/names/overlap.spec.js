// FR-20/21: фикстура overlap.json — 20 случаев пересечений (детекторы WP2 + подставные кандидаты).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { registerNames, analyzeParagraphs, allOnSettings } from './helpers.js';

const fx = JSON.parse(readFileSync(new URL('../../fixtures/overlap.json', import.meta.url), 'utf8'));

function nthIndex(text, sub, nth = 0) {
  let i = -1;
  for (let k = 0; k <= nth; k++) {
    i = text.indexOf(sub, i + 1);
    if (i < 0) throw new Error(`нет «${sub}» в «${text}»`);
  }
  return i;
}

describe('overlap.json (FR-20)', () => {
  it('20 случаев', () => expect(fx.cases).toHaveLength(20));

  it.each(fx.cases.map((c) => [c.name, c]))('%s', async (_n, c) => {
    registerNames({
      withNames: !!c.detectors,
      extra: (api) =>
        api.registerDocumentDetector('inject', (doc) => {
          const s = doc.streams.find((x) => x.type === 'live' && x.text === c.text);
          return (c.inject || []).map((j) => {
            const start = nthIndex(c.text, j.match, j.nth);
            return { streamId: s.id, category: j.category, start, end: start + j.match.length, confidence: j.confidence, source: j.source || 'rule' };
          });
        }),
    });
    const r = await analyzeParagraphs([c.text], allOnSettings());
    expect(r.entities.map((e) => ({ category: e.category, text: e.text }))).toEqual(c.expect);
  });
});
