// Popup. Тумблер перехвата и ссылки — заготовка для WP3; блок «Проверка конвейера» — временный.
import { connectClient } from '../shared/port-client.js';
import { loadSettings, saveSettingsPatch } from '../shared/settings-store.js';

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

async function init() {
  const toggle = /** @type {HTMLInputElement} */ ($('intercept-toggle'));
  const s = await loadSettings();
  toggle.checked = s.interceptEnabled;
  toggle.addEventListener('change', () => saveSettingsPatch({ interceptEnabled: toggle.checked }));
  $('open-options').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  $('open-restore').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('restore/restore.html') });
  });
  $('dev-file').addEventListener('change', onDevFile);
}

async function onDevFile(e) {
  const input = /** @type {HTMLInputElement} */ (e.target);
  const file = input.files?.[0];
  if (!file) return;
  const status = $('dev-status');
  const client = connectClient();
  try {
    status.textContent = 'Чтение…';
    const bytes = new Uint8Array(await file.arrayBuffer());
    const res = await client.analyzeFile({
      name: file.name,
      bytes,
      origin: location.origin,
      onProgress: (stage, p) => (status.textContent = `${stage}: ${p}%`),
    });
    $('dev-result').hidden = false;
    $('dev-result').querySelector('[data-testid="vt-length"]').textContent = String(res.stats.virtualTextLength);
    $('dev-result').querySelector('[data-testid="entity-count"]').textContent = String(res.entities.length);
    status.textContent = 'Применение…';
    const out = await client.apply({ docId: res.docId, decisions: [] });
    $('dev-result').querySelector('[data-testid="result-size"]').textContent = String(out.bytes.length);
    const a = /** @type {HTMLAnchorElement} */ ($('dev-download'));
    a.href = URL.createObjectURL(new Blob([out.bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
    a.download = out.name;
    a.hidden = false;
    status.textContent = `Готово: ${out.name}`;
  } catch (err) {
    status.textContent = `Ошибка: ${err.code || ''} ${err.message}`;
  } finally {
    client.port.disconnect();
  }
}

init();
