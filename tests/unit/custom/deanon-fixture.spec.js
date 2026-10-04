import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { deanonymize } from '../../../src/core/deanon.js';
import { parseMappingFiles, toSegments, countUnresolved } from '../../../src/ui/deanon/index.js';

const fx = JSON.parse(readFileSync(new URL('../../fixtures/deanon.json', import.meta.url), 'utf8'));

describe('deanon.json: 30 случаев (FR-36)', () => {
  it('в фикстуре ровно 30 случаев', () => expect(fx.cases).toHaveLength(30));
  for (const c of fx.cases) {
    it(c.name, () => {
      const r = deanonymize(c.input, fx.mapping);
      expect(r.text).toBe(c.expected);
      expect(r.unresolved.map((u) => u.text)).toEqual(c.unresolved);
      for (const u of r.unresolved) expect(r.text.slice(u.start, u.end)).toBe(u.text);
    });
  }
});

describe('вспомогательные функции страницы «Восстановить»', () => {
  it('parseMappingFiles: один файл, несколько файлов, ошибки', () => {
    const one = JSON.stringify(fx.mapping);
    expect(parseMappingFiles([one]).mapping.entries).toHaveLength(fx.mapping.entries.length);
    const second = JSON.stringify({ ...fx.mapping, entries: [{ ...fx.mapping.entries[0], token: '[ФИО_5]', value: 'Козлов К. К.' }] });
    const merged = parseMappingFiles([one, second]).mapping;
    expect(merged.entries).toHaveLength(fx.mapping.entries.length + 1);
    expect(parseMappingFiles(['{не json']).error).toBe('json');
    expect(parseMappingFiles(['{"entries": 1}']).error).toBe('shape');
    expect(parseMappingFiles(['{"entries": [{"token": 1}]}']).error).toBe('shape');
    expect(parseMappingFiles([]).error).toBe('shape');
  });

  it('toSegments подсвечивает нераспознанные, countUnresolved считает повторы', () => {
    const r = deanonymize('[ФИО_1] и [ФИО_7], снова [ФИО_7]', fx.mapping);
    const seg = toSegments(r.text, r.unresolved);
    expect(seg.filter((s) => s.unresolved).map((s) => s.text)).toEqual(['[ФИО_7]', '[ФИО_7]']);
    expect(seg.map((s) => s.text).join('')).toBe(r.text);
    expect(countUnresolved(r.unresolved)).toEqual([{ text: '[ФИО_7]', count: 2 }]);
  });
});
