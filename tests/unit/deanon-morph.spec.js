// Склонение ФИО при восстановлении (FR-37 в редакции 0.2): разбор значения, падеж по контексту, вид слов.
import { describe, it, expect } from 'vitest';
import { CASES, parsePersonValue, detectCase, declineParsed, declineInContext } from '../../src/core/deanon-morph.js';

const brief = (p) => p && { form: p.form, gender: p.gender, lemmas: p.lemmas, roles: p.words.map((w) => w.role) };

describe('parsePersonValue: формы записи', () => {
  it.each([
    ['Иванов Пётр Сергеевич', 'SFP', 'm', { surname: 'иванов', first: 'петр', patronymic: 'сергеевич' }, ['surname', 'first', 'patronymic']],
    ['Семён Фёдорович Лебедев', 'FPS', 'm', { surname: 'лебедев', first: 'семен', patronymic: 'федорович' }, ['first', 'patronymic', 'surname']],
    ['Шевчук Мария', 'SF', 'f', { surname: 'шевчук', first: 'мария' }, ['surname', 'first']],
    ['Олег Ткаченко', 'FS', 'm', { surname: 'ткаченко', first: 'олег' }, ['first', 'surname']],
    ['Сидоров П.С.', 'S_INI', 'm', { surname: 'сидоров' }, ['surname', 'ini']],
    ['А.В. Кузнецова', 'INI_S', 'f', { surname: 'кузнецова' }, ['ini', 'surname']],
    ['П. С. Иванов', 'INI_S', 'm', { surname: 'иванов' }, ['ini', 'ini', 'surname']],
    ['Громов', 'S', 'm', { surname: 'громов' }, ['surname']],
    ['Анна', 'F', 'f', { first: 'анна' }, ['first']],
  ])('%s → %s', (value, form, gender, lemmas, roles) => {
    expect(brief(parsePersonValue(value))).toEqual({ form, gender, lemmas, roles });
  });

  it('значение в косвенном падеже лемматизируется', () => {
    expect(brief(parsePersonValue('Иванова Петра Сергеевича'))).toMatchObject({
      form: 'SFP',
      gender: 'm',
      lemmas: { surname: 'иванов', first: 'петр', patronymic: 'сергеевич' },
    });
    expect(brief(parsePersonValue('Королёвой Любови'))).toMatchObject({ form: 'SF', gender: 'f', lemmas: { surname: 'королева', first: 'любовь' } });
  });

  it('неоднозначные и нерусские значения → null', () => {
    expect(parsePersonValue('Ким Ли')).toBeNull(); // ни словарного имени, ни фамильного суффикса
    expect(parsePersonValue('Смирнова Голубева')).toBeNull(); // суффикс у обоих слов
    expect(parsePersonValue('Громову')).toBeNull(); // косвенная одиночная фамилия: «громов» (м.) и «громова» (ж.)
    expect(parsePersonValue('John Smith')).toBeNull();
    expect(parsePersonValue('Иванов John')).toBeNull();
    expect(parsePersonValue('Иванов 2')).toBeNull();
    expect(parsePersonValue('П.С.')).toBeNull();
    expect(parsePersonValue('')).toBeNull();
  });

  it('род: по отчеству, по словарю имён, по суффиксу, по голосованию вариантов', () => {
    expect(parsePersonValue('Петрова Анна Ивановна').gender).toBe('f'); // отчество
    expect(parsePersonValue('Шевчук Олег').gender).toBe('m'); // словарь имён
    expect(parsePersonValue('Любовь Королёва').gender).toBe('f'); // суффикс фамилии
    expect(parsePersonValue('Кузнецова А.В.').gender).toBe('f'); // «именительный первым»
    const voted = parsePersonValue('Иванова П.С.', ['Иванов П.С.', 'Иванову П.С.']);
    expect([voted.gender, voted.lemmas.surname]).toEqual(['m', 'иванов']);
    expect(parsePersonValue('Чайковского', []).lemmas).toEqual({ surname: 'чайковский' }); // ровно одна сильная лемма
    expect(parsePersonValue('Громову', ['Громов']).lemmas).toEqual({ surname: 'громов' }); // спор решают варианты
  });
});

describe('detectCase: приклеенное окончание', () => {
  it.each([
    ['а', 1],
    ['я', 1],
    ['у', 2],
    ['ю', 2],
    ['ым', 4],
    ['им', 4],
    ['ом', 4],
    ['ем', 4],
    ['е', 5],
    ['и', 5],
    ['ого', 1],
    ['его', 1],
    ['ому', 2],
    ['ему', 2],
  ])('м.р. -%s → %i', (end, idx) => {
    expect(detectCase({ after: `${end} …`, gender: 'm' })).toEqual({ idx, consumed: end.length, source: 'suffix' });
  });

  it.each([
    ['ой', 1],
    ['ою', 4],
    ['ы', 1],
    ['и', 1],
    ['е', 2],
    ['у', 3],
    ['ую', 3],
  ])('ж.р. -%s → %i', (end, idx) => {
    expect(detectCase({ after: `${end}.`, gender: 'f' })).toEqual({ idx, consumed: end.length, source: 'suffix' });
  });

  it('ж.р. -ой и -е сужаются предлогом', () => {
    expect(detectCase({ before: 'с ', after: 'ой', gender: 'f' }).idx).toBe(4);
    expect(detectCase({ before: 'к ', after: 'ой', gender: 'f' }).idx).toBe(2);
    expect(detectCase({ before: 'о ', after: 'ой', gender: 'f' }).idx).toBe(5);
    expect(detectCase({ before: 'про ', after: 'ой', gender: 'f' }).idx).toBe(1); // вин. не в наборе -ой → родительный
    expect(detectCase({ before: 'о ', after: 'е', gender: 'f' }).idx).toBe(5);
    expect(detectCase({ before: '', after: 'е', gender: 'f' }).idx).toBe(2);
  });

  it('окончание сильнее предлога; регистр окончания не важен', () => {
    expect(detectCase({ before: 'к ', after: 'а.', gender: 'm' })).toEqual({ idx: 1, consumed: 1, source: 'suffix' });
    expect(detectCase({ after: 'У.', gender: 'm' })).toEqual({ idx: 2, consumed: 1, source: 'suffix' });
  });

  it('незнакомое или длинное окончание не потребляется', () => {
    expect(detectCase({ after: 'ых ', gender: 'm' })).toBeNull();
    expect(detectCase({ before: 'от ', after: 'ых ', gender: 'm' })).toEqual({ idx: 1, consumed: 0, source: 'prep' });
    expect(detectCase({ after: 'ский', gender: 'm' })).toBeNull();
    expect(detectCase({ after: 'ам ', gender: 'f' })).toBeNull();
    expect(detectCase({ after: ' у', gender: 'm' })).toBeNull(); // через пробел — не окончание
  });
});

describe('detectCase: предлоги', () => {
  const PREPS = {
    1: ['у', 'от', 'для', 'без', 'до', 'из', 'после', 'кроме', 'около', 'вместо', 'против', 'ради', 'возле'],
    2: ['к', 'ко', 'по', 'благодаря', 'согласно', 'вопреки'],
    3: ['про', 'через'],
    4: ['с', 'со', 'перед', 'передо', 'между', 'над'],
    5: ['о', 'об', 'обо', 'при'],
  };
  for (const [idx, list] of Object.entries(PREPS)) {
    it.each(list)(`«%s» → ${CASES[idx]}`, (p) => {
      expect(detectCase({ before: `Текст ${p} `, gender: 'm' })).toEqual({ idx: Number(idx), consumed: 0, source: 'prep' });
    });
  }

  it.each(['от имени', 'в адрес', 'в лице', 'со стороны', 'на имя'])('двухсловное «%s» → родительный', (p) => {
    expect(detectCase({ before: `Действует ${p} `, gender: 'f' })).toEqual({ idx: 1, consumed: 0, source: 'prep' });
  });

  it.each(['в', 'на', 'за', 'под'])('«%s» — решения нет', (p) => {
    expect(detectCase({ before: `Доверенность ${p} `, gender: 'm' })).toBeNull();
  });

  it('мостики между предлогом и меткой', () => {
    for (const b of [
      'г-н',
      'г-на',
      'г-жи',
      'гражданина',
      'господину',
      'госпожой',
      'уважаемому',
      'директора',
      'представителю',
      'истца',
      'ответчику',
      'заявителя',
    ]) {
      expect(detectCase({ before: `письмо от ${b} `, gender: 'm' }), b).toMatchObject({ idx: 1, source: 'prep' });
    }
    expect(detectCase({ before: 'к уважаемому г-ну ', gender: 'm' })).toMatchObject({ idx: 2 });
    expect(detectCase({ before: 'в адрес г-на ', gender: 'm' })).toMatchObject({ idx: 1 });
  });

  it('должности — мостики: «в лице генерального директора», «председателя правления» → родительный', () => {
    for (const b of [
      'в лице генерального директора ',
      'в лице Генерального директора ',
      'в лице исполнительного директора ',
      'в лице заместителя генерального директора ',
      'в лице председателя правления ',
      'от имени генерального директора ',
      'в лице главного бухгалтера ',
      'в лице управляющего ',
      'от первого заместителя ',
      'в лице индивидуального предпринимателя ',
      'в лице ИП ',
      'в лице учредителя ',
      'от имени участника ',
      'в лице адвоката ',
      'в лице доверителя ',
    ]) {
      expect(detectCase({ before: `Общество, ${b}`, gender: 'f' }), b).toMatchObject({ idx: 1, source: 'prep' });
    }
    expect(detectCase({ before: 'от уважаемого господина директора ', gender: 'm' })).toMatchObject({ idx: 1 });
  });

  it('консервативно: слова после должности не мостики, без предлога — именительный', () => {
    expect(detectCase({ before: 'в лице представителя по доверенности ', gender: 'm' })).toBeNull();
    expect(detectCase({ before: 'в отношении главного бухгалтера ', gender: 'f' })).toBeNull();
    expect(detectCase({ before: 'в лице директора по развитию ', gender: 'm' })).toBeNull();
    expect(detectCase({ before: 'Договор заключён в суде, генеральный директор ', gender: 'm' })).toBeNull();
    expect(detectCase({ before: 'в главной роли ', gender: 'm' })).toBeNull();
  });

  it('окно: не дальше 6 слов, не через запятую и посторонние слова; кавычки и Markdown не мешают', () => {
    // предлог седьмым словом — вне окна
    expect(detectCase({ before: 'от г-на уважаемого господина заместителя генерального директора ', gender: 'm' })).toBeNull();
    expect(detectCase({ before: 'от уважаемого господина заместителя генерального директора ', gender: 'm' })).toMatchObject({ idx: 1 });
    expect(detectCase({ before: 'с ООО «Ромашка» подписал ', gender: 'm' })).toBeNull();
    expect(detectCase({ before: 'от, ', gender: 'm' })).toBeNull();
    expect(detectCase({ before: 'отказано. ', gender: 'm' })).toBeNull();
    expect(detectCase({ before: 'до. ', gender: 'm' })).toBeNull();
    expect(detectCase({ before: 'письмо от **', gender: 'm' })).toMatchObject({ idx: 1 });
    expect(detectCase({ before: 'копия (для ', gender: 'm' })).toMatchObject({ idx: 1 });
    expect(detectCase({ before: 'ОТ ', gender: 'm' })).toMatchObject({ idx: 1 });
    expect(detectCase({ before: 'пот', gender: 'm' })).toBeNull(); // метка приклеена к слову
  });
});

describe('detectCase: сочинение', () => {
  it('«и» или запятая между метками → падеж предыдущей', () => {
    expect(detectCase({ before: 'от [ФИО_1] и ', gender: 'f', prevCase: 1, gap: ' и ' })).toEqual({ idx: 1, consumed: 0, source: 'coord' });
    expect(detectCase({ before: 'к [ФИО_1], ', gender: 'f', prevCase: 2, gap: ', ' })).toEqual({ idx: 2, consumed: 0, source: 'coord' });
  });
  it('другой текст между метками или именительный — нет', () => {
    expect(detectCase({ before: 'от [ФИО_1], а также ', gender: 'f', prevCase: 1, gap: ', а также ' })).toBeNull();
    expect(detectCase({ before: 'и ', gender: 'f', prevCase: 0, gap: ' и ' })).toBeNull();
    expect(detectCase({ before: 'и ', gender: 'f' })).toBeNull();
  });
});

describe('declineParsed / declineInContext: вид слов', () => {
  it('ВСЕ ЗАГЛАВНЫЕ остаются заглавными, «Пётр» теряет «ё» в косвенных падежах', () => {
    const p = parsePersonValue('ИВАНОВ ПЁТР СЕРГЕЕВИЧ');
    expect(declineParsed(p, 0)).toBe('ИВАНОВ ПЁТР СЕРГЕЕВИЧ');
    expect(declineParsed(p, 4)).toBe('ИВАНОВЫМ ПЕТРОМ СЕРГЕЕВИЧЕМ');
    expect(declineParsed(parsePersonValue('Иванов Пётр Сергеевич'), 1)).toBe('Иванова Петра Сергеевича');
  });

  it('«ё» копируется по общему префиксу', () => {
    expect(declineParsed(parsePersonValue('Семён Фёдорович Лебедев'), 2)).toBe('Семёну Фёдоровичу Лебедеву');
    expect(declineParsed(parsePersonValue('Любовь Королёва'), 4)).toBe('Любовью Королёвой');
  });

  it('двойная фамилия склоняется по частям, заглавные — у каждой части', () => {
    expect(declineParsed(parsePersonValue('Римский-Корсаков Николай Андреевич'), 1)).toBe('Римского-Корсакова Николая Андреевича');
    expect(declineParsed(parsePersonValue('Петрова-Водкина Анна'), 2)).toBe('Петровой-Водкиной Анне');
  });

  it('инициалы и разделители сохраняются', () => {
    expect(declineParsed(parsePersonValue('П. С. Иванов'), 2)).toBe('П. С. Иванову');
    expect(declineParsed(parsePersonValue('Иванов  П.С.'), 4)).toBe('Ивановым  П.С.');
  });

  it('declineInContext: null, если подставить как есть; именительный для косвенного value', () => {
    expect(declineInContext('Иванов Пётр Сергеевич', { before: 'Подписал ' })).toBeNull();
    expect(declineInContext('Иванов Пётр Сергеевич', { before: 'на ' })).toBeNull();
    expect(declineInContext('John Smith', { before: 'от ' })).toBeNull();
    expect(declineInContext('Иванова Петра Сергеевича', { before: 'от ' })).toBeNull();
    expect(declineInContext('Иванова Петра Сергеевича', {})).toEqual({ text: 'Иванов Петр Сергеевич', case: 'nom', consumed: 0 });
    expect(declineInContext('Иванов Пётр Сергеевич', { after: 'у.' })).toEqual({ text: 'Иванову Петру Сергеевичу', case: 'dat', consumed: 1 });
    expect(declineInContext('Олег Ткаченко', { after: 'ым ' })).toEqual({ text: 'Олегом Ткаченко', case: 'ins', consumed: 2 });
  });
});
