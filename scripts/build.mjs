// Сборка расширения в dist/ (ТЗ §10, esbuild). Сети не требует.
import { build } from 'esbuild';
import { unzipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePackManifest } from '../src/core/ner/pack.js';
import { findKnownPack } from '../src/core/ner/known-packs.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// --dist=<каталог> — собрать не в dist/ (так собирает архив релиза scripts/pack.mjs)
// --e2e — сборка для Playwright: по умолчанию в dist-e2e/, в манифест добавляется host_permissions <all_urls>.
//   Нативный диалог chrome.permissions.request автоматизировать нельзя, а опциональные host-разрешения нельзя выдать заранее,
//   поэтому e2e-сборка получает доступ ко всем сайтам при установке (К9). Релиз (npm run build, npm run pack) — без него.
const e2e = process.argv.includes('--e2e');
const distArg = process.argv.find((a) => a.startsWith('--dist='));
const dist = distArg ? resolve(distArg.slice('--dist='.length)) : join(root, e2e ? 'dist-e2e' : 'dist');
const dev = process.argv.includes('--dev');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
// --with-model=<zip пакета модели NER> — полная сборка (версия 0.3, WP10-C, К15): zip кладётся в models/<file> как есть
// (без повторного сжатия и распаковки), описание — в models/index.json и define __BUNDLED_MODEL__; при первом запуске
// background ставит пакет в OPFS сам (src/background/bundled-model.js). Только пакеты из KNOWN_PACKS: непроверенный
// пакет в архиве релиза означал бы, что расширение молча ставит чужую модель.
const modelArg = process.argv.find((a) => a.startsWith('--with-model='));
const bundled = modelArg ? await readBundledModel(resolve(modelArg.slice('--with-model='.length))) : null;

/**
 * @param {string} zipPath
 * @returns {Promise<{file: string, id: string, version: string, sha256: string, size: number}>} ключи — в этом порядке (index.json)
 */
async function readBundledModel(zipPath) {
  const bytes = new Uint8Array(await readFile(zipPath));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (!findKnownPack(sha256)) throw new Error(`Пакет модели ${basename(zipPath)} (sha256 ${sha256}) не в KNOWN_PACKS (src/core/ner/known-packs.js)`);
  const entries = unzipSync(bytes, { filter: (f) => f.name === 'pack.json' });
  if (!entries['pack.json']) throw new Error(`В пакете ${basename(zipPath)} нет pack.json`);
  const parsed = parsePackManifest(entries['pack.json']);
  if (!parsed.ok) throw new Error(`pack.json пакета ${basename(zipPath)}: неверное поле ${parsed.error}`);
  const known = findKnownPack(sha256);
  if (known.id !== parsed.manifest.id || known.version !== parsed.manifest.version) {
    throw new Error(`Пакет ${basename(zipPath)}: id/версия в pack.json не совпадают с KNOWN_PACKS`);
  }
  return { file: basename(zipPath), id: parsed.manifest.id, version: parsed.manifest.version, sha256, size: bytes.length };
}

const entries = {
  background: 'src/background/index.js',
  content: 'src/content/content.js',
  'offscreen/offscreen': 'src/offscreen/offscreen.js',
  'popup/popup': 'src/popup/popup.js',
  'options/options': 'src/options/options.js',
  'help/help': 'src/help/help.js',
  'restore/restore': 'src/restore/restore.js',
  'options/regex-guard.worker': 'src/options/regex-guard.worker.js',
};

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const common = {
  bundle: true,
  target: ['chrome120'],
  sourcemap: dev ? 'inline' : false,
  minify: false,
  legalComments: 'none',
  charset: 'utf8',
  // __BUNDLED_MODEL__ — описание встроенного пакета модели или null (лёгкая сборка); читают background, options, popup (WP10-C)
  define: { __VERSION__: JSON.stringify(pkg.version), __BUNDLED_MODEL__: JSON.stringify(bundled) },
  logLevel: 'warning',
};

await build({
  ...common,
  entryPoints: Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, join(root, v)])),
  outdir: dist,
  format: 'iife', // content script и classic worker не поддерживают ESM-импорты
});

// Worker ядра — ES-модуль (WP8): onnxruntime-web (ESM-сборка) находит свой wasm через import.meta.url,
// которого нет в IIFE. offscreen.js создаёт его как new Worker('worker.js', {type: 'module'}).
const workerBuild = await build({
  ...common,
  entryPoints: { 'offscreen/worker': join(root, 'src/offscreen/worker.js') },
  outdir: dist,
  format: 'esm',
  platform: 'browser',
  metafile: true,
});
{
  // Какой вариант ORT попал в бандл: ожидается ort.wasm.bundle.min.mjs (glue встроен, внешний только .wasm из vendor/)
  const ortInputs = Object.keys(workerBuild.metafile.inputs).filter((f) => f.includes('onnxruntime-web'));
  const out = Object.values(workerBuild.metafile.outputs)[0];
  const ortBytes = ortInputs.reduce((n, f) => n + (out.inputs[f]?.bytesInOutput || 0), 0);
  if (!ortInputs.length) throw new Error('onnxruntime-web не попал в worker.js');
  console.log(`worker.js: ${out.bytes} байт, из них ORT ${ortBytes} (${ortInputs.map((f) => f.split('/').pop()).join(', ')})`);
}

// Статика: HTML, CSS, локали
const statics = [
  ['src/popup/popup.html', 'popup/popup.html'],
  ['src/popup/popup.css', 'popup/popup.css'],
  ['src/options/options.html', 'options/options.html'],
  ['src/restore/restore.html', 'restore/restore.html'],
  ['src/help/help.html', 'help/help.html'],
  ['icons', 'icons'],
  ['src/offscreen/offscreen.html', 'offscreen/offscreen.html'],
  ['src/_locales', '_locales'],
  // ORT: только wasm-бинарь (glue встроен в worker.js) и лицензия (WP8)
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', 'vendor/ort-wasm-simd-threaded.wasm'],
  // в npm-пакете ORT нет файла LICENSE — текст MIT лицензии проекта лежит в assets/licenses/
  ['assets/licenses/onnxruntime-web.LICENSE', 'vendor/onnxruntime-web.LICENSE'],
  // pdf.js (версия 0.3): не бандлится, грузится лениво из vendor/pdfjs/ (offscreen/pdf-loader.js). Legacy-сборка: современная
  // требует Map.prototype.getOrInsertComputed и Math.sumPrecise (Chrome новее minimum_chrome_version), в legacy они заполнены.
  // package.json pdf.js не копируется (pack.spec.js запрещает такие пути).
  ['node_modules/pdfjs-dist/legacy/build/pdf.min.mjs', 'vendor/pdfjs/pdf.mjs'],
  ['node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs', 'vendor/pdfjs/pdf.worker.mjs'],
  ['node_modules/pdfjs-dist/cmaps', 'vendor/pdfjs/cmaps'],
  ['node_modules/pdfjs-dist/standard_fonts', 'vendor/pdfjs/standard_fonts'],
  ['node_modules/pdfjs-dist/LICENSE', 'vendor/pdfjs/LICENSE'],
];
for (const [from, to] of statics) await cp(join(root, from), join(dist, to), { recursive: true });
// Встроенная модель NER (WP10-C): zip пакета байт в байт + models/index.json (массив из одного описания)
if (bundled) {
  await mkdir(join(dist, 'models'), { recursive: true });
  await cp(resolve(modelArg.slice('--with-model='.length)), join(dist, 'models', bundled.file));
  await writeFile(join(dist, 'models/index.json'), JSON.stringify([bundled], null, 2) + '\n');
  console.log(`модель: ${bundled.file} (${bundled.id} ${bundled.version}, ${bundled.size} байт, sha256 ${bundled.sha256})`);
} else {
  console.log('без модели (лёгкая сборка)');
}
// HTML ссылается на бандлы как на классические скрипты
for (const f of ['offscreen/offscreen.html']) {
  const p = join(dist, f);
  await writeFile(p, (await readFile(p, 'utf8')).replace('type="module" ', ''));
}

const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
manifest.version = pkg.version;
if (e2e) manifest.host_permissions = ['<all_urls>']; // optional_host_permissions остаётся: код запрашивает доступ так же, как в релизе
await writeFile(join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`${e2e ? 'e2e-сборка' : 'dist/ собран'} (${dev ? 'dev' : 'release'}) в ${dist}, версия ${pkg.version}`);
