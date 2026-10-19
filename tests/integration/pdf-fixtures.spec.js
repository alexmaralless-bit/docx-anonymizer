// PDF-фикстуры (версия 0.3, К1): ≥ 6 текстовых PDF из синтетических договоров (Chromium Playwright, LibreOffice) с gold
// и снимками разметки; сверка извлечения закоммиченных PDF со снимком и, если есть Chromium, — регенерации со снимком.
// Байты PDF недетерминированы (дата, шрифты), поэтому сравнивается извлечённый Markdown, а не байты.
// Снимки обновляет только `npm run gen-pdf-fixtures -- --update-snapshots` (или `--snapshots-only` после правки разметки).
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { buildFixtures } from '../../scripts/gen-fixtures.mjs';
import { buildSampleDocx } from '../../scripts/make-sample.mjs';
import { buildPdfFixtures, layoutSnapshot, PDF_FIXTURES_DIR, perfDocument } from '../../scripts/gen-pdf-fixtures.mjs';
import { isPdf } from '../../src/core/pdf/extract.js';

const DIR = PDF_FIXTURES_DIR;
const TEXT_PDFS = readdirSync(DIR)
  .filter((f) => f.endsWith('.pdf') && existsSync(join(DIR, f.replace(/\.pdf$/, '.txt'))))
  .map((f) => f.slice(0, -4))
  .sort();
const CHROMIUM =
  !process.env.SKIP_PDF_REGEN &&
  (() => {
    try {
      return existsSync(chromium.executablePath());
    } catch {
      return false;
    }
  })();

describe('PDF-фикстуры (К1)', () => {
  it('≥ 6 текстовых PDF со снимком и gold, нужные виды документов на месте', () => {
    expect(TEXT_PDFS.length).toBeGreaterThanOrEqual(6);
    for (const n of TEXT_PDFS) expect(existsSync(join(DIR, `${n}.gold.json`)), n).toBe(true);
    // таблица реквизитов и колонтитулы, две колонки, список, английский договор, LibreOffice, 50 страниц
    for (const n of ['ip-contract', 'two-companies', 'english-contract', 'structures', 'third-persons', 'sample-contract', 'perf-50p', 'mixed']) {
      expect(TEXT_PDFS, n).toContain(n);
    }
    // отказы: скан, пустой, с паролем
    for (const n of ['scan', 'empty']) expect(existsSync(join(DIR, `${n}.pdf`)), n).toBe(true);
    for (const f of readdirSync(DIR).filter((x) => x.endsWith('.pdf'))) expect(isPdf(new Uint8Array(readFileSync(join(DIR, f)))), f).toBe(true);
  });

  it('gold PDF-фикстур совпадает с генераторами DOCX (scripts/gen-fixtures.mjs, make-sample.mjs)', () => {
    const docs = Object.fromEntries(buildFixtures().map((f) => [f.name, f.gold]));
    for (const n of TEXT_PDFS) {
      const gold = JSON.parse(readFileSync(join(DIR, `${n}.gold.json`), 'utf8'));
      const base = n.replace(/\.lo$/, '').replace(/^mixed$/, 'ip-contract');
      if (docs[base]) expect(gold, n).toEqual(docs[base]);
      else if (n === 'sample-contract') expect(gold.map((g) => g.value)).toEqual(Object.values(buildSampleDocx().gold));
      else if (n === 'perf-50p') expect(gold).toEqual(perfDocument().gold);
    }
  });

  for (const n of TEXT_PDFS) {
    it(`${n}: извлечение закоммиченного PDF = снимок разметки`, async () => {
      const snap = readFileSync(join(DIR, `${n}.txt`), 'utf8');
      expect(await layoutSnapshot(new Uint8Array(readFileSync(join(DIR, `${n}.pdf`))))).toBe(snap);
    }, 30000);
  }

  it.skipIf(!CHROMIUM)(
    'регенерация через Chromium даёт ту же разметку',
    async () => {
      const fresh = await buildPdfFixtures({ libreOffice: false, only: TEXT_PDFS.filter((n) => !n.endsWith('.lo')) });
      expect(fresh.length).toBeGreaterThanOrEqual(6);
      for (const f of fresh.filter((x) => x.kind === 'text' || x.kind === 'mixed')) {
        expect(await layoutSnapshot(f.bytes), f.name).toBe(readFileSync(join(DIR, `${f.name}.txt`), 'utf8'));
      }
    },
    180000,
  );
});
