// Архив релиза (npm run pack): состав, манифест в корне, иконки, воспроизводимость. Сети не требуется.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packRelease, FIXED_TIME, findModelZip, latestKnownPack, latestModelZipPath } from '../../scripts/pack.mjs';
import { KNOWN_PACKS, findKnownPack } from '../../src/core/ner/known-packs.js';
import { compareVersions } from '../../src/core/ner/pack.js';
import RU_SURNAMES from '../../src/core/detect/names/dict/ru-surnames.js';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
let out;
let first;
let zip;

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), 'docx-anon-pack-test-'));
  first = packRelease({ outDir: out }).lite;
  zip = unzipSync(new Uint8Array(readFileSync(first.file)));
}, 60000);
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe('архив релиза', () => {
  it('называется по версии и лежит в указанном каталоге', () => {
    expect(first.name).toBe(`docx-anonymizer-${pkg.version}.zip`);
    expect(first.file.startsWith(out)).toBe(true);
    expect(existsSync(first.file)).toBe(true);
  });

  it('manifest.json — в корне архива, версия совпадает с package.json, название не изменено', () => {
    const m = JSON.parse(strFromU8(zip['manifest.json']));
    expect(m.version).toBe(pkg.version);
    expect(m.name).toBe('__MSG_extName__');
    expect(JSON.parse(strFromU8(zip['_locales/ru/messages.json'])).extName.message).toBe('DOCX Anonymizer');
    expect(m.homepage_url).toBe('https://sitimlab.ru');
  });

  it('все файлы, на которые ссылается манифест, есть в архиве: скрипты, страницы, иконки четырёх размеров', () => {
    const m = JSON.parse(strFromU8(zip['manifest.json']));
    // content script регистрируется динамически (background/site-access.js, К9) — в манифесте его нет
    const refs = [
      m.background.service_worker,
      'content.js',
      m.action.default_popup,
      m.options_ui.page,
      ...Object.values(m.icons),
      ...Object.values(m.action.default_icon),
    ];
    expect(Object.keys(m.icons)).toEqual(['16', '32', '48', '128']);
    for (const f of refs) expect(zip[f], f).toBeDefined();
  });

  it('доступ к сайтам опциональный: без host_permissions и content_scripts, с optional_host_permissions (К9)', () => {
    const m = JSON.parse(strFromU8(zip['manifest.json']));
    expect(m).not.toHaveProperty('host_permissions');
    expect(m).not.toHaveProperty('content_scripts');
    expect(m.optional_host_permissions).toEqual(['<all_urls>']);
    expect(m.permissions).toEqual(expect.arrayContaining(['scripting', 'activeTab']));
  });

  it('модель NER (WP8): unlimitedStorage, wasm ORT в vendor/, worker — ES-модуль; worker.js: код ≤ 400 КБ, словари ≤ 400 КБ (К15)', () => {
    const m = JSON.parse(strFromU8(zip['manifest.json']));
    expect(m.permissions).toContain('unlimitedStorage');
    const wasm = zip['vendor/ort-wasm-simd-threaded.wasm'];
    expect(wasm, 'vendor/ort-wasm-simd-threaded.wasm').toBeDefined();
    expect([...wasm.slice(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d]); // \0asm
    expect(zip['vendor/onnxruntime-web.LICENSE']).toBeDefined();
    expect(strFromU8(zip['offscreen/offscreen.js'])).toMatch(/new Worker\("worker\.js", \{ type: "module" \}\)/);
    const worker = strFromU8(zip['offscreen/worker.js']);
    expect(worker).toMatch(/^export\s|\nexport\s|import\.meta\.url/); // ESM-сборка: import.meta доступен
    expect(worker).not.toMatch(/^(?:(?:var|const|let)\s+\S+\s*=\s*)?require\(/m); // нет top-level require
    // Размеры: секции бандла esbuild помечены комментариями «// <путь модуля>». ORT и словари ФИО (генерируемые
    // данные WP7) считаются отдельно от кода: прежний общий бюджет «без ORT ≤ 700 КБ» исчерпан (запас был < 1 КБ),
    // а растёт в основном код. Бэклог: словари — в vendor/dict/*.txt с ленивой загрузкой (docs/tasks.md).
    const sections = worker.split(/\n(?=\/\/ (?:node_modules|src)\/)/);
    const bytesOf = (prefix) => sections.filter((s) => s.startsWith(prefix)).reduce((n, s) => n + Buffer.byteLength(s), 0);
    const ortBytes = bytesOf('// node_modules/onnxruntime-web/');
    const dictBytes = bytesOf('// src/core/detect/names/dict/');
    const total = zip['offscreen/worker.js'].length;
    console.log(`worker.js ${total} байт: ORT ${ortBytes}, словари ${dictBytes}, код ${total - ortBytes - dictBytes}`);
    expect(ortBytes, 'ORT встроен в worker.js (bundle-вариант, glue без внешнего .mjs)').toBeGreaterThan(50 * 1024);
    expect(dictBytes, 'словари ФИО в worker.js').toBeGreaterThan(100 * 1024);
    expect(total - ortBytes - dictBytes, 'код worker.js без ORT и словарей').toBeLessThanOrEqual(400 * 1024);
    expect(dictBytes, 'словари ФИО').toBeLessThanOrEqual(400 * 1024);
    expect(Object.keys(zip).filter((n) => /ort-wasm.*\.mjs$/.test(n))).toEqual([]);
  });

  it('словари ФИО (WP7) только в offscreen/worker.js; content.js < 150 КБ и без словарей (К15)', () => {
    // маркер — первые 24 символа упакованной строки фамилий (в бандле перевод строки может стать escape-последовательностью)
    const marker = RU_SURNAMES.slice(0, 24);
    const has = (code) => code.includes(marker) || code.includes(marker.replace(/\n/g, '\\n'));
    const content = strFromU8(zip['content.js']);
    expect(zip['content.js'].length).toBeLessThan(150 * 1024);
    expect(has(content)).toBe(false);
    expect(has(strFromU8(zip['offscreen/worker.js']))).toBe(true);
    for (const f of ['background.js', 'popup/popup.js', 'options/options.js', 'restore/restore.js', 'help/help.js'])
      expect(has(strFromU8(zip[f])), f).toBe(false);
  });

  it('pdf.js (версия 0.3, К8): vendor/pdfjs/ с CMaps и шрифтами ≤ 6 МБ, не в worker.js; архив ≤ 12 МБ', () => {
    for (const f of ['vendor/pdfjs/pdf.mjs', 'vendor/pdfjs/pdf.worker.mjs', 'vendor/pdfjs/LICENSE']) expect(zip[f], f).toBeDefined();
    const names = Object.keys(zip).filter((n) => n.startsWith('vendor/pdfjs/'));
    expect(names.filter((n) => /^vendor\/pdfjs\/cmaps\/.+\.bcmap$/.test(n)).length).toBeGreaterThanOrEqual(150);
    expect(names.filter((n) => /^vendor\/pdfjs\/standard_fonts\/.+\.(pfb|ttf)$/.test(n)).length).toBeGreaterThanOrEqual(10);
    const vendorBytes = names.reduce((n, f) => n + zip[f].length, 0);
    console.log(`vendor/pdfjs: ${names.length} файлов, ${vendorBytes} байт; архив ${first.size} байт`);
    expect(vendorBytes).toBeLessThanOrEqual(6 * 1024 * 1024);
    expect(first.size).toBeLessThanOrEqual(12 * 1024 * 1024);
    expect(strFromU8(zip['vendor/pdfjs/LICENSE'])).toMatch(/Apache License/);
    // pdf.js грузится лениво из vendor/, а не бандлится в воркер ядра (бюджет К15)
    const worker = strFromU8(zip['offscreen/worker.js']);
    expect(worker).not.toMatch(/\n\/\/ node_modules\/pdfjs-dist\//);
    expect(worker).toContain('vendor/pdfjs/');
  });

  it('иконки — PNG ожидаемых размеров', () => {
    for (const size of [16, 32, 48, 128]) {
      const b = zip[`icons/icon-${size}.png`];
      expect([...b.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const dv = new DataView(b.buffer, b.byteOffset);
      expect([dv.getUint32(16), dv.getUint32(20)]).toEqual([size, size]);
    }
  });

  it('есть страница справки; в архиве нет исходников, тестов, зависимостей и sourcemaps', () => {
    for (const f of ['help/help.html', 'help/help.js', 'help/help.css']) expect(zip[f], f).toBeDefined();
    const names = Object.keys(zip);
    expect(names.filter((n) => /\.map$|^src\/|^tests\/|node_modules|^docs\/|^scripts\/|package/.test(n))).toEqual([]);
    expect(strFromU8(zip['help/help.js'])).not.toContain('sourceMappingURL');
  });

  it('страницы расширения подписаны «Сделано в Sitimlab» и ведут на sitimlab.ru', () => {
    expect(strFromU8(zip['popup/popup.html'])).toContain('href="https://sitimlab.ru"');
    for (const f of ['options/options.js', 'restore/restore.js', 'help/help.js']) {
      const code = strFromU8(zip[f]);
      expect(code, f).toContain('https://sitimlab.ru');
      expect(code, f).toContain('Сделано в');
    }
  });

  it('DOS-время не зависит от TZ: fflate с FIXED_TIME даёт одни байты в UTC+14 и UTC-8 (К11)', () => {
    // Тот же вызов, что в pack.mjs (локальный конструктор даты), в отдельных процессах с разными часовыми поясами.
    const code = [
      "import { zipSync } from 'fflate';",
      "const zip = zipSync({ 'a.txt': [new TextEncoder().encode('docx'), { mtime: new Date(2000, 0, 1, 12) }] });",
      "process.stdout.write(Buffer.from(zip).toString('hex'));",
    ].join('\n');
    const run = (TZ) => execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TZ }, encoding: 'utf8' });
    const east = run('Pacific/Kiritimati');
    const west = run('America/Los_Angeles');
    expect(east.length).toBeGreaterThan(0);
    expect(east).toBe(west);
    // и pack.mjs использует именно эту отметку
    expect([FIXED_TIME.getFullYear(), FIXED_TIME.getMonth(), FIXED_TIME.getDate(), FIXED_TIME.getHours()]).toEqual([2000, 0, 1, 12]);
  });

  it('архив воспроизводим: повторная сборка даёт те же байты', () => {
    const again = packRelease({ outDir: join(out, 'again') }).lite;
    expect(again.sha256).toBe(first.sha256);
    expect(again.size).toBe(first.size);
  }, 60000);
});

// Выбор пакета модели для полного архива (версия 0.4, WP11-C3): --model= главнее; из release/ — zip с sha из KNOWN_PACKS и
// наибольшей версией; неизвестные zip пропускаются с предупреждением. Фейковые zip и подменённый поиск sha — сети и модели не нужно.
describe('findModelZip', () => {
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'docx-anon-find-model-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  /** Каталог с zip: {имя: версия | null}; null — sha нет среди «известных». Возвращает {dir, lookup}. */
  function release(name, files) {
    const d = join(dir, name);
    mkdirSync(d);
    const known = new Map();
    for (const [file, version] of Object.entries(files)) {
      const bytes = Buffer.from(`zip ${file}`);
      writeFileSync(join(d, file), bytes);
      if (version) known.set(sha(bytes), { version });
    }
    writeFileSync(join(d, 'docx-anonymizer-0.4.0.zip'), 'не пакет модели'); // архив расширения не рассматривается
    return { dir: d, lookup: (h) => known.get(h) || null };
  }

  it('несколько известных — наибольшая версия по semver (1.10.0 > 1.9.0 > 1.1.0), неизвестный пропущен с предупреждением', () => {
    const r = release('many', {
      'docx-anonymizer-ner-a-1.1.0.zip': '1.1.0',
      'docx-anonymizer-ner-a-1.10.0.zip': '1.10.0',
      'docx-anonymizer-ner-a-1.9.0.zip': '1.9.0',
      'docx-anonymizer-ner-a-9.9.9.zip': null,
    });
    const warns = [];
    expect(findModelZip([], { ...r, warn: (m) => warns.push(m) })).toBe(join(r.dir, 'docx-anonymizer-ner-a-1.10.0.zip'));
    expect(warns).toEqual([expect.stringContaining('docx-anonymizer-ner-a-9.9.9.zip')]);
    expect(warns[0]).toContain('KNOWN_PACKS');
  });

  it('только неизвестные или ни одного zip — null; --model= главнее выбора из release/', () => {
    const only = release('unknown', { 'docx-anonymizer-ner-x-2.0.0.zip': null });
    const warns = [];
    expect(findModelZip([], { ...only, warn: (m) => warns.push(m) })).toBeNull();
    expect(warns).toHaveLength(1);
    expect(findModelZip([], { dir: join(dir, 'нет-такого'), warn: () => {} })).toBeNull();
    const r = release('arg', { 'docx-anonymizer-ner-a-1.1.0.zip': '1.1.0' });
    const explicit = join(r.dir, 'docx-anonymizer-ner-x-2.0.0.zip');
    writeFileSync(explicit, 'любой');
    expect(findModelZip([`--model=${explicit}`], r)).toBe(explicit);
    expect(() => findModelZip([`--model=${join(r.dir, 'нет.zip')}`], r)).toThrow(/Нет файла пакета модели/);
  });

  it('настоящий KNOWN_PACKS: последняя версия; если её zip есть в release/, выбирается именно он (а не 1.0.0 рядом)', () => {
    const latest = latestKnownPack();
    expect(latest).toBeTruthy();
    for (const p of KNOWN_PACKS) expect(compareVersions(p.version, latest.version), p.version).toBeLessThanOrEqual(0);
    expect(latestModelZipPath(dir)).toBe(join(dir, `docx-anonymizer-ner-${latest.id}-${latest.version}.zip`));
    const real = latestModelZipPath();
    if (existsSync(real)) expect(findModelZip([], { warn: () => {} })).toBe(real);
  }, 30000);
});

// Полный архив (версия 0.3, WP10-C, К15; 0.4, К12 — ≤ 45 МБ): модель NER в models/ — только если локально есть опубликованный zip
// последнего пакета из KNOWN_PACKS (`npm run pack:model`; в git и CI его нет — там собирается только лёгкий архив).
const MODEL_ZIP = latestModelZipPath();
describe.skipIf(!existsSync(MODEL_ZIP))('полный архив', () => {
  let dir;
  let res;
  let fullZip;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'docx-anon-pack-full-'));
    res = packRelease({ outDir: dir, modelZip: MODEL_ZIP });
    fullZip = unzipSync(new Uint8Array(readFileSync(res.full.file)));
  }, 120000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('называется <имя>-full.zip, рядом лёгкий того же кода', () => {
    expect(res.full.name).toBe(`docx-anonymizer-${pkg.version}-full.zip`);
    expect(res.lite.name).toBe(`docx-anonymizer-${pkg.version}.zip`);
    expect(existsSync(res.full.file)).toBe(true);
    expect(res.full.size).toBeGreaterThan(res.lite.size);
  });

  it('размер: полный ≤ 45 МБ, лёгкий ≤ 12 МБ (К12 версии 0.4)', () => {
    console.log(`полный архив ${res.full.size} байт (${(res.full.size / 1048576).toFixed(1)} МБ), лёгкий ${res.lite.size} байт`);
    expect(res.full.size).toBeLessThanOrEqual(45 * 1024 * 1024);
    expect(res.lite.size).toBeLessThanOrEqual(12 * 1024 * 1024);
  });

  it('models/index.json + models/<file>: sha256 из KNOWN_PACKS и равен sha байтов записи; zip пакета без изменений', () => {
    const index = JSON.parse(strFromU8(fullZip['models/index.json']));
    expect(index).toHaveLength(1);
    expect(Object.keys(index[0])).toEqual(['file', 'id', 'version', 'sha256', 'size']);
    const entry = fullZip[`models/${index[0].file}`];
    expect(entry, index[0].file).toBeDefined();
    // пакетов одного id в KNOWN_PACKS несколько (1.0.0 и 1.1.0) — сверка по sha и версии
    const known = findKnownPack(index[0].sha256);
    expect(known).toMatchObject({ id: index[0].id, version: index[0].version });
    expect(known).toEqual(latestKnownPack());
    expect(createHash('sha256').update(entry).digest('hex')).toBe(index[0].sha256);
    expect(entry.length).toBe(index[0].size);
    expect(Buffer.from(entry).equals(readFileSync(MODEL_ZIP))).toBe(true);
    // ничего другого в models/ нет
    expect(
      Object.keys(fullZip)
        .filter((n) => n.startsWith('models/'))
        .sort(),
    ).toEqual(['models/index.json', `models/${index[0].file}`].sort());
  });

  it('описание запечено в background.js полного архива; лёгкий — без models/ и без id', () => {
    const index = JSON.parse(strFromU8(fullZip['models/index.json']));
    // id — строковым литералом (в комментарии settings.js id пакета упоминается и в лёгкой сборке)
    expect(strFromU8(fullZip['background.js'])).toContain(index[0].sha256);
    expect(strFromU8(fullZip['background.js'])).toContain(`"${index[0].id}"`);
    const lite = unzipSync(new Uint8Array(readFileSync(res.lite.file)));
    expect(Object.keys(lite).filter((n) => /^models\//.test(n))).toEqual([]);
    expect(strFromU8(lite['background.js'])).not.toContain(`"${index[0].id}"`);
    expect(strFromU8(lite['background.js'])).not.toContain(index[0].sha256);
    expect(res.lite.sha256).toBe(first.sha256); // лёгкий архив тот же, что без модели
  });

  it('в полном архиве нет исходников, тестов, зависимостей и sourcemaps', () => {
    const names = Object.keys(fullZip);
    expect(names.filter((n) => /\.map$|^src\/|^tests\/|node_modules|^docs\/|^scripts\/|package/.test(n))).toEqual([]);
  });

  it('полный архив воспроизводим', () => {
    const again = packRelease({ outDir: join(dir, 'again'), modelZip: MODEL_ZIP });
    expect(again.full.sha256).toBe(res.full.sha256);
    expect(again.full.size).toBe(res.full.size);
  }, 120000);
});
