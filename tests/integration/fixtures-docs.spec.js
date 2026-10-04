// «Файл → файл» на наборе договоров (ТЗ §9.2, WP5): конвейерная часть — сущности из gold (без детекторов WP1/WP2).
// Проверяется: нет оригиналов ни в одной XML-части, корректность XML и пакета, LibreOffice, детерминизм.
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildFixtures } from '../../scripts/gen-fixtures.mjs';
import { parseDocx, readZip, findOccurrences, clearDetectors } from '../../src/core/index.js';
import { unzipText } from '../helpers/docx.js';
import { assertWellFormed } from '../helpers/wellformed.js';
import { anonymize, findLeaks, checkPackage, sha256, LO_ENABLED, libreOfficeText } from './support/pipeline.js';

const xmllint = spawnSync('xmllint', ['--version']).status === 0;
const REMOVED_WITH_METADATA = ['docProps/custom.xml', 'docProps/thumbnail.jpeg'];

let fixtures;
beforeAll(() => {
  clearDetectors();
  fixtures = buildFixtures();
});

describe('набор договоров: «файл → файл»', () => {
  for (const name of ['ip-contract', 'two-companies', 'english-contract', 'structures']) {
    describe(name, () => {
      const get = () => fixtures.find((f) => f.name === name);

      it('сохранённые в репозитории фикстуры совпадают с генератором (npm run gen-fixtures)', () => {
        const f = get();
        const dir = join(process.cwd(), 'tests/fixtures/docs');
        expect(Buffer.from(f.bytes).equals(readFileSync(join(dir, `${name}.docx`)))).toBe(true);
        expect(JSON.parse(readFileSync(join(dir, `${name}.gold.json`), 'utf8'))).toEqual(f.gold);
      });

      it('каждое gold-значение действительно присутствует в документе', () => {
        const f = get();
        const doc = parseDocx(f.bytes);
        const text = doc.streams
          .map((s) => s.text)
          .join('\n')
          .toLowerCase();
        for (const { value } of f.gold) expect(text.includes(value.toLowerCase()), value).toBe(true);
      });

      it('ни одного исходного значения в XML-частях; XML и пакет корректны', async () => {
        const f = get();
        const values = f.gold.map((x) => x.value);
        const { docxBytes, mapping } = await anonymize(f.bytes, { gold: f.gold });
        expect(findLeaks(docxBytes, values)).toEqual([]);
        for (const [part, xml] of Object.entries(unzipText(docxBytes))) {
          if (/\.(xml|rels)$/.test(part)) assertWellFormed(xml, part);
        }
        expect(checkPackage(docxBytes)).toEqual([]);
        // повторный разбор: ни одного исходного значения в virtualText
        const text = parseDocx(docxBytes)
          .streams.map((s) => s.text)
          .join('\n')
          .toLowerCase();
        for (const v of values) expect(text.includes(v.toLowerCase()), v).toBe(false);
        // каждое gold-значение попало в маппинг (прямо или как вариант)
        const inMap = (v) => mapping.entries.some((e) => [e.original, e.value, ...e.variants].some((x) => x.toLowerCase().includes(v.toLowerCase())));
        for (const v of values) expect(inMap(v), `в маппинге: ${v}`).toBe(true);
      });

      it('режимы mask и delete тоже без утечек', async () => {
        const f = get();
        const values = f.gold.map((x) => x.value);
        for (const mode of ['mask', 'delete']) {
          const { docxBytes } = await anonymize(f.bytes, { gold: f.gold, apply: { mode } });
          expect(findLeaks(docxBytes, values), mode).toEqual([]);
        }
      });

      it('список частей = исходный минус custom.xml и миниатюра; нетронутые части — байт-в-байт', async () => {
        const f = get();
        const { docxBytes } = await anonymize(f.bytes, { gold: f.gold });
        const src = readZip(f.bytes);
        expect(readZip(docxBytes).map((e) => e.name)).toEqual(src.map((e) => e.name).filter((n) => !REMOVED_WITH_METADATA.includes(n)));
        const out = new Map(readZip(docxBytes).map((e) => [e.name, e]));
        const styles = src.find((e) => e.name === 'word/styles.xml');
        expect(Buffer.from(out.get('word/styles.xml').raw).equals(Buffer.from(styles.raw))).toBe(true);
      });

      it('детерминизм: SHA-256 двух прогонов совпадает', async () => {
        const f = get();
        const a = await anonymize(f.bytes, { gold: f.gold });
        const b = await anonymize(buildFixtures().find((x) => x.name === name).bytes, { gold: f.gold });
        expect(sha256(a.docxBytes)).toBe(sha256(b.docxBytes));
        expect(JSON.stringify(a.mapping)).toBe(JSON.stringify(b.mapping));
      });

      it.skipIf(!xmllint)('xmllint --noout', async () => {
        const f = get();
        const { docxBytes } = await anonymize(f.bytes, { gold: f.gold });
        for (const [part, xml] of Object.entries(unzipText(docxBytes))) {
          if (/\.(xml|rels)$/.test(part)) execFileSync('xmllint', ['--noout', '-'], { input: xml });
        }
      });

      it.skipIf(!LO_ENABLED)(
        'LibreOffice открывает результат, исходных значений в тексте нет',
        async () => {
          const f = get();
          const { docxBytes } = await anonymize(f.bytes, { gold: f.gold });
          const out = libreOfficeText(docxBytes, name).toLowerCase();
          expect(out).toContain('[');
          for (const { value } of f.gold) expect(out.includes(value.toLowerCase()), value).toBe(false);
        },
        150000,
      );
    });
  }

  it('structures: 40 страниц, три автора правок и поля внутри mc:AlternateContent/sdt/вложенной таблицы замены', async () => {
    const f = fixtures.find((x) => x.name === 'structures');
    const before = unzipText(f.bytes)['word/document.xml'];
    expect(before.split('w:type="page"').length - 1).toBe(40);
    const { docxBytes, analysis } = await anonymize(f.bytes, { gold: f.gold });
    const after = unzipText(docxBytes)['word/document.xml'];
    // структура не потеряна
    for (const tag of ['<w:sdt>', '<mc:AlternateContent>', '<mc:Fallback>', '<w:tbl>', '<w:ins ', '<w:del ']) {
      expect(after.split(tag).length, tag).toBe(before.split(tag).length);
    }
    // оба экземпляра надписи (Choice и Fallback) заменены на один плейсхолдер
    expect(findOccurrences(parseDocx(f.bytes), 'Зайцева Ольга Петровна').length).toBeGreaterThanOrEqual(2);
    // три автора правок — три разных плейсхолдера ФИО
    const authors = unzipText(docxBytes)['word/people.xml'].match(/w15:author="(\[[^"]+\])"/g);
    expect(new Set(authors).size).toBe(3);
    expect(analysis.groups.length).toBeGreaterThan(8);
  });
});
