// Конвейер PDF → .anon.md на фикстурах (версия 0.3): К2 (утечки — целиком и частично: фамилии gold-ФИО и номера,
// разорванные дефисом или пробелом), К3 (паритет с DOCX; для «диких» PDF без DOCX — полнота по gold), К4 (порядок,
// колонтитулы, таблица реквизитов; perf-50p — порядок по исходному тексту генератора, полнота строк относительно
// pdftotext — финальная приёмка 0.3), К6 (50 страниц ≤ 8 с), кросс-проверка слов с pdftotext (если установлен).
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { extractPdfNode } from './support/pdf.js';
import { goldEntities } from './support/pipeline.js';
import {
  parseDocx,
  analyze,
  applyDecisions,
  defaultSettings,
  registerBuiltinDetectors,
  clearDetectors,
  fromText,
  normalizeValue,
} from '../../src/core/index.js';
import { buildFixtures } from '../../scripts/gen-fixtures.mjs';
import { buildSampleDocx } from '../../scripts/make-sample.mjs';
import { PDF_FIXTURES_DIR, perfDocument } from '../../scripts/gen-pdf-fixtures.mjs';
import { unescapeXml } from '../../src/core/docx/xml.js';

const DIR = PDF_FIXTURES_DIR;
// коммерческая группа включена (политика 0.4): gold фикстур содержит названия организаций
const SETTINGS = { ...defaultSettings(), nerEnabled: false, commercial: true };
// PDF-фикстура → DOCX-исходник (для паритета и порядка абзацев)
const SOURCES = {
  'ip-contract': 'ip-contract',
  'two-companies': 'two-companies',
  'english-contract': 'english-contract',
  structures: 'structures',
  'third-persons': 'third-persons',
  'sample-contract': 'sample-contract',
  'ip-contract.lo': 'ip-contract',
  'two-companies.lo': 'two-companies',
  'structures.lo': 'structures',
  'sample-contract.lo': 'sample-contract',
  rotated: 'ip-contract',
  mixed: 'ip-contract',
};
// LibreOffice рисует исправления (удалённый и вставленный текст подряд) и сноски в теле страницы — абзацы PDF не
// сопоставляются с живым текстом DOCX по вхождению, поэтому порядок (К4) для них не меряется; К2 и К3 — меряются.
const NO_ORDER = new Set(['structures.lo', 'sample-contract.lo']);
// «Дикие» PDF (ревью WP10-A): другой шрифт и кегль, альбом, колонки — без DOCX-исходника, К3 по gold
const WILD = ['wild-mono', 'wild-landscape', 'wild-2col'];
const LEAK_FIXTURES = [...Object.keys(SOURCES), 'perf-50p', ...WILD];
const HEADERS =
  /Договор оказания услуг № 5\/ИП-2026$|— Договор транспортной экспедиции № 88$|— Services Agreement$|— Договор № 3$|— Договор № 12\/К$|— Договор поставки № 17\/ПС-2026$|^Договор подряда № 50\/П-2026$/;
const PDFTOTEXT = spawnSync('pdftotext', ['-v']).status === 0;

const norm = (s) =>
  s
    .toLowerCase()
    .replace(/[\u00A0\s]+/g, ' ')
    .trim();
const paraNorm = (s) =>
  s
    .replace(/\uFFFC/g, '')
    .replace(/[\u00a0\s]+/g, ' ')
    .replace(/ ([.,;:])/g, '$1')
    .trim();
const pdfBytes = (n) => new Uint8Array(readFileSync(join(DIR, `${n}.pdf`)));
const gold = (n) => JSON.parse(readFileSync(join(DIR, `${n}.gold.json`), 'utf8'));
let docx;

/** Абзацы document.xml генератора (perfDocument) — исходный текст perf-50p по порядку, gold для К4. */
function xmlParagraphs(xml) {
  return [...xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)]
    .map((m) => paraNorm([...m[1].matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((t) => unescapeXml(t[1])).join('')))
    .filter(Boolean);
}

/** Блоки текста (абзацы, заголовки, пункты), сопоставленные по порядку с абзацами исходника: доля упорядоченных. */
function orderedShare(paras, blocks) {
  // каждому блоку — абзац исходника, который его содержит или содержится в нём; индексы должны идти по порядку
  let cursor = 0;
  let ordered = 0;
  for (const t of blocks) {
    const idx = paras.findIndex((p, i) => i >= cursor && (p === t || p.includes(t) || t.includes(p)));
    if (idx >= 0) {
      ordered++;
      cursor = idx;
    }
  }
  return ordered / blocks.length;
}

/** Множество (категория, нормализованное значение вхождения) — по основному тексту документа. */
function keyset(groups, pred) {
  const s = new Set();
  for (const g of groups)
    for (const o of g.occurrences)
      if (pred(o)) s.add(`${g.category}\u0000${normalizeValue(g.category, o.text.slice(o.keepPrefix, o.text.length - o.keepSuffix))}`);
  return s;
}

async function pdfPipeline(n, { injectGold = false, textFormat = 'md' } = {}) {
  const layout = await extractPdfNode(pdfBytes(n));
  const doc = fromText(layout.blocks, { name: `${n}.pdf` });
  const userEntities = injectGold ? goldEntities(doc, gold(n)) : undefined;
  const analysis = await analyze(doc, SETTINGS, { userEntities });
  const r = applyDecisions(doc, analysis.groups, { textFormat, placeholderLanguage: 'ru' });
  return { layout, doc, analysis, text: new TextDecoder().decode(r.bytes), r };
}

beforeAll(() => {
  clearDetectors();
  registerBuiltinDetectors();
  docx = Object.fromEntries([...buildFixtures().map((f) => [f.name, f.bytes]), ['sample-contract', buildSampleDocx().bytes]]);
});

/**
 * Частичные утечки: фамилия любого gold-ФИО целым словом (без учёта регистра) и номера из ≥ 9 цифр, в том числе
 * разорванные в тексте дефисом, знаком переноса или пробелом («ИНН 7805-003215» — мягкий перенос LibreOffice).
 * Фамилия — первое слово русского ФИО («Иванов Пётр Сергеевич», «Иванова П.С.»), последнее — латинского («John Smith»).
 * @returns {string[]} ключи gold с утечкой
 */
function partialLeaks(goldList, text) {
  const words = new Set(
    (
      text
        .toLowerCase()
        .replace(/ё/g, 'е')
        .match(/\p{L}+/gu) || []
    ).filter((w) => w.length >= 3),
  );
  const digits = text.replace(/(?<=\d)[\s\-\u2010\u2011\u00AD]+(?=\d)/g, '');
  const leaks = [];
  for (const g of goldList) {
    if (g.category === 'PERSON') {
      const toks = g.value.split(/\s+/).filter((t) => /^\p{L}{3,}$/u.test(t));
      const surname = /^\p{Script=Latin}/u.test(g.value) ? toks[toks.length - 1] : toks[0];
      if (surname && words.has(surname.toLowerCase().replace(/ё/g, 'е'))) leaks.push(`${g.key}~${g.category}`);
    }
    const num = g.value.replace(/\D/g, '');
    if (['INN', 'KPP', 'OGRN', 'OGRNIP', 'BIK', 'ACCOUNT', 'SNILS', 'PASSPORT'].includes(g.category) && num.length >= 9) {
      if (new RegExp(`(?<!\\d)${num}(?!\\d)`).test(digits)) leaks.push(`${g.key}~${g.category}`);
    }
  }
  return leaks;
}

describe('К2: в .anon.md нет ни одного gold-значения — ни целиком, ни частью', () => {
  for (const n of LEAK_FIXTURES) {
    it(`${n}: только детекторы`, async () => {
      const { text } = await pdfPipeline(n);
      const out = norm(text);
      expect(
        gold(n)
          .filter((g) => out.includes(norm(g.value)))
          .map((g) => g.key),
      ).toEqual([]);
      expect(partialLeaks(gold(n), text), 'частичные утечки').toEqual([]);
      expect(text).toMatch(/\[[A-ZА-ЯЁ_]+_\d+\]/u);
    }, 30000);
  }
  it('проверка частичных утечек ловит фамилию и ИНН, разорванный дефисом', () => {
    const g = [
      { key: 'p', category: 'PERSON', value: 'Тихонов Борис Львович' },
      { key: 'i', category: 'INN', value: '7805003215' },
      { key: 'e', category: 'PERSON', value: 'John Smith' },
    ];
    expect(partialLeaks(g, 'директор [ФИО_1], ИНН [ИНН_1]; [PERSON_1]')).toEqual([]);
    expect(partialLeaks(g, 'подписал ТИХОНОВ, ИНН 7805-003215, Mr. Smith')).toEqual(['p~PERSON', 'i~INN', 'e~PERSON']);
    expect(partialLeaks(g, 'ИНН 7805 003215')).toEqual(['i~INN']);
  });
  it('с gold как пользовательскими сущностями (конвейерная часть) — и в .txt', async () => {
    for (const n of ['ip-contract', 'structures', 'sample-contract']) {
      const { text } = await pdfPipeline(n, { injectGold: true, textFormat: 'txt' });
      const out = norm(text);
      expect(
        gold(n)
          .filter((g) => out.includes(norm(g.value)))
          .map((g) => g.key),
        n,
      ).toEqual([]);
    }
  }, 30000);
});

describe('К3: паритет с DOCX (детекторы без gold)', () => {
  it('≥ 95 % сущностей основного текста DOCX найдены и в PDF, по каждой фикстуре', async () => {
    const byCat = {};
    for (const [n, src] of Object.entries(SOURCES)) {
      const dd = parseDocx(docx[src]);
      const da = await analyze(dd, SETTINGS);
      const want = keyset(da.groups, (o) => o.part === 'word/document.xml' && dd.streamById.get(o.streamId).type === 'live');
      const { analysis } = await pdfPipeline(n);
      const got = keyset(analysis.groups, (o) => o.part === 'word/document.xml');
      const hit = [...want].filter((k) => got.has(k));
      for (const k of want) {
        const cat = k.split('\u0000')[0];
        byCat[cat] ||= { docx: 0, pdf: 0 };
        byCat[cat].docx++;
        if (got.has(k)) byCat[cat].pdf++;
      }
      expect(hit.length / want.size, `${n}: ${[...want].filter((k) => !got.has(k)).map((k) => k.split('\u0000')[0])}`).toBeGreaterThanOrEqual(0.95);
    }
    const table = Object.fromEntries(Object.entries(byCat).map(([c, v]) => [c, { ...v, recall: +(v.pdf / v.docx).toFixed(3) }]));
    console.table(table);
  }, 60000);

  it('«дикие» PDF без DOCX: ≥ 95 % gold-значений найдены детекторами', async () => {
    const key = (s) =>
      s
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[^\p{L}\p{N}]/gu, '');
    for (const n of WILD) {
      const { analysis } = await pdfPipeline(n);
      const found = new Set(analysis.groups.flatMap((g) => g.occurrences.map((o) => key(o.text.slice(o.keepPrefix, o.text.length - o.keepSuffix)))));
      const list = gold(n);
      const miss = list.filter((g) => !found.has(key(g.value))).map((g) => `${g.key}:${g.category}`);
      console.log(`${n}: gold ${list.length - miss.length}/${list.length}`);
      expect((list.length - miss.length) / list.length, `${n}: ${miss}`).toBeGreaterThanOrEqual(0.95);
    }
  }, 60000);
});

describe('К4: разметка', () => {
  it('порядок абзацев совпадает с DOCX, колонтитулы и номера страниц не попадают в текст', async () => {
    for (const [n, src] of Object.entries(SOURCES).filter(([x]) => !NO_ORDER.has(x))) {
      const { layout } = await pdfPipeline(n);
      const dd = parseDocx(docx[src]);
      const paras = dd.paragraphs
        .filter((p) => p.part === 'word/document.xml' && p.streams.live)
        .map((p) => paraNorm(dd.streamById.get(p.streams.live).text))
        .filter(Boolean);
      const blocks = layout.blocks.filter((b) => ['p', 'h1', 'h2', 'li'].includes(b.kind)).map((b) => paraNorm(b.text));
      expect(orderedShare(paras, blocks), n).toBeGreaterThanOrEqual(0.98);
      for (const b of layout.blocks.filter((x) => !['header', 'footer'].includes(x.kind))) {
        expect(HEADERS.test(b.text), `${n}: колонтитул в тексте: ${b.kind}`).toBe(false);
        expect(/^Страница \d+ из \d+$/.test(b.text), `${n}: номер страницы`).toBe(false);
      }
    }
  }, 60000);

  it('perf-50p: абзацы по порядку исходного текста генератора, ни один абзац и заголовок раздела не потерян', async () => {
    // Финальная приёмка 0.3: эвристика колонтитулов удаляла из тела повторяющиеся строки с цифрами («(ИНН …), который
    // согласует…»), «обязательств по настоящему договору.» и заголовки разделов 13, 26, 39 в нижней полосе.
    const { layout } = await pdfPipeline('perf-50p');
    const paras = xmlParagraphs(perfDocument().xml);
    const blocks = layout.blocks.filter((b) => ['p', 'h1', 'h2', 'li'].includes(b.kind)).map((b) => paraNorm(b.text));
    expect(orderedShare(paras, blocks)).toBe(1);
    // каждый абзац исходника — ровно один блок (не склеен с соседним и не обрезан)
    expect(blocks).toEqual(paras);
    expect(layout.blocks.filter((b) => b.kind === 'header').map((b) => b.text)).toEqual(['Договор подряда № 50/П-2026']);
    expect(layout.blocks.filter((b) => b.kind === 'footer')).toEqual([]);
  }, 30000);

  it('таблица реквизитов ip-contract: ≥ 7 строк × 2 колонки с текстами ячеек DOCX (Chromium и LibreOffice)', async () => {
    const dd = parseDocx(docx['ip-contract']);
    const paras = new Set(dd.paragraphs.filter((p) => p.streams.live).map((p) => paraNorm(dd.streamById.get(p.streams.live).text)));
    for (const n of ['ip-contract', 'ip-contract.lo']) {
      const { layout, text } = await pdfPipeline(n);
      const cells = layout.blocks.filter((b) => b.kind === 'cell' && b.table.index === 0);
      const rows = new Set(cells.map((c) => c.table.row));
      expect(cells[0].table.cols, n).toBe(2);
      expect(rows.size, n).toBeGreaterThanOrEqual(7);
      for (const c of cells.filter((x) => x.text)) expect(paras.has(paraNorm(c.text)), `${n}: ${c.table.row}/${c.table.col}`).toBe(true);
      expect(text).toMatch(/^\| \[КОМПАНИЯ_\d+\]|^\| Исполнитель \| Заказчик \|$/m);
      expect(text).toMatch(/^\| --- \| --- \|$/m);
    }
  }, 30000);

  it('колонтитулы фикстур Chromium распознаны и вынесены в отдельную часть', async () => {
    const { layout, doc } = await pdfPipeline('ip-contract');
    expect(layout.blocks.filter((b) => b.kind === 'header').map((b) => b.text)).toEqual(['ООО «Лунный свет» — Договор оказания услуг № 5/ИП-2026']);
    expect(doc.streams.find((s) => s.part === 'word/header1.xml')).toBeTruthy();
    const many = await pdfPipeline('structures');
    expect(many.layout.blocks.filter((b) => b.kind === 'header')).toHaveLength(1);
    expect(many.layout.blocks.filter((b) => b.kind === 'hr').length).toBeGreaterThanOrEqual(39);
  }, 30000);
});

describe('К6: производительность', () => {
  it('perf-50p: извлечение + разметка + анализ (без NER) ≤ 8 000 мс', async () => {
    const t0 = performance.now();
    const layout = await extractPdfNode(pdfBytes('perf-50p'));
    const t1 = performance.now();
    const analysis = await analyze(fromText(layout.blocks), SETTINGS);
    const t2 = performance.now();
    const words = layout.blocks.reduce((n, b) => n + b.text.split(/\s+/).filter(Boolean).length, 0);
    console.log(`perf-50p: ${layout.pages} стр., ${words} слов; извлечение+разметка ${(t1 - t0).toFixed(0)} мс, анализ ${(t2 - t1).toFixed(0)} мс`);
    expect(layout.pages).toBeGreaterThanOrEqual(45);
    expect(words).toBeGreaterThanOrEqual(18000);
    expect(analysis.groups.length).toBeGreaterThan(0);
    expect(t2 - t0).toBeLessThanOrEqual(8000);
  }, 60000);
});

describe.skipIf(!PDFTOTEXT)('кросс-проверка с pdftotext -layout', () => {
  it('К4 perf-50p: ≥ 99 % строк pdftotext (с повторами) есть в тексте блоков, кроме колонтитула и номеров страниц', async () => {
    // Строки сравниваются мультимножеством: строка, повторённая на странице k раз, должна встретиться в тексте тела
    // не меньше k раз, — иначе удалённая из тела повторяющаяся строка («обязательств по настоящему договору.») не видна.
    const { layout } = await pdfPipeline('perf-50p');
    const ours = layout.blocks
      .filter((b) => ['p', 'h1', 'h2', 'li', 'cell'].includes(b.kind))
      .map((b) => paraNorm(b.text))
      .join('\n');
    const pt = spawnSync('pdftotext', [join(DIR, 'perf-50p.pdf'), '-'], { encoding: 'utf8' }).stdout;
    const lines = pt
      .split('\n')
      .map((l) => paraNorm(l).replace(/-$/, ''))
      .filter((l) => l && !HEADERS.test(l) && !/^Страница \d+ из \d+$/.test(l));
    const count = new Map();
    for (const l of lines) count.set(l, (count.get(l) || 0) + 1);
    let found = 0;
    const missing = [];
    for (const [l, c] of count) {
      const o = ours.split(l).length - 1;
      found += Math.min(c, o);
      if (o < c) missing.push(`${c - o}× ${l.slice(0, 40)}`);
    }
    console.log(`perf-50p: строк pdftotext ${lines.length}, найдено ${found}`);
    expect(lines.length).toBeGreaterThan(1500);
    expect(found / lines.length, missing.slice(0, 5).join('; ')).toBeGreaterThanOrEqual(0.99);
  }, 30000);

  it('Jaccard слов основного текста ≥ 0.97', async () => {
    const words = (s) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
    for (const n of LEAK_FIXTURES) {
      const { doc } = await pdfPipeline(n);
      const ours = words(doc.streams.map((s) => s.text).join('\n'));
      const pt = spawnSync('pdftotext', ['-layout', join(DIR, `${n}.pdf`), '-'], { encoding: 'utf8' });
      const theirs = words(pt.stdout.replace(/Страница \d+ из \d+/g, ''));
      const inter = [...ours].filter((w) => theirs.has(w)).length;
      expect(inter / (ours.size + theirs.size - inter), n).toBeGreaterThanOrEqual(0.97);
    }
  }, 60000);
});
