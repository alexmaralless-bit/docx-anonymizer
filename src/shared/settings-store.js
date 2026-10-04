// Обёртка chrome.storage.local для настроек (FR-34). Единственное место, где настройки читаются из хранилища.
import { SETTINGS_KEY, migrateSettings, validateSettingsPatch } from '../core/settings.js';

/** @returns {Promise<import('../core/settings.js').Settings>} */
export async function loadSettings() {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  return migrateSettings(r[SETTINGS_KEY]).settings;
}

/** Применяет миграцию к сохранённым настройкам (onInstalled). */
export async function migrateStoredSettings() {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  const { settings, changed } = migrateSettings(r[SETTINGS_KEY]);
  if (changed) await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}

/**
 * Сохраняет частичное изменение. Невалидные ключи не сохраняются — возвращаются в `rejected`.
 * @param {Partial<import('../core/settings.js').Settings>} patch
 */
export async function saveSettingsPatch(patch) {
  const rejected = validateSettingsPatch(patch);
  const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => !rejected.includes(k)));
  const current = await loadSettings();
  const next = { ...current, ...clean };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return { settings: next, rejected };
}

/** Подписка на изменения настроек; возвращает функцию отписки. */
export function onSettingsChanged(cb) {
  const fn = (changes, area) => {
    if (area === 'local' && changes[SETTINGS_KEY]) cb(migrateSettings(changes[SETTINGS_KEY].newValue).settings);
  };
  chrome.storage.onChanged.addListener(fn);
  return () => chrome.storage.onChanged.removeListener(fn);
}
