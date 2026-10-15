// Web Worker: ядро. Сообщения от offscreen.js: { clientId, msg }; ответы — { clientId, msg }.
// ES-модуль (WP8): offscreen.js создаёт его как new Worker('worker.js', {type: 'module'}), сборка — отдельный вызов esbuild
// с format:'esm' (scripts/build.mjs), потому что onnxruntime-web ищет свой wasm через import.meta.url.
import * as ort from 'onnxruntime-web/wasm';
import { createHost } from './host.js';
import { openModelFiles } from '../shared/model-store.js';
import { createOnnxNerProvider } from '../core/ner/onnx-provider.js';

// ONNX Runtime: только WASM SIMD в одну нить, без proxy-воркера (§5.2 NLP, концепция 0.2). Glue встроен в бандл
// (ort.wasm.bundle.min.mjs), внешний только wasm-бинарь из vendor/ — грузится с chrome-extension://, сети нет (NFR-01).
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = { wasm: new URL('../vendor/ort-wasm-simd-threaded.wasm', import.meta.url).href };

const host = createHost({
  post: (clientId, msg) => self.postMessage({ clientId, msg }),
  toolVersion: typeof __VERSION__ !== 'undefined' ? __VERSION__ : '0.0.0',
  // Провайдер NER по пакету из OPFS (settings.nerModel): WordPiece + onnxruntime-web (WP9); модель читается лениво в init().
  createNerProvider: (s) => createOnnxNerProvider({ files: openModelFiles(s.nerModel), modelId: s.nerModel, ort }),
});

self.onmessage = (e) => {
  const { clientId, msg } = e.data || {};
  if (msg) host.handle(clientId, msg);
};
