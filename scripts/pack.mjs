// Архив релиза: npm run pack → release/docx-anonymizer-<версия>.zip (manifest.json — в корне архива).
// Собирает расширение (release-сборка, без sourcemaps) во временный каталог, не трогая dist/, и пакует его
// без зависимостей от системного zip: fflate уже в проекте. Состав и время файлов фиксированы, поэтому
// один и тот же код даёт побайтно один и тот же архив. Сети не требует; на GitHub ничего не публикуется.
//
//   node scripts/pack.mjs [--out=<каталог>]   (по умолчанию release/)
import { zipSync } from 'fflate';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXED_TIME = new Date(2000, 0, 1, 12);

function walk(dir) {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
}

/**
 * @param {{outDir?: string}} [opts]
 * @returns {{file: string, name: string, version: string, sha256: string, size: number, files: string[]}}
 */
export function packRelease({ outDir = join(root, 'release') } = {}) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const stage = mkdtempSync(join(tmpdir(), 'docx-anon-pack-'));
  try {
    execFileSync(process.execPath, [join(root, 'scripts/build.mjs'), `--dist=${stage}`], { cwd: root, stdio: 'pipe' });
    const entries = {};
    for (const file of walk(stage)) {
      const rel = relative(stage, file).split(sep).join('/');
      entries[rel] = [new Uint8Array(readFileSync(file)), { mtime: FIXED_TIME, level: 9 }];
    }
    const zip = zipSync(entries);
    mkdirSync(outDir, { recursive: true });
    const name = `docx-anonymizer-${pkg.version}.zip`;
    const out = join(resolve(outDir), name);
    writeFileSync(out, zip);
    return { file: out, name, version: pkg.version, sha256: createHash('sha256').update(zip).digest('hex'), size: zip.length, files: Object.keys(entries) };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outArg = process.argv.find((a) => a.startsWith('--out='));
  const r = packRelease(outArg ? { outDir: outArg.slice('--out='.length) } : {});
  console.log(`${relative(process.cwd(), r.file) || r.file}: ${r.files.length} файлов, ${r.size} байт, версия ${r.version}`);
  console.log(`sha256 ${r.sha256}`);
}
