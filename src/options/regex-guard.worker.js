// Проверка пользовательского регулярного выражения в отдельном Worker (FR-45, R-8).
// Получает {regex, flags, sample?}, отвечает {ok, matches} либо {ok:false, code}.
// Вызывающий завершает Worker через 500 мс (terminate) — зависший бэктрекинг так не страшен.
import { evaluateRegex } from './regex-guard-core.js';

self.postMessage({ ready: true }); // клиент запускает таймер 500 мс только после старта Worker'а
self.onmessage = (e) => {
  try {
    self.postMessage(evaluateRegex(e.data || {}));
  } catch (err) {
    self.postMessage({ ok: false, code: 'SYNTAX', message: String(err?.message || err) });
  }
};
