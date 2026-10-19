// Автоустановка встроенной модели NER (версия 0.3, WP10-C, Ц7/К15; docs/contracts.md §6.8).
// Полная сборка запекает описание пакета в __BUNDLED_MODEL__ (scripts/build.mjs --with-model), лёгкая — null.
// При установке/обновлении расширения и старте профиля background решает по planBootstrap; при `install` поднимает offscreen и
// шлёт MODEL_INSTALL: воркер сам читает zip из пакета расширения (chrome-extension://, сети нет — NFR-01) и пишет в OPFS
// (createWritable в service worker не подтверждён, background без fetch). Ответ MODEL_INSTALLED приходит ОТДЕЛЬНЫМ сообщением
// (service worker мог уснуть за время установки и проснётся на нём) и превращается в патч настроек. Значений документа нет —
// в лог пишутся только коды.
import { MSG, TARGET, makeRequestId } from '../shared/protocol.js';
import { BOOTSTRAP_CLIENT, planBootstrap, settingsPatchFor } from '../shared/bundled-model.js';
import { loadSettings, migrateStoredSettings, saveSettingsPatch } from '../shared/settings-store.js';
import { ensureOffscreen } from './offscreen-manager.js';

/** @returns {import('../shared/bundled-model.js').BundledModel | null} */
function bundled() {
  // читается при каждом вызове (а не один раз при загрузке), чтобы тесты могли подменить define через vi.stubGlobal
  return typeof __BUNDLED_MODEL__ !== 'undefined' ? __BUNDLED_MODEL__ : null;
}
const extVersion = () => (typeof __VERSION__ !== 'undefined' ? __VERSION__ : '0.0.0');

/** @type {Promise<string> | null} текущий запуск: повторные вызовы до отправки MODEL_INSTALL получают его же */
let running = null;

/**
 * Слушатели верхнего уровня (MV3: регистрируются синхронно при каждом пробуждении service worker).
 * onInstalled: миграция настроек (раньше — в index.js), затем при install|update — план установки; onStartup — план;
 * onMessage — ответ хоста MODEL_INSTALLED с clientId 'bootstrap' (router такие сообщения игнорирует: порта с этим id нет).
 * @param {typeof chrome} [api]
 */
export function initBundledModel(api = chrome) {
  api.runtime.onInstalled.addListener((details) => {
    migrateStoredSettings()
      .catch(() => {})
      .then(() => {
        if (details?.reason === 'install' || details?.reason === 'update') return bootstrapBundledModel();
      })
      .catch(() => {});
  });
  api.runtime.onStartup?.addListener(() => {
    bootstrapBundledModel().catch(() => {});
  });
  api.runtime.onMessage.addListener((m) => {
    if (!m || m.target !== TARGET.BACKGROUND || m.clientId !== BOOTSTRAP_CLIENT) return false;
    onHostReply(m.msg).catch(() => console.warn('[bundled-model] SETTINGS_FAILED'));
    return false;
  });
}

/**
 * Решает и при необходимости запускает установку. Не ждёт её окончания: возвращает план ('none'|'skip'|'foreign'|'install').
 * force (кнопка «Восстановить встроенную модель», MSG.MODEL_BOOTSTRAP) трактует `skip` как `install`.
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<string>}
 */
export function bootstrapBundledModel({ force = false } = {}) {
  if (!running) running = run(force).finally(() => (running = null));
  return running;
}

async function run(force) {
  const b = bundled();
  let plan = planBootstrap({ bundled: b, settings: await loadSettings() });
  if (force && plan === 'skip') plan = 'install';
  if (plan !== 'install') return plan;
  const msg = {
    type: MSG.MODEL_INSTALL,
    requestId: makeRequestId('mi'),
    url: chrome.runtime.getURL(`models/${b.file}`),
    id: b.id,
    sha256: b.sha256,
    version: b.version,
    extensionVersion: extVersion(),
  };
  try {
    await ensureOffscreen();
    try {
      await chrome.runtime.sendMessage({ target: TARGET.OFFSCREEN, clientId: BOOTSTRAP_CLIENT, msg });
    } catch {
      // как router (§3.5): одна повторная попытка после пересоздания offscreen
      await ensureOffscreen();
      await chrome.runtime.sendMessage({ target: TARGET.OFFSCREEN, clientId: BOOTSTRAP_CLIENT, msg });
    }
  } catch {
    console.warn('[bundled-model] HOST_UNAVAILABLE');
  }
  return plan;
}

/** Ответ хоста: installed|present → патч настроек; failed/ERROR → предупреждение с кодом, настройки не меняются. */
async function onHostReply(msg) {
  const b = bundled();
  if (!msg || !b) return;
  if (msg.type === MSG.ERROR) {
    console.warn(`[bundled-model] ${msg.code || 'INTERNAL'}`);
    return;
  }
  if (msg.type !== MSG.MODEL_INSTALLED || msg.sha256 !== b.sha256) return;
  if (msg.status === 'failed') {
    console.warn(`[bundled-model] ${msg.code || 'INTERNAL'}`);
    return;
  }
  const patch = settingsPatchFor(msg, b, await loadSettings());
  if (!patch) return;
  await saveSettingsPatch(patch);
  if (msg.status === 'installed') console.info(`[bundled-model] installed in ${Math.round(msg.ms ?? 0)} ms`);
}
