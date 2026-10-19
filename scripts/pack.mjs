// Архивы релиза: npm run pack → release/docx-anonymizer-<версия>.zip (лёгкий, без модели) и, если есть пакет модели NER,
// release/docx-anonymizer-<версия>-full.zip (полный: models/index.json + zip пакета; версия 0.3, WP10-C, К15).
// manifest.json — в корне архива. Каждый вариант собирается (release-сборка, без sourcemaps) в свой временный каталог,
// не трогая dist/: define __BUNDLED_MODEL__ запечён в background/options/popup, поэтому лёгкий архив из полной стадии
// «думал» бы, что модель есть. Пакуется без системного zip: fflate уже в проекте. Состав и время файлов фиксированы, поэтому
// один и тот же код даёт побайтно один и тот же архив. Сети не требует; на GitHub ничего не публикуется.
//
//   node scripts/pack.mjs [--out=<каталог>] [--model=<zip пакета>]   (по умолчанию release/; пакет — release/docx-anonymizer-ner-*.zip
//   с sha из KNOWN_PACKS и наибольшей версией, findModelZip)
import { zipSync } from 'fflate';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findKnownPack, KNOWN_PACKS } from '../src/core/ner/known-packs.js';
import { compareVersions, packZipName } from '../src/core/ner/pack.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Фиксированное время всех записей архива (воспроизводимость, К11). Дата создаётся ЛОКАЛЬНЫМ конструктором намеренно:
// fflate 0.8.3 пишет DOS-время локальными геттерами (getFullYear/getHours/…) и не пишет extra-поле с UTC-временем,
// поэтому «полдень 1 января 2000 по местному времени» даёт одни и те же байты в любом часовом поясе.
// Date.UTC(...) здесь сломал бы воспроизводимость: локальные часы/дата такой отметки зависят от TZ сборщика.
// Полдень выбран с запасом от смены суток. Проверка — tests/integration/pack.spec.js («DOS-время не зависит от TZ»).
export const FIXED_TIME = new Date(2000, 0, 1, 12);

function walk(dir) {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
}

/**
 * @typedef {{file: string, name: string, version: string, sha256: string, size: number, files: string[]}} PackResult
 */

/**
 * Лёгкий архив всегда; полный — при modelZip (пакет обязан быть в KNOWN_PACKS — иначе build.mjs падает).
 * @param {{outDir?: string, modelZip?: string|null}} [opts]
 * @returns {{lite: PackResult, full: PackResult | null}}
 */
export function packRelease({ outDir = join(root, 'release'), modelZip = null } = {}) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const lite = packOne({ outDir, name: `docx-anonymizer-${pkg.version}.zip`, version: pkg.version, buildArgs: [] });
  const full = modelZip
    ? packOne({ outDir, name: `docx-anonymizer-${pkg.version}-full.zip`, version: pkg.version, buildArgs: [`--with-model=${resolve(modelZip)}`] })
    : null;
  return { lite, full };
}

/** @returns {PackResult} */
function packOne({ outDir, name, version, buildArgs }) {
  const stage = mkdtempSync(join(tmpdir(), 'docx-anon-pack-'));
  try {
    execFileSync(process.execPath, [join(root, 'scripts/build.mjs'), `--dist=${stage}`, ...buildArgs], { cwd: root, stdio: 'pipe' });
    const entries = {};
    for (const file of walk(stage)) {
      const rel = relative(stage, file).split(sep).join('/');
      // zip пакета модели уже сжат (и его sha256 сверяется с KNOWN_PACKS) — кладётся без повторного сжатия
      const level = /^models\/[^/]+\.zip$/.test(rel) ? 0 : 9;
      entries[rel] = [new Uint8Array(readFileSync(file)), { mtime: FIXED_TIME, level }];
    }
    const zip = zipSync(entries);
    mkdirSync(outDir, { recursive: true });
    const out = join(resolve(outDir), name);
    writeFileSync(out, zip);
    return { file: out, name, version, sha256: createHash('sha256').update(zip).digest('hex'), size: zip.length, files: Object.keys(entries) };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * Последний опубликованный пакет из KNOWN_PACKS (наибольшая версия semver; при равных — первый в списке) или null.
 * Его файл в release/ — packZipName(запись): тесты полного архива (pack.spec, manifest.spec) берут имя отсюда, а не хардкодят.
 * @returns {{id: string, version: string, sha256: string} | null}
 */
export function latestKnownPack() {
  return KNOWN_PACKS.reduce((best, p) => (!best || compareVersions(p.version, best.version) > 0 ? p : best), null);
}

/** Путь к zip последнего пакета из KNOWN_PACKS в release/ (может не существовать — гейт тестов). */
export function latestModelZipPath(dir = join(root, 'release')) {
  const p = latestKnownPack();
  return p ? join(dir, packZipName(p)) : null;
}

/**
 * Пакет модели для полного архива (версия 0.4, WP11-C3): --model=<zip> главнее всего; иначе из release/docx-anonymizer-ner-*.zip
 * выбирается zip, чей sha256 есть в KNOWN_PACKS, с наибольшей версией (semver; при равных — первый по имени). Неизвестные zip
 * (sha нет в KNOWN_PACKS: локальная пересборка, чужой пакет) пропускаются с предупреждением — build.mjs их всё равно не встроит.
 * Ни одного подходящего — null (CI: модель в git не хранится, собирается только лёгкий).
 * @param {string[]} [argv]
 * @param {{dir?: string, warn?: (msg: string) => void, lookup?: (sha256: string) => {version: string} | null}} [opts]
 *   dir — каталог поиска (по умолчанию release/), warn — куда писать предупреждения, lookup — поиск sha (по умолчанию findKnownPack; тесты подменяют)
 * @returns {string|null}
 */
export function findModelZip(argv = process.argv, { dir = join(root, 'release'), warn = (m) => console.warn(m), lookup = findKnownPack } = {}) {
  const arg = argv.find((a) => a.startsWith('--model='));
  if (arg) {
    const p = resolve(arg.slice('--model='.length));
    if (!existsSync(p)) throw new Error(`Нет файла пакета модели: ${p}`);
    return p;
  }
  const found = existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => /^docx-anonymizer-ner-.+\.zip$/.test(n))
        .sort()
    : [];
  let best = null;
  for (const name of found) {
    const file = join(dir, name);
    const known = lookup(createHash('sha256').update(readFileSync(file)).digest('hex'));
    if (!known) {
      warn(`${name}: sha256 нет в KNOWN_PACKS — пропущен (пакет не встраивается)`);
      continue;
    }
    if (!best || compareVersions(known.version, best.version) > 0) best = { file, version: known.version };
  }
  return best ? best.file : null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outArg = process.argv.find((a) => a.startsWith('--out='));
  const modelZip = findModelZip();
  if (modelZip) console.log(`пакет модели: ${relative(process.cwd(), modelZip) || modelZip}`);
  const { lite, full } = packRelease({ ...(outArg ? { outDir: outArg.slice('--out='.length) } : {}), modelZip });
  for (const r of [lite, full].filter(Boolean)) {
    console.log(`${relative(process.cwd(), r.file) || r.file}: ${r.files.length} файлов, ${r.size} байт, версия ${r.version}`);
    console.log(`sha256 ${r.sha256}`);
  }
  if (!full) console.log('полный архив не собран: нет release/docx-anonymizer-ner-*.zip из KNOWN_PACKS (npm run pack:model) и не задан --model=<zip>');
}
