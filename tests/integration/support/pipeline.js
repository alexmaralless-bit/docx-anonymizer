// Общие функции интеграционных тестов «файл → файл» (WP5).
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocx, analyze, applyDecisions, findOccurrences, readZip, defaultSettings } from '../../../src/core/index.js';
import { unzipText } from '../../helpers/docx.js';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const FIXED = { createdAt: '2026-10-04T00:00:00Z', placeholderLanguage: 'ru' };

/** Gold → «пользовательские» сущности (конвейерная часть, без детекторов WP1/WP2). */
export function goldEntities(doc, gold) {
  const out = [];
  for (const { category, value } of gold) {
    for (const o of findOccurrences(doc, value)) out.push({ ...o, category, confidence: 'labeled' });
  }
  return out;
}

/** @param {{name?: string, gold?: {category: string, value: string}[], settings?: object, apply?: object}} [opts] без gold — только детекторы */
export async function anonymize(bytes, opts = {}) {
  const doc = parseDocx(bytes);
  const userEntities = opts.gold ? goldEntities(doc, opts.gold) : undefined;
  // коммерческая группа включена (политика 0.4): фикстуры договоров 0.1–0.3 проверяют и названия организаций
  const analysis = await analyze(doc, { ...defaultSettings(), commercial: true, ...(opts.settings || {}) }, { userEntities });
  const res = applyDecisions(doc, analysis.groups, {
    mode: 'placeholder',
    ...FIXED,
    document: { name: opts.name || 'document.docx', sha256: sha256(bytes), resultName: 'document.anon.docx' },
    ...(opts.apply || {}),
  });
  return { doc, analysis, ...res };
}

const stripTags = (xml) => xml.replace(/<[^>]+>/g, '');
const unesc = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/**
 * Утечки: значения gold, оставшиеся в любой XML-части — как есть, в экранированном виде
 * и в тексте без разметки (значение, разбитое ранами). Регистр не учитывается.
 * @returns {string[]} «значение @ часть»
 */
export function findLeaks(docxBytes, values) {
  const leaks = [];
  for (const [name, xml] of Object.entries(unzipText(docxBytes))) {
    if (!/\.(xml|rels)$/.test(name)) continue;
    const hay = [xml, unesc(xml), unesc(stripTags(xml))].map((s) => s.toLowerCase());
    for (const v of values) if (hay.some((h) => h.includes(v.toLowerCase()))) leaks.push(`${v} @ ${name}`);
  }
  return leaks;
}

/** Целостность пакета: каждая часть имеет тип содержимого, каждый Override указывает на существующую часть. */
export function checkPackage(docxBytes) {
  const names = readZip(docxBytes).map((e) => e.name);
  const ct = unzipText(docxBytes)['[Content_Types].xml'];
  const defaults = new Set([...ct.matchAll(/<Default Extension="([^"]+)"/g)].map((m) => m[1].toLowerCase()));
  const overrides = new Set([...ct.matchAll(/<Override PartName="\/([^"]+)"/g)].map((m) => m[1]));
  const problems = [];
  for (const o of overrides) if (!names.includes(o)) problems.push(`Override без части: ${o}`);
  for (const n of names) {
    if (n === '[Content_Types].xml') continue;
    const ext = n.split('.').pop().toLowerCase();
    if (!overrides.has(n) && !defaults.has(ext)) problems.push(`нет типа содержимого: ${n}`);
  }
  // целевые части внутренних связей существуют
  for (const n of names.filter((x) => x.endsWith('.rels'))) {
    const base = n.replace(/_rels\/[^/]*$/, '');
    const xml = unzipText(docxBytes)[n];
    for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
      if (/TargetMode="External"/.test(m[0])) continue;
      const t = /Target="([^"]*)"/.exec(m[0])?.[1];
      if (!t) continue;
      const full = t.startsWith('/') ? t.slice(1) : normalize(base + t);
      if (!names.includes(full)) problems.push(`${n}: нет цели ${t}`);
    }
  }
  return problems;
}

function normalize(path) {
  const out = [];
  for (const seg of path.split('/')) {
    if (seg === '..') out.pop();
    else if (seg && seg !== '.') out.push(seg);
  }
  return out.join('/');
}

export const SOFFICE = ['soffice', 'libreoffice'].find((b) => spawnSync('which', [b]).status === 0);
export const LO_ENABLED = Boolean(SOFFICE) && !process.env.SKIP_LIBREOFFICE;

/**
 * Конвертирует .docx в txt через LibreOffice и возвращает текст.
 * snap-LibreOffice не видит скрытые каталоги и /tmp — пишем в test-output/ репозитория;
 * свой профиль (UserInstallation) — чтобы не конфликтовать с другими запусками soffice.
 */
export function libreOfficeText(docxBytes, name) {
  const dir = join(process.cwd(), 'test-output', 'lo-fixtures');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.docx`);
  const txt = join(dir, `${name}.txt`);
  rmSync(txt, { force: true });
  writeFileSync(file, docxBytes);
  const profile = join(dir, 'profile');
  const res = spawnSync(
    /** @type {string} */ (SOFFICE),
    [`-env:UserInstallation=file://${profile}`, '--headless', '--convert-to', 'txt:Text', file, '--outdir', dir],
    { encoding: 'utf8', timeout: 120000 },
  );
  if (res.status !== 0) throw new Error(`LibreOffice: ${res.stderr}`);
  if (/repair/i.test(`${res.stdout}${res.stderr}`)) throw new Error('LibreOffice просит восстановление файла');
  if (!existsSync(txt)) throw new Error('LibreOffice не создал txt');
  return readFileSync(txt, 'utf8');
}
