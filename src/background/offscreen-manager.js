// Жизненный цикл offscreen-документа (ТЗ §5.2).
const OFFSCREEN_URL = 'offscreen/offscreen.html';
let creating = null;

export async function hasDocument() {
  if (chrome.runtime.getContexts) {
    const ctx = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
    });
    return ctx.length > 0;
  }
  return false;
}

/** Создаёт offscreen-документ, если его нет, и ждёт, пока он ответит на PING. */
export async function ensureOffscreen() {
  if (!(await hasDocument())) {
    if (!creating) {
      creating = chrome.offscreen
        .createDocument({
          url: OFFSCREEN_URL,
          reasons: ['WORKERS'],
          justification: 'Локальная обработка .docx в Web Worker без сетевых запросов',
        })
        .finally(() => {
          creating = null;
        });
    }
    await creating;
  }
  for (let i = 0; i < 50; i++) {
    try {
      const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'PING' });
      if (r && r.ok) return;
    } catch {
      /* ещё не готов */
    }
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('offscreen не отвечает');
}

export async function closeOffscreen() {
  if (await hasDocument()) await chrome.offscreen.closeDocument();
}
