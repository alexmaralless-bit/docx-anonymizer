// WP4: проверка пользовательского регулярного выражения в отдельном Worker (FR-45, R-8).
// Получает {regex, flags, sample}, отвечает {ok, matches} — вызывающий завершает Worker через 500 мс.
self.onmessage = () => {
  self.postMessage({ ok: false, error: 'не реализовано' });
};
