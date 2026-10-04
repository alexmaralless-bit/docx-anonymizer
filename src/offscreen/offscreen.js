// Offscreen-документ: только мост runtime.sendMessage ⇄ Web Worker с ядром. UI нет.
import { TARGET } from '../shared/protocol.js';

const worker = new Worker('worker.js');

worker.onmessage = (e) => {
  const { clientId, msg } = e.data;
  chrome.runtime.sendMessage({ target: TARGET.BACKGROUND, clientId, msg }).catch(() => {
    // background мог перезапуститься — клиент получит HOST_UNAVAILABLE по разрыву порта
  });
};
worker.onerror = () => {
  chrome.runtime.sendMessage({ target: TARGET.BACKGROUND, type: 'WORKER_CRASHED' }).catch(() => {});
};

chrome.runtime.onMessage.addListener((m, _sender, sendResponse) => {
  if (!m || m.target !== TARGET.OFFSCREEN) return false;
  if (m.type === 'PING') {
    sendResponse({ ok: true });
    return false;
  }
  worker.postMessage({ clientId: m.clientId, msg: m.msg });
  return false;
});
