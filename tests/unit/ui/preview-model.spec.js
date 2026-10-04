import { describe, it, expect } from 'vitest';
import {
  toItems,
  filterItems,
  sortItems,
  setEnabled,
  isWeak,
  summary,
  toDecisions,
  replacementText,
  setReplacement,
  categoryCounts,
  plannedReplacements,
} from '../../../src/ui/preview/model.js';

const ent = (id, category, value, extra = {}) => ({
  id,
  category,
  value,
  normalized: value.toLowerCase(),
  placeholder: `[${category}_${id}]`,
  level: 'validated',
  source: 'rule',
  enabled: true,
  occurrences: [{ id: `${id}-o1` }],
  ...extra,
});
const sample = () => [
  ent('e1', 'EMAIL', 'a@x.ru'),
  ent('e2', 'PERSON', 'Иванов Пётр', { level: 'weak', occurrences: [{ id: 'o1' }, { id: 'o2' }, { id: 'o3' }] }),
  ent('e3', 'INN', '7707083893'),
];

describe('модель превью (FR-30)', () => {
  it('фильтрует по категориям и поиску', () => {
    const items = toItems(sample());
    expect(filterItems(items, { categories: new Set(['PERSON', 'INN']) }).map((i) => i.id)).toEqual(['e2', 'e3']);
    expect(filterItems(items, { query: 'иванов' }).map((i) => i.id)).toEqual(['e2']);
    expect(filterItems(items, { categories: new Set() })).toHaveLength(3);
  });

  it('сортирует по категории и числу вхождений', () => {
    const items = toItems(sample());
    expect(sortItems(items, 'count').map((i) => i.id)[0]).toBe('e2');
    expect(sortItems(items, 'category', ['INN', 'PERSON', 'EMAIL']).map((i) => i.id)).toEqual(['e3', 'e2', 'e1']);
    expect(sortItems(items, 'order').map((i) => i.id)).toEqual(['e1', 'e2', 'e3']);
  });

  it('массовые действия и счётчики', () => {
    const items = toItems(sample());
    setEnabled(items, false, isWeak);
    expect(summary(items)).toEqual({ total: 3, enabled: 2 });
    setEnabled(items, false);
    expect(summary(items).enabled).toBe(0);
    setEnabled(items, true);
    expect(summary(items).enabled).toBe(3);
    expect([...categoryCounts(items)]).toEqual([
      ['EMAIL', 1],
      ['PERSON', 1],
      ['INN', 1],
    ]);
  });

  it('решения: снятая галочка, ручная замена, исключённые вхождения', () => {
    const items = toItems(sample());
    items[0].enabled = false;
    setReplacement(items[1], '  Сторона А ');
    items[1].excluded.add('o2');
    expect(toDecisions(items)).toEqual([
      { entityId: 'e1', action: 'skip' },
      { entityId: 'e2', action: 'replace', replacement: 'Сторона А', excludedOccurrences: ['o2'] },
      { entityId: 'e3', action: 'replace' },
    ]);
    expect(plannedReplacements(items)).toBe(2 + 1);
  });

  it('замена, равная плейсхолдеру, или пустая — сброс', () => {
    const [it0] = toItems(sample());
    setReplacement(it0, 'X');
    expect(replacementText(it0)).toBe('X');
    setReplacement(it0, it0.placeholder);
    expect(it0.edited).toBeNull();
    setReplacement(it0, '   ');
    expect(replacementText(it0)).toBe(it0.placeholder);
  });

  it('при новом списке (ADD_ENTITY) локальные правки сохраняются по ключу', () => {
    const items = toItems(sample());
    items[0].enabled = false;
    setReplacement(items[2], 'ИНН-А');
    const next = toItems([...sample(), ent('e4', 'PERSON', 'Новый')], items);
    expect(next.find((i) => i.id === 'e1').enabled).toBe(false);
    expect(next.find((i) => i.id === 'e3').edited).toBe('ИНН-А');
    expect(next.find((i) => i.id === 'e4').enabled).toBe(true);
  });

  it('восстановленная с сервера замена показывается и уходит в решения', () => {
    const [i] = toItems([ent('e1', 'EMAIL', 'a@x.ru', { replacement: 'почта' })]);
    expect(replacementText(i)).toBe('почта');
  });
});
