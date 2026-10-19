// Набор ревью WP11-D (tests/fixtures/heldout, scripts/gen-heldout-fixtures.mjs): 12 документов вне корпуса жанров —
// регрессия Ц1/К2/К6 для правил, фильтров и модели. Без модели — ни одной утечки, кроме лиц, которые находит только модель
// (gold `modelOnly`); с моделью (NER_MODEL_DIR) — ни одной утечки, целиком и частью (фамилия, части адреса из gold),
// в обоих режимах; покрытие людей и адресов — по вхождениям в тексте. Финальная проверка версии — на новом наборе
// ревьюера, которого в репозитории нет.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildHeldoutDocs, HELDOUT_DIR } from '../../scripts/gen-heldout-fixtures.mjs';
import { evaluateCorpus, listCorpus, loadDoc, loadNerProvider, modeSettings, formatReport } from '../../scripts/eval-genres.mjs';
import { registerBuiltinDetectors, clearDetectors, analyze, findOccurrences } from '../../src/core/index.js';

const MODEL_DIR = process.env.NER_MODEL_DIR ? resolve(process.env.NER_MODEL_DIR) : '';
/** Покрытие людей и адресов gold по вхождениям: доля вхождений, закрытых сущностями целиком. */
const COVERAGE_MIN = 0.95;

/**
 * Покрытие PERSON и ADDRESS: вхождение gold закрыто, если сущности анализа покрывают его целиком.
 * @param {{nerProvider?: any, skipModelOnly?: boolean}} o
 */
async function coverage(o) {
  const out = { PERSON: [0, 0], ADDRESS: [0, 0], missed: [] };
  for (const it of listCorpus(HELDOUT_DIR)) {
    const doc = await loadDoc(it.path);
    for (const mode of ['normal', 'commercial']) {
      const a = await analyze(doc, modeSettings(mode), { nerProvider: o.nerProvider || undefined });
      for (const e of it.gold.entities) {
        if (!(e.category in out) || (o.skipModelOnly && e.modelOnly)) continue;
        for (const occ of findOccurrences(doc, e.value)) {
          const spans = a.entities.filter((x) => x.streamId === occ.streamId && x.start < occ.end && occ.start < x.end).sort((x, y) => x.start - y.start);
          let pos = occ.start;
          for (const x of spans) if (x.start <= pos) pos = Math.max(pos, x.end);
          out[e.category][1]++;
          if (pos >= occ.end) out[e.category][0]++;
          else out.missed.push(`${it.name} ${mode} ${e.key} ${e.category}`);
        }
      }
    }
  }
  return out;
}

const leakKeys = (docs, skipModelOnly) =>
  docs.flatMap((d) =>
    [...d.leaks, ...d.partial]
      .filter((e) => !(skipModelOnly && e.modelOnly))
      .map((e) => `${d.genre}/${d.name} ${d.mode}: ${e.key} ${e.category}${e.part ? ` (${e.part})` : ''}`),
  );

beforeAll(() => {
  clearDetectors();
  registerBuiltinDetectors();
});

describe('набор ревью WP11-D (heldout)', () => {
  it('генератор детерминирован: DOCX и gold в репозитории совпадают с генерацией', () => {
    const docs = buildHeldoutDocs();
    expect(docs).toHaveLength(12);
    for (const d of docs) {
      const base = join(HELDOUT_DIR, d.genre, d.name);
      expect(Buffer.from(readFileSync(`${base}.docx`)).equals(Buffer.from(d.docx)), `${d.name}: npm run gen-heldout-fixtures`).toBe(true);
      expect(JSON.parse(readFileSync(`${base}.gold.json`, 'utf8')), d.name).toEqual(d.gold);
    }
  });

  it('без модели: ни одной утечки (целиком и частью), кроме лиц «только модель»; покрытие людей и адресов ≥ 0,95', async () => {
    const r = await evaluateCorpus({ dir: HELDOUT_DIR });
    console.log(`[heldout] без модели${formatReport(r.summary)}`);
    expect(leakKeys(r.docs, true)).toEqual([]);
    const c = await coverage({ skipModelOnly: true });
    console.log(`[heldout] без модели: покрытие PERSON ${c.PERSON.join('/')}, ADDRESS ${c.ADDRESS.join('/')}`);
    for (const cat of ['PERSON', 'ADDRESS']) expect(c[cat][0] / c[cat][1], `${cat}: ${c.missed.join('; ')}`).toBeGreaterThanOrEqual(COVERAGE_MIN);
    // отрицательные примеры без модели сущностью не становятся
    expect(r.docs.filter((d) => d.mode === 'normal' && d.negHits.length).map((d) => `${d.name}: ${d.negHits.map((n) => n.value)}`)).toEqual([]);
  }, 60000);

  describe.skipIf(!MODEL_DIR)('с моделью NER (NER_MODEL_DIR)', () => {
    let provider;
    beforeAll(async () => {
      provider = await loadNerProvider(MODEL_DIR);
      if (!provider) throw new Error('модель не найдена');
    }, 60000);

    it('ни одной утечки (целиком и частью) в обоих режимах; покрытие людей и адресов ≥ 0,95', async () => {
      try {
        const r = await evaluateCorpus({ dir: HELDOUT_DIR, nerProvider: provider });
        console.log(`[heldout] модель ${provider.label}${formatReport(r.summary)}`);
        expect(leakKeys(r.docs, false)).toEqual([]);
        const c = await coverage({ nerProvider: provider });
        console.log(`[heldout] ${provider.label}: покрытие PERSON ${c.PERSON.join('/')}, ADDRESS ${c.ADDRESS.join('/')}`);
        for (const cat of ['PERSON', 'ADDRESS']) expect(c[cat][0] / c[cat][1], `${cat}: ${c.missed.join('; ')}`).toBeGreaterThanOrEqual(COVERAGE_MIN);
      } finally {
        provider.dispose?.();
      }
    }, 300000);
  });
});
