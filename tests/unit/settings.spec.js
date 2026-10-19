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
  });
  it('миграция: пусто → дефолты; v0 → текущая; невалидные поля заменяются; новые категории добавляются', () => {
    expect(migrateSettings(undefined).changed).toBe(true);
    const { settings } = migrateSettings({ interceptEnabled: true, mode: 'bogus', categories: { INN: false }, maxFileSizeMB: 500 });
    expect(settings.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
    expect(settings.interceptEnabled).toBe(true);
    expect(settings.mode).toBe('placeholder');
    expect(settings.maxFileSizeMB).toBe(50);
    expect(settings.categories.INN).toBe(false);
    expect(settings.categories.PERSON).toBe(true);
    expect(migrateSettings(settings).changed).toBe(false);
  });
  it('validateSettingsPatch', () => {
    expect(validateSettingsPatch({ mode: 'mask', nerThreshold: 0.5 })).toEqual([]);
    expect(validateSettingsPatch({ mode: 'x', allowlist: ['chatgpt.com'], unknown: 1 })).toEqual(['mode', 'allowlist', 'unknown']);
  });
  it('nerThreshold (WP9): по умолчанию 0.7 = recommendedThreshold пакета; миграция 1 → 2 меняет только прежний дефолт 0.6', () => {
    expect(defaultSettings().nerThreshold).toBe(0.7);
    expect(SETTINGS_SCHEMA_VERSION).toBe(2);
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
    expect(applyMigrations(patch, 1)).toEqual({ nerThreshold: 0.7, schemaVersion: 2 });
    expect(patch).toEqual({ nerThreshold: 0.6 });
    expect(applyMigrations({ nerThreshold: 0.6 })).toEqual({ nerThreshold: 0.7, schemaVersion: 2 });
    expect(applyMigrations({ nerThreshold: 0.6 }, 2)).toEqual({ nerThreshold: 0.6 });
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
