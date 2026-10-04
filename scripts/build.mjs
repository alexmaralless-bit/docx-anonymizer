// Сборка расширения в dist/ (ТЗ §10, esbuild). Сети не требует.
import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const dev = process.argv.includes('--dev');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

const entries = {
  background: 'src/background/index.js',
  content: 'src/content/content.js',
  'offscreen/offscreen': 'src/offscreen/offscreen.js',
  'offscreen/worker': 'src/offscreen/worker.js',
  'popup/popup': 'src/popup/popup.js',
  'options/options': 'src/options/options.js',
  'restore/restore': 'src/restore/restore.js',
  'options/regex-guard.worker': 'src/options/regex-guard.worker.js',
};

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, join(root, v)])),
  outdir: dist,
  bundle: true,
  format: 'iife', // content script и classic worker не поддерживают ESM-импорты
  target: ['chrome120'],
  sourcemap: dev ? 'inline' : false,
  minify: false,
  legalComments: 'none',
  charset: 'utf8',
  define: { __VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'warning',
});

// Статика: HTML, CSS, локали
const statics = [
  ['src/popup/popup.html', 'popup/popup.html'],
  ['src/popup/popup.css', 'popup/popup.css'],
  ['src/options/options.html', 'options/options.html'],
  ['src/restore/restore.html', 'restore/restore.html'],
  ['src/offscreen/offscreen.html', 'offscreen/offscreen.html'],
  ['src/_locales', '_locales'],
];
for (const [from, to] of statics) await cp(join(root, from), join(dist, to), { recursive: true });
// HTML ссылается на бандлы как на классические скрипты
for (const f of ['offscreen/offscreen.html']) {
  const p = join(dist, f);
  await writeFile(p, (await readFile(p, 'utf8')).replace('type="module" ', ''));
}

const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
manifest.version = pkg.version;
await writeFile(join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`dist/ собран (${dev ? 'dev' : 'release'}), версия ${pkg.version}`);
