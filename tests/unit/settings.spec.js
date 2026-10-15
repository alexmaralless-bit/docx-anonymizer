import { describe, it, expect } from 'vitest';
import { defaultSettings, migrateSettings, validateSettingsPatch, effectiveSettings, SETTINGS_SCHEMA_VERSION } from '../../src/core/settings.js';
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
