// Корпус жанров (версия 0.4, Ц2, Ц4, К2 часть, К4 синтетика, К5, К7 часть правил, К10, `docs/contracts.md` §8.4):
// 8 жанров × ≥ 3 документа, ru + en для letter/resume, DOCX и PDF, детерминированный генератор (scripts/gen-genre-fixtures.mjs);
// обычный режим — ноль утечек pii/ids (целиком и частично), ноль организаций, отрицательные примеры не становятся сущностью;
// коммерческий без модели — полнота организаций с ОПФ ≥ 0,95, ложных COMPANY на КП ≤ 2; фильтры модельных ORG на корпусе —
// стаб-провайдером, который размечает ORG каждый отрицательный пример; с моделью (NER_MODEL_DIR) — числа в отчёт, гейты К6/К7
// включаются флагом (WP11-C3); PRIVATE_FIXTURES=1 — настоящие документы из tests/fixtures/private, только счётчики.
// Отчёт целиком: npm run eval-genres.
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { buildGenreDocs, buildGenrePdf, GENRES, GENRES_DIR } from '../../scripts/gen-genre-fixtures.mjs';
import { layoutSnapshot } from '../../scripts/gen-pdf-fixtures.mjs';
import {
  listCorpus,
  loadDoc,
  evaluateDoc,
  evaluateCorpus,
  evaluatePrivate,
  summarize,
  catMetrics,
  formatReport,
  loadNerProvider,
  partialLeaks,
  modeSettings,
} from '../../scripts/eval-genres.mjs';
import { registerBuiltinDetectors, clearDetectors, analyze, applyDecisions, findOccurrences } from '../../src/core/index.js';

// Гейты К6/К7 с моделью: пороги концепции 0.4; жёсткая проверка включается для пакета 1.1.0 (WP11-C3) —
// флагом ниже или переменной GENRES_MODEL_GATES=1. До этого числа только печатаются.
const ENFORCE_MODEL_GATES = process.env.GENRES_MODEL_GATES === '1';
const K6_PERSON_PRECISION = 0.9;
const K6_PERSON_RECALL = 0.85;
const K7_COMPANY_PRECISION = 0.8;
const K7_PROPOSAL_FALSE_COMPANY = 2;
const K7_OPF_RECALL = 0.95;
// без модели (правила + база знаний): гейты таблицы приёмки WP11-B
const OPF_RECALL = 0.95;
const PROPOSAL_FALSE_COMPANY = 2;

/**
 * Известные недочёты, найденные корпусом (WP11-B, ревью): корпус не подстраивается под них. Основные гейты исключают
 * ровно эти ключи gold, а `it.fails` ниже проверяет, что недочёт пока на месте. Пакет WP11-D исправит причину, удалит
 * запись отсюда и снимет `it.fails` (зелёный `it.fails` превратится в красный, как только недочёт исправлен).
 * kind: leak — значение (целиком или частью) остаётся в результате; fn — не найдено точно (найдено с лишним словом,
 * утечки нет); fp — ложная находка. format: '*' — DOCX и PDF.
 */
const KNOWN_GAPS = [
  {
    doc: 'invoice/upd-ip',
    format: '*',
    key: 'e4',
    kind: 'leak',
    reason: 'WP11-D: КПП в «ИНН/КПП покупателя: X/Y» не находится (слово между меткой и номерами)',
  },
  { doc: 'chat/chat-sales', format: '*', key: 'e5', kind: 'leak', reason: 'WP11-D: обращение одним именем («Елена, спасибо…») не находится' },
  { doc: 'chat/chat-team', format: '*', key: 'e4', kind: 'leak', reason: 'WP11-D: обращение одним именем («Наталья, добрый день!») не находится' },
  {
    doc: 'letter/letter-schedule',
    format: 'pdf',
    key: 'e4',
    kind: 'leak',
    reason: 'WP11-D: PDF — центрированная строка с переносом рвёт адрес почты на два абзаца',
  },
  {
    doc: 'reconciliation/reconciliation-ooo',
    format: 'pdf',
    key: 'e4',
    kind: 'leak',
    reason: 'WP11-D: PDF — таблица подписей из двух строк не распознаётся, ячейки перемешаны: фамилия отделена от инициалов',
  },
  {
    doc: 'reconciliation/reconciliation-ooo',
    format: 'pdf',
    key: 'e6',
    kind: 'leak',
    reason: 'WP11-D: PDF — таблица подписей из двух строк не распознаётся («(Фролова Главный бухгалтер … А.М.)»)',
  },
  { doc: 'letter/letter-schedule', format: '*', key: 'e7', kind: 'fn', reason: 'WP11-D: «Уважаемый Павел Николаевич» — PERSON вместе с «Уважаемый»' },
  { doc: 'letter/letter-reply', format: '*', key: 'e6', kind: 'fn', reason: 'WP11-D: «Уважаемая Марина Павловна» — PERSON вместе с «Уважаемая»' },
  {
    doc: 'invoice/upd-ip',
    format: '*',
    kind: 'fp',
    category: 'INN',
    value: '8471300000',
    reason: 'WP11-D: код ТН ВЭД проходит контрольную сумму ИНН — ложный INN',
  },
];
const gapFor = (d, kind) => KNOWN_GAPS.filter((g) => g.kind === kind && g.doc === `${d.genre}/${d.name}` && (g.format === '*' || g.format === d.format));
/** Утечки документа без известных недочётов. */
const leaksOf = (d) => [...d.leaks, ...d.partial].filter((e) => !gapFor(d, 'leak').some((g) => g.key === e.key));

const MODEL_DIR = process.env.NER_MODEL_DIR ? resolve(process.env.NER_MODEL_DIR) : '';
const PRIVATE = process.env.PRIVATE_FIXTURES === '1';
const CHROMIUM =
  !process.env.SKIP_PDF_REGEN &&
  (() => {
    try {
      return existsSync(chromium.executablePath());
    } catch {
      return false;
    }
  })();

const docs = buildGenreDocs();
const corpus = listCorpus();
const docxOf = (d) => new Uint8Array(readFileSync(join(GENRES_DIR, d.genre, `${d.name}.docx`)));
let result;

beforeAll(async () => {
  clearDetectors();
  registerBuiltinDetectors();
  result = await evaluateCorpus();
  console.log(`[genres] без модели, ${corpus.length} файлов${formatReport(result.summary)}`);
}, 120000);

describe('К5: корпус жанров', () => {
  it('8 жанров × ≥ 3 документа, letter и resume — ещё и на английском; DOCX (кроме deck), PDF и снимок у каждого', () => {
    expect(readdirSync(GENRES_DIR).sort()).toEqual([...GENRES].sort());
    for (const g of GENRES) {
      const list = docs.filter((d) => d.genre === g);
      expect(list.length, g).toBeGreaterThanOrEqual(3);
      expect(list.filter((d) => d.lang === 'ru').length, g).toBeGreaterThanOrEqual(3);
      if (g === 'letter' || g === 'resume')
        expect(
          list.some((d) => d.lang === 'en'),
          g,
        ).toBe(true);
      for (const d of list) {
        const base = join(GENRES_DIR, g, d.name);
        expect(existsSync(`${base}.pdf`), d.name).toBe(true);
        expect(existsSync(`${base}.pdf.txt`), d.name).toBe(true);
        expect(existsSync(`${base}.gold.json`), d.name).toBe(true);
        expect(existsSync(`${base}.docx`), d.name).toBe(g !== 'deck');
      }
    }
    // синтетический аналог КП Sitimlab (К4)
    expect(docs.some((d) => d.genre === 'proposal' && d.name === 'kp-lunopark')).toBe(true);
  });

  it('генератор детерминирован: двойная генерация — те же DOCX-байты и gold, что в репозитории', () => {
    const again = buildGenreDocs();
    expect(again.map((d) => d.name)).toEqual(docs.map((d) => d.name));
    for (let i = 0; i < docs.length; i++) {
      const d = docs[i];
      expect(again[i].gold, d.name).toEqual(d.gold);
      expect(again[i].html, d.name).toBe(d.html);
      expect(JSON.parse(readFileSync(join(GENRES_DIR, d.genre, `${d.name}.gold.json`), 'utf8')), d.name).toEqual(d.gold);
      if (!d.docx) continue;
      expect(Buffer.from(again[i].docx).equals(Buffer.from(d.docx)), d.name).toBe(true);
      expect(Buffer.from(docxOf(d)).equals(Buffer.from(d.docx)), `${d.name}: DOCX в репозитории устарел (npm run gen-genre-fixtures)`).toBe(true);
    }
  });

  it('извлечение закоммиченных PDF совпадает со снимком .pdf.txt', async () => {
    for (const d of docs) {
      const base = join(GENRES_DIR, d.genre, d.name);
      const snap = await layoutSnapshot(new Uint8Array(readFileSync(`${base}.pdf`)));
      expect(snap, d.name).toBe(readFileSync(`${base}.pdf.txt`, 'utf8'));
    }
  }, 60000);

  it.skipIf(!CHROMIUM)(
    'регенерация PDF в Chromium даёт тот же снимок разметки (байты PDF недетерминированы)',
    async () => {
      const browser = await chromium.launch({ channel: 'chromium' });
      try {
        for (const d of docs) {
          const snap = await layoutSnapshot(await buildGenrePdf(browser, d));
          expect(snap, d.name).toBe(readFileSync(join(GENRES_DIR, d.genre, `${d.name}.pdf.txt`), 'utf8'));
        }
      } finally {
        await browser.close();
      }
    },
    120000,
  );

  it('gold согласован с текстом: каждое значение и отрицательный пример есть в документе', async () => {
    for (const it of corpus) {
      const doc = await loadDoc(it.path);
      for (const e of it.gold.entities) {
        if (e.meta && it.format === 'pdf') continue;
        // известный недочёт разметки PDF: значение разорвано (KNOWN_GAPS)
        if (gapFor(it, 'leak').some((g) => g.key === e.key && g.format === 'pdf')) continue;
        // значение ищется подстрокой без учёта регистра: «ООО «Ромашка»» — ядро внутри кавычек, «СТУДИЯ ЛУНОПАРК» на слайде
        const found = doc.streams.some((s) => s.text.toLowerCase().includes(e.value.toLowerCase()));
        expect(found, `${it.genre}/${it.name}.${it.format}: ${e.key} ${e.category}`).toBe(true);
      }
      for (const n of it.gold.negatives) expect(findOccurrences(doc, n.value).length, `${it.name}.${it.format}: отрицательный пример`).toBeGreaterThan(0);
      // у людей — фамилия для проверки частичных утечек; у организаций — признак ОПФ
      for (const e of it.gold.entities) {
        if (e.category === 'PERSON' && e.value.split(' ').length > 2) expect(typeof e.surname, `${it.name}: ${e.key}`).toBe('string');
        if (e.category === 'COMPANY') expect(typeof e.opf, `${it.name}: ${e.key}`).toBe('boolean');
      }
    }
  }, 60000);
});

describe('обычный режим (политика 0.4, Ц1/Ц2): без модели', () => {
  it('ноль утечек pii/ids — ни целиком, ни частью (фамилия, номер, индекс и дом адреса, начало почты), кроме KNOWN_GAPS', () => {
    const bad = result.docs.filter((d) => d.mode === 'normal' && leaksOf(d).length);
    expect(bad.map((d) => `${d.genre}/${d.name}.${d.format}: ${leaksOf(d).map((e) => `${e.key}~${e.category}`)}`)).toEqual([]);
  });

  it('ни одной организации и ни одного отрицательного примера в результатах', () => {
    const normal = result.docs.filter((d) => d.mode === 'normal');
    expect(normal.filter((d) => d.companyCount).map((d) => `${d.name}.${d.format}`)).toEqual([]);
    expect(normal.filter((d) => d.negHits.length).map((d) => `${d.name}.${d.format}: ${d.negHits.length}`)).toEqual([]);
  });

  it('проверка частичных утечек ловит фамилию в другой форме и номер с пробелом', () => {
    const g = [
      { key: 'p', category: 'PERSON', value: 'Соколовой Дарьи Андреевны', surname: 'Соколовой' },
      { key: 'i', category: 'INN', value: '7814981468' },
    ];
    expect(partialLeaks(g, 'менеджер [ФИО_1], ИНН [ИНН_1]').map((e) => e.key)).toEqual([]);
    expect(partialLeaks(g, 'от СОКОЛОВОЙ, ИНН 7814 981468').map((e) => e.key)).toEqual(['p', 'i']);
    // адрес: индекс или «д./кв./офис N» из gold-адреса; почта — «имя@начало домена»
    const a = [{ key: 'a', category: 'ADDRESS', value: '630002, г. Новосибирск, ул. Советская, д. 77, офис 72' }];
    expect(partialLeaks(a, '[АДРЕС_1]')).toEqual([]);
    expect(partialLeaks(a, '630002, г. [АДРЕС_1], ул. [АДРЕС_2]').map((e) => e.part)).toEqual(['zip']);
    expect(partialLeaks(a, 'г. [АДРЕС_1], ул. [АДРЕС_2], д. 77, офис 72').map((e) => e.part)).toEqual(['house']);
    expect(partialLeaks(a, 'д. 7, офис 7').map((e) => e.part)).toEqual([]);
    const m = [{ key: 'm', category: 'EMAIL', value: 'info@vector-plus.example' }];
    expect(partialLeaks(m, 'почта info@vector-\n\nplus.example').map((e) => e.part)).toEqual(['email']);
  });

  it('К4 (синтетика): КП — замаскированы ИНН, КПП, счёт, БИК, контакт; организаций нет; бренд, заголовки и аббревиатуры на месте', async () => {
    for (const ext of ['docx', 'pdf']) {
      const it = corpus.find((x) => x.name === 'kp-lunopark' && x.format === ext);
      const doc = await loadDoc(it.path);
      const analysis = await analyze(doc, modeSettings('normal'));
      const cats = new Set(analysis.groups.map((g) => g.category));
      for (const c of ['INN', 'KPP', 'ACCOUNT', 'BIK', 'OGRN', 'PERSON', 'PHONE', 'EMAIL', 'URL', 'ADDRESS']) expect(cats.has(c), `${ext}: ${c}`).toBe(true);
      expect(cats.has('COMPANY')).toBe(false);
      const out = ext === 'pdf' ? new TextDecoder().decode(applyDecisions(doc, analysis.groups, { textFormat: 'md', placeholderLanguage: 'ru' }).bytes) : null;
      if (out) {
        for (const s of ['КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ', 'Студия Лунопарк', '05 Цены', 'ЭДО', 'ВЭД', 'УПД', 'MVP', 'Word', 'Excel', 'ООО «Лунопарк Диджитал»']) {
          expect(out, s).toContain(s);
        }
        expect(out).toMatch(/ИНН \[ИНН_1\], КПП \[КПП_1\]/);
      }
    }
  }, 30000);
});

describe('коммерческий режим без модели', () => {
  it(`полнота организаций с ОПФ ≥ ${OPF_RECALL} (корпус) и в каждом жанре; утечек и отрицательных примеров нет`, () => {
    const com = result.docs.filter((d) => d.mode === 'commercial');
    const tp = com.reduce((s, d) => s + d.opf.tp, 0);
    const fn = com.reduce((s, d) => s + d.opf.fn, 0);
    console.log(`[genres] коммерческий режим: полнота организаций с ОПФ ${(tp / (tp + fn)).toFixed(3)} (${tp}/${tp + fn})`);
    expect(tp / (tp + fn)).toBeGreaterThanOrEqual(OPF_RECALL);
    for (const g of GENRES) {
      const o = result.summary.commercial[g].opf;
      if (o.tp + o.fn) expect(o.tp / (o.tp + o.fn), g).toBeGreaterThanOrEqual(OPF_RECALL);
    }
    expect(com.filter((d) => leaksOf(d).length).map((d) => `${d.name}.${d.format}`)).toEqual([]);
    expect(com.filter((d) => d.negHits.length).map((d) => `${d.name}.${d.format}`)).toEqual([]);
  });

  it(`ложных COMPANY на каждом КП ≤ ${PROPOSAL_FALSE_COMPANY}`, () => {
    for (const d of result.docs.filter((x) => x.mode === 'commercial' && x.genre === 'proposal')) {
      expect(d.perCat.COMPANY?.fp ?? 0, `${d.name}.${d.format}`).toBeLessThanOrEqual(PROPOSAL_FALSE_COMPANY);
    }
  });
});

describe('К10 на корпусе: фильтры модельных ORG (стаб-провайдер размечает ORG каждый отрицательный пример и организацию)', () => {
  /** Стаб NER: ORG на каждое вхождение (целым словом) значений из списка. */
  const stubOrg = (values) => ({
    name: 'stub-org',
    init: async () => {},
    detect: async (text) => {
      const out = [];
      const low = text.toLowerCase();
      for (const v of values) {
        const needle = v.toLowerCase();
        for (let i = low.indexOf(needle); i >= 0; i = low.indexOf(needle, i + 1)) {
          const before = text[i - 1];
          const after = text[i + v.length];
          if ((before && /[\p{L}\p{N}]/u.test(before)) || (after && /[\p{L}\p{N}]/u.test(after))) continue;
          out.push({ start: i, end: i + v.length, label: 'ORG', score: 0.99 });
        }
      }
      return out;
    },
  });

  it('коммерческий режим: отрицательные примеры отброшены фильтром, организации с ОПФ сохранены; обычный — ORG не выдаётся', async () => {
    const survived = [];
    const lostBare = [];
    let bareAll = 0;
    let opfTp = 0;
    let opfAll = 0;
    for (const it of corpus) {
      const doc = await loadDoc(it.path);
      const negatives = it.gold.negatives.filter((n) => !n.mode);
      const orgs = it.gold.entities.filter((e) => e.category === 'COMPANY' && e.opf).map((e) => e.value);
      // организации без ОПФ со строчными словами в предложении («Северная транспортная компания») — тоже сохраняются
      const bare = it.gold.entities.filter((e) => e.category === 'COMPANY' && !e.opf && /\s\p{Ll}/u.test(e.value)).map((e) => e.value);
      const nerProvider = stubOrg([...negatives.map((n) => n.value), ...orgs, ...bare]);
      const r = await evaluateDoc(doc, it.gold, 'commercial', { nerProvider });
      for (const n of r.negHits) survived.push(`${it.genre}/${it.name}.${it.format}: «${n.value}»`);
      for (const v of bare) if (r.fnList.some((e) => e.value === v)) lostBare.push(`${it.name}.${it.format}: «${v}»`);
      bareAll += bare.length;
      opfTp += r.opf.tp;
      opfAll += r.opf.tp + r.opf.fn;
      const normal = await evaluateDoc(doc, it.gold, 'normal', { nerProvider });
      expect(normal.companyCount, `${it.name}.${it.format}`).toBe(0);
    }
    console.log(
      `[genres] стаб ORG: отрицательных примеров прошло фильтр ${survived.length}; организации с ОПФ ${opfTp}/${opfAll}; без ОПФ со строчными словами ${bareAll - lostBare.length}/${bareAll}`,
    );
    expect(survived).toEqual([]);
    expect(opfTp).toBe(opfAll);
    expect(bareAll).toBeGreaterThanOrEqual(6); // 3 организации × DOCX и PDF
    expect(lostBare).toEqual([]);
  }, 60000);
});

describe('известные недочёты (KNOWN_GAPS): пока на месте — снимет WP11-D', () => {
  for (const g of KNOWN_GAPS) {
    // it.fails: тест зелёный, пока недочёт есть; исправленный недочёт делает его красным — удалить запись из KNOWN_GAPS
    it.fails(`${g.doc} (${g.format}): ${g.reason}`, () => {
      const docs = result.docs.filter((d) => d.mode === 'normal' && `${d.genre}/${d.name}` === g.doc && (g.format === '*' || g.format === d.format));
      expect(docs.length).toBeGreaterThan(0);
      for (const d of docs) {
        if (g.kind === 'leak') expect([...d.leaks, ...d.partial].map((e) => e.key)).not.toContain(g.key);
        else if (g.kind === 'fn') expect(d.fnList.map((e) => e.key)).not.toContain(g.key);
        else expect(d.fpList.some((f) => f.category === g.category && f.value === g.value)).toBe(false);
      }
    });
  }
});

describe.skipIf(!MODEL_DIR)('с моделью NER (NER_MODEL_DIR): числа К6/К7, гейты — для пакета 1.1.0 (WP11-C3)', () => {
  let withModel;
  let label;
  beforeAll(async () => {
    const provider = await loadNerProvider(MODEL_DIR);
    if (!provider) throw new Error('модель не найдена');
    label = provider.label;
    try {
      withModel = await evaluateCorpus({ nerProvider: provider });
    } finally {
      provider.dispose?.();
    }
    console.log(`[genres] модель ${label}${formatReport(withModel.summary)}`);
  }, 300000);

  it('обычный режим с моделью: ноль утечек pii/ids (жёстко при GENRES_MODEL_GATES=1) и ни одной организации', () => {
    const normal = withModel.docs.filter((d) => d.mode === 'normal');
    const bad = normal.filter((d) => leaksOf(d).length);
    const addr = normal.reduce((n, d) => n + leaksOf(d).filter((e) => e.category === 'ADDRESS').length, 0);
    // с моделью 1.0.0 LOC дробит адрес правил и индекс/дом остаются в тексте — разрешение пересечений (координатор)
    console.log(
      `[genres] ${label} обычный режим: утечек ${bad.reduce((n, d) => n + leaksOf(d).length, 0)} в ${bad.length} файлах, из них частичных адресов ${addr}`,
    );
    if (ENFORCE_MODEL_GATES) expect(bad.map((d) => `${d.name}.${d.format}: ${leaksOf(d).map((e) => `${e.key}~${e.category}`)}`)).toEqual([]);
    expect(normal.filter((d) => d.companyCount).map((d) => `${d.name}.${d.format}`)).toEqual([]);
  });

  it(`К6: PERSON P ≥ ${K6_PERSON_PRECISION}, R ≥ ${K6_PERSON_RECALL}; К7: COMPANY P ≥ ${K7_COMPANY_PRECISION}, ложных на КП ≤ ${K7_PROPOSAL_FALSE_COMPANY}, ОПФ R ≥ ${K7_OPF_RECALL}`, () => {
    const s = withModel.summary;
    const fails = [];
    for (const g of GENRES) {
      const per = catMetrics(s, 'commercial', g, 'PERSON');
      const com = catMetrics(s, 'commercial', g, 'COMPANY');
      const opf = s.commercial[g].opf;
      const opfR = opf.tp + opf.fn ? opf.tp / (opf.tp + opf.fn) : 1;
      console.log(
        `[genres] ${label} ${g}: PERSON P ${per.precision.toFixed(3)} R ${per.recall.toFixed(3)}; COMPANY P ${com.precision.toFixed(3)} (ложных ${com.fp}); ОПФ R ${opfR.toFixed(3)}`,
      );
      if (per.precision < K6_PERSON_PRECISION || per.recall < K6_PERSON_RECALL) fails.push(`К6 ${g}`);
      if (com.precision < K7_COMPANY_PRECISION || opfR < K7_OPF_RECALL) fails.push(`К7 ${g}`);
    }
    for (const d of withModel.docs.filter((x) => x.mode === 'commercial' && x.genre === 'proposal'))
      if ((d.perCat.COMPANY?.fp ?? 0) > K7_PROPOSAL_FALSE_COMPANY) fails.push(`К7 ложные ORG ${d.name}.${d.format}`);
    if (fails.length) console.log(`[genres] не пройдены гейты: ${fails.join(', ')}${ENFORCE_MODEL_GATES ? '' : ' (гейты не включены, GENRES_MODEL_GATES=1)'}`);
    if (ENFORCE_MODEL_GATES) expect(fails).toEqual([]);
  });
});

describe.skipIf(!PRIVATE)('настоящие документы (PRIVATE_FIXTURES=1, tests/fixtures/private)', () => {
  it('прогон без падения; в выводе только счётчики по категориям, без значений', async () => {
    const provider = MODEL_DIR ? await loadNerProvider(MODEL_DIR) : null;
    try {
      const priv = await evaluatePrivate({ nerProvider: provider });
      console.log(`[genres] private: ${priv.length} документов`);
      for (const p of priv) {
        expect(p.file).toMatch(/^документ \d+/);
        if (p.error) {
          console.log(`[genres]   ${p.file}: не открыт (${p.error})`);
          continue;
        }
        for (const [mode, m] of Object.entries(p.modes)) {
          // только имена категорий и числа
          for (const [k, v] of Object.entries(m.counts)) {
            expect(k).toMatch(/^[A-Z_]+$/);
            expect(typeof v).toBe('number');
          }
          console.log(`[genres]   ${p.file} ${mode}: ${JSON.stringify(m.counts)}${m.metrics ? ` gold ${JSON.stringify(m.metrics)}` : ''}`);
        }
      }
    } finally {
      provider?.dispose?.();
    }
  }, 300000);
});

// summarize экспортируется для eval-genres --json; проверка формы сводки
describe('сводка отчёта', () => {
  it('summarize считает точность и полноту по категориям', () => {
    const s = summarize([
      {
        mode: 'normal',
        genre: 'x',
        perCat: { PERSON: { tp: 3, fp: 1, fn: 1 } },
        opf: { tp: 0, fn: 0 },
        leaks: [],
        partial: [],
        negHits: [],
        companyNonList: 0,
      },
    ]);
    expect(s.normal.x.cats.PERSON).toMatchObject({ precision: 0.75, recall: 0.75 });
  });
});
