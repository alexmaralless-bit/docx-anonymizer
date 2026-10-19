// Service worker расширения: маршрутизатор + миграция настроек + бейдж + регистрация content script по выданному доступу (К9)
// + автоустановка встроенной модели NER (WP10-C).
import { initRouter } from './router.js';
import { initBadge } from './badge.js';
import { createSiteAccess } from './site-access.js';
import { initBundledModel } from './bundled-model.js';

initRouter();
initBadge();
createSiteAccess().init();
// onInstalled → migrateStoredSettings() и затем (install|update) план установки встроенной модели; onStartup — тот же план.
// Миграция живёт там же, чтобы патч настроек после установки модели не перетёрся параллельной миграцией.
initBundledModel();
