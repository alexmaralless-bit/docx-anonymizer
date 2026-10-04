// Content script (WP3): перехват input/drop/paste и панель в Shadow DOM (FR-01–FR-09, §3.2–3.7).
// FR-07: если перехват выключен или сайт не разрешён — НИЧЕГО не делаем (ни обработчиков, ни DOM, ни порта).
import { isInterceptActive } from '../core/sites.js';
import { defaultSettings } from '../core/settings.js';
import { loadSettings, onSettingsChanged } from '../shared/settings-store.js';
import { createInterceptor } from './interceptor.js';
import { createFlow } from './flow.js';
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
    interceptor = createInterceptor(flow);
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

boot();
