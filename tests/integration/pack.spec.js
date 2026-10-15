// Архив релиза (npm run pack): состав, манифест в корне, иконки, воспроизводимость. Сети не требуется.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packRelease, FIXED_TIME } from '../../scripts/pack.mjs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
let out;
let first;
let zip;

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), 'docx-anon-pack-test-'));
  first = packRelease({ outDir: out });
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
    const again = packRelease({ outDir: join(out, 'again') });
    expect(again.sha256).toBe(first.sha256);
    expect(again.size).toBe(first.size);
  }, 60000);
});
