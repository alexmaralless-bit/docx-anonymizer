// Приёмка WP2 на образце договора: обе стороны, оба директора во всех падежах и сокращениях,
// оба адреса — одна группа на лицо/компанию; лишних PERSON/COMPANY/ADDRESS нет.
import { describe, it, expect, beforeAll } from 'vitest';
import { buildSampleDocx } from '../../../scripts/make-sample.mjs';
import { parseDocx } from '../../../src/core/docx/model.js';
import { analyze } from '../../../src/core/detect/runner.js';
import { applyDecisions } from '../../../src/core/apply.js';
import { defaultSettings } from '../../../src/core/settings.js';
import { registerNames } from './helpers.js';
import { unzipText } from '../../helpers/docx.js';

let gold;
let doc;
let res;
const groupsOf = (cat) => res.groups.filter((g) => g.category === cat);
const groupWith = (cat, text) => groupsOf(cat).filter((g) => g.occurrences.some((o) => o.text.slice(o.keepPrefix, o.text.length - o.keepSuffix) === text));

beforeAll(async () => {
  registerNames();
  const s = buildSampleDocx();
  gold = s.gold;
  doc = parseDocx(s.bytes);
  res = await analyze(doc, defaultSettings());
});

describe('образец договора (WP2)', () => {
  it('стороны: две компании, каждая — одна группа со всеми вхождениями', () => {
    const comps = groupsOf('COMPANY');
    expect(comps.map((g) => g.value)).toEqual([gold.company1, gold.company2]);
    const [romashka, vector] = comps;
    // преамбула (разбита по ранам), колонтитул, реквизиты, docProps
    expect(romashka.occurrences.length).toBeGreaterThanOrEqual(5);
    expect(new Set(romashka.occurrences.map((o) => o.part))).toEqual(
      new Set(['word/document.xml', 'word/header1.xml', 'docProps/app.xml', 'docProps/core.xml']),
    );
    expect(romashka.occurrences.every((o) => o.text === `ООО «${gold.company1}»` && o.keepPrefix === 5 && o.keepSuffix === 1)).toBe(true);
    // «Вектор-М» без ОПФ в метаданных — KB-вариант той же стороны
    expect(vector.occurrences.some((o) => o.text === gold.company2 && o.confidence === 'kb')).toBe(true);
  });

  it('директор Поставщика: все падежи и сокращения — одна группа', () => {
    const forms = [gold.person1Gen, gold.person1, gold.person1Short, gold.person1ShortGen];
    const groups = new Set(forms.flatMap((f) => groupWith('PERSON', f)));
    expect(groups.size).toBe(1);
    const g = [...groups][0];
    expect(g.value).toBe(gold.person1);
    for (const f of forms)
      expect(
        g.occurrences.some((o) => o.text === f),
        f,
      ).toBe(true);
    // преамбула, п. 2.2, текстовое поле, alt-тексты, подпись, сноска, docProps
    expect(g.occurrences.length).toBeGreaterThanOrEqual(10);
  });

  it('директор Покупателя: родительный падеж и «Фамилия И.О.» — одна группа', () => {
    const groups = new Set([gold.person2Gen, gold.person2Short].flatMap((f) => groupWith('PERSON', f)));
    expect(groups.size).toBe(1);
  });

  it('адреса: два адреса — две группы, по одному вхождению', () => {
    const addr = groupsOf('ADDRESS');
    expect(addr.map((g) => g.value)).toEqual([gold.address1, gold.address2]);
    expect(addr.every((g) => g.level === 'labeled')).toBe(true);
  });

  it('нет ложных PERSON: только директора и авторы правок', () => {
    const extra = groupsOf('PERSON').filter((g) => ![gold.person1, gold.person2Gen, gold.author1, gold.author2].includes(g.value));
    expect(extra.map((g) => g.value)).toEqual([]);
  });

  it('после замены в document.xml нет ФИО директоров, названий и адресов', () => {
    const out = applyDecisions(doc, res.groups, { mode: 'placeholder', placeholderLanguage: 'ru', createdAt: '2026-10-04T00:00:00Z' });
    const files = unzipText(out.docxBytes);
    const all = Object.values(files).join('\n');
    for (const v of [
      gold.person1,
      gold.person1Gen,
      gold.person1Short,
      gold.person1ShortGen,
      gold.person2Gen,
      gold.person2Short,
      gold.address1,
      gold.address2,
      `«${gold.company1}»`,
      gold.company2,
    ]) {
      expect(all.includes(v), v).toBe(false);
    }
    const text = parseDocx(out.docxBytes)
      .streams.map((s) => s.text)
      .join('\n');
    expect(text).toContain('ООО «[КОМПАНИЯ_1]», ИНН');
    expect(text).toContain('в лице генерального директора [ФИО_1],');
    expect(text).toContain('Юридический адрес: [АДРЕС_1]');
  });
});
