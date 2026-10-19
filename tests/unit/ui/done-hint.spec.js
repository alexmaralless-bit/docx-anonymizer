// WP10-D, К16: предикат одноразовой подсказки о ключе восстановления.
import { describe, it, expect } from 'vitest';
import { shouldShowMappingHint } from '../../../src/ui/panel/done-hint.js';

describe('shouldShowMappingHint', () => {
  it('таблица истинности: только карта есть, не сохранена и подсказка не показывалась', () => {
    for (const hintMappingShown of [false, true]) {
      for (const mappingAvailable of [false, true]) {
        for (const mappingSaved of [false, true]) {
          const want = mappingAvailable && !mappingSaved && !hintMappingShown;
          expect(
            shouldShowMappingHint({ hintMappingShown, mappingAvailable, mappingSaved }),
            JSON.stringify({ hintMappingShown, mappingAvailable, mappingSaved }),
          ).toBe(want);
        }
      }
    }
  });

  it('флаг не задан (старые настройки) — как «не показывалась»; пустой вызов — false', () => {
    expect(shouldShowMappingHint({ hintMappingShown: undefined, mappingAvailable: true, mappingSaved: false })).toBe(true);
    expect(shouldShowMappingHint({ mappingAvailable: true })).toBe(true);
    expect(shouldShowMappingHint({})).toBe(false);
    expect(shouldShowMappingHint()).toBe(false);
  });
});
