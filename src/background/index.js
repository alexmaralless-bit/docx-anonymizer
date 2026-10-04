// Service worker расширения: маршрутизатор + миграция настроек + бейдж.
import { initRouter } from './router.js';
import { initBadge } from './badge.js';
import { migrateStoredSettings } from '../shared/settings-store.js';

initRouter();
initBadge();

chrome.runtime.onInstalled.addListener(() => {
  migrateStoredSettings();
});
