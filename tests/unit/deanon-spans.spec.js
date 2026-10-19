// WP10-B: deanonymizeSpans / findUnresolved — обратная замена в координатах входного текста (FR-36, FR-37).
// Основа восстановления DOCX (core/restore-doc.js); deanonymize() построен поверх и даёт прежний результат.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { deanonymize, deanonymizeSpans, findUnresolved } from '../../src/core/deanon.js';

const load = (n) => JSON.parse(readFileSync(new URL(`../fixtures/${n}`, import.meta.url), 'utf8'));
const fx = load('deanon.json');
const declineFx = load('deanon-decline.json');

/** Склейка результата по спанам — так же, как это делает deanonymize. */
function splice(text, spans) {
  let out = '';
  let last = 0;
  for (const s of spans) {
    out += text.slice(last, s.start) + s.newText;
    last = s.end;
  }
  return out + text.slice(last);
}

function checkSpans(text, spans) {
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i];
    expect(s.start).toBeLessThan(s.end);
    expect(s.end).toBeLessThanOrEqual(text.length);
    if (i) expect(s.start).toBeGreaterThanOrEqual(spans[i - 1].end); // отсортированы и не пересекаются
  }
}

describe('deanonymizeSpans: эквивалентность deanonymize на фикстурах', () => {
  const cases = [
    ...fx.cases.map((c) => ({ ...c, mapping: fx.mapping, decline: false, src: 'deanon' })),
    ...declineFx.cases.map((c) => ({ ...c, mapping: declineFx.mapping, decline: c.decline ?? true, src: 'decline' })),
  ];
  it('все 30 + все случаи склонения', () => expect(cases.length).toBe(fx.cases.length + declineFx.cases.length));
  for (const c of cases) {
    it(`${c.src}: ${c.name}`, () => {
      const spans = deanonymizeSpans(c.input, c.mapping, { decline: c.decline });
      const r = deanonymize(c.input, c.mapping, { decline: c.decline });
      checkSpans(c.input, spans);
      expect(splice(c.input, spans)).toBe(r.text);
      expect(r.replaced).toBe(spans.length);
      expect(spans.filter((s) => s.declined).map((s) => [s.declined.case, s.declined.original])).toEqual(r.declined.map((d) => [d.case, d.original]));
    });
  }
});

describe('deanonymizeSpans: координаты входа', () => {
  it('приклеенное окончание поглощается: «Письмо [ФИО_1]у.» → один спан до точки, дательный', () => {
    const text = 'Письмо [ФИО_1]у.';
    const spans = deanonymizeSpans(text, declineFx.mapping, { decline: true });
    expect(spans).toHaveLength(1);
    expect(spans[0].start).toBe(text.indexOf('['));
    expect(spans[0].end).toBe(text.indexOf('.'));
    expect(spans[0].declined).toEqual({ case: 'dat', original: 'Иванов Пётр Сергеевич' });
    expect(spans[0].newText).toBe('Иванову Петру Сергеевичу');
  });

  it('сочинение: «от [ФИО_1] и [ФИО_2]» → оба в родительном (prev/gap по входу)', () => {
    const spans = deanonymizeSpans('от [ФИО_1] и [ФИО_2]', declineFx.mapping, { decline: true });
    expect(spans.map((s) => s.declined?.case)).toEqual(['gen', 'gen']);
  });

  it('decline: false — без declined и без поглощения окончаний', () => {
    const text = 'Письмо [ФИО_1]у.';
    const spans = deanonymizeSpans(text, declineFx.mapping);
    expect(spans).toEqual([{ start: 7, end: 14, newText: 'Иванов Пётр Сергеевич' }]);
  });

  it('пустая карта или карта без меток → []', () => {
    expect(deanonymizeSpans('[ФИО_1]', { entries: [] })).toEqual([]);
    expect(deanonymizeSpans('[ФИО_1]', null)).toEqual([]);
    expect(deanonymizeSpans('XXXX', { entries: [{ token: 'XXXX', value: 'a', category: 'INN' }] })).toEqual([]);
  });
});

describe('findUnresolved', () => {
  it('метки вне спанов, координаты входа', () => {
    const text = '[ФИО_9] и [ФИО_1]';
    const spans = deanonymizeSpans(text, fx.mapping);
    expect(spans).toHaveLength(1);
    expect(findUnresolved(text, spans)).toEqual([{ text: '[ФИО_9]', start: 0, end: 7 }]);
  });

  it('совпадает с unresolved deanonymize по тексту меток', () => {
    for (const c of fx.cases) {
      const spans = deanonymizeSpans(c.input, fx.mapping);
      const u = findUnresolved(c.input, spans);
      for (const x of u) expect(c.input.slice(x.start, x.end)).toBe(x.text);
      expect(u.map((x) => x.text)).toEqual(deanonymize(c.input, fx.mapping).unresolved.map((x) => x.text));
    }
  });
});
