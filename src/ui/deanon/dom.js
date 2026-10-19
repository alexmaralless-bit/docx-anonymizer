// Мини-помощники для сборки DOM без innerHTML (значения пользователя всегда попадают как текст).

/**
 * @param {string} tag
 * @param {Record<string, any>} [attrs]  class, dataset, on* (обработчики), остальное — атрибуты/свойства
 * @param {...(Node|string|null|false)} children
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list' && k !== 'form') /** @type {any} */ (el)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** Скачивание файла без chrome.downloads (FR-36а: восстановленный файл от ИИ). */
export function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Скачивание JSON-файла без chrome.downloads. */
export function downloadJson(name, obj) {
  downloadBlob(name, new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
}

/** Модальное подтверждение на <dialog>. */
export function confirmDialog(text, { ok = 'OK', cancel = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'dlg', 'aria-label': text });
    const done = (v) => {
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    dlg.append(
      h('p', { class: 'dlg-text' }, text),
      h(
        'div',
        { class: 'dlg-actions' },
        h('button', { type: 'button', class: 'btn', dataset: { testid: 'dlg-cancel' }, onclick: () => done(false) }, cancel),
        h('button', { type: 'button', class: danger ? 'btn danger' : 'btn primary', dataset: { testid: 'dlg-ok' }, onclick: () => done(true) }, ok),
      ),
    );
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      done(false);
    });
    document.body.append(dlg);
    dlg.showModal();
  });
}

export function readFileText(file) {
  return file.text();
}
