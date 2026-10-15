// ONNX-провайдер NER (WP9, ТЗ §5.2 NLP, ступень 3): пакет модели из хранилища (WP8) → WordPiece → окна → батчи
// onnxruntime (WASM SIMD, одна нить; модуль ort передаёт worker.js) → softmax → метка первого субтокена слова → BIO → спаны.
// Модель и словарь читаются только из пакета (files.read) — сетевых запросов нет (NFR-01). Ошибки загрузки —
// CoreError MODEL_LOAD_FAILED: runner превращает их в предупреждение NER_FAILED, анализ правилами продолжается (NFR-13).
// В логах и сообщениях ошибок нет текста документа (NFR-14).
import { CoreError } from '../errors.js';
import { PACK_MANIFEST, parsePackManifest } from './pack.js';
import { createWordPiece } from './wordpiece.js';
import { makeWindows, sentenceRanges } from './windows.js';
import { labelsToTags, decodeWord, bridgePunct, mergeBio, joinAdjacent, filterSpans, alignSpans, dedupeSpans } from './bio.js';

const UPPER_RE = /\p{Lu}/u;
const decoder = new TextDecoder('utf-8');

/**
 * @typedef {object} OnnxProviderDeps
 * @property {{read: (path: string) => Promise<Uint8Array>}} files  файлы пакета (shared/model-store.js openModelFiles)
 * @property {any} ort         модуль onnxruntime ({InferenceSession, Tensor}): onnxruntime-web в воркере, в тестах — тот же или node
 * @property {string} modelId
 * @property {number} [batchSize=8]            окон в одном вызове run
 * @property {boolean} [skipLowercaseWindows=true]  пре-фильтр: окно без единого слова с заглавной буквой не считается (все O)
 * @property {number} [maxLen]                 ограничить maxLen пакета (митигация скорости, NFR-03); больше пакетного нельзя
 * @property {boolean} [splitSentences=true]  резать поток на предложения перед окнами (windows.js sentenceRanges):
 *   каждое предложение — свои окна, модель не видит соседних. Замер на склейках eval-ru — docs/contracts.md §6.7
 * @property {string[]} [executionProviders=['wasm']]
 * @property {(p: {windows: number, done: number}) => void} [onProgress]
 */

/**
 * @param {OnnxProviderDeps} deps
 * @returns {import('../contracts/ner.js').NerProvider & {stats: object}}
 */
export function createOnnxNerProvider({
  files,
  ort,
  modelId,
  batchSize = 8,
  skipLowercaseWindows = true,
  maxLen: maxLenCap,
  splitSentences = true,
  executionProviders = ['wasm'],
  onProgress,
}) {
  /** @type {Promise<void> | null} */
  let loading = null;
  /** @type {any} */
  let session = null;
  /** @type {any} */
  let model = null; // {wp, tags, manifest, maxLen, stride, inputs, output, indexType}
  /** Поколение: dispose() его увеличивает — загрузка и detect, начатые до dispose, это видят и не трогают null. */
  let gen = 0;
  /** Счётчики для бенчмарка и тестов (без содержимого документа). */
  const stats = { initMs: 0, windows: 0, skippedWindows: 0, tokens: 0, runMs: 0, runs: 0 };

  /** Ошибка «модель выгружена во время работы»: runner покажет её как NER_FAILED, анализ правилами продолжится. */
  const disposedError = () => new CoreError('MODEL_LOAD_FAILED', `Модель ${modelId} выгружена во время распознавания`, { modelId, disposed: true });

  async function load() {
    const t0 = now();
    const g = gen;
    try {
      const parsed = parsePackManifest(await files.read(PACK_MANIFEST));
      if (!parsed.ok) throw new Error(`pack.json: ${parsed.error}`);
      const manifest = parsed.manifest;
      const tk = manifest.tokenizer;
      if (tk.type !== 'wordpiece') throw new Error(`токенизатор ${tk.type} не поддерживается`);
      const wp = createWordPiece({
        vocab: decoder.decode(await files.read(tk.vocab)),
        lowercase: tk.lowercase,
        stripAccents: tk.stripAccents,
        cls: tk.cls,
        sep: tk.sep,
        pad: tk.pad,
        unk: tk.unk,
      });
      const labels = await readLabels(files, manifest);
      const tags = labelsToTags(labels);
      if (!tags.some((t) => t.type)) throw new Error('в метках модели нет PER/ORG/LOC');

      let bytes = await files.read(manifest.model.file);
      const s = await ort.InferenceSession.create(bytes, { executionProviders, graphOptimizationLevel: 'all' });
      bytes = null; // модель живёт в сессии; копию в JS не держим
      const { inputs, output } = manifest.model;
      const need = [inputs.ids, inputs.mask, ...(inputs.types ? [inputs.types] : [])];
      const missing = need.filter((n) => !s.inputNames.includes(n));
      if (missing.length) {
        await s.release?.();
        throw new Error(`у модели нет входов ${missing.join(', ')}`);
      }
      if (!s.outputNames.includes(output)) {
        await s.release?.();
        throw new Error(`у модели нет выхода ${output}`);
      }
      if (g !== gen) {
        // dispose() во время загрузки: сессию не оставляем жить без владельца
        await s.release?.();
        throw disposedError();
      }
      const maxLen = Math.min(tk.maxLen, maxLenCap || tk.maxLen);
      session = s;
      model = {
        wp,
        tags,
        numLabels: labels.length,
        maxLen,
        stride: Math.min(tk.stride, Math.floor(maxLen / 2) - 1),
        inputs,
        output,
        indexType: manifest.model.indexType,
      };
      stats.initMs = Math.round(now() - t0);
    } catch (err) {
      if (err instanceof CoreError) throw err;
      throw new CoreError('MODEL_LOAD_FAILED', `Модель ${modelId} не загружена: ${/** @type {Error} */ (err)?.message || err}`, { modelId });
    }
  }

  async function init() {
    if (!loading) {
      const p = load();
      loading = p;
      // сбой загрузки не кэшируется навсегда: следующий анализ попробует снова (файл могли переустановить);
      // загрузку, начатую после dispose, сбой прежней не сбрасывает
      p.catch(() => {
        if (loading === p) loading = null;
      });
    }
    return loading;
  }

  /**
   * @param {string} text
   * @returns {Promise<import('../contracts/ner.js').NerSpan[]>}
   */
  async function detect(text) {
    const g = gen;
    await init();
    // снимок модели и сессии: dispose() во время detect обнуляет их, а этот вызов доводит или прерывает работу сам
    const m = model;
    const sess = session;
    if (g !== gen || !m || !sess) throw disposedError();
    const { wp, tags, maxLen, stride } = m;
    const words = wp.pretokenize(text);
    if (!words.length) return [];
    const wordIds = wp.encodeWords(words);
    const wopts = { maxLen, stride, cls: wp.specials.cls, sep: wp.specials.sep };
    const all = splitSentences
      ? sentenceRanges(words, text).flatMap(([a, b]) =>
          makeWindows(wordIds.slice(a, b), wopts).map((w) => ({ ...w, wordFrom: w.wordFrom + a, wordTo: w.wordTo + a })),
        )
      : makeWindows(wordIds, wopts);
    const windows = skipLowercaseWindows ? all.filter((w) => hasUpper(words, w)) : all;
    stats.windows += windows.length;
    stats.skippedWindows += all.length - windows.length;

    // Лучшее предсказание по словам: из окна, чей центр ближе к слову (края окна видят меньше контекста)
    const C = m.numLabels;
    const best = new Float64Array(words.length).fill(Infinity);
    const probs = new Float32Array(words.length * C);
    for (let b = 0; b < windows.length; b += batchSize) {
      const batch = windows.slice(b, b + batchSize);
      let logits;
      try {
        logits = await runBatch(batch, m, sess);
      } catch (err) {
        if (g !== gen) throw disposedError(); // сессию освободили посреди run
        throw err;
      }
      if (g !== gen) throw disposedError();
      const L = Math.max(...batch.map((w) => w.ids.length));
      batch.forEach((w, bi) => {
        const center = (w.wordFrom + w.wordTo - 1) / 2;
        for (let k = 0; k < w.wordStartIndex.length; k++) {
          const t = w.wordStartIndex[k];
          if (t < 0) continue;
          const wi = w.wordFrom + k;
          const dist = Math.abs(wi - center);
          if (dist >= best[wi]) continue;
          best[wi] = dist;
          softmaxInto(logits, (bi * L + t) * C, C, probs, wi * C);
        }
      });
      onProgress?.({ windows: windows.length, done: Math.min(windows.length, b + batchSize) });
    }

    // Слова → теги (маргинальные вероятности типов) → мостики через «-», «'», точку инициала → BIO → соседние спаны
    // одного типа → подрезка краёв → границы по соглашениям каталога (ОПФ и кавычки у ORG, точка инициала у PER, без
    // должности и обращения впереди) → без дубликатов и вложенных спанов
    const preds = words.map((w, i) => {
      const d = best[i] === Infinity ? { tag: 'O', type: null, prob: 1 } : decodeWord(probs.subarray(i * C, i * C + C), tags);
      return { start: w.start, end: w.end, ...d };
    });
    const spans = joinAdjacent(mergeBio(/** @type {any} */ (bridgePunct(/** @type {any} */ (preds), text)), { withWords: true, text }), text);
    return dedupeSpans(filterSpans(alignSpans(filterSpans(spans, text), text), text), text);
  }

  /**
   * Один вызов модели на батч окон, дополненных [PAD] до самого длинного.
   * @param {any[]} batch @param {any} m  снимок model @param {any} sess  снимок session
   * @returns {Promise<Float32Array>} [B, L, C]
   */
  async function runBatch(batch, m, sess) {
    const { inputs, output, indexType, wp } = m;
    const B = batch.length;
    const L = Math.max(...batch.map((w) => w.ids.length));
    const big = indexType === 'int64';
    const Arr = big ? BigInt64Array : Int32Array;
    const ids = new Arr(B * L);
    const mask = new Arr(B * L);
    const pad = big ? BigInt(wp.specials.pad) : wp.specials.pad;
    const one = big ? 1n : 1;
    ids.fill(/** @type {any} */ (pad));
    batch.forEach((w, bi) => {
      const off = bi * L;
      for (let j = 0; j < w.ids.length; j++) {
        ids[off + j] = /** @type {any} */ (big ? BigInt(w.ids[j]) : w.ids[j]);
        mask[off + j] = /** @type {any} */ (one);
      }
      stats.tokens += w.ids.length;
    });
    const feeds = {
      [inputs.ids]: new ort.Tensor(indexType, ids, [B, L]),
      [inputs.mask]: new ort.Tensor(indexType, mask, [B, L]),
    };
    if (inputs.types) feeds[inputs.types] = new ort.Tensor(indexType, new Arr(B * L), [B, L]);
    const t0 = now();
    const out = await sess.run(feeds);
    stats.runMs += now() - t0;
    stats.runs++;
    const t = out[output];
    const dims = t.dims;
    if (dims.length !== 3 || dims[0] !== B || dims[1] !== L || dims[2] !== m.numLabels) {
      throw new Error(`выход модели [${dims.join(',')}] не совпадает с [${B},${L},${m.numLabels}]`);
    }
    return /** @type {Float32Array} */ (t.data);
  }

  return {
    name: `onnx:${modelId}`,
    init,
    detect,
    stats,
    dispose() {
      gen++;
      const s = session;
      session = null;
      model = null;
      loading = null;
      if (s) Promise.resolve(s.release?.()).catch(() => {});
    },
  };
}

/** Метки по индексам выхода: id2label из config.json, иначе labels манифеста. */
async function readLabels(files, manifest) {
  if (manifest.files.some((f) => f.path === 'config.json')) {
    try {
      const cfg = JSON.parse(decoder.decode(await files.read('config.json')));
      const map = cfg?.id2label;
      if (map && typeof map === 'object') {
        const n = Object.keys(map).length;
        const labels = Array.from({ length: n }, (_, i) => map[i] ?? map[String(i)]);
        if (n > 1 && labels.every((l) => typeof l === 'string')) {
          if (n !== manifest.labels.length) throw new Error('число меток config.json и pack.json различается');
          return labels;
        }
      }
    } catch (err) {
      if (/** @type {Error} */ (err)?.message?.startsWith('число меток')) throw err;
      // config.json без id2label или нечитаемый — берём метки манифеста
    }
  }
  return manifest.labels;
}

function hasUpper(words, w) {
  for (let k = w.wordFrom; k < w.wordTo; k++) if (UPPER_RE.test(words[k].text)) return true;
  return false;
}

/** softmax строки логитов data[off .. off+C) → out[outOff .. outOff+C) */
function softmaxInto(data, off, C, out, outOff) {
  let max = -Infinity;
  for (let c = 0; c < C; c++) if (data[off + c] > max) max = data[off + c];
  let sum = 0;
  for (let c = 0; c < C; c++) sum += out[outOff + c] = Math.exp(data[off + c] - max);
  for (let c = 0; c < C; c++) out[outOff + c] /= sum;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
