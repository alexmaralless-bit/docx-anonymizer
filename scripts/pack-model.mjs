// Пакет модели NER (WP8): npm run pack:model -- --id=<id> → release/docx-anonymizer-ner-<id>-<version>.zip.
// Источник — models-src/<id>/ (в git не попадает): pack.src.json (манифест без files) + model.onnx, vocab.txt, config.json,
// LICENSE, NOTICE. Скрипт считает {path, sha256, size} каждого файла, собирает pack.json, проверяет его тем же кодом,
// что и расширение (src/core/ner/pack.js), и пакует плоский zip детерминированно: порядок записей и время фиксированы,
// поэтому один и тот же источник даёт побайтно один и тот же архив. Сети не требует.
//
//   node scripts/pack-model.mjs --id=<id> [--src=models-src] [--out=release]
import { zipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FIXED_TIME } from './pack.mjs';
import { PACK_MANIFEST, PACK_PATH_RE, isReservedPackPath, packZipName, parsePackManifest } from '../src/core/ner/pack.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_MANIFEST = 'pack.src.json';
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/**
 * @param {{srcDir: string, outDir?: string, now?: Date}} opts  srcDir — каталог models-src/<id>
 * @returns {{file: string, name: string, sha256: string, size: number, manifest: object}}
 */
export function buildModelPack({ srcDir, outDir = join(root, 'release'), now = FIXED_TIME }) {
  const src = resolve(srcDir);
  if (!existsSync(join(src, SRC_MANIFEST))) throw new Error(`Нет ${SRC_MANIFEST} в ${src}`);
  let base;
  try {
    base = JSON.parse(readFileSync(join(src, SRC_MANIFEST), 'utf8'));
  } catch (e) {
    throw new Error(`${SRC_MANIFEST}: не JSON (${e.message})`, { cause: e });
  }
  if (base && typeof base === 'object' && 'files' in base) throw new Error(`${SRC_MANIFEST} не должен содержать files — их считает скрипт`);

  const names = readdirSync(src)
    .filter((n) => n !== SRC_MANIFEST)
    .sort();
  const files = [];
  const entries = {};
  for (const name of names) {
    const p = join(src, name);
    if (!statSync(p).isFile()) throw new Error(`Пакет плоский: ${name} — каталог`);
    if (!PACK_PATH_RE.test(name) || isReservedPackPath(name)) throw new Error(`Недопустимое имя файла пакета: ${name}`);
    const bytes = new Uint8Array(readFileSync(p));
    files.push({ path: name, sha256: sha256(bytes), size: bytes.length });
    entries[name] = bytes;
  }
  const manifest = { ...base, files };
  const parsed = parsePackManifest(manifest);
  if (!parsed.ok) throw new Error(`pack.json не проходит проверку: поле ${parsed.error}`);

  const json = new TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n');
  // pack.json — первой записью; остальные — по имени. Модель уже сжата плохо — уровень 6 разумен по времени.
  const zipEntries = { [PACK_MANIFEST]: [json, { mtime: now, level: 9 }] };
  for (const name of names) zipEntries[name] = [entries[name], { mtime: now, level: 6 }];
  const zip = zipSync(zipEntries);

  mkdirSync(outDir, { recursive: true });
  const name = packZipName(manifest);
  const file = join(resolve(outDir), name);
  writeFileSync(file, zip);
  return { file, name, sha256: sha256(zip), size: zip.length, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const id = arg('id');
  if (!id) {
    console.error('Использование: node scripts/pack-model.mjs --id=<id> [--src=models-src] [--out=release]');
    process.exit(2);
  }
  const srcDir = join(resolve(arg('src') || join(root, 'models-src')), id);
  try {
    if (!existsSync(srcDir)) throw new Error(`Нет каталога ${srcDir}`);
    const r = buildModelPack({ srcDir, outDir: resolve(arg('out') || join(root, 'release')) });
    console.log(`${relative(process.cwd(), r.file) || r.file}: ${r.manifest.files.length + 1} записей, ${r.size} байт`);
    console.log(`sha256 ${r.sha256}`);
  } catch (e) {
    console.error(`pack:model: ${e.message}`);
    process.exit(1);
  }
}
