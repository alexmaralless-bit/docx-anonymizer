// Content script (WP3): перехват input/drop/paste и панель в Shadow DOM (FR-01–FR-09, §3.2–3.7).
// FR-07: если перехват выключен или сайт не разрешён — НИЧЕГО не делаем (ни обработчиков, ни DOM, ни порта).
import { isInterceptActive } from '../core/sites.js';
import { defaultSettings } from '../core/settings.js';
import { loadSettings, onSettingsChanged } from '../shared/settings-store.js';
import { createInterceptor } from './interceptor.js';
import { createFlow } from './flow.js';
import { isSupported } from './files.js';
import { contextValid } from './runtime.js';

let settings = defaultSettings();
let interceptor = null;
let unsubscribe = null;

function teardown() {
  interceptor?.detach();
  interceptor = null;
  try {
    unsubscribe?.();
  } catch {
    /* контекст инвалидирован */
  }
  unsubscribe = null;
}

function sync() {
  const active = isInterceptActive(settings, location.origin);
  if (active && !interceptor) {
    const flow = createFlow({ getSettings: () => settings, onInvalidated: () => interceptor?.detach() }); // FR-09
    // DOCX всегда, PDF — по настройке pdfMode (версия 0.3); настройки читаются в момент события
    interceptor = createInterceptor(flow, { isSupported: (f) => isSupported(f, settings) });
    interceptor.attach();
  } else if (!active && interceptor) {
    interceptor.detach();
    interceptor = null;
  }
}

async function boot() {
  if (!contextValid()) return;
  try {
    settings = await loadSettings();
    sync();
    unsubscribe = onSettingsChanged((s) => {
      settings = s;
      sync();
    });
  } catch {
    teardown();
  }
}

// Скрипт может прийти дважды: через зарегистрированный content script и через executeScript сразу после выдачи доступа
// (background/site-access.js). Изолированный мир у обоих общий — второй запуск ничего не делает.
const BOOT_FLAG = '__docxAnonymizerBooted';
if (!globalThis[BOOT_FLAG]) {
  globalThis[BOOT_FLAG] = true;
  boot();
}
