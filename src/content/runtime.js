// Доступ к API расширения из content script с учётом инвалидации контекста (FR-09, §3.5).
import { connectClient } from '../shared/port-client.js';
import { ProtocolError } from '../shared/protocol.js';

/** chrome.runtime.id пропадает, когда расширение обновлено/перезагружено, а страница осталась. */
export function contextValid() {
  try {
    return !!(globalThis.chrome && chrome.runtime && chrome.runtime.id);
  } catch {
    return false;
  }
}

/** Ленивое соединение с background; переподключается после разрыва порта. */
export class Link {
  constructor() {
    this.client = null;
  }
  get() {
    if (!this.client) {
      if (!contextValid()) throw new ProtocolError('HOST_UNAVAILABLE', 'Extension context invalidated');
      const c = connectClient();
      c.port.onDisconnect.addListener(() => {
        if (this.client === c) this.client = null;
      });
      this.client = c;
    }
    return this.client;
  }
  close() {
    try {
      this.client?.port.disconnect();
    } catch {
      /* порт уже закрыт */
    }
    this.client = null;
  }
}

/** Флаг тестов: открытый Shadow DOM, чтобы Playwright видел панель. Задаётся только из страницы расширения. */
export const E2E_FLAG_KEY = '__e2eOpenShadow';
export async function readOpenShadowFlag() {
  try {
    if (!contextValid()) return false;
    const r = await chrome.storage.local.get(E2E_FLAG_KEY);
    return r[E2E_FLAG_KEY] === true;
  } catch {
    return false;
  }
}
