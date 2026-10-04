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
