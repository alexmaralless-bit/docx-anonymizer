// Манифест расширения (К9, К11 из docs/concept-0.2.md): версия = package.json; доступ к сайтам — только опциональный
// (нет host_permissions и статических content_scripts); e2e-сборка добавляет host_permissions для Playwright.
// Сборки — во временные каталоги os.tmpdir(), dist/ не затрагивается. Сети не требуется.
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { latestKnownPack, latestModelZipPath } from '../../scripts/pack.mjs';
import { createHash } from 'node:crypto';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const tmp = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

/** Собирает расширение в новый временный каталог и возвращает его манифест (dir — каталог сборки). */
function buildManifest(args, out = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'docx-anon-manifest-'));
  tmp.push(dir);
  out.dir = dir;
  execFileSync(process.execPath, ['scripts/build.mjs', ...args, `--dist=${dir}`], { stdio: 'pipe' });
  return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
}

describe('manifest.json репозитория', () => {
  it('версия совпадает с package.json (К11)', () => {
    expect(manifest.version).toBe(pkg.version);
  });

  it('доступ к сайтам опциональный: нет host_permissions и content_scripts (К9)', () => {
    expect(manifest).not.toHaveProperty('host_permissions');
    expect(manifest).not.toHaveProperty('content_scripts');
    expect(manifest.optional_host_permissions).toEqual(['<all_urls>']);
    expect(manifest.permissions).toEqual(expect.arrayContaining(['storage', 'offscreen', 'scripting', 'activeTab']));
  });

  it('поле key фиксирует идентификатор расширения: обновление из любой папки сохраняет настройки, доступ к сайтам и модель', () => {
    // Chrome вычисляет ID распакованного расширения из пути к папке; с key — из открытого ключа (sha256 DER → первые 32 hex → a…p)
    const der = Buffer.from(manifest.key, 'base64');
    expect(der.length).toBeGreaterThan(200);
    const id = createHash('sha256')
      .update(der)
      .digest('hex')
      .slice(0, 32)
      .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
    expect(id).toBe('oppdmoakaiampmmdgedmboeklbhkfmgh');
  });

  it('минимальная версия Chrome ≥ 132: pdf.js 6 читает CMaps и шрифты через Response.bytes() (версия 0.3, спайк S1)', () => {
    expect(Number(manifest.minimum_chrome_version)).toBeGreaterThanOrEqual(132);
    // CSP не ослаблена ради pdf.js: свои скрипты, wasm ORT, fetch только к своему пакету
    expect(manifest.content_security_policy.extension_pages).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(manifest.content_security_policy.extension_pages).toContain("connect-src 'self'");
  });
});

describe('сборка', () => {
  it('--e2e добавляет host_permissions <all_urls>, обычная — нет', () => {
    const e2e = buildManifest(['--e2e']);
    expect(e2e.host_permissions).toEqual(['<all_urls>']);
    expect(e2e.optional_host_permissions).toEqual(['<all_urls>']);
    expect(e2e.version).toBe(pkg.version);
    const lite = {};
    const release = buildManifest([], lite);
    expect(existsSync(join(lite.dir, 'models')), 'лёгкая сборка без models/ (WP10-C)').toBe(false);
    expect(release).not.toHaveProperty('host_permissions');
    expect(release).not.toHaveProperty('content_scripts');
    expect(release.optional_host_permissions).toEqual(['<all_urls>']);
    expect(release.version).toBe(pkg.version);
  }, 60000);
});

// Встроенная модель NER (версия 0.3, WP10-C, К15): --with-model=<zip> принимает только пакеты из KNOWN_PACKS
// Имя zip — последнего пакета из KNOWN_PACKS (версия 0.4, WP11-C3), гейт — его наличие в release/
const MODEL_ZIP = latestModelZipPath();
describe('сборка с моделью', () => {
  it('пакет не из KNOWN_PACKS — сборка падает с понятным текстом', () => {
    const dir = mkdtempSync(join(tmpdir(), 'docx-anon-manifest-'));
    tmp.push(dir);
    const fake = join(dir, 'docx-anonymizer-ner-fake-0.0.1.zip');
    writeFileSync(fake, zipSync({ 'pack.json': strToU8('{"id":"fake"}') }));
    const r = spawnSync(process.execPath, ['scripts/build.mjs', `--with-model=${fake}`, `--dist=${join(dir, 'out')}`], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('не в KNOWN_PACKS');
    expect(existsSync(join(dir, 'out', 'manifest.json'))).toBe(false);
  }, 60000);

  it.skipIf(!existsSync(MODEL_ZIP))(
    'настоящий пакет — models/index.json с описанием и сам zip',
    () => {
      const b = {};
      buildManifest([`--with-model=${MODEL_ZIP}`], b);
      const index = JSON.parse(readFileSync(join(b.dir, 'models/index.json'), 'utf8'));
      expect(index).toHaveLength(1);
      expect(Object.keys(index[0])).toEqual(['file', 'id', 'version', 'sha256', 'size']);
      const latest = latestKnownPack();
      expect(index[0].file).toBe(basename(MODEL_ZIP));
      expect(index[0]).toMatchObject({ id: latest.id, version: latest.version, sha256: latest.sha256, size: statSync(MODEL_ZIP).size });
      expect(readFileSync(join(b.dir, 'models', index[0].file)).equals(readFileSync(MODEL_ZIP))).toBe(true);
      expect(readFileSync(join(b.dir, 'background.js'), 'utf8')).toContain(index[0].sha256);
    },
    60000,
  );
});
