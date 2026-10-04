import { describe, it, expect } from 'vitest';
import { resolveOverlaps } from '../../src/core/detect/overlap.js';
import { buildCatalog } from '../../src/core/categories.js';

const catalog = buildCatalog({});
let n = 0;
const e = (category, start, end, confidence = 'labeled', source = 'rule', streamId = 's1') => ({
  id: `x${n++}`,
  category,
  start,
  end,
  confidence,
  source,
  streamId,
  text: '',
  normalized: '',
  enabled: true,
  keepPrefix: 0,
  keepSuffix: 0,
});
const ids = (list) => list.map((x) => `${x.category}:${x.start}-${x.end}`);

describe('resolveOverlaps (FR-20)', () => {
  it('user побеждает всегда', () => {
    expect(ids(resolveOverlaps([e('INN', 0, 10, 'validated'), e('PERSON', 5, 20, 'labeled', 'user')], catalog))).toEqual(['PERSON:5-20']);
  });
  it('уровень важнее приоритета категории', () => {
    expect(ids(resolveOverlaps([e('INN', 0, 10, 'labeled'), e('PHONE', 0, 12, 'validated')], catalog))).toEqual(['PHONE:0-12']);
  });
  it('при равном уровне — приоритет категории (ИНН внутри телефона)', () => {
    expect(ids(resolveOverlaps([e('PHONE', 0, 16), e('INN', 2, 12)], catalog))).toEqual(['INN:2-12']);
  });
  it('COMPANY «ИП Иванов Иван Иванович» целиком побеждает PERSON того же уровня? нет — PERSON приоритетнее; KB-уровень решает', () => {
    // FR-21: внутри COMPANY с ОПФ «ИП» ФИО не выделяется — детектор WP2 должен выдать COMPANY уровнем выше PERSON
    expect(ids(resolveOverlaps([e('COMPANY', 0, 22, 'labeled'), e('PERSON', 3, 22, 'kb')], catalog))).toEqual(['COMPANY:0-22']);
  });
  it('при равенстве — раньше начавшийся, затем длиннее', () => {
    expect(ids(resolveOverlaps([e('ADDRESS', 5, 30), e('ADDRESS', 0, 10)], catalog))).toEqual(['ADDRESS:0-10']);
    expect(ids(resolveOverlaps([e('ADDRESS', 0, 10), e('ADDRESS', 0, 30)], catalog))).toEqual(['ADDRESS:0-30']);
  });
  it('проигравший отбрасывается целиком; непересекающиеся остаются; разные потоки независимы', () => {
    const r = resolveOverlaps([e('INN', 0, 10), e('PHONE', 5, 20), e('EMAIL', 25, 30, 'validated'), e('PHONE', 5, 20, 'labeled', 'rule', 's2')], catalog);
    expect(ids(r)).toEqual(['INN:0-10', 'EMAIL:25-30', 'PHONE:5-20']);
  });
  it('пользовательская категория aboveBuiltin выигрывает у PERSON на пересечении', () => {
    const cat = buildCatalog({ customCategories: [{ id: 'custom:project', priority: 'aboveBuiltin', kind: 'dictionary' }] });
    expect(ids(resolveOverlaps([e('PERSON', 0, 10), e('custom:project', 3, 12)], cat))).toEqual(['custom:project:3-12']);
  });
});
