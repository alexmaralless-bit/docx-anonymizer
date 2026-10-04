import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { parseDocx } from '../../../src/core/docx/model.js';
import { analyze } from '../../../src/core/detect/runner.js';
import { clearDetectors, registerDetector } from '../../../src/core/contracts/index.js';
import { register as registerCustom, findCustomMatches } from '../../../src/core/detect/custom/index.js';
import { checkRegexSource, validateCustomCategory } from '../../../src/core/detect/custom/rules.js';
import { VALIDATORS } from '../../../src/core/validators.js';
import { defaultSettings, validateSettingsPatch } from '../../../src/core/settings.js';
import { parseCategoriesFile, parseConfigFile } from '../../../src/options/config-io.js';
import { makeDocx, para, run } from '../../helpers/docx.js';

const fx = JSON.parse(readFileSync(new URL('../../fixtures/custom-categories.json', import.meta.url), 'utf8'));

const luhn = (v) => {
  let s = 0;
  [...v.replace(/\D/g, '')].reverse().forEach((c, i) => {
    let d = Number(c);
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    s += d;
  });
  return v.length > 1 && s % 10 === 0;
};

async function detect(cc, text, extra = {}) {
  const doc = parseDocx(makeDocx(para(run(text))));
  const settings = { ...defaultSettings(), customCategories: [cc], ...extra };
  return analyze(doc, settings);
}

let savedLuhn;
beforeEach(() => {
  clearDetectors();
  registerCustom({ registerDetector, registerDocumentDetector: (await_name, fn) => registerDocumentDetectorShim(await_name, fn) });
  savedLuhn = VALIDATORS.luhn;
  VALIDATORS.luhn ||= luhn; // WP1 мог ещё не влиться
});
afterEach(() => {
  if (savedLuhn) VALIDATORS.luhn = savedLuhn;
  else delete VALIDATORS.luhn;
});

import { registerDocumentDetector as registerDocumentDetectorShim } from '../../../src/core/contracts/index.js';

describe('custom-categories.json: три категории каждого типа (FR-44)', () => {
  it('в фикстуре по 3 категории каждого типа', () => {
    for (const k of ['dictionary', 'labeled', 'pattern']) expect(fx.categories.filter((c) => c.category.kind === k)).toHaveLength(3);
    for (const c of fx.categories) expect(validateCustomCategory(c.category)).toEqual([]);
  });
  for (const { category: cc, positive, negative } of fx.categories) {
    describe(`${cc.kind}: ${cc.label.ru}`, () => {
      for (const p of positive) {
        it(`находит ${JSON.stringify(p.matches)}`, async () => {
          const r = await detect(cc, p.text);
          const found = r.entities.filter((e) => e.category === cc.id);
          expect(found.map((e) => e.text)).toEqual(p.matches);
          if (p.levels) expect(found.map((e) => e.confidence)).toEqual(p.levels);
          expect(r.groups.every((g) => g.placeholder.startsWith(`[${cc.placeholderPrefix.ru}_`))).toBe(true);
        });
      }
      for (const n of negative) {
        it(`не находит в «${n}»`, async () => {
          const r = await detect(cc, n);
          expect(r.entities.filter((e) => e.category === cc.id)).toEqual([]);
        });
      }
    });
  }

  it('выключенная категория не ищется', async () => {
    const { category: cc, positive } = fx.categories[0];
    const r = await detect({ ...cc, enabled: false }, positive[0].text);
    expect(r.entities).toEqual([]);
  });

  it('невалидная категория (lookbehind) пропускается без падения', async () => {
    const cc = { ...fx.categories[6].category, pattern: { regex: '(?<=ЗК-)\\d+', flags: 'u', validator: 'none' } };
    const r = await detect(cc, 'ЗК-2024');
    expect(r.entities).toEqual([]);
    expect(r.warnings.find((w) => w.code === 'DETECTOR_FAILED')).toBeUndefined();
  });

  it('priority: aboveBuiltin выигрывает у PERSON на пересечении, belowBuiltin — проигрывает', async () => {
    const a = fx.aboveBuiltin;
    registerDetector('PERSON', (t) =>
      [...t.matchAll(new RegExp(a.personStubRegex, 'g'))].map((m) => ({ start: m.index, end: m.index + m[0].length, confidence: 'labeled' })),
    );
    const above = await detect(a.category, a.text);
    expect(above.entities.map((e) => e.category)).toEqual([a.expectAbove]);
    const below = await detect({ ...a.category, priority: 'belowBuiltin' }, a.text);
    expect(below.entities.map((e) => e.category)).toEqual([a.expectBelow]);
  });

  it('сущности своих категорий получают плейсхолдеры и склеиваются по значению', async () => {
    const r = await detect(fx.categories[0].category, 'Орион, потом снова орион');
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]).toMatchObject({ placeholder: '[ПРОЕКТ_1]' });
    expect(r.groups[0].occurrences).toHaveLength(2);
  });
});

describe('findCustomMatches (предпросмотр в настройках)', () => {
  it('учитывает язык документа для меток', () => {
    const cc = { ...fx.categories[3].category };
    expect(findCustomMatches(cc, 'Табельный номер: 123456', 'ru')).toHaveLength(1);
    expect(findCustomMatches(cc, 'Табельный номер: 123456', 'en')).toHaveLength(0);
  });
  it('пустой текст и пустой словарь', () => {
    expect(findCustomMatches(fx.categories[0].category, '')).toEqual([]);
    expect(findCustomMatches({ kind: 'dictionary', dictionary: { values: [] } }, 'текст')).toEqual([]);
  });
});

describe('правила regex (FR-45)', () => {
  it('принимает ЗК-\\d{4}/\\d{2}', () => expect(checkRegexSource('ЗК-\\d{4}/\\d{2}', 'u')).toEqual({ ok: true }));
  it('отклоняет: длина, флаги, lookbehind, синтаксис, пустое совпадение', () => {
    expect(checkRegexSource('a'.repeat(501), 'u')).toMatchObject({ code: 'TOO_LONG' });
    expect(checkRegexSource('a', 'g')).toMatchObject({ code: 'BAD_FLAGS' });
    expect(checkRegexSource('a', 'ii')).toMatchObject({ code: 'BAD_FLAGS' });
    expect(checkRegexSource('(?<=a)b', 'u')).toMatchObject({ code: 'LOOKBEHIND' });
    expect(checkRegexSource('(?<!a)b', '')).toMatchObject({ code: 'LOOKBEHIND' });
    expect(checkRegexSource('(a', '')).toMatchObject({ code: 'SYNTAX' });
    expect(checkRegexSource('a*', '')).toMatchObject({ code: 'MATCHES_EMPTY' });
    expect(checkRegexSource('', '')).toMatchObject({ code: 'EMPTY' });
  });
  it('экранированная скобка и класс символов — не lookbehind; именованная группа допустима', () => {
    expect(checkRegexSource('\\(?<=x', '')).toEqual({ ok: true });
    expect(checkRegexSource('[(?<=]x', '')).toEqual({ ok: true });
    expect(checkRegexSource('(?<year>\\d{4})', 'u')).toEqual({ ok: true });
  });
});

function guard(regex, flags = 'u', timeout = 500) {
  return new Promise((resolve) => {
    const w = new Worker(new URL('./guard-thread.mjs', import.meta.url), { workerData: { regex, flags } });
    const timer = setTimeout(() => {
      w.terminate();
      resolve({ ok: false, code: 'TIMEOUT' });
    }, timeout);
    w.once('message', (m) => {
      clearTimeout(timer);
      w.terminate();
      resolve(m);
    });
  });
}

describe('regex-guard: катастрофический бэктрекинг (R-8)', () => {
  it('(a+)+$ отклоняется по таймауту', async () => expect(await guard('(a+)+$')).toMatchObject({ ok: false, code: 'TIMEOUT' }), 5000);
  it('(a|aa)+$ и (\\w+\\s?)*$ отклоняются', async () => {
    expect((await guard('^(a|aa)+$')).ok).toBe(false);
    expect((await guard('(\\w+\\s?)*!$')).ok).toBe(false);
  }, 10000);
  it('ЗК-\\d{4}/\\d{2} принимается', async () => expect(await guard('ЗК-\\d{4}/\\d{2}')).toMatchObject({ ok: true }));
  it('правила проверяются и в Worker (lookbehind)', async () => expect(await guard('(?<=a)b')).toMatchObject({ ok: false, code: 'LOOKBEHIND' }));
});

describe('схема настроек и импорт/экспорт', () => {
  it('customCategories проходят validateSettingsPatch', () => {
    expect(validateSettingsPatch({ customCategories: fx.categories.map((c) => c.category) })).toEqual([]);
  });
  it('validateCustomCategory ловит ошибки по полям', () => {
    const base = fx.categories[0].category;
    expect(validateCustomCategory({ ...base, color: 'red' }).map((e) => e.field)).toContain('color');
    expect(validateCustomCategory({ ...base, placeholderPrefix: { ru: 'Ф И', en: 'X' } }).map((e) => e.field)).toContain('placeholderPrefix.ru');
    expect(validateCustomCategory({ ...base, dictionary: { values: [], caseSensitive: false, wholeWord: true } }).map((e) => e.field)).toContain(
      'dictionary.values',
    );
    const lab = fx.categories[3].category;
    expect(validateCustomCategory({ ...lab, labeled: { ...lab.labeled, minLen: 9, maxLen: 3 } })).toContainEqual({ field: 'labeled.maxLen', code: 'RANGE' });
  });
  it('*.categories.json: экспорт → импорт восстанавливает категории с теми же id', () => {
    const cats = fx.categories.map((c) => c.category);
    const text = JSON.stringify({ kind: 'docx-anonymizer-categories', version: 1, categories: cats });
    expect(parseCategoriesFile(text).categories.map((c) => c.id)).toEqual(cats.map((c) => c.id));
    expect(parseCategoriesFile('нет').error).toBe('JSON');
    expect(parseCategoriesFile('{"categories": [{"id": "x"}]}').error).toMatch(/x/);
  });
  it('конфигурация: невалидные поля пропускаются, служебные не импортируются', () => {
    const s = { ...defaultSettings(), mode: 'bogus', maxFileSizeMB: 20, panelPosition: { a: 1 } };
    const r = parseConfigFile(JSON.stringify({ kind: 'docx-anonymizer-config', version: 1, settings: s }));
    expect(r.skipped).toEqual(['mode']);
    expect(r.patch.maxFileSizeMB).toBe(20);
    expect('panelPosition' in r.patch).toBe(false);
    expect(parseConfigFile('{}').error).toBe('kind');
  });
});
