import { describe, it, expect, beforeEach } from 'vitest';
import { parseDocx } from '../../src/core/docx/model.js';
import { analyze } from '../../src/core/detect/runner.js';
import { applyDecisions } from '../../src/core/apply.js';
import { clearDetectors, registerDetector, registerDocumentDetector, mergeDecisions } from '../../src/core/contracts/index.js';
import { defaultSettings } from '../../src/core/settings.js';

/** Коммерческая группа включена (политика 0.4): COMPANY ищется, как в 0.3. */
const commercial = (patch = {}) => ({ ...defaultSettings(), commercial: true, ...patch });
import { PlaceholderAllocator } from '../../src/core/placeholders.js';
import { makeDocx, run, para, unzipText } from '../helpers/docx.js';

const reAll = (re, text, extra = {}) => [...text.matchAll(re)].map((m) => ({ start: m.index, end: m.index + m[0].length, confidence: 'labeled', ...extra }));

describe('analyze: конвейер детекторов', () => {
  beforeEach(() => {
    clearDetectors();
    registerDetector('INN', (t) => reAll(/\b\d{10}\b/g, t, { confidence: 'validated', validator: 'inn' }));
    registerDetector('COMPANY', (t) =>
      [...t.matchAll(/ООО «([^»]+)»/g)].map((m) => ({ start: m.index, end: m.index + m[0].length, confidence: 'labeled', keepPrefix: 5, keepSuffix: 1 })),
    );
    registerDetector('SWIFT', (t) => reAll(/\bCONTRACT\b/g, t, { confidence: 'weak' })); // weak для SWIFT запрещён
    registerDetector('AMOUNT', (t) => reAll(/\d+ руб\./g, t)); // AMOUNT выключен по умолчанию
  });

  it('группирует, нумерует по порядку обхода, фильтрует уровни и выключенные категории', async () => {
    const doc = parseDocx(
      makeDocx(para(run('ООО «Ромашка», ИНН 7736050003, CONTRACT, 100 руб.')) + para(run('Повторно: ИНН 7736050003 и 5004001234; ООО «Вектор»'))),
    );
    const r = await analyze(doc, commercial());
    const view = r.groups.map((g) => [g.category, g.value, g.placeholder, g.occurrences.length]);
    expect(view).toEqual([
      ['COMPANY', 'Ромашка', '[КОМПАНИЯ_1]', 1],
      ['INN', '7736050003', '[ИНН_1]', 2],
      ['INN', '5004001234', '[ИНН_2]', 1],
      ['COMPANY', 'Вектор', '[КОМПАНИЯ_2]', 1],
    ]);
    expect(r.stats.entities).toBe(4);
  });

  it('ОПФ и кавычки остаются вне плейсхолдера; маппинг и режимы', async () => {
    const doc = parseDocx(makeDocx(para(run('ООО «Ромашка», ИНН 7736050003'))));
    const r = await analyze(doc, commercial());
    const out = applyDecisions(doc, r.groups, { mode: 'placeholder', createdAt: '2026-01-01T00:00:00Z' });
    expect(unzipText(out.docxBytes)['word/document.xml']).toContain('ООО «[КОМПАНИЯ_1]», ИНН [ИНН_1]');
    const comp = out.mapping.entries.find((e) => e.category === 'COMPANY');
    expect(comp).toMatchObject({ placeholder: 'ООО «[КОМПАНИЯ_1]»', token: '[КОМПАНИЯ_1]', original: 'ООО «Ромашка»', value: 'Ромашка' });
    expect(out.mapping.entries.map((e) => e.category)).toEqual(['INN', 'COMPANY']);

    const masked = applyDecisions(doc, r.groups, { mode: 'mask' });
    expect(unzipText(masked.docxBytes)['word/document.xml']).toContain('ООО «XXXXXXX», ИНН XXXXXXXXXX');
    const del = applyDecisions(doc, mergeDecisions(r.groups, [{ entityId: r.groups[0].id, action: 'skip' }]), { mode: 'delete', placeholderLanguage: 'ru' });
    expect(unzipText(del.docxBytes)['word/document.xml']).toContain('ООО «Ромашка», ИНН [удалено]');
  });

  it('ручная замена побеждает режим (FR-26); исключённое вхождение не заменяется', async () => {
    const doc = parseDocx(makeDocx(para(run('ИНН 7736050003 и 7736050003'))));
    const r = await analyze(doc, commercial());
    const g = r.groups[0];
    const out = applyDecisions(
      doc,
      mergeDecisions(r.groups, [{ entityId: g.id, action: 'replace', replacement: 'ИНН-А', excludedOccurrences: [g.occurrences[1].id] }]),
      { mode: 'mask' },
    );
    expect(unzipText(out.docxBytes)['word/document.xml']).toContain('ИНН ИНН-А и 7736050003');
  });

  it('авторы правок/комментариев → PERSON; инициалы и userId получают плейсхолдер автора (FR-11)', async () => {
    const doc = parseDocx(
      makeDocx(para(run('Договор') + '<w:ins w:id="1" w:author="Петров Олег"><w:r><w:t>x</w:t></w:r></w:ins>'), {
        'word/comments.xml': `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0" w:author="Петров Олег" w:initials="ПО"><w:p><w:r><w:t>к</w:t></w:r></w:p></w:comment><w:comment w:id="1" w:author="Сидорова Анна" w:initials="СА"><w:p/></w:comment></w:comments>`,
      }),
    );
    const r = await analyze(doc, commercial());
    expect(r.groups.map((g) => [g.value, g.placeholder, g.occurrences.length])).toEqual([
      ['Петров Олег', '[ФИО_1]', 3],
      ['Сидорова Анна', '[ФИО_2]', 2],
    ]);
    const xml = unzipText(applyDecisions(doc, r.groups).docxBytes)['word/comments.xml'];
    expect(xml).toContain('w:author="[ФИО_1]" w:initials="[ФИО_1]"');
  });

  it('документный детектор (KB) добавляет варианты к основной сущности через canonical', async () => {
    registerDetector('PERSON', (t) => reAll(/Иванов Пётр/g, t));
    registerDocumentDetector('kb-test', (doc) =>
      doc.streams.flatMap((s) =>
        reAll(/Иванова Петра/g, s.text, { confidence: 'kb', source: 'kb', streamId: s.id, category: 'PERSON', canonical: 'иванов пётр' }),
      ),
    );
    const doc = parseDocx(makeDocx(para(run('в лице Иванова Петра')) + para(run('Иванов Пётр'))));
    const r = await analyze(doc, commercial());
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]).toMatchObject({ value: 'Иванов Пётр', placeholder: '[ФИО_1]', level: 'labeled' });
    expect(r.groups[0].occurrences.map((o) => o.variantOf)).toEqual(['Иванов Пётр', undefined]);
  });

  it('сущность не пересекает U+FFFC и \\n; сбой детектора → предупреждение, анализ продолжается', async () => {
    registerDetector('PERSON', () => [{ start: 0, end: 5, confidence: 'labeled' }]);
    registerDetector('ADDRESS', () => {
      throw new Error('boom');
    });
    const doc = parseDocx(makeDocx(para('<w:r><w:t>ab</w:t><w:br/><w:t>cd</w:t></w:r>')));
    const r = await analyze(doc, commercial());
    expect(r.groups).toHaveLength(0);
    expect(r.warnings.map((w) => w.code)).toContain('DETECTOR_FAILED');
  });

  it('NER: сбой провайдера → NER_FAILED (NFR-13); исключения пользователя применяются (FR-32)', async () => {
    const doc = parseDocx(makeDocx(para(run('ИНН 7736050003'))));
    const s = commercial({ exclusions: [{ value: '7736050003', category: 'INN' }] });
    const r = await analyze(doc, s, {
      nerProvider: {
        name: 'bad',
        init: async () => {},
        detect: async () => {
          throw new Error('oom');
        },
      },
    });
    expect(r.warnings.map((w) => w.code)).toContain('NER_FAILED');
    expect(r.groups).toHaveLength(0);
  });

  it('общий PlaceholderAllocator даёт сквозную нумерацию по файлам (§3.7)', async () => {
    const alloc = new PlaceholderAllocator('ru');
    const a = await analyze(parseDocx(makeDocx(para(run('ИНН 7736050003')))), defaultSettings(), { allocator: alloc });
    const b = await analyze(parseDocx(makeDocx(para(run('ИНН 5004001234, ИНН 7736050003')))), defaultSettings(), { allocator: alloc });
    expect(a.groups.map((g) => g.placeholder)).toEqual(['[ИНН_1]']);
    expect(b.groups.map((g) => g.placeholder)).toEqual(['[ИНН_2]', '[ИНН_1]']);
  });
  it('политика 0.4 (К1, К3): выключенная COMPANY не выдаётся правилами, но user и list принимаются; pii/ids нельзя выключить', async () => {
    registerDocumentDetector('list-stub', (doc) => {
      const s = doc.streams.find((x) => x.type === 'live');
      const i = s.text.indexOf('Вектор');
      return i < 0 ? [] : [{ streamId: s.id, category: 'COMPANY', start: i, end: i + 6, confidence: 'labeled', source: 'list', canonical: 'Вектор' }];
    });
    const doc = parseDocx(makeDocx(para(run('ООО «Ромашка», ИНН 7736050003, Вектор'))));
    const off = { ...defaultSettings(), categories: { ...defaultSettings().categories, INN: false, PERSON: false } };
    const r = await analyze(doc, off, {
      userEntities: [{ streamId: doc.streams[0].id, category: 'COMPANY', start: 0, end: 13, confidence: 'labeled', source: 'user' }],
    });
    const view = r.groups.map((g) => [g.category, g.value, g.occurrences[0].source]);
    // ИНН выключить нельзя (ids); «ООО «Ромашка»» правилом — нет (commercial выключен), но вручную — да; «Вектор» из списка — да
    expect(view).toEqual([
      ['COMPANY', 'ООО «Ромашка»', 'user'],
      ['INN', '7736050003', 'rule'],
      ['COMPANY', 'Вектор', 'list'],
    ]);
    const on = await analyze(doc, commercial());
    expect(on.groups.map((g) => [g.category, g.value])).toEqual([
      ['COMPANY', 'Ромашка'],
      ['INN', '7736050003'],
      ['COMPANY', 'Вектор'],
    ]);
  });

  it('NER (0.4, К10): у ORG свой порог nerThresholdOrg; фильтр получает вид блока; при выключенной COMPANY ORG не выдаётся', async () => {
    const seen = [];
    const provider = {
      name: 'stub',
      init: async () => {},
      detect: async (text) => {
        seen.push(text);
        const out = [];
        const add = (word, label, score) => {
          const i = text.indexOf(word);
          if (i >= 0) out.push({ start: i, end: i + word.length, label, score });
        };
        add('Иван Петров', 'PER', 0.75);
        add('Ромашка', 'ORG', 0.8);
        add('Вектор', 'ORG', 0.9);
        return out;
      },
    };
    const doc = parseDocx(makeDocx(para(run('Иван Петров, Ромашка и Вектор'))));
    const r = await analyze(doc, commercial({ nerThreshold: 0.7, nerThresholdOrg: 0.85 }), { nerProvider: provider });
    // PER 0.75 ≥ 0.7 — есть; ORG 0.8 < 0.85 — нет; ORG 0.9 — есть
    expect(r.groups.map((g) => [g.category, g.value])).toEqual([
      ['PERSON', 'Иван Петров'],
      ['COMPANY', 'Вектор'],
    ]);
    const off = await analyze(doc, { ...defaultSettings(), nerThreshold: 0.7, nerThresholdOrg: 0.5 }, { nerProvider: provider });
    expect(off.groups.map((g) => [g.category, g.value])).toEqual([['PERSON', 'Иван Петров']]);
    expect(doc.paragraphs[0].kind).toBe('p');
  });
});
