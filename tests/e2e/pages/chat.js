// Общая логика тестовой страницы «чат LLM» (WP5): принимает файлы разными способами и ЗАПИСЫВАЕТ в DOM,
// что страница реально получила (имя, размер, SHA-256, источник). Страница — единственный источник правды для e2e.
// Без внешней сети.
(function () {
  const received = []; // {name, size, type, sha256, source}
  const files = []; // File — для чтения содержимого тестом
  const rawEvents = { change: 0, drop: 0, paste: 0 };
  const log = document.getElementById('log');

  async function sha256(file) {
    const buf = await file.arrayBuffer();
    const d = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function accept(source, fileList) {
    const list = Array.from(fileList || []);
    for (const f of list) {
      const rec = { name: f.name, size: f.size, type: f.type, sha256: await sha256(f), source };
      received.push(rec);
      files.push(f);
      const li = document.createElement('li');
      li.dataset.testid = 'received';
      li.dataset.name = rec.name;
      li.dataset.size = String(rec.size);
      li.dataset.sha256 = rec.sha256;
      li.dataset.source = source;
      li.textContent = `${rec.name} · ${rec.size} · ${rec.sha256.slice(0, 12)} · ${source}`;
      log.appendChild(li);
    }
    document.getElementById('count').textContent = String(received.length);
    return list.length;
  }

  /** Привязывает input к «чату»: после выбора файлы принимаются, значение сбрасывается (как в ChatGPT/Claude). */
  function wireInput(input, source) {
    input.addEventListener('change', async () => {
      rawEvents.change++;
      const picked = Array.from(input.files);
      await accept(source, picked);
      input.value = '';
    });
  }

  window.__chat = {
    wireInput,
    accept,
    received,
    rawEvents,
    /** base64 содержимого принятого файла (для проверок в Node) */
    async fileBase64(i) {
      const buf = new Uint8Array(await files[i].arrayBuffer());
      let s = '';
      for (let k = 0; k < buf.length; k += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(k, k + 0x8000));
      return btoa(s);
    },
    reset() {
      received.length = 0;
      files.length = 0;
      log.textContent = '';
      document.getElementById('count').textContent = '0';
    },
  };
})();
