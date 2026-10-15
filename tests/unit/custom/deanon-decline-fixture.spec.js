// К10 (концепция 0.2): склонение ФИО при восстановлении (FR-37 в редакции 0.2) — фикстура deanon-decline.json, 100 %.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { deanonymize } from '../../../src/core/deanon.js';
import { toSegments } from '../../../src/ui/deanon/index.js';

const fx = JSON.parse(readFileSync(new URL('../../fixtures/deanon-decline.json', import.meta.url), 'utf8'));

describe('deanon-decline.json: склонение по контексту (FR-37)', () => {
  it('в фикстуре не меньше 40 случаев', () => expect(fx.cases.length).toBeGreaterThanOrEqual(40));
  for (const c of fx.cases) {
    it(c.name, () => {
      const r = deanonymize(c.input, fx.mapping, { decline: c.decline ?? true });
      expect(r.text).toBe(c.expected);
      expect(r.declined.map((d) => [d.case, d.original])).toEqual(c.declined);
      for (const d of r.declined) expect(r.text.slice(d.start, d.end)).toBe(d.text);
      expect(r.unresolved.map((u) => u.text)).toEqual(c.unresolved);
      for (const u of r.unresolved) expect(r.text.slice(u.start, u.end)).toBe(u.text);
    });
  }

  it('toSegments: склонённые и нераспознанные сегменты не пересекаются и склеиваются в текст', () => {
    const r = deanonymize('Письмо [ФИО_99]у и от [ФИО_1], копия [ФИО_2]е.', fx.mapping, { decline: true });
    const seg = toSegments(r.text, r.unresolved, r.declined);
    expect(seg.map((s) => s.text).join('')).toBe(r.text);
    expect(seg.filter((s) => s.unresolved).map((s) => s.text)).toEqual(['[ФИО_99]']);
    expect(seg.filter((s) => s.declined).map((s) => [s.text, s.item.case])).toEqual([
      ['Иванова Петра Сергеевича', 'gen'],
      ['Петровой Анне Ивановне', 'dat'],
    ]);
    expect(seg.every((s) => !(s.declined && s.unresolved))).toBe(true);
  });

  it('decline выключен по умолчанию: результат без склонения и с пустым declined', () => {
    const r = deanonymize('Письмо [ФИО_1]у.', fx.mapping);
    expect(r.text).toBe('Письмо Иванов Пётр Сергеевичу.');
    expect(r.declined).toEqual([]);
  });
});
