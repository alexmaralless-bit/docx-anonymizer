#!/usr/bin/env node
// Отчёт по корпусу жанров (версия 0.4, Ц4, К5–К7, `docs/contracts.md` §8.4): по жанру × категории × режиму — точность,
// полнота, число ложных. Режимы: `normal` — настройки по умолчанию (названия организаций не маскируются), `commercial` —
// с включённой коммерческой группой. Документы — tests/fixtures/genres/<жанр>/<имя>.{docx,pdf} с gold (scripts/gen-genre-fixtures.mjs);
// PDF извлекается тем же ядром, что в расширении (pdf.js в Node, tests/integration/support/pdf.js).
// Сравнение — по множествам (категория, нормализованное значение вхождения), как `keyset` в tests/integration/pdf-pipeline.spec.js.
// Дополнительно: утечки pii/ids (gold-значение осталось в результате applyDecisions), отрицательные примеры, ставшие сущностью,
// число COMPANY в обычном режиме, полнота организаций с ОПФ.
//
//   npm run eval-genres [-- --model=<каталог модели>] [--json] [--private] [--verbose] [--format=docx|pdf]
//   NER_MODEL_DIR=models-src/rubert-tiny2-ner-ruen npm run eval-genres
//   PRIVATE_FIXTURES=1 npm run eval-genres   — плюс tests/fixtures/private/*.{pdf,docx} (только счётчики, без значений)
//
// Значения документов печатаются только с --verbose и только для синтетического корпуса; по private/ — никогда.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  parseDocx,
  fromText,
  analyze,
  applyDecisions,
  defaultSettings,
  registerBuiltinDetectors,
  findOccurrences,
  normalizeValue,
  BUILTIN_CATEGORIES,
} from '../src/core/index.js';
import { getDetectors } from '../src/core/contracts/detector.js';
import { CATEGORY_GROUPS } from '../src/core/categories.js';
import { extractPdfNode } from '../tests/integration/support/pdf.js';
import { findLeaks } from '../tests/integration/support/pipeline.js';
import { unzipText } from '../tests/helpers/docx.js';
import { unescapeXml } from '../src/core/docx/xml.js';
import { lowerE } from '../src/core/detect/names/lexicon.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const GENRES_DIR = join(root, 'tests/fixtures/genres');
export const PRIVATE_DIR = join(root, 'tests/fixtures/private');
export const MODE_NAMES = ['normal', 'commercial'];
const CAT = new Map(BUILTIN_CATEGORIES.map((c) => [c.id, c]));
const COMMERCIAL = new Set(CATEGORY_GROUPS.commercial);
const ALWAYS = new Set([...CATEGORY_GROUPS.pii, ...CATEGORY_GROUPS.ids]);

/** Настройки режима: обычный — по умолчанию (0.4), коммерческий — с группой `commercial`. */
export function modeSettings(mode) {
  const s = defaultSettings();
  return mode === 'commercial' ? { ...s, commercial: true } : s;
}

/** Родовое слово перед названием («Студия Лунопарк», «СТУДИЯ ЛУНОПАРК» от модели) — организация сравнивается по ядру. */
const GENERIC_ORG_RE = /^(?:студия|агентство|бюро|компания|группа компаний|холдинг|гк)\s+(?=\p{Lu})/iu;
const keyOf = (category, value) => `${category}\u0000${normalizeValue(CAT.get(category), category === 'COMPANY' ? value.replace(GENERIC_ORG_RE, '') : value)}`;
const norm = (s) =>
  s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[\u00a0\s]+/g, ' ')
    .trim();

/** Текст результата: .anon.md или все XML-части DOCX без разметки. */
function resultText(doc, bytes) {
  if (doc.kind === 'text') return new TextDecoder().decode(bytes);
  return Object.entries(unzipText(bytes))
    .filter(([n]) => /\.(xml|rels)$/.test(n))
    .map(([, xml]) => unescapeXml(xml.replace(/<[^>]+>/g, ' ')))
    .join('\n');
}

/** Части адреса, которые выдают его без остального: индекс (6 цифр) и «д./кв./офис/оф./стр./корп. N». */
const ADDRESS_PART_RE = /(?<![\p{L}])(?:д|кв|офис|оф|стр|корп|пом)\.?[\s\u00a0]*\d+[а-я]?(?![\d\p{L}])/giu;
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Частичные утечки (как `partialLeaks` в tests/integration/pdf-pipeline.spec.js): фамилия gold-ФИО целым словом
 * (поле `surname` gold); номер pii/ids из ≥ 9 цифр, в том числе разорванный пробелом, дефисом или переносом; у адреса —
 * индекс или номер дома/квартиры/офиса из gold-адреса; у почты — «имя@первая часть домена» (адрес, разорванный переносом).
 * @returns {(object & {part?: string})[]} сущности gold с частичной утечкой; `part` — что именно осталось (для отчёта)
 */
export function partialLeaks(entities, text) {
  const words = new Set((lowerE(text).match(/\p{L}+/gu) || []).filter((w) => w.length >= 3));
  const digits = text.replace(/(?<=\d)[\s\-\u2010\u2011\u00AD]+(?=\d)/g, '');
  const low = lowerE(text);
  const out = [];
  for (const e of entities) {
    if (e.category === 'PERSON') {
      if (e.surname && words.has(lowerE(e.surname))) out.push({ ...e, part: 'surname' });
    } else if (e.category === 'ADDRESS') {
      const zip = /(?<!\d)\d{6}(?!\d)/.exec(e.value)?.[0];
      if (zip && new RegExp(`(?<!\\d)${zip}(?!\\d)`).test(text)) out.push({ ...e, part: 'zip' });
      else {
        const parts = [...e.value.matchAll(ADDRESS_PART_RE)].map((m) => m[0]);
        const hit = parts.find((x) => {
          const [, w, n] = /^(\p{L}+)\.?[\s\u00a0]*(\S+)$/u.exec(x) || [];
          return w && new RegExp(`(?<![\\p{L}])${esc(lowerE(w))}\\.?[\\s\\u00a0]*${esc(n)}(?![\\d\\p{L}])`, 'u').test(low);
        });
        if (hit) out.push({ ...e, part: 'house' });
      }
    } else if (e.category === 'EMAIL') {
      const [local, domain = ''] = lowerE(e.value).split('@');
      const head = `${local}@${domain.split(/[.-]/)[0]}`;
      if (domain && low.includes(head)) out.push({ ...e, part: 'email' });
    } else if (e.category !== 'PHONE') {
      const num = e.value.replace(/\D/g, '');
      if (num.length >= 9 && new RegExp(`(?<!\\d)${num}(?!\\d)`).test(digits)) out.push({ ...e, part: 'number' });
    }
  }
  return out;
}

/**
 * Документы корпуса: по каждому gold — DOCX и PDF, какие есть.
 * @param {string} [dir]
 * @returns {{genre: string, name: string, format: 'docx'|'pdf', path: string, gold: any}[]}
 */
export function listCorpus(dir = GENRES_DIR) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const genre of readdirSync(dir).sort()) {
    const gdir = join(dir, genre);
    for (const f of readdirSync(gdir)
      .filter((x) => x.endsWith('.gold.json'))
      .sort()) {
      const name = f.slice(0, -'.gold.json'.length);
      const gold = JSON.parse(readFileSync(join(gdir, f), 'utf8'));
      for (const format of /** @type {const} */ (['docx', 'pdf'])) {
        const path = join(gdir, `${name}.${format}`);
        if (existsSync(path)) out.push({ genre, name, format, path, gold });
      }
    }
  }
  return out;
}

/** Файл → DocModel (DOCX — parseDocx, PDF — извлечение и разметка ядра, затем fromText). */
export async function loadDoc(path) {
  const bytes = new Uint8Array(readFileSync(path));
  if (path.endsWith('.pdf')) {
    const layout = await extractPdfNode(bytes);
    return fromText(layout.blocks, { name: basename(path), size: bytes.length });
  }
  return parseDocx(bytes);
}

/**
 * ONNX-провайдер NER из каталога модели (как scripts/bench-ner.mjs и tests/integration/ner-provider.spec.js) или null.
 * @param {string} [dir]
 */
export async function loadNerProvider(dir) {
  if (!dir || !existsSync(dir)) return null;
  const { loadOrt, dirFiles } = await import('./bench-ner.mjs');
  const { createOnnxNerProvider } = await import('../src/core/ner/onnx-provider.js');
  const files = dirFiles(dir);
  const manifest = files.manifest();
  const provider = createOnnxNerProvider({ files, ort: await loadOrt(), modelId: manifest.id });
  await provider.init();
  return Object.assign(provider, { label: `${manifest.id}@${manifest.version}` });
}

/** Ключи (категория, нормализованное ядро вхождения) по всем группам анализа. */
function foundKeys(groups) {
  const s = new Map();
  for (const g of groups)
    for (const o of g.occurrences) {
      const core = o.text.slice(o.keepPrefix, o.text.length - o.keepSuffix);
      s.set(keyOf(g.category, core), { category: g.category, value: core });
    }
  return s;
}

/**
 * Оценка одного документа в одном режиме.
 * @param {any} doc DocModel
 * @param {{entities: {key: string, category: string, value: string, opf?: boolean}[], negatives?: {value: string, category: string, mode?: string}[]}} gold
 * @param {'normal'|'commercial'} mode
 * @param {{nerProvider?: any}} [opts]
 */
export async function evaluateDoc(doc, gold, mode, opts = {}) {
  if (!getDetectors().length) registerBuiltinDetectors();
  const settings = modeSettings(mode);
  const analysis = await analyze(doc, settings, { nerProvider: opts.nerProvider || undefined });
  // meta — значение только в свойствах DOCX (автор): в PDF его нет
  const expected = gold.entities.filter((e) => (mode === 'commercial' || !COMMERCIAL.has(e.category)) && !(e.meta && doc.kind === 'text'));
  const want = new Map(expected.map((e) => [keyOf(e.category, e.value), e]));
  const got = foundKeys(analysis.groups);
  /** @type {Record<string, {tp: number, fp: number, fn: number}>} */
  const perCat = {};
  const cell = (c) => (perCat[c] ||= { tp: 0, fp: 0, fn: 0 });
  const fpList = [];
  const fnList = [];
  for (const [k, e] of want) {
    if (got.has(k)) cell(e.category).tp++;
    else {
      cell(e.category).fn++;
      fnList.push(e);
    }
  }
  for (const [k, f] of got) {
    if (want.has(k)) continue;
    cell(f.category).fp++;
    fpList.push(f);
  }
  // организации с ОПФ (коммерческий режим): полнота отдельно
  const opf = { tp: 0, fn: 0 };
  if (mode === 'commercial') for (const e of expected) if (e.category === 'COMPANY' && e.opf) got.has(keyOf(e.category, e.value)) ? opf.tp++ : opf.fn++;
  // утечки pii/ids: gold-значение осталось в результате (DOCX — в любой XML-части, PDF — в тексте .anon.md)
  const res = applyDecisions(doc, analysis.groups, { mode: 'placeholder', placeholderLanguage: 'ru', textFormat: 'md' });
  const secret = expected.filter((e) => ALWAYS.has(e.category));
  const outText = resultText(doc, res.bytes);
  const out = norm(outText);
  let leaks;
  if (doc.kind === 'text') leaks = secret.filter((e) => out.includes(norm(e.value)));
  else {
    const hit = new Set(
      findLeaks(
        res.bytes,
        secret.map((e) => e.value),
      ).map((x) => x.replace(/ @ .*$/, '')),
    );
    leaks = secret.filter((e) => hit.has(e.value));
  }
  const partial = partialLeaks(secret, outText).filter((e) => !leaks.some((l) => l.key === e.key));
  // отрицательные примеры: ни одна сущность не пересекает их вхождения
  const negHits = [];
  for (const n of gold.negatives || []) {
    if (n.mode && n.mode !== mode) continue;
    const occ = findOccurrences(doc, n.value);
    const hit = analysis.entities.some((e) => occ.some((o) => o.streamId === e.streamId && e.start < o.end && o.start < e.end));
    if (hit) negHits.push(n);
  }
  const companies = analysis.groups.filter((g) => g.category === 'COMPANY');
  return {
    perCat,
    opf,
    leaks,
    partial,
    negHits,
    fpList,
    fnList,
    companyCount: companies.length,
    companyNonList: companies.filter((g) => g.source !== 'list').length,
    warnings: analysis.warnings.map((w) => w.code),
  };
}

/**
 * Прогон корпуса в обоих режимах.
 * @param {{dir?: string, nerProvider?: any, modes?: string[], formats?: string[]}} [o]
 */
export async function evaluateCorpus(o = {}) {
  const items = listCorpus(o.dir).filter((x) => !o.formats || o.formats.includes(x.format));
  const docs = [];
  for (const it of items) {
    const doc = await loadDoc(it.path);
    for (const mode of o.modes || MODE_NAMES) {
      const r = await evaluateDoc(doc, it.gold, /** @type {any} */ (mode), { nerProvider: o.nerProvider });
      docs.push({ ...it, mode, ...r });
    }
  }
  return { docs, summary: summarize(docs) };
}

/** Сводка: режим → жанр → категория → {tp, fp, fn, precision, recall}; плюс полнота ОПФ и счётчики проверок. */
export function summarize(docs) {
  const out = {};
  for (const d of docs) {
    const m = (out[d.mode] ||= {});
    const g = (m[d.genre] ||= { cats: {}, opf: { tp: 0, fn: 0 }, leaks: 0, addrLeaks: 0, negHits: 0, companies: 0, docs: 0 });
    g.docs++;
    g.leaks += d.leaks.length + d.partial.length;
    g.addrLeaks += d.partial.filter((e) => e.category === 'ADDRESS').length;
    g.negHits += d.negHits.length;
    g.companies += d.companyNonList;
    g.opf.tp += d.opf.tp;
    g.opf.fn += d.opf.fn;
    for (const [c, v] of Object.entries(d.perCat)) {
      const x = (g.cats[c] ||= { tp: 0, fp: 0, fn: 0 });
      x.tp += v.tp;
      x.fp += v.fp;
      x.fn += v.fn;
    }
  }
  for (const m of Object.values(out))
    for (const g of Object.values(m))
      for (const x of Object.values(g.cats)) {
        x.precision = x.tp + x.fp ? x.tp / (x.tp + x.fp) : 1;
        x.recall = x.tp + x.fn ? x.tp / (x.tp + x.fn) : 1;
      }
  return out;
}

/** Метрики одной категории по жанру и режиму (для гейтов genres.spec.js). */
export function catMetrics(summary, mode, genre, category) {
  return summary[mode]?.[genre]?.cats[category] || { tp: 0, fp: 0, fn: 0, precision: 1, recall: 1 };
}

const f3 = (x) => x.toFixed(2);
/** Таблица отчёта: строка — жанр, столбцы — категории (P/R/ложные), затем проверки. */
export function formatReport(summary) {
  const lines = [];
  for (const [mode, genres] of Object.entries(summary)) {
    lines.push(`\nРежим ${mode === 'normal' ? 'normal (по умолчанию)' : 'commercial (коммерческая группа включена)'}`);
    const cats = [...new Set(Object.values(genres).flatMap((g) => Object.keys(g.cats)))].sort();
    const head = ['жанр'.padEnd(15), ...cats.map((c) => c.padEnd(16)), 'утечки', 'адр.ч.', 'негат.', 'COMPANY', 'ОПФ R'];
    lines.push(head.join(' '));
    const total = { cats: {}, leaks: 0, addrLeaks: 0, negHits: 0, companies: 0, opf: { tp: 0, fn: 0 } };
    for (const [genre, g] of Object.entries(genres).sort()) {
      const row = [genre.padEnd(15)];
      for (const c of cats) {
        const x = g.cats[c];
        row.push((x ? `${f3(x.precision)}/${f3(x.recall)}/${x.fp}` : '—').padEnd(16));
        if (x) {
          const t = (total.cats[c] ||= { tp: 0, fp: 0, fn: 0 });
          t.tp += x.tp;
          t.fp += x.fp;
          t.fn += x.fn;
        }
      }
      total.leaks += g.leaks;
      total.addrLeaks += g.addrLeaks;
      total.negHits += g.negHits;
      total.companies += g.companies;
      total.opf.tp += g.opf.tp;
      total.opf.fn += g.opf.fn;
      const opfN = g.opf.tp + g.opf.fn;
      row.push(
        String(g.leaks).padEnd(6),
        String(g.addrLeaks).padEnd(6),
        String(g.negHits).padEnd(6),
        String(g.companies).padEnd(7),
        opfN ? f3(g.opf.tp / opfN) : '—',
      );
      lines.push(row.join(' '));
    }
    const row = ['итого'.padEnd(15)];
    for (const c of cats) {
      const t = total.cats[c];
      const P = t.tp + t.fp ? t.tp / (t.tp + t.fp) : 1;
      const R = t.tp + t.fn ? t.tp / (t.tp + t.fn) : 1;
      row.push(`${f3(P)}/${f3(R)}/${t.fp}`.padEnd(16));
    }
    const opfN = total.opf.tp + total.opf.fn;
    row.push(
      String(total.leaks).padEnd(6),
      String(total.addrLeaks).padEnd(6),
      String(total.negHits).padEnd(6),
      String(total.companies).padEnd(7),
      opfN ? f3(total.opf.tp / opfN) : '—',
    );
    lines.push(row.join(' '));
  }
  lines.push(
    '\nЯчейка: точность/полнота/ложные; «утечки» — gold pii/ids в результате (целиком или частью: фамилия, номер, индекс/дом адреса, начало почты), «адр.ч.» — из них частичные адресов; «негат.» — отрицательные примеры, ставшие сущностью;',
  );
  lines.push('«COMPANY» — найдено организаций не из списка компаний; «ОПФ R» — полнота организаций с ОПФ (коммерческий режим).');
  return lines.join('\n');
}

/**
 * Настоящие документы владельца (tests/fixtures/private, в .gitignore): только счётчики по категориям, без значений.
 * Необязательный `<имя>.gold.json` того же формата — тогда ещё точность/полнота по категориям.
 * @param {{dir?: string, nerProvider?: any}} [o]
 */
export async function evaluatePrivate(o = {}) {
  const dir = o.dir || PRIVATE_DIR;
  const out = [];
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)
    .filter((x) => /\.(pdf|docx)$/i.test(x))
    .sort()) {
    const path = join(dir, f);
    const goldPath = join(dir, f.replace(/\.(pdf|docx)$/i, '.gold.json'));
    const gold = existsSync(goldPath) ? JSON.parse(readFileSync(goldPath, 'utf8')) : null;
    let doc;
    try {
      doc = await loadDoc(path);
    } catch (err) {
      out.push({ file: `документ ${out.length + 1}`, error: /** @type {any} */ (err)?.code || 'LOAD_FAILED' });
      continue;
    }
    const entry = { file: `документ ${out.length + 1} (${f.split('.').pop()})`, modes: {} };
    for (const mode of MODE_NAMES) {
      const analysis = await analyze(doc, modeSettings(mode), { nerProvider: o.nerProvider || undefined });
      const counts = {};
      for (const g of analysis.groups) counts[g.category] = (counts[g.category] || 0) + 1;
      const m = { counts };
      if (gold) {
        const r = await evaluateDoc(doc, gold, mode, o);
        m.metrics = Object.fromEntries(Object.entries(r.perCat).map(([c, v]) => [c, { tp: v.tp, fp: v.fp, fn: v.fn }]));
        m.leaks = r.leaks.length + r.partial.length;
        m.negHits = r.negHits.length;
      }
      entry.modes[mode] = m;
    }
    out.push(entry);
  }
  return out;
}

async function main() {
  const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const modelDir = arg('model') || process.env.NER_MODEL_DIR;
  const json = process.argv.includes('--json');
  const verbose = process.argv.includes('--verbose');
  const withPrivate = process.argv.includes('--private') || process.env.PRIVATE_FIXTURES === '1';
  const format = arg('format');
  registerBuiltinDetectors();
  const nerProvider = modelDir ? await loadNerProvider(resolve(modelDir)) : null;
  if (modelDir && !nerProvider) console.error(`eval-genres: модель не найдена (${modelDir}) — прогон без NER`);
  const t0 = performance.now();
  const { docs, summary } = await evaluateCorpus({ nerProvider, formats: format ? [format] : undefined });
  const priv = withPrivate ? await evaluatePrivate({ nerProvider }) : null;
  const ms = Math.round(performance.now() - t0);
  nerProvider?.dispose?.();
  if (json) {
    console.log(JSON.stringify({ model: nerProvider?.label || null, documents: docs.length, ms, summary, private: priv }, null, 2));
    return;
  }
  const files = new Set(docs.map((d) => `${d.genre}/${d.name}.${d.format}`)).size;
  console.log(`Корпус жанров: ${files} файлов, модель NER: ${nerProvider?.label || 'нет'}, ${ms} мс`);
  console.log(formatReport(summary));
  if (verbose) {
    for (const d of docs) {
      const bad = [
        ...d.leaks.map((e) => `утечка ${e.category}: ${e.value}`),
        ...d.partial.map((e) => `частичная утечка ${e.category} (${e.part}): ${e.value}`),
        ...d.negHits.map((n) => `отрицательный пример стал сущностью: ${n.value}`),
        ...d.fpList.map((f) => `ложная ${f.category}: ${f.value}`),
        ...d.fnList.map((e) => `пропуск ${e.category}: ${e.value}`),
      ];
      if (bad.length) console.log(`\n${d.mode} ${d.genre}/${d.name}.${d.format}\n  ${bad.join('\n  ')}`);
    }
  }
  if (priv) {
    console.log(`\nНастоящие документы (tests/fixtures/private): ${priv.length}`);
    for (const p of priv) {
      if (p.error) {
        console.log(`  ${p.file}: не открыт (${p.error})`);
        continue;
      }
      for (const [mode, m] of Object.entries(p.modes)) {
        const counts = Object.entries(m.counts)
          .map(([c, n]) => `${c} ${n}`)
          .join(', ');
        const metrics = m.metrics
          ? '; gold: ' +
            Object.entries(m.metrics)
              .map(([c, v]) => `${c} tp ${v.tp} fp ${v.fp} fn ${v.fn}`)
              .join(', ') +
            `; утечки ${m.leaks}`
          : '';
        console.log(`  ${p.file} ${mode}: ${counts || 'ничего не найдено'}${metrics}`);
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`eval-genres: ${e.message}`);
    process.exit(1);
  });
}
