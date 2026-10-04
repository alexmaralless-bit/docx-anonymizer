// Перехват выбора файла (FR-01), drag&drop (FR-02) и вставки (FR-03). FR-05: подмена через DataTransfer.
// Обработчики вешаются на window в фазе capture — раньше обработчиков страницы (content script на document_start).
import { hasDocx, isDocx, fileSignature } from './files.js';

const isFileInput = (n) => !!n && n.tagName === 'INPUT' && /** @type {HTMLInputElement} */ (n).type === 'file';

/**
 * @param {{run: (files: File[]) => Promise<{action: string, files: File[]}>}} flow
 * @param {{win?: Window}} [env]
 */
export function createInterceptor(flow, env = {}) {
  const win = env.win || window;
  const doc = win.document;
  let bypass = false; // наши собственные события не перехватываем повторно (FR-05)
  const produced = new Set(); // сигнатуры файлов, которые мы сами подставили
  const held = new WeakSet(); // inputs, по которым идёт обработка
  const hooked = new WeakSet();
  const roots = [];
  let observer = null;
  let scanTimer = 0;
  const pendingNodes = new Set();
  let attached = false;

  const needsProcessing = (files) => hasDocx(files) && !files.filter(isDocx).every((f) => produced.has(fileSignature(f)));

  function withBypass(fn) {
    bypass = true;
    try {
      fn();
    } finally {
      bypass = false;
    }
  }

  function setInputFiles(input, files) {
    const dt = new win.DataTransfer();
    for (const f of files) dt.items.add(f);
    input.files = dt.files;
  }

  function fireInputEvents(input) {
    withBypass(() => {
      input.dispatchEvent(new win.Event('input', { bubbles: true, composed: true }));
      input.dispatchEvent(new win.Event('change', { bubbles: true }));
    });
  }

  function remember(originals, res) {
    res.files.forEach((f, i) => {
      if (f !== originals[i]) produced.add(fileSignature(f));
    });
  }

  /* ---------- input[type=file] ---------- */
  function onInputEvent(e) {
    if (bypass) return;
    const input = e.composedPath?.()[0] ?? e.target;
    if (!isFileInput(input)) return;
    if (held.has(input)) {
      e.stopImmediatePropagation(); // input → change: второе событие той же выборки
      return;
    }
    const files = Array.from(input.files || []);
    if (!needsProcessing(files)) return;
    e.stopImmediatePropagation();
    held.add(input);
    flow
      .run(files)
      .then((res) => {
        if (res.action === 'cancel') {
          input.value = ''; // повторный выбор того же файла снова вызовет change
          return;
        }
        if (res.action === 'anonymized') {
          remember(files, res);
          setInputFiles(input, res.files);
        }
        fireInputEvents(input);
      })
      .catch(() => {
        input.value = '';
      })
      .finally(() => held.delete(input));
  }

  /* ---------- drop ---------- */
  function onDrop(e) {
    if (bypass) return;
    const files = Array.from(e.dataTransfer?.files || []);
    if (!needsProcessing(files)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const target = e.composedPath?.()[0] ?? e.target;
    const init = { clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY, bubbles: true, cancelable: true, composed: true };
    flow
      .run(files)
      .then((res) => {
        if (res.action === 'cancel') return;
        if (res.action === 'anonymized') remember(files, res);
        if (isFileInput(target)) {
          setInputFiles(target, res.files);
          fireInputEvents(target);
          return;
        }
        const dt = new win.DataTransfer();
        for (const f of res.files) dt.items.add(f);
        withBypass(() => target.dispatchEvent(new win.DragEvent('drop', { ...init, dataTransfer: dt })));
      })
      .catch(() => {});
  }

  /* ---------- paste ---------- */
  function onPaste(e) {
    if (bypass) return;
    const files = Array.from(e.clipboardData?.files || []);
    if (!needsProcessing(files)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const target = e.composedPath?.()[0] ?? e.target;
    flow
      .run(files)
      .then((res) => {
        if (res.action === 'cancel') return;
        if (res.action === 'anonymized') remember(files, res);
        const dt = new win.DataTransfer();
        for (const f of res.files) dt.items.add(f);
        withBypass(() => target.dispatchEvent(new win.ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true })));
      })
      .catch(() => {});
  }

  /* ---------- открытые Shadow DOM: change не «composed», слушаем корни ---------- */
  function hookRoot(root) {
    if (hooked.has(root)) return;
    hooked.add(root);
    roots.push(root);
    root.addEventListener('change', onInputEvent, true);
    root.addEventListener('input', onInputEvent, true);
    observer?.observe(root, { childList: true, subtree: true });
    scan(root);
  }

  function scan(node) {
    if (node.nodeType === 1 && /** @type {Element} */ (node).shadowRoot) hookRoot(/** @type {Element} */ (node).shadowRoot);
    const list = node.querySelectorAll ? node.querySelectorAll('*') : [];
    for (const el of list) if (el.shadowRoot) hookRoot(el.shadowRoot);
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = win.setTimeout(() => {
      scanTimer = 0;
      const nodes = [...pendingNodes];
      pendingNodes.clear();
      for (const n of nodes) if (n.isConnected) scan(n);
    }, 150);
  }

  function attach() {
    if (attached) return;
    attached = true;
    win.addEventListener('input', onInputEvent, true);
    win.addEventListener('change', onInputEvent, true);
    win.addEventListener('drop', onDrop, true);
    win.addEventListener('paste', onPaste, true);
    observer = new win.MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) pendingNodes.add(n);
      if (pendingNodes.size) scheduleScan();
    });
    const start = () => {
      if (!attached || !doc.documentElement) return;
      observer.observe(doc.documentElement, { childList: true, subtree: true });
      scan(doc.documentElement);
    };
    if (doc.documentElement) start();
    else doc.addEventListener('DOMContentLoaded', start, { once: true });
  }

  /** Снять все обработчики и наблюдатели (FR-07, FR-09). */
  function detach() {
    if (!attached) return;
    attached = false;
    win.removeEventListener('input', onInputEvent, true);
    win.removeEventListener('change', onInputEvent, true);
    win.removeEventListener('drop', onDrop, true);
    win.removeEventListener('paste', onPaste, true);
    for (const r of roots) {
      r.removeEventListener('change', onInputEvent, true);
      r.removeEventListener('input', onInputEvent, true);
    }
    roots.length = 0;
    observer?.disconnect();
    observer = null;
    win.clearTimeout(scanTimer);
    scanTimer = 0;
    pendingNodes.clear();
  }

  return {
    attach,
    detach,
    get attached() {
      return attached;
    },
  };
}
