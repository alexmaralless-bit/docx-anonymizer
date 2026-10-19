// Группы категорий и политика маскирования 0.4 (К1): pii/ids всегда, commercial по переключателю.
import { describe, it, expect } from 'vitest';
import { BUILTIN_CATEGORIES, BUILTIN_IDS, CATEGORY_GROUPS, ALWAYS_ON_IDS, buildCatalog, isCategoryEnabled } from '../../src/core/categories.js';
import { defaultSettings } from '../../src/core/settings.js';

const byId = (id) => BUILTIN_CATEGORIES.find((c) => c.id === id);

describe('группы категорий (0.4, концепция п. 1)', () => {
  it('у каждой встроенной категории есть группа; группы не пересекаются и покрывают все категории', () => {
    for (const c of BUILTIN_CATEGORIES) expect(['pii', 'ids', 'commercial'], c.id).toContain(c.group);
    const all = [...CATEGORY_GROUPS.pii, ...CATEGORY_GROUPS.ids, ...CATEGORY_GROUPS.commercial];
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...BUILTIN_IDS].sort());
  });
  it('состав групп — по решению владельца', () => {
    expect([...CATEGORY_GROUPS.pii].sort()).toEqual(['ADDRESS', 'BIRTHDATE', 'CARD', 'EMAIL', 'PASSPORT', 'PERSON', 'PHONE', 'SNILS', 'SSN']);
    expect([...CATEGORY_GROUPS.ids].sort()).toEqual(['ACCOUNT', 'BIK', 'IBAN', 'INN', 'KPP', 'OGRN', 'SWIFT', 'TAXID', 'URL']);
    expect([...CATEGORY_GROUPS.commercial]).toEqual(['COMPANY', 'CONTRACT', 'AMOUNT']);
    expect(ALWAYS_ON_IDS).toHaveLength(18);
  });
  it('pii и ids включены всегда — даже если в настройках false', () => {
    const s = { ...defaultSettings(), categories: Object.fromEntries(BUILTIN_IDS.map((id) => [id, false])) };
    for (const id of ALWAYS_ON_IDS) expect(isCategoryEnabled(byId(id), s), id).toBe(true);
    for (const id of ALWAYS_ON_IDS) expect(isCategoryEnabled(byId(id), {}), id).toBe(true);
  });
  it('commercial: по умолчанию выключена; при commercial: true действуют переключатели категорий и defaultOn', () => {
    const d = defaultSettings();
    for (const id of CATEGORY_GROUPS.commercial) expect(isCategoryEnabled(byId(id), d), id).toBe(false);
    expect(isCategoryEnabled(byId('COMPANY'), {})).toBe(false);
    const on = { ...d, commercial: true };
    expect(isCategoryEnabled(byId('COMPANY'), on)).toBe(true);
    expect(isCategoryEnabled(byId('CONTRACT'), on)).toBe(false);
    expect(isCategoryEnabled(byId('AMOUNT'), on)).toBe(false);
    expect(isCategoryEnabled(byId('AMOUNT'), { ...on, categories: { ...on.categories, AMOUNT: true } })).toBe(true);
    expect(isCategoryEnabled(byId('COMPANY'), { ...on, categories: { ...on.categories, COMPANY: false } })).toBe(false);
    expect(isCategoryEnabled(byId('COMPANY'), { commercial: true })).toBe(true); // defaultOn
  });
  it('пользовательские категории — по полю enabled, группы не имеют', () => {
    const cat = buildCatalog({ customCategories: [{ id: 'custom:x', label: { ru: 'x' }, enabled: false }] }).byId.get('custom:x');
    expect(cat.group).toBeUndefined();
    expect(isCategoryEnabled(cat, { commercial: true })).toBe(false);
  });
  it('defaultSettings().categories: pii/ids — true, внутри commercial — по defaultOn', () => {
    const c = defaultSettings().categories;
    for (const id of ALWAYS_ON_IDS) expect(c[id], id).toBe(true);
    expect(c).toMatchObject({ COMPANY: true, CONTRACT: false, AMOUNT: false });
  });
});
