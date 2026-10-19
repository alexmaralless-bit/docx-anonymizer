// «Файл → файл» с ПОЛНЫМ набором детекторов (WP1 + WP2 + WP4): никакого gold-подсказывания, только то, что нашли детекторы.
// До слияния WP1/WP2 тесты пропускаются (it.skipIf), после — должны проходить: «каждое gold-значение проверено на утечку».
// Принудительно: FULL_DETECTORS=1 (запустить, даже если проба не нашла детекторов), FULL_DETECTORS=0 (пропустить).
import { describe, it, expect } from 'vitest';
import { buildFixtures } from '../../scripts/gen-fixtures.mjs';
import { buildSampleDocx } from '../../scripts/make-sample.mjs';
import { registerBuiltinDetectors, getDetectors, getDocumentDetectors } from '../../src/core/index.js';
import { anonymize, findLeaks, sha256 } from './support/pipeline.js';

registerBuiltinDetectors();
// Готовность: зарегистрирован настоящий детектор ИНН (WP1) и документный детектор имён/компаний (WP2, не `custom`)
const probe = getDetectors().has('INN') && getDocumentDetectors().some((d) => !/custom/i.test(d.name));
const enabled = process.env.FULL_DETECTORS === '1' || (process.env.FULL_DETECTORS !== '0' && probe);

const sample = (() => {
  const { bytes, gold } = buildSampleDocx();
  // ключи образца → значения; авторов правок ядро находит само
  return { name: 'sample-contract', bytes, gold: Object.entries(gold).map(([key, value]) => ({ key, value })) };
})();
const docs = [sample, ...buildFixtures()];
// Ключи образца с названиями организаций (у gold образца нет категорий)
const SAMPLE_COMPANIES = new Set(['company1', 'company2']);
const isCompany = (f, x) => (x.category ? x.category === 'COMPANY' : f.name === 'sample-contract' && SAMPLE_COMPANIES.has(x.key));

describe.skipIf(!enabled)('полный набор детекторов: файл → файл', () => {
  for (const f of docs) {
    it(`${f.name}: ни одно gold-значение не осталось ни в одной XML-части`, async () => {
      const { docxBytes, analysis } = await anonymize(f.bytes);
      expect(analysis.groups.length).toBeGreaterThan(5);
      expect(
        findLeaks(
          docxBytes,
          f.gold.map((x) => x.value),
        ),
      ).toEqual([]);
    });

    it(`${f.name}: детерминизм — SHA-256 двух прогонов совпадает`, async () => {
      const a = await anonymize(f.bytes);
      const b = await anonymize(f.bytes);
      expect(sha256(a.docxBytes)).toBe(sha256(b.docxBytes));
    });
  }

  it('одно лицо/компания — один плейсхолдер во всех падежах и сокращениях (ip-contract, two-companies)', async () => {
    const { mapping } = await anonymize(docs.find((d) => d.name === 'ip-contract').bytes);
    const person = mapping.entries.find((e) => e.original.includes('Кузнецов Андрей'));
    expect(person?.variants.join('|') + person?.original).toMatch(/Кузнецова/);
  });
});

// Политика 0.4 (К2, К3, contracts §8): обычный режим — pii/ids замаскированы всегда, названий организаций нет;
// список компаний находит gold-организации и без коммерческой группы; коммерческий режим (anonymize по умолчанию) — выше
describe.skipIf(!enabled)('политика 0.4: обычный режим и список компаний', () => {
  const NORMAL = { commercial: false };
  for (const f of docs) {
    it(`${f.name}: обычный режим — ноль утечек pii/ids, ни одной находки COMPANY`, async () => {
      const { docxBytes, analysis } = await anonymize(f.bytes, { settings: NORMAL });
      expect(analysis.groups.filter((g) => g.category === 'COMPANY').map((g) => g.value)).toEqual([]);
      expect(analysis.groups.filter((g) => ['CONTRACT', 'AMOUNT'].includes(g.category))).toEqual([]);
      const values = f.gold.filter((x) => !isCompany(f, x)).map((x) => x.value);
      expect(findLeaks(docxBytes, values)).toEqual([]);
    });

    it(`${f.name}: список компаний при выключенной коммерческой группе — gold-организации замаскированы, только source list`, async () => {
      const names = f.gold.filter((x) => isCompany(f, x)).map((x) => x.value);
      if (!names.length) return;
      const { docxBytes, analysis } = await anonymize(f.bytes, { settings: { ...NORMAL, maskedCompanies: names.map((name) => ({ name, aliases: [] })) } });
      const groups = analysis.groups.filter((g) => g.category === 'COMPANY');
      expect(groups.every((g) => g.source === 'list')).toBe(true);
      expect(groups.length).toBe(new Set(names.map((n) => n.toLowerCase())).size);
      expect(
        findLeaks(
          docxBytes,
          f.gold.map((x) => x.value),
        ),
      ).toEqual([]);
    });
  }
});

describe.skipIf(enabled)('полный набор детекторов (ожидают WP1/WP2)', () => {
  it.todo('gold-значения всех документов не остаются в результате');
  it.todo('детерминизм при полном наборе детекторов');
});
