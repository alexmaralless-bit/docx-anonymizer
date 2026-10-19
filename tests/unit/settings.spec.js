import { describe, it, expect } from 'vitest';
import {
  defaultSettings,
  migrateSettings,
  validateSettingsPatch,
  effectiveSettings,
  applyMigrations,
  SETTINGS_SCHEMA_VERSION,
} from '../../src/core/settings.js';
import { matchOrigin, isOriginAllowed, isInterceptActive } from '../../src/core/sites.js';

describe('settings', () => {
  it('дефолты по таблице §4.8', () => {
    const s = defaultSettings();
    expect(s.interceptEnabled).toBe(false);
    expect(s.siteMode).toBe('allowlist');
    expect(s.allowlist).toHaveLength(5);
    expect(s.categories.CONTRACT).toBe(false);
    expect(s.categories.AMOUNT).toBe(false);
    expect(s.categories.INN).toBe(true);
    expect(s.maxFileSizeMB).toBe(50);
    // политика 0.4: коммерческая группа выключена, список компаний пуст, порог ORG выше общего
    expect(s.commercial).toBe(false);
    expect(s.maskedCompanies).toEqual([]);
    expect(s.orgPolicyHintPending).toBe(false);
    expect(s.nerThresholdOrg).toBe(0.85);
    expect(s.nerStoplist).toEqual([]);
  });
  it('миграция: пусто → дефолты; v0 → текущая; невалидные поля заменяются; новые категории добавляются', () => {
    expect(migrateSettings(undefined).changed).toBe(true);
    const { settings } = migrateSettings({ interceptEnabled: true, mode: 'bogus', categories: { INN: false, AMOUNT: true }, maxFileSizeMB: 500 });
    expect(settings.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
    expect(settings.interceptEnabled).toBe(true);
    expect(settings.mode).toBe('placeholder');
    expect(settings.maxFileSizeMB).toBe(50);
    // политика 0.4 (К1): идентификатор нельзя выключить даже в сохранённом объекте; переключатель коммерческой группы сохраняется
    expect(settings.categories.INN).toBe(true);
    expect(settings.categories.AMOUNT).toBe(true);
    expect(settings.categories.PERSON).toBe(true);
    expect(migrateSettings(settings).changed).toBe(false);
  });
  it('validateSettingsPatch', () => {
    expect(validateSettingsPatch({ mode: 'mask', nerThreshold: 0.5 })).toEqual([]);
    expect(validateSettingsPatch({ mode: 'x', allowlist: ['chatgpt.com'], unknown: 1 })).toEqual(['mode', 'allowlist', 'unknown']);
  });
  it('nerThreshold (WP9): по умолчанию 0.7 = recommendedThreshold пакета; миграция 1 → 2 меняет только прежний дефолт 0.6', () => {
    expect(defaultSettings().nerThreshold).toBe(0.7);
    expect(SETTINGS_SCHEMA_VERSION).toBe(3);
    expect(migrateSettings({ schemaVersion: 1, nerThreshold: 0.6 }).settings.nerThreshold).toBe(0.7);
    expect(migrateSettings({ schemaVersion: 1, nerThreshold: 0.45 }).settings.nerThreshold).toBe(0.45);
    expect(migrateSettings({ nerThreshold: 0.6 }).settings.nerThreshold).toBe(0.7); // v0 → 1 → 2
    // текущая версия: 0.6 — выбор пользователя, не трогаем
    expect(migrateSettings({ ...defaultSettings(), nerThreshold: 0.6 }).settings.nerThreshold).toBe(0.6);
  });
  it('импорт конфигурации (FR-47): файл старой схемы проходит миграции — порог 0.6 из 0.1 → 0.7', async () => {
    const { parseConfigFile, CONFIG_KIND } = await import('../../src/options/config-io.js');
    const file = (extra, settings) => JSON.stringify({ kind: CONFIG_KIND, version: 1, ...extra, settings });
    // файл 0.1: schemaVersion нет (ни в файле, ни в settings — служебное поле не экспортировалось)
    expect(parseConfigFile(file({}, { nerThreshold: 0.6, mode: 'mask' })).patch).toEqual({ nerThreshold: 0.7, mode: 'mask' });
    expect(parseConfigFile(file({ schemaVersion: 1 }, { nerThreshold: 0.6 })).patch).toEqual({ nerThreshold: 0.7 });
    // не прежний дефолт — выбор пользователя
    expect(parseConfigFile(file({}, { nerThreshold: 0.55 })).patch).toEqual({ nerThreshold: 0.55 });
    // файл текущей схемы: 0.6 — выбор пользователя
    expect(parseConfigFile(file({ schemaVersion: 2 }, { nerThreshold: 0.6 })).patch).toEqual({ nerThreshold: 0.6 });
    // версия из будущего — без миграций, поля проверяются как обычно
    expect(parseConfigFile(file({ schemaVersion: 99 }, { nerThreshold: 0.6 })).patch).toEqual({ nerThreshold: 0.6 });
    // общая функция чистая: вход не меняется, частичный объект остаётся частичным
    const patch = { nerThreshold: 0.6 };
    expect(applyMigrations(patch, 1)).toEqual({ nerThreshold: 0.7, schemaVersion: 3 });
    expect(patch).toEqual({ nerThreshold: 0.6 });
    expect(applyMigrations({ nerThreshold: 0.6 })).toEqual({ nerThreshold: 0.7, schemaVersion: 3 });
    expect(applyMigrations({ nerThreshold: 0.6 }, 2)).toEqual({ nerThreshold: 0.6, schemaVersion: 3 });
    expect(applyMigrations({ nerThreshold: 0.6 }, 3)).toEqual({ nerThreshold: 0.6 });
  });
  it('миграция 2 → 3 (политика 0.4, К1): pii/ids включаются в настройках и профилях, commercial выключен у всех, подсказка один раз', async () => {
    const stored = {
      ...defaultSettings(),
      schemaVersion: 2,
      categories: { PERSON: false, INN: false, COMPANY: true, AMOUNT: true },
      profiles: [{ id: 'p1', name: { ru: 'П', en: 'P' }, builtin: false, values: { categories: { PHONE: false, CONTRACT: true } } }],
    };
    delete stored.commercial;
    delete stored.orgPolicyHintPending;
    const { settings, changed } = migrateSettings(stored);
    expect(changed).toBe(true);
    expect(settings.schemaVersion).toBe(3);
    expect(settings.categories).toMatchObject({ PERSON: true, INN: true, COMPANY: true, AMOUNT: true });
    expect(settings.commercial).toBe(false);
    expect(settings.orgPolicyHintPending).toBe(true);
    expect(settings.profiles[0].values.categories).toMatchObject({ PHONE: true, CONTRACT: true, INN: true });
    // у текущей версии подсказка не возвращается
    expect(migrateSettings({ ...settings, orgPolicyHintPending: false }).settings.orgPolicyHintPending).toBe(false);
    // частичный объект без categories (патч импорта) — только версия
    expect(applyMigrations({ mode: 'mask' }, 2)).toEqual({ mode: 'mask', schemaVersion: 3 });
    // импорт старого конфига: pii/ids включены, подсказка (состояние браузера) не импортируется
    const { parseConfigFile, CONFIG_KIND, NOT_EXPORTED } = await import('../../src/options/config-io.js');
    const r = parseConfigFile(JSON.stringify({ kind: CONFIG_KIND, version: 1, schemaVersion: 2, settings: { categories: { INN: false } } }));
    expect(r.patch.categories.INN).toBe(true);
    expect(r.patch.orgPolicyHintPending).toBeUndefined();
    expect(NOT_EXPORTED.has('orgPolicyHintPending')).toBe(true);
    expect(NOT_EXPORTED.has('commercial')).toBe(false);
    expect(NOT_EXPORTED.has('maskedCompanies')).toBe(false);
  });
  it('новые поля 0.4: валидаторы commercial, maskedCompanies, nerThresholdOrg, nerStoplist; commercial и nerThresholdOrg — в профилях', () => {
    expect(validateSettingsPatch({ commercial: true, maskedCompanies: [{ name: 'Ромашка' }, { name: 'Вектор', aliases: ['Vector'] }] })).toEqual([]);
    expect(validateSettingsPatch({ maskedCompanies: [{ name: '' }] })).toEqual(['maskedCompanies']);
    expect(validateSettingsPatch({ maskedCompanies: [{ name: 'A', aliases: [1] }] })).toEqual(['maskedCompanies']);
    expect(validateSettingsPatch({ maskedCompanies: Array.from({ length: 201 }, () => ({ name: 'A' })) })).toEqual(['maskedCompanies']);
    expect(validateSettingsPatch({ nerThresholdOrg: 1.5, nerStoplist: ['ЭДО', 2] })).toEqual(['nerThresholdOrg', 'nerStoplist']);
    expect(validateSettingsPatch({ nerThresholdOrg: 0.9, nerStoplist: ['ЭДО', 'MVP'], orgPolicyHintPending: true })).toEqual([]);
    const s = {
      ...defaultSettings(),
      profiles: [{ id: 'x', name: { ru: 'x', en: 'x' }, builtin: false, values: { commercial: true, nerThresholdOrg: 0.5, nerStoplist: ['a'] } }],
    };
    const eff = effectiveSettings(s, 'x');
    expect(eff.commercial).toBe(true);
    expect(eff.nerThresholdOrg).toBe(0.5);
    expect(eff.nerStoplist).toEqual([]); // не поле профиля
  });
  it('экспорт/импорт конфигурации (0.4, К1): commercial, maskedCompanies, nerThresholdOrg и nerStoplist переносятся', async () => {
    const { parseConfigFile, CONFIG_KIND, NOT_EXPORTED } = await import('../../src/options/config-io.js');
    const src = {
      ...defaultSettings(),
      commercial: true,
      maskedCompanies: [{ name: 'ООО «Ромашка»', aliases: ['Romashka'] }],
      nerThresholdOrg: 0.9,
      nerStoplist: ['ЭДО'],
      orgPolicyHintPending: true,
    };
    // как dataSection: всё, кроме NOT_EXPORTED
    const exported = Object.fromEntries(Object.entries(src).filter(([k]) => !NOT_EXPORTED.has(k)));
    const r = parseConfigFile(JSON.stringify({ kind: CONFIG_KIND, version: 1, schemaVersion: SETTINGS_SCHEMA_VERSION, settings: exported }));
    expect(r.skipped).toEqual([]);
    expect(r.patch).toMatchObject({ commercial: true, maskedCompanies: src.maskedCompanies, nerThresholdOrg: 0.9, nerStoplist: ['ЭДО'] });
    expect(r.patch.orgPolicyHintPending).toBeUndefined();
  });
  it('файл списка компаний (0.4, options/companies-io.js): формат, слияние, псевдонимы, предупреждение о коротком названии', async () => {
    const io = await import('../../src/options/companies-io.js');
    const list = [{ name: 'Ромашка', aliases: ['Romashka'] }];
    const file = io.companiesFile(list);
    expect(file).toEqual({ kind: 'docx-anonymizer-companies', version: 1, companies: list });
    expect(io.parseCompaniesFile(JSON.stringify(file))).toEqual({ companies: list });
    expect(io.parseCompaniesFile(JSON.stringify(['Вектор']))).toEqual({ companies: [{ name: 'Вектор', aliases: [] }] });
    expect(io.parseCompaniesFile('{')).toEqual({ error: 'JSON' });
    expect(io.parseCompaniesFile(JSON.stringify({ kind: 'other', companies: list }))).toEqual({ error: 'kind' });
    expect(io.parseCompaniesFile(JSON.stringify({ kind: io.COMPANIES_KIND, companies: [{ name: '' }] }))).toEqual({ error: 'companies' });
    expect(io.mergeCompanies(list, [{ name: 'РОМАШКА', aliases: ['Ромашка-М', 'romashka'] }, { name: 'Вектор' }])).toEqual([
      { name: 'Ромашка', aliases: ['Romashka', 'Ромашка-М'] },
      { name: 'Вектор', aliases: [] },
    ]);
    expect(io.parseAliases(' Romashka, ромашка-м ;; Romashka ')).toEqual(['Romashka', 'ромашка-м']);
    for (const n of ['Рог', 'ООО «Рог»', 'Старт', 'Вектор']) expect(io.isRiskyCompanyName(n), n).toBe(true);
    for (const n of ['Ромашка-Трейд', 'ООО «Лунный свет»', '']) expect(io.isRiskyCompanyName(n), n).toBe(false);
    // бренд владельца (решение 6): предупреждение company-brand
    for (const n of ['Sitimlab', 'Студия Sitimlab', 'ООО «Ситимлаб»']) expect(io.isOwnerBrand(n), n).toBe(true);
    expect(io.isOwnerBrand('Ромашка')).toBe(false);
  });
  it('nerModel (WP8): по умолчанию пусто, id пакета проверяется, в профили и экспорт конфига не попадает', async () => {
    expect(defaultSettings().nerModel).toBe('');
    expect(validateSettingsPatch({ nerModel: 'rubert-tiny2-ner-ruen' })).toEqual([]);
    expect(validateSettingsPatch({ nerModel: '' })).toEqual([]);
    expect(validateSettingsPatch({ nerModel: 'Bad Id' })).toEqual(['nerModel']);
    expect(validateSettingsPatch({ nerModel: '../x' })).toEqual(['nerModel']);
    expect(migrateSettings({ nerModel: 'Bad Id' }).settings.nerModel).toBe('');
    expect(migrateSettings({ nerModel: 'my-model' }).settings.nerModel).toBe('my-model');
    const s = {
      ...defaultSettings(),
      nerModel: 'my-model',
      profiles: [{ id: 'p', name: { ru: 'p', en: 'p' }, builtin: false, values: { nerModel: 'other' } }],
    };
    expect(effectiveSettings(s, 'p').nerModel).toBe('my-model');
    const { NOT_EXPORTED, parseConfigFile, CONFIG_KIND } = await import('../../src/options/config-io.js');
    expect(NOT_EXPORTED.has('nerModel')).toBe(true);
    const r = parseConfigFile(JSON.stringify({ kind: CONFIG_KIND, settings: { nerModel: 'my-model', mode: 'mask' } }));
    expect(r.patch).toEqual({ mode: 'mask' });
  });
  it('dictNames (WP7): по умолчанию вкл., boolean, поле профиля, переносится миграцией и экспортом конфига', async () => {
    expect(defaultSettings().dictNames).toBe(true);
    expect(validateSettingsPatch({ dictNames: false })).toEqual([]);
    expect(validateSettingsPatch({ dictNames: 'no' })).toEqual(['dictNames']);
    expect(migrateSettings({ dictNames: 1 }).settings.dictNames).toBe(true);
    expect(migrateSettings({ dictNames: false }).settings.dictNames).toBe(false);
    const s = { ...defaultSettings(), profiles: [{ id: 'p', name: { ru: 'p', en: 'p' }, builtin: false, values: { dictNames: false } }] };
    expect(effectiveSettings(s, 'p').dictNames).toBe(false);
    const { parseConfigFile, CONFIG_KIND } = await import('../../src/options/config-io.js');
    expect(parseConfigFile(JSON.stringify({ kind: CONFIG_KIND, settings: { dictNames: false } })).patch).toEqual({ dictNames: false });
  });
  it('hintMappingShown (WP10-D): по умолчанию false, boolean, миграция без изменений версии, не экспортируется', async () => {
    expect(defaultSettings().hintMappingShown).toBe(false);
    expect(validateSettingsPatch({ hintMappingShown: true })).toEqual([]);
    expect(validateSettingsPatch({ hintMappingShown: 'да' })).toEqual(['hintMappingShown']);
    expect(migrateSettings({ hintMappingShown: 1 }).settings.hintMappingShown).toBe(false);
    expect(migrateSettings({ hintMappingShown: true }).settings.hintMappingShown).toBe(true);
    expect(migrateSettings({}).settings.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
    const { NOT_EXPORTED, parseConfigFile, CONFIG_KIND } = await import('../../src/options/config-io.js');
    expect(NOT_EXPORTED.has('hintMappingShown')).toBe(true);
    expect(parseConfigFile(JSON.stringify({ kind: CONFIG_KIND, settings: { hintMappingShown: true, mode: 'mask' } })).patch).toEqual({ mode: 'mask' });
  });
  it('bundledModelError (WP10-C): по умолчанию пусто, только код A-Z/_, не экспортируется; сброс настроек его сохраняет', async () => {
    expect(defaultSettings().bundledModelError).toBe('');
    expect(validateSettingsPatch({ bundledModelError: 'HASH_MISMATCH' })).toEqual([]);
    expect(validateSettingsPatch({ bundledModelError: '' })).toEqual([]);
    for (const bad of ['hash', 'Ошибка', 'A B', 'X'.repeat(41), 1, null])
      expect(validateSettingsPatch({ bundledModelError: bad }), String(bad)).toEqual(['bundledModelError']);
    expect(migrateSettings({ bundledModelError: 'плохо' }).settings.bundledModelError).toBe('');
    expect(migrateSettings({ bundledModelError: 'QUOTA' }).settings.bundledModelError).toBe('QUOTA');
    const { NOT_EXPORTED, KEPT_ON_RESET, parseConfigFile, CONFIG_KIND } = await import('../../src/options/config-io.js');
    expect(NOT_EXPORTED.has('bundledModelError')).toBe(true);
    expect([...KEPT_ON_RESET].sort()).toEqual(['bundledModelError', 'bundledModelSha', 'nerModel']);
    expect(parseConfigFile(JSON.stringify({ kind: CONFIG_KIND, settings: { bundledModelError: 'QUOTA', mode: 'mask' } })).patch).toEqual({ mode: 'mask' });
  });
  it('bundledModelSha (WP10-C): по умолчанию пусто, только hex64, без миграции версии, не экспортируется', async () => {
    const sha = '0123456789abcdef'.repeat(4);
    expect(defaultSettings().bundledModelSha).toBe('');
    expect(validateSettingsPatch({ bundledModelSha: sha })).toEqual([]);
    expect(validateSettingsPatch({ bundledModelSha: '' })).toEqual([]);
    for (const bad of ['abc', sha.toUpperCase(), sha + '0', 42])
      expect(validateSettingsPatch({ bundledModelSha: bad }), String(bad)).toEqual(['bundledModelSha']);
    expect(migrateSettings({ bundledModelSha: 'плохо' }).settings.bundledModelSha).toBe('');
    expect(migrateSettings({ bundledModelSha: sha }).settings.bundledModelSha).toBe(sha);
    expect(migrateSettings({}).settings.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
    const { NOT_EXPORTED, parseConfigFile, CONFIG_KIND } = await import('../../src/options/config-io.js');
    expect(NOT_EXPORTED.has('bundledModelSha')).toBe(true);
    expect(parseConfigFile(JSON.stringify({ kind: CONFIG_KIND, settings: { bundledModelSha: sha, mode: 'mask' } })).patch).toEqual({ mode: 'mask' });
  });
  it('профиль external включает все категории', () => {
    const s = effectiveSettings(defaultSettings(), 'external');
    expect(s.categories.AMOUNT).toBe(true);
    expect(s.stripEmbedded).toBe(true);
  });
});

describe('sites (FR-35)', () => {
  it('matchOrigin с * для поддоменов', () => {
    expect(matchOrigin('https://chatgpt.com', 'https://chatgpt.com')).toBe(true);
    expect(matchOrigin('https://chatgpt.com', 'http://chatgpt.com')).toBe(false);
    expect(matchOrigin('https://*.google.com', 'https://gemini.google.com')).toBe(true);
    expect(matchOrigin('https://*.google.com', 'https://google.com')).toBe(true);
    expect(matchOrigin('https://*.google.com', 'https://evilgoogle.com')).toBe(false);
    expect(matchOrigin('http://localhost:8080', 'http://localhost:8080')).toBe(true);
    expect(matchOrigin('http://localhost:8080', 'http://localhost:9090')).toBe(false);
  });
  it('allowlist / all / blocklist / тумблер', () => {
    const s = defaultSettings();
    expect(isOriginAllowed(s, 'https://claude.ai')).toBe(true);
    expect(isOriginAllowed(s, 'https://mail.ru')).toBe(false);
    expect(isInterceptActive(s, 'https://claude.ai')).toBe(false);
    const all = { ...s, interceptEnabled: true, siteMode: 'all', blocklist: ['https://mail.ru'] };
    expect(isInterceptActive(all, 'https://example.org')).toBe(true);
    expect(isInterceptActive(all, 'https://mail.ru')).toBe(false);
  });
});
