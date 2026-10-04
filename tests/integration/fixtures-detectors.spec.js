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

describe.skipIf(enabled)('полный набор детекторов (ожидают WP1/WP2)', () => {
  it.todo('gold-значения всех документов не остаются в результате');
  it.todo('детерминизм при полном наборе детекторов');
});
