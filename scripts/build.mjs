// Сборка расширения в dist/ (ТЗ §10, esbuild). Сети не требует.
import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  define: { __VERSION__: JSON.stringify(pkg.version) },
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
];
for (const [from, to] of statics) await cp(join(root, from), join(dist, to), { recursive: true });
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
