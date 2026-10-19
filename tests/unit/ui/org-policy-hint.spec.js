// Политика 0.4 в панели: одноразовая подсказка «организации — по желанию», «Маскировать всегда» / «запомнить»
// (пополнение списка компаний), исключение ⊘ компании из списка по canonical, подписи ru/en (Ц3, К3).
import { describe, it, expect } from 'vitest';
import { shouldShowOrgPolicyHint, withMaskedCompany } from '../../../src/ui/panel/org-policy.js';
import { toItems, canMaskAlways, exclusionValue } from '../../../src/ui/preview/model.js';
import { validateSettingsPatch, migrateSettings, defaultSettings } from '../../../src/core/settings.js';
import { panel } from '../../../src/ui/i18n/panel.js';
import { preview } from '../../../src/ui/i18n/preview.js';

describe('подсказка о политике (org-policy-hint)', () => {
  it('показывается только при orgPolicyHintPending: true', () => {
    expect(shouldShowOrgPolicyHint({ orgPolicyHintPending: true })).toBe(true);
    expect(shouldShowOrgPolicyHint({ orgPolicyHintPending: false })).toBe(false);
    expect(shouldShowOrgPolicyHint({})).toBe(false);
    expect(shouldShowOrgPolicyHint()).toBe(false);
  });

  it('новая установка — подсказки нет; профиль 0.3 после миграции — есть один раз', () => {
    expect(shouldShowOrgPolicyHint(defaultSettings())).toBe(false);
    const { settings } = migrateSettings({ schemaVersion: 2, categories: { COMPANY: true } });
    expect(shouldShowOrgPolicyHint(settings)).toBe(true);
    expect(shouldShowOrgPolicyHint({ ...settings, orgPolicyHintPending: false })).toBe(false);
  });

  it('тексты ru/en есть и называют раздел настроек', () => {
    expect(panel.ru.orgPolicyHint).toMatch(/Что маскируется/);
    expect(panel.en.orgPolicyHint).toMatch(/What is masked/);
    for (const k of ['source_list', 'maskAlways', 'maskAlwaysTitle', 'maskedAlways', 'remember', 'rememberTitle']) {
      expect(preview.ru[k], k).toBeTruthy();
      expect(preview.en[k], k).toBeTruthy();
    }
    expect(preview.ru.source_list).toBe('из списка');
    expect(preview.en.source_list).toBe('from list');
  });
});

describe('«Маскировать всегда» и «запомнить» (withMaskedCompany)', () => {
  it('добавляет запись без псевдонимов; результат проходит валидатор настроек', () => {
    const next = withMaskedCompany([{ name: 'Вектор', aliases: ['Vector'] }], '  Ромашка ');
    expect(next).toEqual([
      { name: 'Вектор', aliases: ['Vector'] },
      { name: 'Ромашка', aliases: [] },
    ]);
    expect(validateSettingsPatch({ maskedCompanies: next })).toEqual([]);
    expect(withMaskedCompany(undefined, 'Ромашка')).toEqual([{ name: 'Ромашка', aliases: [] }]);
  });

  it('повтор (регистр, «ё», псевдоним) и пустое название — null', () => {
    const list = [{ name: 'Ёлка', aliases: ['Yolka'] }];
    expect(withMaskedCompany(list, 'ЕЛКА')).toBeNull();
    expect(withMaskedCompany(list, 'yolka')).toBeNull();
    expect(withMaskedCompany(list, '   ')).toBeNull();
  });
});

describe('строки превью: кнопка и исключение', () => {
  const ent = (id, category, value, source, normalized = value.toLowerCase()) => ({
    id,
    category,
    value,
    normalized,
    placeholder: `[X_${id}]`,
    level: 'labeled',
    source,
    occurrences: [],
  });

  it('«Маскировать всегда» — только у организаций не из списка', () => {
    const items = toItems([ent('e1', 'COMPANY', 'Ромашка', 'rule'), ent('e2', 'COMPANY', 'Вектор', 'list'), ent('e3', 'PERSON', 'Иванов И.И.', 'rule')]);
    expect(items.map(canMaskAlways)).toEqual([true, false, false]);
  });

  it('⊘ у компании из списка исключает canonical записи, у остальных — значение', () => {
    const items = toItems([ent('e1', 'COMPANY', 'Ромашки', 'list', 'ромашка'), ent('e2', 'COMPANY', 'Вектор', 'rule')]);
    expect(items.map(exclusionValue)).toEqual(['ромашка', 'Вектор']);
  });
});
