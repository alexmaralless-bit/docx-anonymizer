// «Файл → файл» на образце договора (ТЗ §9.2): parse → сущности → apply → повторный разбор.
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { buildSampleDocx } from '../../scripts/make-sample.mjs';
import { parseDocx, analyze, applyDecisions, findOccurrences, readZip, defaultSettings, clearDetectors } from '../../src/core/index.js';
import { unzipText } from '../helpers/docx.js';
import { assertWellFormed } from '../helpers/wellformed.js';

const CATEGORY_BY_KEY = (k) =>
  ({
    company: 'COMPANY',
    person: 'PERSON',
    author: 'PERSON',
    inn: 'INN',
    kpp: 'KPP',
    ogrn: 'OGRN',
    bik: 'BIK',
    rs: 'ACCOUNT',
    ks: 'ACCOUNT',
    snils: 'SNILS',
    passport: 'PASSPORT',
    phone: 'PHONE',
    email: 'EMAIL',
    url: 'URL',
    address: 'ADDRESS',
  })[k.replace(/(Gen|Short|ShortGen|Old|\d)+$/, '').replace(/\d/g, '')];

let sample;
let gold;
let goldValues;

beforeAll(() => {
  clearDetectors(); // только «пользовательские» сущности — детекторы делают рабочие пакеты
  ({ bytes: sample, gold } = buildSampleDocx());
  goldValues = Object.values(gold);
});

async function anonymize(bytes, opts = {}) {
  const doc = parseDocx(bytes);
  const userEntities = [];
  for (const [k, v] of Object.entries(gold)) {
    const category = CATEGORY_BY_KEY(k);
    if (!category) throw new Error(`нет категории для ${k}`);
    for (const o of findOccurrences(doc, v)) userEntities.push({ ...o, category, confidence: 'labeled' });
  }
  const analysis = await analyze(doc, { ...defaultSettings(), commercial: true }, { userEntities });
  const res = applyDecisions(doc, analysis.groups, { mode: 'placeholder', placeholderLanguage: 'ru', createdAt: '2026-10-04T00:00:00Z', ...opts });
  return { doc, analysis, ...res };
}

describe('образец договора: файл → файл', () => {
  it('разбор покрывает все части §4.2', () => {
    const doc = parseDocx(sample);
    const parts = new Set(doc.streams.map((s) => s.part));
    for (const p of [
      'word/document.xml',
      'word/header1.xml',
      'word/footer1.xml',
      'word/footnotes.xml',
      'word/endnotes.xml',
      'word/comments.xml',
      'word/people.xml',
      'word/_rels/document.xml.rels',
      'docProps/core.xml',
      'docProps/app.xml',
    ]) {
      expect(parts.has(p), p).toBe(true);
    }
    const kinds = new Set(doc.streams.map((s) => s.attrKind || s.type));
    for (const k of ['live', 'deleted', 'field', 'author', 'initials', 'author-id', 'alt', 'field-instr', 'rel-target', 'meta'])
      expect(kinds.has(k), k).toBe(true);
    // ФИО разбито на 3 рана, но в virtualText — цельное
    expect(doc.streams.find((s) => s.text.includes('в лице генерального директора Иванова Петра Сергеевича,'))).toBeTruthy();
    // ИНН с мягким переносом находится целиком
    expect(findOccurrences(doc, gold.inn2).length).toBeGreaterThanOrEqual(2);
  });

  it('все значения заменены, оригиналов нет ни в одной части, форматирование сохранено', async () => {
    const { docxBytes, mapping, analysis } = await anonymize(sample);
    expect(analysis.groups.length).toBeGreaterThan(25);

    // 1) повторный разбор: в virtualText нет исходных значений
    const doc2 = parseDocx(docxBytes);
    const allText = doc2.streams.map((s) => s.text).join('\n');
    for (const v of goldValues) expect(allText, v).not.toContain(v);
    expect(allText).toContain('в лице генерального директора [ФИО_');
    expect(allText).toContain('ООО «[КОМПАНИЯ_1]»');

    // 2) grep по всем XML-частям (включая rels и [Content_Types].xml)
    const texts = unzipText(docxBytes);
    for (const [name, xml] of Object.entries(texts)) {
      if (!/\.(xml|rels)$/.test(name)) continue;
      for (const v of goldValues) expect(xml.includes(v), `${v} в ${name}`).toBe(false);
      assertWellFormed(xml, name);
    }

    // 3) раны и их форматирование не потеряны
    const before = unzipText(sample)['word/document.xml'];
    const after = texts['word/document.xml'];
    for (const tag of [
      '<w:r>',
      '<w:rPr>',
      '<w:b/>',
      '<w:i/>',
      '<w:u w:val="single"/>',
      '<w:tbl>',
      '<w:drawing>',
      '<w:pict>',
      '<w:footnoteReference',
      '<w:commentReference',
    ]) {
      expect(after.split(tag).length, tag).toBe(before.split(tag).length);
    }
    expect(after).not.toContain('w:softHyphen'); // единственный мягкий перенос был внутри ИНН

    // 4) ссылки и авторы
    expect(texts['word/_rels/document.xml.rels']).toMatch(/Target="mailto:\[EMAIL_\d+\]"/);
    expect(texts['word/comments.xml']).toMatch(/w:author="\[ФИО_\d+\]" w:date="[^"]+" w:initials="\[ФИО_\d+\]"/);
    expect(texts['word/document.xml']).toMatch(/w:instr=" HYPERLINK &quot;\[URL_\d+\]&quot; "/);

    // 5) маппинг
    expect(mapping.entries.find((e) => e.original === gold.inn1)).toMatchObject({ category: 'INN', token: '[ИНН_1]' });
    expect(new Set(mapping.entries.map((e) => e.token)).size).toBe(mapping.entries.length);
  });

  it('метаданные очищены, custom.xml и миниатюра удалены вместе со ссылками (FR-12)', async () => {
    const { docxBytes } = await anonymize(sample);
    const names = readZip(docxBytes).map((e) => e.name);
    const orig = readZip(sample).map((e) => e.name);
    expect(names).toEqual(orig.filter((n) => n !== 'docProps/custom.xml' && n !== 'docProps/thumbnail.jpeg'));
    const t = unzipText(docxBytes);
    expect(t['docProps/core.xml']).toContain('<dc:creator></dc:creator>');
    expect(t['docProps/app.xml']).toContain('<Company></Company>');
    expect(t['[Content_Types].xml']).not.toContain('custom.xml');
    expect(t['_rels/.rels']).not.toContain('custom.xml');
    expect(t['_rels/.rels']).not.toContain('thumbnail');
    expect(t['docProps/core.xml']).toContain('<cp:revision>3</cp:revision>');
  });

  it('keepMetadata: тот же список частей, метаданные анонимизированы, а не стёрты', async () => {
    const { docxBytes } = await anonymize(sample, { keepMetadata: true });
    expect(readZip(docxBytes).map((e) => e.name)).toEqual(readZip(sample).map((e) => e.name));
    const t = unzipText(docxBytes);
    expect(t['docProps/core.xml']).toMatch(/<dc:creator>\[ФИО_\d+\]<\/dc:creator>/);
  });

  it('нетронутые части копируются байт-в-байт; результат детерминирован; читается сторонним unzip', async () => {
    const a = await anonymize(sample);
    const b = await anonymize(sample);
    expect(Buffer.from(a.docxBytes).equals(Buffer.from(b.docxBytes))).toBe(true);
    const src = new Map(readZip(sample).map((e) => [e.name, e]));
    for (const e of readZip(a.docxBytes)) {
      if (['word/styles.xml', 'word/settings.xml', 'word/media/image1.png'].includes(e.name)) {
        expect(Buffer.from(e.raw).equals(Buffer.from(src.get(e.name).raw)), e.name).toBe(true);
      }
    }
    expect(Object.keys(unzipSync(a.docxBytes)).length).toBe(readZip(a.docxBytes).length);
  });

  it('stripEmbedded удаляет только embeddings/charts (картинки остаются)', async () => {
    const { docxBytes } = await anonymize(sample, { stripEmbedded: true });
    expect(readZip(docxBytes).map((e) => e.name)).toContain('word/media/image1.png');
  });

  const xmllint = spawnSync('xmllint', ['--version']).status === 0;
  it.skipIf(!xmllint)('xmllint --noout на изменённых частях', async () => {
    const { docxBytes } = await anonymize(sample);
    for (const [name, xml] of Object.entries(unzipText(docxBytes))) {
      if (!/\.(xml|rels)$/.test(name)) continue;
      execFileSync('xmllint', ['--noout', '-'], { input: xml });
    }
  });

  const soffice = ['soffice', 'libreoffice'].find((b) => spawnSync('which', [b]).status === 0);
  it.skipIf(!soffice || process.env.SKIP_LIBREOFFICE)(
    'LibreOffice открывает результат (прокси «без восстановления»)',
    async () => {
      const { docxBytes } = await anonymize(sample);
      // snap-LibreOffice не видит скрытые каталоги и /tmp — пишем в test-output/ внутри репозитория
      const dir = join(process.cwd(), 'test-output', 'lo');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'sample.anon.docx');
      writeFileSync(file, docxBytes);
      const r = spawnSync(/** @type {string} */ (soffice), ['--headless', '--convert-to', 'txt:Text', file, '--outdir', dir], {
        encoding: 'utf8',
        timeout: 120000,
      });
      expect(r.status, r.stderr).toBe(0);
      expect(`${r.stdout}${r.stderr}`.toLowerCase()).not.toContain('repair');
      const txt = join(dir, 'sample.anon.txt');
      expect(existsSync(txt)).toBe(true);
      const out = readFileSync(txt, 'utf8');
      expect(out).toContain('[ИНН_1]');
      for (const v of goldValues) expect(out.includes(v), v).toBe(false);
    },
    150000,
  );
});
