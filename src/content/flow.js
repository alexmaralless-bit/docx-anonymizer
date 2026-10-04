// Сценарий одной перехваченной отправки (§3.2, §3.4–3.7): анализ → панель → применение → результат.
// Возвращает решение интерсептору: что передать сайту.
import { Panel } from '../ui/panel/panel.js';
import { buildCatalog } from '../core/categories.js';
import { mergeMappings } from '../core/mapping.js';
import { resolveUiLanguage, createT } from '../ui/i18n/index.js';
import { common } from '../ui/i18n/common.js';
import { panel as panelDict } from '../ui/i18n/panel.js';
import { MSG, ProtocolError, makeRequestId } from '../shared/protocol.js';
import { saveSettingsPatch } from '../shared/settings-store.js';
import { isDocx, resultType, mappingFileName, isInvalidatedError, makeResultName } from './files.js';
import { Link, contextValid, readOpenShadowFlag } from './runtime.js';

/**
 * @typedef {{action: 'anonymized'|'original'|'cancel', files: File[]}} FlowResult
 */

/**
 * @param {{getSettings: () => import('../core/settings.js').Settings, onInvalidated?: () => void}} deps
 */
export function createFlow(deps) {
  let queue = Promise.resolve();
  let busy = 0;

  return {
    get busy() {
      return busy > 0;
    },
    /**
     * Перехваченные файлы → решение. Вызовы выстраиваются в очередь: панель одна.
     * @param {File[]} originals
     * @returns {Promise<FlowResult>}
     */
    run(originals) {
      busy++;
      const p = queue.then(() => runOnce(originals, deps)).finally(() => busy--);
      queue = p.catch(() => {});
      return p;
    },
  };
}

/** @returns {Promise<FlowResult>} */
async function runOnce(originals, deps) {
  const settings = deps.getSettings();
  const lang = resolveUiLanguage(settings.uiLanguage);
  const tt = createT({ ru: { ...common.ru, ...panelDict.ru }, en: { ...common.en, ...panelDict.en } }, lang);
  const origin = location.origin;
  const catalog = buildCatalog(settings);
  const link = new Link();
  const openShadow = await readOpenShadowFlag();
  const docxIdx = originals.map((f, i) => (isDocx(f) ? i : -1)).filter((i) => i >= 0);
  const batchId = docxIdx.length > 1 ? makeRequestId('b') : null;

  /** @type {Map<number, {docId: string, k: number}>} */
  const analyzed = new Map();
  let closed = false;
  let finish;
  const result = new Promise((res) => (finish = res));

  const discardAll = () => {
    if (!contextValid()) return;
    try {
      const c = link.get();
      for (const a of analyzed.values()) c.request(MSG.DISCARD, { docId: a.docId }).catch(() => {});
      if (batchId) c.request(MSG.BATCH_END, { batchId }).catch(() => {});
    } catch {
      /* контекст недоступен — сессии уйдут вместе с offscreen */
    }
  };
  const closePanel = () => {
    if (closed) return;
    closed = true;
    panel.destroy();
    link.close();
  };
  const decide = (action, files) => {
    finish({ action, files });
  };

  const handlers = {
    onCancel: () => {
      if (panel.phase !== 'done') {
        discardAll();
        decide('cancel', originals);
      }
      closePanel();
    },
    onOriginal: () => {
      discardAll();
      decide('original', originals);
      closePanel();
    },
    onAnonymize: () => applyAll(),
    onAsIs: () => panel.updateChrome(),
    onRetry: (i) => analyzeOne(i),
    onDisableSite: async () => {
      try {
        const cur = deps.getSettings();
        if (!cur.blocklist.includes(origin)) await saveSettingsPatch({ blocklist: [...cur.blocklist, origin] });
        panel.getPreview(panel.active)?.showToast(tt('siteDisabled', { host: location.host }));
      } catch (err) {
        if (isInvalidatedError(err)) invalidated();
      }
    },
    onPosition: (pos) => {
      try {
        const cur = deps.getSettings();
        saveSettingsPatch({ panelPosition: { ...cur.panelPosition, [origin]: pos } }).catch(() => {});
      } catch {
        /* контекст инвалидирован */
      }
    },
  };

  const panel = new Panel({ lang, catalog, origin, position: settings.panelPosition?.[origin], openShadow, handlers });
  panel.mount();

  function invalidated() {
    deps.onInvalidated?.();
    link.close();
    panel.showNotice({ title: tt('invalidatedTitle'), text: tt('invalidatedText'), allowOriginal: true });
  }

  function fail(i, err) {
    if (isInvalidatedError(err) || !contextValid()) return invalidated();
    const code = err instanceof ProtocolError ? err.code : 'INTERNAL';
    const limit = settings.maxFileSizeMB;
    const known = tt(`err.${code}`, { limit });
    panel.setError(docxIdx.indexOf(i), {
      code,
      message: known.startsWith('err.') ? err.message : known,
      retry: code === 'HOST_UNAVAILABLE' || code === 'INTERNAL',
    });
  }

  async function analyzeOne(i) {
    const k = docxIdx.indexOf(i);
    const file = originals[i];
    if (file.size > settings.maxFileSizeMB * 1024 * 1024) return fail(i, new ProtocolError('TOO_LARGE', 'too large'));
    try {
      panel.setProgress(k, 'receiving', 0);
      const client = link.get();
      const bytes = new Uint8Array(await file.arrayBuffer());
      const ent = await client.analyzeFile({
        name: file.name,
        bytes,
        origin,
        batchId: batchId || undefined,
        onProgress: (stage, p) => !closed && panel.setProgress(k, stage, p),
      });
      if (closed) return;
      analyzed.set(i, { docId: ent.docId, k });
      panel.setReady(k, {
        entities: ent.entities,
        warnings: ent.warnings,
        restored: ent.restoredDecisions,
        api: {
          getText: (from, count) => link.get().request(MSG.GET_TEXT, { docId: ent.docId, from, count }),
          addEntity: async (category, text) => (await link.get().request(MSG.ADD_ENTITY, { docId: ent.docId, category, text, replaceAll: true })).entities,
          ignoreForever: async (item) => {
            try {
              const cur = deps.getSettings();
              if (!cur.exclusions.some((e) => e.value === item.value && e.category === item.category))
                await saveSettingsPatch({ exclusions: [...cur.exclusions, { value: item.value, category: item.category }] });
            } catch (err) {
              if (isInvalidatedError(err)) invalidated();
            }
          },
        },
      });
    } catch (err) {
      if (!closed) fail(i, err);
    }
  }

  async function applyAll() {
    if (!panel.canAnonymize) return;
    panel.showApplying();
    try {
      const client = link.get();
      const outFiles = [];
      const mappings = [];
      let replacements = 0;
      const out = originals.slice();
      let stepNo = 0;
      const ready = docxIdx.filter((i) => analyzed.has(i) && panel.getPreview(docxIdx.indexOf(i)));
      for (const i of ready) {
        const k = docxIdx.indexOf(i);
        const res = await client.apply({
          docId: analyzed.get(i).docId,
          decisions: panel.getPreview(k).getDecisions(),
          onProgress: (stage, p) => panel.setApplyProgress(stage, Math.round(((stepNo + p / 100) / ready.length) * 100)),
        });
        stepNo++;
        const file = new File([res.bytes], makeResultName(originals[i].name, settings.outputSuffix), {
          type: resultType(originals[i]),
          lastModified: Date.now(),
        });
        out[i] = file;
        outFiles.push(file);
        mappings.push(res.mapping);
        replacements += res.stats?.replacements ?? 0;
      }
      if (batchId) client.request(MSG.BATCH_END, { batchId }).catch(() => {});
      const merged = mappings.length ? mergeMappings(mappings) : null;
      const sent = originals.map((f, i) => out[i].name);
      panel.showDone({
        replacements,
        names: sent,
        resultFiles: outFiles,
        mappingText: merged ? JSON.stringify(merged, null, 2) : null,
        mappingName: mappingFileName(outFiles[0]?.name),
      });
      decide('anonymized', out);
    } catch (err) {
      if (isInvalidatedError(err) || !contextValid()) return invalidated();
      panel.backToReview();
      const msg = err instanceof ProtocolError ? tt(`err.${err.code}`, { limit: settings.maxFileSizeMB }) : String(err?.message || err);
      panel.getPreview(panel.active)?.showToast(msg);
    }
  }

  // Запуск: вкладки по файлам, батч для сквозной нумерации, анализ по очереди
  if (!contextValid()) {
    invalidated();
    return result;
  }
  for (const i of docxIdx) panel.addFile(originals[i].name, originals[i].size);
  (async () => {
    try {
      if (batchId) await link.get().request(MSG.BATCH_BEGIN, { batchId });
    } catch (err) {
      for (const i of docxIdx) fail(i, err);
      return;
    }
    for (const i of docxIdx) {
      if (closed) return;
      await analyzeOne(i);
    }
  })();

  return result;
}
