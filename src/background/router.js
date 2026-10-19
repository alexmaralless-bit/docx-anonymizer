// Маршрутизатор: порты клиентов (content/popup/options/restore) ⇄ offscreen (§5.1, §5.4).
// Background добавляет к сообщениям поле `settings` — offscreen не имеет доступа к chrome.storage.
import { PORT_NAME, TARGET, MSG, OPTIONS_SECTIONS, errorMessage } from '../shared/protocol.js';
import { ensureOffscreen, hasDocument } from './offscreen-manager.js';
import { loadSettings } from '../shared/settings-store.js';
import { bootstrapBundledModel } from './bundled-model.js';

/** @type {Map<string, chrome.runtime.Port>} */
const ports = new Map();
let clientSeq = 0;

/** Сообщения, которым нужны настройки. */
const NEEDS_SETTINGS = new Set([MSG.FILE_BEGIN, MSG.ANALYZE, MSG.APPLY, MSG.ADD_ENTITY, MSG.BATCH_BEGIN]);

export function initRouter() {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return;
    const clientId = `c${++clientSeq}_${Date.now().toString(36)}`;
    ports.set(clientId, port);
    port.onDisconnect.addListener(() => ports.delete(clientId));
    // Очередь: сообщения одного клиента уходят в offscreen строго по порядку
    let chain = Promise.resolve();
    port.onMessage.addListener((msg) => {
      chain = chain.then(() => forward(clientId, port, msg));
    });
  });

  chrome.runtime.onMessage.addListener((m) => {
    if (!m || m.target !== TARGET.BACKGROUND) return false;
    if (m.clientId) ports.get(m.clientId)?.postMessage(m.msg);
    return false;
  });
}

/** Сообщения только background ⇄ offscreen (WP10-C): клиентский порт их слать не может — хост ставит модель лишь по просьбе background. */
const BOOTSTRAP_ONLY = new Set([MSG.MODEL_INSTALL, MSG.MODEL_INSTALLED]);

async function forward(clientId, port, msg) {
  try {
    // Дополнительный рубеж (К17, NFR-01): url в MODEL_INSTALL проверяет и воркер (offscreen/package-fetch.js), но от
    // страниц такое сообщение в offscreen не пропускаем вовсе
    if (BOOTSTRAP_ONLY.has(msg?.type)) {
      port.postMessage(errorMessage(msg.requestId, { code: 'INTERNAL', message: 'Сообщение недоступно клиенту' }));
      return;
    }
    // 0.4: ссылка «Открыть настройки» из панели на сайте — страница расширения не открывается из контент-скрипта
    // (нет web_accessible_resources), поэтому вкладку открывает background; раздел — только из списка
    if (msg.type === MSG.OPEN_OPTIONS) {
      if (!OPTIONS_SECTIONS.includes(msg.section)) {
        port.postMessage(errorMessage(msg.requestId, { code: 'INTERNAL', message: 'Неизвестный раздел настроек' }));
        return;
      }
      await chrome.tabs.create({ url: chrome.runtime.getURL(`options/options.html#${msg.section}`) });
      port.postMessage({ type: MSG.ACK, requestId: msg.requestId });
      return;
    }
    // WP10-C: «Восстановить встроенную модель» — установка идёт в фоне (bundled-model.js), клиенту сразу ACK;
    // итог он увидит по смене настроек (nerModel/bundledModelSha). offscreen поднимает сам bootstrap, если нужно.
    if (msg.type === MSG.MODEL_BOOTSTRAP) {
      bootstrapBundledModel({ force: true }).catch(() => {});
      port.postMessage({ type: MSG.ACK, requestId: msg.requestId });
      return;
    }
    // WP8: смена пакета модели NER сбрасывает кэш провайдера в воркере. Нет offscreen — нет и кэша: отвечаем сами,
    // не поднимая документ ради пустой операции (новый воркер прочтёт модель заново).
    if (msg.type === MSG.MODEL_CHANGED && !(await hasDocument())) {
      port.postMessage({ type: MSG.ACK, requestId: msg.requestId });
      return;
    }
    if (NEEDS_SETTINGS.has(msg.type)) msg = { ...msg, settings: await loadSettings() };
    await ensureOffscreen();
    try {
      await chrome.runtime.sendMessage({ target: TARGET.OFFSCREEN, clientId, msg });
    } catch {
      // §3.5: одна повторная попытка после пересоздания offscreen
      await ensureOffscreen();
      await chrome.runtime.sendMessage({ target: TARGET.OFFSCREEN, clientId, msg });
    }
  } catch (err) {
    try {
      port.postMessage(errorMessage(msg.requestId, { code: 'HOST_UNAVAILABLE', message: 'Модуль обработки недоступен' }));
    } catch {
      /* порт закрыт */
    }
  }
}
