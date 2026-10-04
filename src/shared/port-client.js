// Подключение страниц расширения и content script к background по протоколу §5.4.
import { PORT_NAME, createClient } from './protocol.js';

/** @returns {ReturnType<typeof createClient> & {port: chrome.runtime.Port}} */
export function connectClient() {
  const port = chrome.runtime.connect({ name: PORT_NAME });
  return Object.assign(createClient(port), { port });
}
