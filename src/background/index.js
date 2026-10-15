// Service worker расширения: маршрутизатор + миграция настроек + бейдж + регистрация content script по выданному доступу (К9).
import { initRouter } from './router.js';
import { initBadge } from './badge.js';
import { createSiteAccess } from './site-access.js';
import { migrateStoredSettings } from '../shared/settings-store.js';

initRouter();
initBadge();
createSiteAccess().init();

chrome.runtime.onInstalled.addListener(() => {
  migrateStoredSettings();
});
