#!/usr/bin/env node
// Бенчмарк и оценка ONNX-провайдера NER в Node (WP9, NFR-03, К7, К8): холодная init(), мс/окно (батч 1 и 8),
// токены/с, span-F1 по классам на корпусах tests/fixtures/ner/eval-{ru,en}.json, время анализа «20-страничного
// договора» (≈ 9 000 слов) с пре-фильтром окон и без него. ORT — onnxruntime-web (сборка для Node, тот же WASM, одна нить).
//
//   npm run bench-ner [-- --dir=models-src/rubert-tiny2-ner-ruen] [--threshold=0.7] [--errors=10] [--json]
//   NER_MODEL_DIR=… npm run bench-ner
//
// Каталог модели — распакованный пакет (pack.json) или исходник пакета (models-src/<id>/ с pack.src.json: манифест
// дополняется списком файлов, как в scripts/pack-model.mjs). Из кода — экспортируемые помощники для тестов.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createOnnxNerProvider } from '../src/core/ner/onnx-provider.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_MODEL_DIR = join(root, 'models-src/rubert-tiny2-ner-ruen');

/** onnxruntime-web в Node (dist/ort.node.min.mjs: WASM-бэкенд, как в расширении), одна нить. */
export async function loadOrt() {
  const req = createRequire(join(root, 'package.json'));
  const entry = req.resolve('onnxruntime-web').replace(/\.js$/, '.mjs');
  const ort = await import(pathToFileURL(entry).href);
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  return ort;
}

/**
 * Доступ к файлам пакета в каталоге: {read(path) → Uint8Array}. Для models-src/<id> pack.json собирается из pack.src.json.
 * @param {string} dir
 */
export function dirFiles(dir) {
  const abs = resolve(dir);
  let manifestBytes = null;
  const manifest = () => {
    if (manifestBytes) return manifestBytes;
    if (existsSync(join(abs, 'pack.json'))) return (manifestBytes = new Uint8Array(readFileSync(join(abs, 'pack.json'))));
    const base = JSON.parse(readFileSync(join(abs, 'pack.src.json'), 'utf8'));
    const files = readdirSync(abs)
      .filter((n) => n !== 'pack.src.json' && statSync(join(abs, n)).isFile())
      .sort()
      .map((path) => {
        const b = readFileSync(join(abs, path));
        return { path, sha256: createHash('sha256').update(b).digest('hex'), size: b.length };
      });
    return (manifestBytes = new TextEncoder().encode(JSON.stringify({ ...base, files })));
  };
  return {
    read: async (p) => {
      if (p.includes('/') || p.includes('..')) throw new Error('путь вне пакета');
      return p === 'pack.json' ? manifest() : new Uint8Array(await readFile(join(abs, p)));
    },
    manifest: () => JSON.parse(new TextDecoder().decode(manifest())),
  };
}

/**
 * Span-F1 (точное совпадение границ и метки) по классам + разбор ошибок.
 * @param {{text: string, spans: {start: number, end: number, label: string}[]}[]} sentences
 * @param {{start: number, end: number, label: string, score: number}[][]} predicted  по предложениям
 */
export function scoreSpans(sentences, predicted) {
  const labels = ['PER', 'ORG', 'LOC'];
  const by = Object.fromEntries(labels.map((l) => [l, { tp: 0, fp: 0, fn: 0 }]));
  // confusion[gold][pred]: pred ∈ PER|ORG|LOC (те же границы, другая метка) | boundary (пересечение) | missed
  const confusion = Object.fromEntries(labels.map((l) => [l, { PER: 0, ORG: 0, LOC: 0, boundary: 0, missed: 0 }]));
  const spurious = { PER: 0, ORG: 0, LOC: 0 };
  const errors = [];
  sentences.forEach((s, i) => {
    const pred = predicted[i] || [];
    const key = (x) => `${x.start}:${x.end}:${x.label}`;
    const g = new Set(s.spans.map(key));
    const p = new Set(pred.map(key));
    const errs = [];
    for (const x of s.spans) {
      if (p.has(key(x))) {
        by[x.label].tp++;
        confusion[x.label][x.label]++;
        continue;
      }
      by[x.label].fn++;
      const same = pred.find((y) => y.start === x.start && y.end === x.end);
      const over = pred.find((y) => y.start < x.end && x.start < y.end);
      const kind = same ? same.label : over ? 'boundary' : 'missed';
      confusion[x.label][kind]++;
      errs.push(
        `${x.label} «${s.text.slice(x.start, x.end)}» → ${same ? same.label : over ? `${over.label} «${s.text.slice(over.start, over.end)}»` : 'не найдено'}`,
      );
    }
    for (const y of pred) {
      if (g.has(key(y))) continue;
      by[y.label].fp++;
      if (!s.spans.some((x) => y.start < x.end && x.start < y.end)) {
        spurious[y.label]++;
        errs.push(`лишнее ${y.label} «${s.text.slice(y.start, y.end)}» (${y.score.toFixed(2)})`);
      }
    }
    if (errs.length) errors.push({ text: s.text, errors: errs });
  });
  const f = ({ tp, fp, fn }) => {
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    return { tp, fp, fn, precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0 };
  };
  const micro = labels.reduce((a, l) => ({ tp: a.tp + by[l].tp, fp: a.fp + by[l].fp, fn: a.fn + by[l].fn }), { tp: 0, fp: 0, fn: 0 });
  return { byLabel: Object.fromEntries(labels.map((l) => [l, f(by[l])])), micro: f(micro), confusion, spurious, errors };
}

/** Прогон корпуса через провайдер с порогом (как runner: score < threshold отбрасывается). */
export async function evalCorpus(provider, corpus, threshold) {
  const predicted = [];
  for (const s of corpus.sentences) {
    const spans = await provider.detect(s.text, { language: 'both' });
    predicted.push(spans.filter((x) => x.score >= threshold));
  }
  return scoreSpans(corpus.sentences, predicted);
}

/** «20-страничный договор»: ≈ 9 000 слов из предложений корпуса, абзацами по 3–5 предложений. */
export function bigDocument(corpus, words = 9000) {
  const paras = [];
  let n = 0;
  let i = 0;
  while (n < words) {
    const para = [];
    for (let k = 0; k < 3 + (i % 3); k++) {
      const t = corpus.sentences[i++ % corpus.sentences.length].text;
      para.push(t);
      n += t.split(/\s+/).length;
    }
    paras.push(para.join(' '));
  }
  return paras;
}

const fmt = (x) => x.toFixed(3);

async function main() {
  const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const dir = resolve(arg('dir') || process.env.NER_MODEL_DIR || DEFAULT_MODEL_DIR);
  const files = dirFiles(dir);
  const manifest = files.manifest();
  const threshold = Number(arg('threshold') ?? manifest.recommendedThreshold ?? 0.6);
  const nErrors = Number(arg('errors') ?? 10);
  const ort = await loadOrt();
  const ru = JSON.parse(readFileSync(join(root, 'tests/fixtures/ner/eval-ru.json'), 'utf8'));
  const en = JSON.parse(readFileSync(join(root, 'tests/fixtures/ner/eval-en.json'), 'utf8'));
  const out = { model: `${manifest.id}@${manifest.version}`, maxLen: manifest.tokenizer.maxLen, stride: manifest.tokenizer.stride, threshold };

  // Холодная загрузка: чтение файлов + словарь + сессия ORT
  const t0 = performance.now();
  const p8 = createOnnxNerProvider({ files, ort, modelId: manifest.id, batchSize: 8, skipLowercaseWindows: false });
  await p8.init();
  out.coldInitMs = Math.round(performance.now() - t0);
  const t1 = performance.now();
  await p8.init();
  out.warmInitMs = +(performance.now() - t1).toFixed(2);

  // мс/окно: полные окна maxLen, батч 1 и 8
  const doc = bigDocument(ru).join(' ');
  for (const bs of [1, 8]) {
    const p = createOnnxNerProvider({ files, ort, modelId: manifest.id, batchSize: bs, skipLowercaseWindows: false });
    await p.init();
    await p.detect(ru.sentences[0].text, { language: 'ru' }); // прогрев
    Object.assign(p.stats, { windows: 0, tokens: 0, runMs: 0, runs: 0 });
    const t = performance.now();
    await p.detect(doc.slice(0, 20000), { language: 'ru' });
    const ms = performance.now() - t;
    out[`batch${bs}`] = { windows: p.stats.windows, msPerWindow: +(ms / p.stats.windows).toFixed(2), tokensPerSec: Math.round(p.stats.tokens / (ms / 1000)) };
    p.dispose();
  }

  // Корпус eval-ru: токены/с на коротких потоках (предложение = поток, как абзацы docx)
  {
    Object.assign(p8.stats, { windows: 0, tokens: 0, runMs: 0, runs: 0 });
    const t = performance.now();
    for (const s of ru.sentences) await p8.detect(s.text, { language: 'ru' });
    const ms = performance.now() - t;
    out.evalRu = { sentences: ru.sentences.length, ms: Math.round(ms), windows: p8.stats.windows, tokensPerSec: Math.round(p8.stats.tokens / (ms / 1000)) };
  }

  // «20-страничный договор» (≈ 9 000 слов, абзацы — отдельные потоки): без пре-фильтра и с ним
  const paras = bigDocument(ru);
  out.doc = { words: paras.join(' ').split(/\s+/).length, paragraphs: paras.length };
  for (const skip of [false, true]) {
    const p = createOnnxNerProvider({ files, ort, modelId: manifest.id, batchSize: 8, skipLowercaseWindows: skip });
    await p.init();
    const t = performance.now();
    for (const para of paras) await p.detect(para, { language: 'ru' });
    out.doc[skip ? 'skipLowercase' : 'all'] = { ms: Math.round(performance.now() - t), windows: p.stats.windows, skipped: p.stats.skippedWindows };
    p.dispose();
  }
  p8.dispose();

  // Качество при пороге (провайдер как в расширении: с пре-фильтром)
  const pq = createOnnxNerProvider({ files, ort, modelId: manifest.id });
  out.ru = await evalCorpus(pq, ru, threshold);
  out.en = await evalCorpus(pq, en, threshold);
  pq.dispose();

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(out, (k, v) => (k === 'errors' ? v.slice(0, nErrors) : v), 2));
    return;
  }
  console.log(`Модель ${out.model}, maxLen ${out.maxLen}, stride ${out.stride}, порог ${threshold}`);
  console.log(`init: холодная ${out.coldInitMs} мс, тёплая ${out.warmInitMs} мс`);
  for (const bs of [1, 8]) {
    const b = out[`batch${bs}`];
    console.log(`батч ${bs}: ${b.msPerWindow} мс/окно, ${b.tokensPerSec} токенов/с (${b.windows} окон)`);
  }
  console.log(`eval-ru (${out.evalRu.sentences} предложений): ${out.evalRu.ms} мс, ${out.evalRu.tokensPerSec} токенов/с`);
  console.log(
    `договор ${out.doc.words} слов / ${out.doc.paragraphs} абзацев: все окна ${out.doc.all.ms} мс (${out.doc.all.windows} окон); ` +
      `с пропуском окон без заглавных ${out.doc.skipLowercase.ms} мс (${out.doc.skipLowercase.windows} окон, пропущено ${out.doc.skipLowercase.skipped})`,
  );
  for (const lang of ['ru', 'en']) {
    const r = out[lang];
    console.log(`\nF1 ${lang}: micro ${fmt(r.micro.f1)}`);
    for (const [l, m] of Object.entries(r.byLabel))
      console.log(`  ${l}: P ${fmt(m.precision)} R ${fmt(m.recall)} F1 ${fmt(m.f1)} (tp ${m.tp}, fp ${m.fp}, fn ${m.fn})`);
    console.log(`  confusion (gold → pred): ${JSON.stringify(r.confusion)}; лишние без пересечения: ${JSON.stringify(r.spurious)}`);
    for (const e of r.errors.slice(0, nErrors)) console.log(`  · ${e.text}\n      ${e.errors.join('\n      ')}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`bench-ner: ${e.message}`);
    process.exit(1);
  });
}
