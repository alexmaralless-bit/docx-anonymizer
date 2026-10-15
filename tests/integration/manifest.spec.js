// Манифест расширения (К9, К11 из docs/concept-0.2.md): версия = package.json; доступ к сайтам — только опциональный
// (нет host_permissions и статических content_scripts); e2e-сборка добавляет host_permissions для Playwright.
// Сборки — во временные каталоги os.tmpdir(), dist/ не затрагивается. Сети не требуется.
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const tmp = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

/** Собирает расширение в новый временный каталог и возвращает его манифест. */
function buildManifest(args) {
  const dir = mkdtempSync(join(tmpdir(), 'docx-anon-manifest-'));
  tmp.push(dir);
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
});

describe('сборка', () => {
  it('--e2e добавляет host_permissions <all_urls>, обычная — нет', () => {
    const e2e = buildManifest(['--e2e']);
    expect(e2e.host_permissions).toEqual(['<all_urls>']);
    expect(e2e.optional_host_permissions).toEqual(['<all_urls>']);
    expect(e2e.version).toBe(pkg.version);
    const release = buildManifest([]);
    expect(release).not.toHaveProperty('host_permissions');
    expect(release).not.toHaveProperty('content_scripts');
    expect(release.optional_host_permissions).toEqual(['<all_urls>']);
    expect(release.version).toBe(pkg.version);
  }, 60000);
});
