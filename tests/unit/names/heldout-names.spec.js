// WP11-D (ревью, отложенный набор): профессия перед именем — не фамилия; одиночная фамилия после профессии; латиница
// с диакритикой и «McAllister»; имя строкой целиком капсом («OLIVER BRANNIGAN»); одиночная фамилия и «Фамилия И.» — варианты
// лица с полным именем, в том числе найденного моделью. Все имена вымышленные.
import { describe, it, expect, beforeEach } from 'vitest';
import { tokenize } from '../../../src/core/detect/names/text.js';
import { isRoleNoun } from '../../../src/core/detect/names/lexicon.js';
import { analyzeParagraphs, registerNames, docFromParagraphs } from './helpers.js';
import { analyze } from '../../../src/core/detect/runner.js';
import { defaultSettings } from '../../../src/core/settings.js';

const persons = (r) => r.entities.filter((e) => e.category === 'PERSON').map((e) => e.text);

describe('лексика и токены', () => {
  it('профессии — роль, а не фамилия; фамилии словаря на «-ов» — не профессии', () => {
    for (const w of ['Сотрудник', 'курьер', 'курьера', 'аналитику', 'Секретарь']) expect(isRoleNoun(w), w).toBe(true);
    for (const w of ['Мастеров', 'Кассиров', 'Ахмедов']) expect(isRoleNoun(w), w).toBe(false);
  });
  it('латиница с диакритикой и с заглавной внутри после Mc/Mac — одно слово', () => {
    expect(tokenize('Tomasz Wiśniewski, Fiona McAllister, MÜLLER').map((t) => `${t.text}:${t.script}`)).toEqual([
      'Tomasz:lat',
      'Wiśniewski:lat',
      'Fiona:lat',
      'McAllister:lat',
      'MÜLLER:lat',
    ]);
  });
});

describe('правила и база лиц', () => {
  beforeEach(() => registerNames());

  it('«Сотрудник Кирилл Ахмедов» — лицо без профессии; «согласован с Ахмедовым» — вариант того же лица', async () => {
    const r = await analyzeParagraphs(['Сотрудник Кирилл Ахмедов подготовил отчёт.', 'Отчёт согласован с Ахмедовым.']);
    expect(persons(r)).toEqual(['Кирилл Ахмедов', 'Ахмедовым']);
    expect(r.groups.filter((g) => g.category === 'PERSON')).toHaveLength(1);
  });

  it('одиночная фамилия после профессии со строчной — PERSON; имя после профессии — не она', async () => {
    const r = await analyzeParagraphs(['Машину привезли через три недели, курьер Абдуллаев отказался поднять её в квартиру.']);
    expect(persons(r)).toEqual(['Абдуллаев']);
  });

  it('латинская фамилия одним словом после полного имени — вариант («John Whitfield» → «Whitfield»)', async () => {
    const r = await analyzeParagraphs(['Participants: John Whitfield, consultant.', 'Whitfield will approve the budget.']);
    expect(persons(r)).toEqual(['John Whitfield', 'Whitfield']);
    expect(r.groups.filter((g) => g.category === 'PERSON')).toHaveLength(1);
  });

  it('имя строкой целиком капсом и подпись письма — PERSON', async () => {
    const r = await analyzeParagraphs(['OLIVER BRANNIGAN', 'Senior Data Engineer', 'Kind regards,', 'Fiona McAllister']);
    expect(persons(r)).toEqual(['OLIVER BRANNIGAN', 'Fiona McAllister']);
  });

  it('лицо, найденное только моделью, — запись базы: одиночная фамилия и «Фамилия И.» находятся правилами', async () => {
    const paras = [
      'Обучение завершил Олжас Нурланов.',
      'Пропуск передать Нурланову О.',
      'Нурланов вышел на работу.',
      'Our engineer, Priya Raghunathan, will visit you.',
      'Raghunathan will call.',
    ];
    const stub = (names) => ({
      name: 'stub',
      init: async () => {},
      detect: async (text) =>
        names.flatMap((n) => {
          const i = text.indexOf(n);
          return i < 0 ? [] : [{ start: i, end: i + n.length, label: 'PER', score: 0.99 }];
        }),
    });
    const doc = docFromParagraphs(paras);
    // WP11-E: «Нурланову О.» без модели — «Фамилия И.» по суффиксу фамилии (К11: было ни одного лица)
    expect(persons(await analyze(doc, defaultSettings()))).toEqual(['Нурланову О.']);
    const r = await analyze(doc, defaultSettings(), { nerProvider: stub(['Олжас Нурланов', 'Priya Raghunathan']) });
    expect(persons(r).sort()).toEqual(['Олжас Нурланов', 'Нурланову О.', 'Нурланов', 'Priya Raghunathan', 'Raghunathan'].sort());
  });
});

describe('ревью WP11-D (3): имя или фамилия после профессии — PERSON без профессии', () => {
  beforeEach(() => registerNames());
  it('профессия с заглавной и со строчной, метка реплики «Роль Имя:»', async () => {
    const cases = [
      ['09:03 Оператор Алина: Добрый день!', 'Алина'],
      ['Сотрудник Кирилл подготовил отчёт.', 'Кирилл'],
      ['[10:02] Консультант Марина: Здравствуйте!', 'Марина'],
      ['Водитель Рашид позвонит за час.', 'Рашид'],
      ['Бухгалтер Петрова подписала акт.', 'Петрова'],
      ['Инженер Захарченко выехал на объект.', 'Захарченко'],
      ['Документы привёз курьер Абдуллаев.', 'Абдуллаев'],
    ];
    for (const [t, w] of cases) expect(persons(await analyzeParagraphs([t])), t).toEqual([w]);
  });
  it('после профессии не имя и не фамилия — ничего; пара «Имя Фамилия» — целиком', async () => {
    expect(persons(await analyzeParagraphs(['Оператор Связи ответит позже.']))).toEqual([]);
    expect(persons(await analyzeParagraphs(['Оператор Алина Петрова ответит позже.']))).toEqual(['Алина Петрова']);
  });
});
