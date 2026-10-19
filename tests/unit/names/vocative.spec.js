// WP11-D (корпус жанров, К6): обращение одним именем в начале реплики или письма — PERSON уровня kb; омонимы
// нарицательных («Вера, надежда, любовь», «Роза ветров») — нет; обращение «Уважаемый» — вне плейсхолдера, восстановление
// «Уважаемый [ФИО_1]» → «Уважаемый Павел Николаевич».
import { describe, it, expect, beforeAll } from 'vitest';
import { findVocativeNames } from '../../../src/core/detect/names/vocative.js';
import { analyzeParagraphs, registerNames } from './helpers.js';
import { fromText, applyDecisions, deanonymize, defaultSettings, analyze } from '../../../src/core/index.js';

const names = (t) => findVocativeNames(t).map((v) => v.name);

describe('findVocativeNames', () => {
  it('имя из словаря в начале строки или после метки реплики, за ним запятая или «!»', () => {
    expect(names('Елена, спасибо, гляну сегодня.')).toEqual(['Елена']);
    expect(names('Наталья, добрый день! Пришли контакты.')).toEqual(['Наталья']);
    expect(names('Максим, привет')).toEqual(['Максим']);
    expect(names('[12.10.2026 10:20] Максим Савельев: Елена, спасибо')).toEqual(['Елена']);
    expect(names('10:42 Иван: Ольга, посмотри')).toEqual(['Ольга']);
    expect(names('Иван: Ольга!')).toEqual(['Ольга']);
    expect(names('Здравствуйте, Елена! Высылаю счёт.')).toEqual(['Елена']);
    expect(names('Добрый день, Максим.')).toEqual(['Максим']);
    expect(names('Anna, thanks for the update.')).toEqual(['Anna']);
    expect(names('Первая строка\nКирилл, привет')).toEqual(['Кирилл']);
  });

  it('позиции — в тексте потока', () => {
    const t = '[10:42] Иван: Ольга, привет';
    const [v] = findVocativeNames(t);
    expect(t.slice(v.start, v.end)).toBe('Ольга');
  });

  it('нарицательные омонимы и не имена — нет', () => {
    for (const t of [
      'Вера, надежда, любовь',
      'Вера, надежда и любовь',
      'Роза ветров',
      'Любовь к делу',
      'Слава богу',
      'Слава, честь и хвала',
      'Роман, написанный в 1869 году',
      'Итак, начнём',
      'Марта, как дела',
      'Поддержка: Добрый день!',
      'Мы с Еленой, как договорились',
      'Елена Тихонова: Добрый день!',
    ])
      expect(names(t), t).toEqual([]);
  });

  it('ревью WP11-D: повелительное наклонение после запятой — не перечисление, «и» — только отдельным словом', () => {
    expect(names('[10:30] Иван: Роман, подскажи пароль')).toEqual(['Роман']);
    expect(names('Иван: Вера, посмотри, пожалуйста')).toEqual(['Вера']);
    expect(names('Вера, посмотри задачу')).toEqual(['Вера']);
    expect(names('Иван: Роман, напиши отчёт')).toEqual(['Роман']);
    // омонимы в обычном тексте — по-прежнему нет
    for (const t of ['Роман, конечно, хороший.', 'Вера, надежда, любовь — так называется выставка.', 'Роза, лилия и мак']) expect(names(t), t).toEqual([]);
  });

  it('омоним с меткой реплики, приветствием или словом обращения — обращение', () => {
    expect(names('Иван: Вера, привет')).toEqual(['Вера']);
    expect(names('Лена, спасибо!')).toEqual(['Лена']);
    expect(names('Здравствуйте, Вера!')).toEqual(['Вера']);
    expect(names('Иван: Вера, надежда, любовь')).toEqual([]);
  });
});

describe('обращение в анализе (kb.js)', () => {
  beforeAll(() => registerNames());

  it('имя полного лица документа — та же метка; без полного лица — своя метка уровня kb', async () => {
    const r = await analyzeParagraphs([
      '[12.10.2026 10:15] Елена Тихонова: Добрый день! Отправила КП.',
      '[12.10.2026 10:20] Максим Савельев: Елена, спасибо, гляну сегодня.',
      'Ольга, добрый день! Жду ответа.',
    ]);
    const persons = r.groups.filter((g) => g.category === 'PERSON');
    const elena = persons.find((g) => g.occurrences.some((o) => o.text === 'Елена'));
    expect(elena.occurrences.map((o) => o.text)).toEqual(['Елена Тихонова', 'Елена']);
    const olga = persons.find((g) => g.value === 'Ольга');
    expect(olga.level).toBe('kb');
    expect(olga.placeholder).not.toBe(elena.placeholder);
  });

  it('два лица с одним именем — обращение получает свою метку', async () => {
    const r = await analyzeParagraphs(['Елена Тихонова: Добрый день!', 'Елена Смирнова: Привет!', 'Иван Петров: Елена, спасибо.']);
    const g = r.groups.find((x) => x.category === 'PERSON' && x.value === 'Елена');
    expect(g.occurrences).toHaveLength(1);
  });

  it('омонимы нарицательных в тексте не становятся PERSON', async () => {
    const r = await analyzeParagraphs(['Вера, надежда, любовь', 'Роза ветров', 'Любовь к делу', 'Слава богу, всё получилось.']);
    expect(r.groups.filter((g) => g.category === 'PERSON')).toEqual([]);
  });
});

describe('обращение «Уважаемый» — вне плейсхолдера (person.js, lexicon.js)', () => {
  beforeAll(() => registerNames());

  it('«Уважаемый Павел Николаевич!», «Уважаемая Марина Павловна» — PERSON без обращения', async () => {
    const r = await analyzeParagraphs([
      'Уважаемый Павел Николаевич!',
      'Уважаемая Марина Павловна, направляем акт.',
      'Уважаемый Иван Сергеевич Петров, добрый день.',
    ]);
    const texts = r.groups.filter((g) => g.category === 'PERSON').flatMap((g) => g.occurrences.map((o) => o.text));
    expect(texts).toEqual(['Павел Николаевич', 'Марина Павловна', 'Иван Сергеевич Петров']);
  });

  it('восстановление: «Уважаемый [ФИО_1]!» → «Уважаемый Павел Николаевич!» (и со склонением)', async () => {
    const doc = fromText([
      { kind: 'p', text: 'Уважаемый Павел Николаевич!', page: 1 },
      { kind: 'p', text: 'Просим подтвердить график.', page: 1 },
    ]);
    const a = await analyze(doc, defaultSettings());
    const res = applyDecisions(doc, a.groups, { textFormat: 'txt', placeholderLanguage: 'ru' });
    const out = new TextDecoder().decode(res.bytes);
    expect(out).toContain('Уважаемый [ФИО_1]!');
    expect(deanonymize('Уважаемый [ФИО_1]! Спасибо за ответ.', res.mapping).text).toBe('Уважаемый Павел Николаевич! Спасибо за ответ.');
    expect(deanonymize('Уважаемый [ФИО_1]!', res.mapping, { decline: true }).text).toBe('Уважаемый Павел Николаевич!');
  });
});
