// WP9: метки модели и слияние BIO (core/ner/bio.js): I без B, смена типа, средний score, подрезка краёв,
// решение по маргинальным вероятностям типов, мостики через пунктуацию, границы по соглашениям каталога (FR-18).
import { describe, it, expect } from 'vitest';
import { labelsToTags, decodeWord, bridgePunct, mergeBio, joinAdjacent, filterSpans, alignSpans } from '../../../src/core/ner/bio.js';

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
  it('LOC не меняется', () => {
    const t = 'в г. Москва.';
    expect(vals(t, [sp(t, 'Москва', 'LOC')])).toEqual(['Москва']);
  });
});
