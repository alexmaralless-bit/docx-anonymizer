// Встроенная модель NER (версия 0.3, WP10-C, К15/К16): план автоустановки, патч настроек по ответу хоста, чтение zip из
// собственного пакета расширения и сторож NFR-01 «fetch в src/ — ровно в одном файле».
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { BOOTSTRAP_CLIENT, planBootstrap, settingsPatchFor } from '../../src/shared/bundled-model.js';
import { readPackageFile } from '../../src/offscreen/package-fetch.js';
import { ModelStoreError } from '../../src/shared/model-store.js';
import { OPTIONS_DICT } from '../../src/ui/i18n/options.js';
import { popup } from '../../src/ui/i18n/popup.js';
import { panel } from '../../src/ui/i18n/panel.js';

const SHA = 'a'.repeat(64);
const OLD = 'b'.repeat(64);
const BUNDLED = { file: 'docx-anonymizer-ner-test-pack-1.0.0.zip', id: 'test-pack', version: '1.0.0', sha256: SHA, size: 123 };

describe('planBootstrap', () => {
  it('лёгкая сборка (bundled = null) → none', () => {
    expect(planBootstrap({ bundled: null, settings: { nerModel: '', bundledModelSha: '' } })).toBe('none');
  });
  it('свежий профиль → install', () => {
    expect(planBootstrap({ bundled: BUNDLED, settings: { nerModel: '', bundledModelSha: '' } })).toBe('install');
  });
  it('этот sha уже обработан: модель стоит → skip; пользователь её удалил → тоже skip (сама не возвращается)', () => {
    expect(planBootstrap({ bundled: BUNDLED, settings: { nerModel: 'test-pack', bundledModelSha: SHA } })).toBe('skip');
    expect(planBootstrap({ bundled: BUNDLED, settings: { nerModel: '', bundledModelSha: SHA } })).toBe('skip');
  });
  it('обновление с новым sha встроенного пакета → install', () => {
    expect(planBootstrap({ bundled: BUNDLED, settings: { nerModel: '', bundledModelSha: OLD } })).toBe('install');
    expect(planBootstrap({ bundled: BUNDLED, settings: { nerModel: 'test-pack', bundledModelSha: OLD } })).toBe('install');
  });
  it('пользователь выбрал свой пакет → foreign', () => {
    expect(planBootstrap({ bundled: BUNDLED, settings: { nerModel: 'my', bundledModelSha: '' } })).toBe('foreign');
  });
  it('тот же пакет импортирован вручную, sha не отмечен → install (хост ответит present)', () => {
    expect(planBootstrap({ bundled: BUNDLED, settings: { nerModel: 'test-pack', bundledModelSha: '' } })).toBe('install');
  });
});

describe('settingsPatchFor', () => {
  it('installed / present → nerModel и bundledModelSha', () => {
    for (const status of ['installed', 'present']) {
      expect(settingsPatchFor({ status }, BUNDLED, { nerModel: '' })).toEqual({ nerModel: 'test-pack', bundledModelSha: SHA });
      expect(settingsPatchFor({ status }, BUNDLED, { nerModel: 'test-pack' })).toEqual({ nerModel: 'test-pack', bundledModelSha: SHA });
    }
  });
  it('пока шла установка, пользователь выбрал другой пакет → только bundledModelSha', () => {
    expect(settingsPatchFor({ status: 'installed' }, BUNDLED, { nerModel: 'my' })).toEqual({ bundledModelSha: SHA });
  });
  it('failed → null (ничего не пишем, следующий запуск попробует снова)', () => {
    expect(settingsPatchFor({ status: 'failed', code: 'QUOTA' }, BUNDLED, { nerModel: '' })).toBeNull();
  });
  it('clientId bootstrap', () => {
    expect(BOOTSTRAP_CLIENT).toBe('bootstrap');
  });
});

describe('readPackageFile: только собственный пакет расширения (NFR-01)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const own = () => vi.stubGlobal('self', { location: { protocol: 'chrome-extension:', host: 'abcdefgh', origin: 'chrome-extension://abcdefgh' } });

  it('http(s), data:, чужое расширение, мусор → IO до вызова fetch', async () => {
    own();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    for (const url of [
      'https://example.invalid/m.zip',
      'http://127.0.0.1/m.zip',
      'data:application/zip;base64,AA==',
      'chrome-extension://other/models/m.zip',
      'не адрес',
    ]) {
      const err = await readPackageFile(url).catch((e) => e);
      expect(err, url).toBeInstanceOf(ModelStoreError);
      expect(err.code, url).toBe('IO');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('свой origin → байты; файла нет (!ok) → IO «Файл пакета расширения не найден»', async () => {
    own();
    const fetch = vi.fn(async (url) =>
      url.endsWith('/models/ok.zip') ? { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } : { ok: false, status: 404 },
    );
    vi.stubGlobal('fetch', fetch);
    expect([...(await readPackageFile('chrome-extension://abcdefgh/models/ok.zip'))]).toEqual([1, 2, 3]);
    const err = await readPackageFile('chrome-extension://abcdefgh/models/none.zip').catch((e) => e);
    expect(err).toBeInstanceOf(ModelStoreError);
    expect(err.code).toBe('IO');
    expect(err.message).toBe('Файл пакета расширения не найден');
  });

  it('вне контекста расширения (нет self.location) → IO', async () => {
    vi.stubGlobal('self', undefined);
    const err = await readPackageFile('chrome-extension://abcdefgh/models/ok.zip').catch((e) => e);
    expect(err.code).toBe('IO');
  });
});

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('сторож NFR-01 (К16)', () => {
  it('fetch( в src/**/*.js — ровно в src/offscreen/package-fetch.js', () => {
    const hits = walk('src')
      .filter((f) => f.endsWith('.js'))
      .filter((f) => /\bfetch\(/.test(readFileSync(f, 'utf8')))
      .map((f) => relative('.', f).split(sep).join('/'));
    expect(hits).toEqual(['src/offscreen/package-fetch.js']);
  });

  it('override ESLint снимает запрет fetch ровно с этого файла, остальные сетевые API в нём запрещены', async () => {
    const config = (await import('../../eslint.config.js')).default;
    const overrides = config.filter((c) => c.files?.includes('src/offscreen/package-fetch.js'));
    expect(overrides).toHaveLength(1);
    expect(overrides[0].files).toEqual(['src/offscreen/package-fetch.js']);
    const banned = overrides[0].rules['no-restricted-globals'].slice(1).map((r) => (typeof r === 'string' ? r : r.name));
    expect(banned.sort()).toEqual(['EventSource', 'WebSocket', 'XMLHttpRequest']);
    // общий запрет для src/** остаётся
    const general = config.find((c) => c.files?.length === 1 && c.files[0] === 'src/**/*.js');
    expect(general.rules['no-restricted-globals'].slice(1).map((r) => r.name)).toContain('fetch');
    // define встроенной модели объявлен глобалом, как __VERSION__
    expect(config.some((c) => c.languageOptions?.globals?.__BUNDLED_MODEL__ === 'readonly')).toBe(true);
  });
});

describe('строки онбординга (К16)', () => {
  it('ключи ru/en совпадают в popup и панели; новые строки есть', () => {
    for (const dict of [popup, panel, OPTIONS_DICT]) expect(Object.keys(dict.en).sort()).toEqual(Object.keys(dict.ru).sort());
    for (const k of ['ner_bundled_installing', 'ner_bundled_restore', 'ner_bundled_restoring', 'ner_onboard_h', 'ner_step_1', 'ner_step_2', 'ner_step_3'])
      for (const lang of ['ru', 'en']) expect(OPTIONS_DICT[lang][k], `${lang}.${k}`).toBeTruthy();
    expect(popup.ru.nerHint).toBe('Модель NER не установлена — находить больше имён');
    expect(popup.ru.nerInstalling).toBeTruthy();
    expect(panel.ru.nerHint).toBe('Хотите находить больше имён? Установите модель NER в настройках расширения');
    expect(OPTIONS_DICT.ru.ner_bundled_installing).toBe('Встроенная модель устанавливается…');
    expect(OPTIONS_DICT.ru.ner_bundled_restore).toBe('Восстановить встроенную модель');
  });
});
