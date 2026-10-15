// Клиент протокола внутри страницы расширения: гоняет конвейер background → offscreen → worker без UI popup.
import { build } from 'esbuild';
import { resolve } from 'node:path';

let bundle;
/** Вставляет window.__docx = {connectClient, MSG} в страницу расширения (через CDP evaluate — CSP страницы не мешает). */
export async function installClient(page) {
  if (!bundle) {
    const r = await build({
      entryPoints: [resolve('tests/e2e/helpers/client-entry.js')],
      bundle: true,
      format: 'iife',
      write: false,
      charset: 'utf8',
      target: ['chrome120'],
    });
    bundle = r.outputFiles[0].text;
  }
  await page.evaluate(bundle);
}

/**
 * Файл → ANALYZE → APPLY в странице расширения. Возвращает метаданные и результат (base64).
 * @param {import('@playwright/test').Page} page страница расширения с установленным клиентом
 */
export function runPipeline(page, { name, bytes, origin = 'http://test.invalid' }) {
  return page.evaluate(
    async ({ name, b64, origin }) => {
      const client = window.__docx.connectClient();
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const stages = [];
      const t0 = performance.now();
      const ent = await client.analyzeFile({ name, bytes, origin, onProgress: (s) => stages.push(s) });
      const analyzeMs = performance.now() - t0;
      const res = await client.apply({ docId: ent.docId, mode: 'placeholder', decisions: [] });
      let bin = '';
      for (let i = 0; i < res.bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, res.bytes.subarray(i, i + 0x8000));
      client.port.disconnect();
      return {
        ent: {
          docId: ent.docId,
          stats: ent.stats,
          language: ent.language,
          warnings: ent.warnings,
          entities: ent.entities.map((e) => ({ id: e.id, category: e.category, value: e.value, placeholder: e.placeholder, source: e.source })),
        },
        analyzeMs,
        stages: [...new Set(stages)],
        resultName: res.name,
        mapping: res.mapping,
        b64: btoa(bin),
      };
    },
    { name, b64: Buffer.from(bytes).toString('base64'), origin },
  );
}
