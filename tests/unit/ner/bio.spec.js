// WP9: метки модели и слияние BIO (core/ner/bio.js): I без B, смена типа, средний score, подрезка краёв,
// решение по маргинальным вероятностям типов, мостики через пунктуацию, границы по соглашениям каталога (FR-18).
import { describe, it, expect } from 'vitest';
import { labelsToTags, decodeWord, bridgePunct, mergeBio, joinAdjacent, filterSpans, alignSpans, dedupeSpans } from '../../../src/core/ner/bio.js';

/** Слова текста (по пробелам и пунктуации) с тегами: «Иван/B-PER:0.9». */
function preds(text, tagged) {
  const out = [];
  let pos = 0;
  for (const item of tagged) {
    const [word, rest = 'O:1'] = item.split('/');
    const [lab, p] = rest.split(':');
    const start = text.indexOf(word, pos);
    pos = start + word.length;
    const [tag, type] = lab === 'O' ? ['O', null] : lab.split('-');
    out.push({ start, end: pos, tag, type, prob: Number(p) });
  }
  return out;
}

describe('labelsToTags', () => {
  it('BIO, голые типы (IO), синонимы типов, прочие → O', () => {
    expect(labelsToTags(['O', 'B-PER', 'I-PER', 'B-ORG', 'I-ORG', 'B-LOC', 'I-LOC'])).toEqual([
      { tag: 'O', type: null },
      { tag: 'B', type: 'PER' },
      { tag: 'I', type: 'PER' },
      { tag: 'B', type: 'ORG' },
      { tag: 'I', type: 'ORG' },
      { tag: 'B', type: 'LOC' },
      { tag: 'I', type: 'LOC' },
    ]);
    expect(labelsToTags(['PER', 'PERSON', 'ORGANIZATION', 'LOCATION', 'GPE', 'B-MISC', 'I-GPE', 'S-PER', 'E-ORG'])).toEqual([
      { tag: 'I', type: 'PER' },
      { tag: 'I', type: 'PER' },
      { tag: 'I', type: 'ORG' },
      { tag: 'I', type: 'LOC' },
      { tag: 'I', type: 'LOC' },
      { tag: 'O', type: null },
      { tag: 'I', type: 'LOC' },
      { tag: 'B', type: 'PER' },
      { tag: 'I', type: 'ORG' },
    ]);
  });
});

describe('decodeWord', () => {
  const tags = labelsToTags(['O', 'B-PER', 'I-PER', 'B-ORG', 'I-ORG', 'B-LOC', 'I-LOC']);
  it('тип — по сумме B и I: O 0.39 против PER 0.2 + 0.41', () => {
    const d = decodeWord([0.39, 0.2, 0.41, 0, 0, 0, 0], tags);
    expect(d.tag).toBe('I');
    expect(d.type).toBe('PER');
    expect(d.prob).toBeCloseTo(0.61, 6);
  });
  it('B при перевесе B; O при перевесе O; MISC считается O', () => {
    expect(decodeWord([0.1, 0.6, 0.3, 0, 0, 0, 0], tags)).toMatchObject({ tag: 'B', type: 'PER' });
    expect(decodeWord([0.5, 0.2, 0.1, 0.1, 0.1, 0, 0], tags)).toEqual({ tag: 'O', type: null, prob: 0.5 });
    const misc = labelsToTags(['O', 'B-MISC', 'B-PER']);
    expect(decodeWord([0.3, 0.4, 0.3], misc)).toMatchObject({ tag: 'O', type: null });
  });
});

describe('mergeBio', () => {
  const text = 'Иван Петров и ООО Ромашка в Москве';
  it('B открывает, I продолжает, O закрывает; score — средняя prob', () => {
    const s = mergeBio(preds(text, ['Иван/B-PER:0.9', 'Петров/I-PER:0.7', 'и', 'ООО/B-ORG:0.8', 'Ромашка/I-ORG:0.6', 'в', 'Москве/B-LOC:0.95']));
    expect(s.map((x) => [text.slice(x.start, x.end), x.label])).toEqual([
      ['Иван Петров', 'PER'],
      ['ООО Ромашка', 'ORG'],
      ['Москве', 'LOC'],
    ]);
    expect(s[0].score).toBeCloseTo(0.8, 6);
    expect(s[1].score).toBeCloseTo(0.7, 6);
  });
  it('I без B начинает спан; смена типа закрывает спан; B после B — новый спан', () => {
    const s = mergeBio(preds(text, ['Иван/I-PER:0.5', 'Петров/I-ORG:0.9', 'и', 'ООО/B-ORG:1', 'Ромашка/B-ORG:1', 'в', 'Москве/I-LOC:1']));
    expect(s.map((x) => [text.slice(x.start, x.end), x.label])).toEqual([
      ['Иван', 'PER'],
      ['Петров', 'ORG'],
      ['ООО', 'ORG'],
      ['Ромашка', 'ORG'],
      ['Москве', 'LOC'],
    ]);
  });
  it('с text: перенос строки и U+FFFC между словами закрывают спан', () => {
    const t = 'Директор\nИванов Пётр Сергеевич и Анна\uFFFCПетрова';
    const s = mergeBio(
      preds(t, ['Директор/B-PER:0.8', 'Иванов/I-PER:0.9', 'Пётр/I-PER:0.9', 'Сергеевич/I-PER:0.9', 'и', 'Анна/B-PER:0.9', 'Петрова/I-PER:0.9']),
      { text: t },
    );
    expect(s.map((x) => t.slice(x.start, x.end))).toEqual(['Директор', 'Иванов Пётр Сергеевич', 'Анна', 'Петрова']);
    // без text — прежнее поведение
    expect(mergeBio(preds(t, ['Директор/B-PER:0.8', 'Иванов/I-PER:0.9'])).map((x) => t.slice(x.start, x.end))).toEqual(['Директор\nИванов']);
  });
  it('withWords — число слов спана', () => {
    expect(mergeBio(preds(text, ['Иван/B-PER:1', 'Петров/I-PER:1']), { withWords: true })[0].words).toBe(2);
  });
});

describe('bridgePunct и joinAdjacent', () => {
  it('точка инициала и дефис без пробелов связывают слова одного типа', () => {
    const text = 'И.С. Римский-Корсаков пришёл.';
    const p = bridgePunct(
      preds(text, ['И/B-PER:0.9', './O:0.6', 'С/I-PER:0.9', './O:0.5', 'Римский/I-PER:0.8', '-/O:0.9', 'Корсаков/B-PER:0.7', 'пришёл', '.']),
      text,
    );
    const s = mergeBio(p);
    expect(s).toHaveLength(1);
    expect(text.slice(s[0].start, s[0].end)).toBe('И.С. Римский-Корсаков');
  });
  it('точка в конце предложения и дефис с пробелами не связывают', () => {
    const text = 'Иванов. Петров - Сидоров';
    const s = mergeBio(bridgePunct(preds(text, ['Иванов/B-PER:1', '.', 'Петров/B-PER:1', '-', 'Сидоров/B-PER:1']), text));
    expect(s).toHaveLength(3);
  });
  it('соседние спаны одного типа через пробел склеиваются (взвешенное среднее), через запятую — нет', () => {
    const text = 'Сибагатуллина Наталия Эдуардовна, Петров';
    const s = joinAdjacent(
      mergeBio(preds(text, ['Сибагатуллина/B-PER:0.9', 'Наталия/B-PER:0.6', 'Эдуардовна/I-PER:0.9', ',', 'Петров/B-PER:0.8']), { withWords: true }),
      text,
    );
    expect(s.map((x) => text.slice(x.start, x.end))).toEqual(['Сибагатуллина Наталия Эдуардовна', 'Петров']);
    expect(s[0].score).toBeCloseTo(0.8, 6);
    expect(s[0]).not.toHaveProperty('words');
  });
});

describe('filterSpans', () => {
  const sp = (text, value, label = 'PER') => {
    const start = text.indexOf(value);
    return { start, end: start + value.length, label, score: 0.9 };
  };
  const vals = (text, spans) => filterSpans(spans, text).map((x) => text.slice(x.start, x.end));

  it('подрезает пунктуацию по краям, парные кавычки внутри оставляет', () => {
    const t = 'Подписал: (Иванов Пётр), — ООО «Ромашка»; «Вектор» и «Альфа.';
    expect(vals(t, [sp(t, '(Иванов Пётр),'), sp(t, 'ООО «Ромашка»;', 'ORG'), sp(t, ' «Вектор» ', 'ORG'), sp(t, '«Альфа.', 'ORG')])).toEqual([
      'Иванов Пётр',
      'ООО «Ромашка»',
      '«Вектор»',
      'Альфа',
    ]);
  });
  it('точка инициала и сокращения ОПФ остаётся, точка конца предложения — нет', () => {
    const t = 'Подписал Иванов П. С. для Acme Ltd. и Петров.';
    expect(vals(t, [sp(t, 'Иванов П. С.'), sp(t, 'Acme Ltd.', 'ORG'), sp(t, 'Петров.')])).toEqual(['Иванов П. С.', 'Acme Ltd.', 'Петров']);
  });
  it('короче 2 символов, без букв или из одних шаблонных слов договора — выбрасываются', () => {
    const t = 'Я, 123, — настоящего Договора, Licensor, Mr. Smith, Москва';
    expect(
      vals(t, [
        sp(t, 'Я'),
        sp(t, '123', 'ORG'),
        sp(t, '—', 'LOC'),
        sp(t, 'настоящего Договора', 'ORG'),
        sp(t, 'Licensor', 'ORG'),
        sp(t, 'Mr'),
        sp(t, 'Mr. Smith'),
      ]),
    ).toEqual(['Mr. Smith']);
    // топонимы стоп-словами не фильтруются («Москва» есть в стоп-словах правил)
    expect(vals(t, [sp(t, 'Москва', 'LOC')])).toEqual(['Москва']);
  });
  // §6.7: ложные ORG финальной модели на колонтитулах и заголовках («Стр. 1» 0.88, «Лист 2» 0.76, «Раздел 3. …» 0.94)
  const one = (value, label) => vals(value, [sp(value, value, label)]);
  it('колонтитулы и заголовки (структурное слово + номер) — не ORG/LOC', () => {
    for (const v of [
      'Стр. 1',
      'Лист 2',
      'Раздел 3. Порядок расчётов',
      'Стр. 1 из 4',
      'Страница 5 из 12',
      'Приложение № 2. Стр. 3',
      'Приложению № 2',
      'Статья 5 — Ответственность сторон',
      'Пункт 4.1',
      'Глава IV. Права и обязанности',
      '§ 3. Предмет договора',
      'Форма 4',
      'СТРАНИЦА 7',
      'Page 3 of 10',
      'Section IV. Term',
      'Schedule 2',
    ]) {
      expect(one(v, 'ORG'), v).toEqual([]);
      expect(one(v, 'LOC'), v).toEqual([]);
    }
    // модель отдала ORG только структурное слово, номер — сразу за спаном
    const t = 'Лист 2 из 3. Раздел 5. Ответственность сторон. Форма заявки';
    expect(vals(t, [sp(t, 'Лист', 'ORG'), sp(t, 'Раздел', 'ORG'), sp(t, 'Форма', 'ORG')])).toEqual(['Форма']);
    // нарицательное (COMMON_NOUNS WP2) с номером без ОПФ и кавычек
    expect(one('Ромашка 2', 'ORG')).toEqual([]);
    // PER не трогается
    expect(one('Лист 2', 'PER')).toEqual(['Лист 2']);
  });
  it('названия со структурным словом остаются; ORG с ОПФ или в кавычках после номера отрезается от заголовка', () => {
    for (const v of ['ООО «Лист»', 'АО «Страница»', '«Раздел-Инвест»', 'Раздел-Инвест', '«Лист 2»', 'Таблица Менделеева', 'Сокол 2000 Холдинг']) {
      expect(one(v, 'ORG'), v).toEqual([v]);
    }
    expect(one('Листвянка', 'LOC')).toEqual(['Листвянка']);
    const t = 'Приложение № 2 ООО «Ромашка»; Schedule 1 Acme Ltd.; Раздел 3. Москва; Таблица 1. Реквизиты АО «Кедр»';
    expect(
      vals(t, [
        sp(t, 'Приложение № 2 ООО «Ромашка»', 'ORG'),
        sp(t, 'Schedule 1 Acme Ltd.', 'ORG'),
        sp(t, 'Раздел 3. Москва', 'LOC'),
        sp(t, 'Таблица 1. Реквизиты АО «Кедр»', 'ORG'),
      ]),
    ).toEqual(['ООО «Ромашка»', 'Acme Ltd.', 'АО «Кедр»']);
  });
});

describe('alignSpans', () => {
  const sp = (text, value, label) => {
    const start = text.indexOf(value);
    return { start, end: start + value.length, label, score: 0.9 };
  };
  const vals = (text, spans) => alignSpans(spans, text).map((x) => text.slice(x.start, x.end));

  it('ORG: кавычки и ОПФ перед названием, латинская ОПФ после', () => {
    const t = 'между ООО «Ромашка-Строй» и Общество с ограниченной ответственностью "Вектор", а также Acme Trading Ltd. и Beta GmbH';
    expect(vals(t, [sp(t, 'Ромашка', 'ORG'), sp(t, 'Вектор', 'ORG'), sp(t, 'Acme Trading', 'ORG'), sp(t, 'Beta', 'ORG')])).toEqual([
      'ООО «Ромашка-Строй»',
      'Общество с ограниченной ответственностью "Вектор"',
      'Acme Trading Ltd.',
      'Beta GmbH',
    ]);
  });
  it('ORG: одна ОПФ дотягивается до названия в кавычках; голая ОПФ выбрасывается; незакрытая кавычка закрывается', () => {
    const t = 'силами Акционерное общество «Росток «Плюс»» и ПАО, далее ПАО "Кедр-Сервис" и АО «Лотос';
    expect(vals(t, [sp(t, 'Акционерное общество', 'ORG'), sp(t, 'ПАО', 'ORG'), sp(t, 'ПАО "Кедр', 'ORG')])).toEqual([
      'Акционерное общество «Росток «Плюс»»',
      'ПАО "Кедр-Сервис"',
    ]);
  });
  it('PER: без обращения, с точкой последнего инициала', () => {
    const t = 'Mr. John Smith и Иванов П.С. подписали';
    expect(vals(t, [sp(t, 'Mr. John Smith', 'PER'), sp(t, 'Иванов П.С', 'PER')])).toEqual(['John Smith', 'Иванов П.С.']);
  });
  it('PER: без ведущей должности, обращения и роли; спан из одних таких слов выбрасывается', () => {
    const t1 = 'Директор Иванов Пётр Сергеевич подписал';
    expect(vals(t1, [sp(t1, 'Директор Иванов Пётр Сергеевич', 'PER')])).toEqual(['Иванов Пётр Сергеевич']);
    const t2 = 'Уважаемый Аркадий Валентинович, направляем';
    expect(vals(t2, [sp(t2, 'Уважаемый Аркадий Валентинович', 'PER')])).toEqual(['Аркадий Валентинович']);
    const t3 = 'генеральный директор Иванова Петра, г-жа Смирнова, гражданка Олейник, ИСПОЛНИТЕЛЬ: КУЗНЕЦОВ ГЕННАДИЙ, экспедитор Кравчук';
    expect(
      vals(t3, [
        sp(t3, 'генеральный директор Иванова Петра', 'PER'),
        sp(t3, 'г-жа Смирнова', 'PER'),
        sp(t3, 'гражданка Олейник', 'PER'),
        sp(t3, 'ИСПОЛНИТЕЛЬ: КУЗНЕЦОВ ГЕННАДИЙ', 'PER'),
        sp(t3, 'экспедитор Кравчук', 'PER'),
      ]),
    ).toEqual(['Иванова Петра', 'Смирнова', 'Олейник', 'КУЗНЕЦОВ ГЕННАДИЙ', 'Кравчук']);
    // одна должность — не имя; фамилия, начинающаяся как должность, не режется
    const t4 = 'Директор и Директоров Пётр';
    expect(vals(t4, [sp(t4, 'Директор', 'PER'), sp(t4, 'Директоров Пётр', 'PER')])).toEqual(['Директоров Пётр']);
  });
  it('LOC не меняется', () => {
    const t = 'в г. Москва.';
    expect(vals(t, [sp(t, 'Москва', 'LOC')])).toEqual(['Москва']);
  });
});

describe('провайдерная цепочка: «Директор\\nИванов Пётр Сергеевич»', () => {
  it('перенос строки отделяет должность, спан без «Директор» — один', () => {
    const t = 'Директор\nИванов Пётр Сергеевич';
    const p = preds(t, ['Директор/B-PER:0.9', 'Иванов/I-PER:0.95', 'Пётр/I-PER:0.95', 'Сергеевич/I-PER:0.95']);
    const spans = dedupeSpans(filterSpans(alignSpans(filterSpans(joinAdjacent(mergeBio(p, { withWords: true, text: t }), t), t), t), t), t);
    expect(spans.map((x) => [t.slice(x.start, x.end), x.label])).toEqual([['Иванов Пётр Сергеевич', 'PER']]);
  });
});

describe('dedupeSpans', () => {
  const at = (text, value, label, score, from = 0) => {
    const start = text.indexOf(value, from);
    return { start, end: start + value.length, label, score };
  };
  const show = (text, spans) => spans.map((x) => [text.slice(x.start, x.end), x.label, x.score]);
  it('дубликат и вложенный спан того же типа поглощаются объемлющим, score — больший', () => {
    const t = 'с ПАО «Кедр-Сервис» и ООО «Лотос»';
    const out = dedupeSpans(
      [at(t, 'ПАО «Кедр-Сервис»', 'ORG', 0.8), at(t, '«Кедр-Сервис»', 'ORG', 0.95), at(t, 'ПАО «Кедр-Сервис»', 'ORG', 0.7), at(t, 'ООО «Лотос»', 'ORG', 0.9)],
      t,
    );
    expect(show(t, out)).toEqual([
      ['ПАО «Кедр-Сервис»', 'ORG', 0.95],
      ['ООО «Лотос»', 'ORG', 0.9],
    ]);
  });
  it('разные типы: без пересечения — оба; пересечение — больший score; другой тип внутри кавычек ORG — поглощается', () => {
    const t = 'Иванов из Москвы направил в ПАО "Орион-Логистик" письмо';
    const out = dedupeSpans(
      [
        at(t, 'Иванов', 'PER', 0.9),
        at(t, 'Москвы', 'LOC', 0.6),
        at(t, 'Москвы', 'ORG', 0.7),
        at(t, 'ПАО "Орион-Логистик"', 'ORG', 0.86),
        at(t, 'Орион', 'PER', 0.94),
      ],
      t,
    );
    expect(show(t, out)).toEqual([
      ['Иванов', 'PER', 0.9],
      ['Москвы', 'ORG', 0.7],
      ['ПАО "Орион-Логистик"', 'ORG', 0.94],
    ]);
    // частичное пересечение одного типа — больший score
    const u = 'Анна Петрова Сидорова';
    expect(show(u, dedupeSpans([at(u, 'Анна Петрова', 'PER', 0.7), at(u, 'Петрова Сидорова', 'PER', 0.9)], u))).toEqual([['Петрова Сидорова', 'PER', 0.9]]);
  });
});
