import { describe, it, expect } from 'vitest';
import { resolveOverlaps } from '../../src/core/detect/overlap.js';
import { buildCatalog } from '../../src/core/categories.js';

const catalog = buildCatalog({});
let n = 0;
const e = (category, start, end, confidence = 'labeled', source = 'rule', streamId = 's1') => ({
  id: `x${n++}`,
  category,
  start,
  end,
  confidence,
  source,
  streamId,
  text: '',
  normalized: '',
  enabled: true,
  keepPrefix: 0,
  keepSuffix: 0,
});
const ids = (list) => list.map((x) => `${x.category}:${x.start}-${x.end}`);

describe('resolveOverlaps (FR-20)', () => {
  it('user побеждает всегда', () => {
    expect(ids(resolveOverlaps([e('INN', 0, 10, 'validated'), e('PERSON', 5, 20, 'labeled', 'user')], catalog))).toEqual(['PERSON:5-20']);
  });
  it('уровень важнее приоритета категории', () => {
    expect(ids(resolveOverlaps([e('INN', 0, 10, 'labeled'), e('PHONE', 0, 12, 'validated')], catalog))).toEqual(['PHONE:0-12']);
  });
  it('при равном уровне — приоритет категории (ИНН внутри телефона)', () => {
    expect(ids(resolveOverlaps([e('PHONE', 0, 16), e('INN', 2, 12)], catalog))).toEqual(['INN:2-12']);
  });
  it('COMPANY «ИП Иванов Иван Иванович» целиком побеждает PERSON того же уровня? нет — PERSON приоритетнее; KB-уровень решает', () => {
    // FR-21: внутри COMPANY с ОПФ «ИП» ФИО не выделяется — детектор WP2 должен выдать COMPANY уровнем выше PERSON
    expect(ids(resolveOverlaps([e('COMPANY', 0, 22, 'labeled'), e('PERSON', 3, 22, 'kb')], catalog))).toEqual(['COMPANY:0-22']);
  });
  it('находка модели внутри более длинной находки правил не вытесняет её (0.4: адрес weak против LOC модели)', () => {
    // «630002, г. Новосибирск, ул. Советская, д. 77»: адрес без метки — weak, «Новосибирск» модели — ner
    expect(ids(resolveOverlaps([e('ADDRESS', 0, 44, 'weak'), e('ADDRESS', 11, 22, 'ner', 'ner'), e('ADDRESS', 28, 36, 'ner', 'ner')], catalog))).toEqual([
      'ADDRESS:0-44',
    ]);
    // и другой категории (PER «Пушкина» внутри адреса)
    expect(ids(resolveOverlaps([e('ADDRESS', 0, 30, 'weak'), e('PERSON', 5, 12, 'ner', 'ner')], catalog))).toEqual(['ADDRESS:0-30']);
    // модель за пределами находки правил и частичное пересечение — по прежним правилам (уровень)
    expect(ids(resolveOverlaps([e('ADDRESS', 0, 20, 'weak'), e('PERSON', 15, 30, 'ner', 'ner')], catalog))).toEqual(['PERSON:15-30']);
    expect(ids(resolveOverlaps([e('ADDRESS', 0, 20, 'weak'), e('PERSON', 25, 30, 'ner', 'ner')], catalog))).toEqual(['ADDRESS:0-20', 'PERSON:25-30']);
  });
  it('при равенстве — раньше начавшийся, затем длиннее', () => {
    expect(ids(resolveOverlaps([e('ADDRESS', 5, 30), e('ADDRESS', 0, 10)], catalog))).toEqual(['ADDRESS:0-10']);
    expect(ids(resolveOverlaps([e('ADDRESS', 0, 10), e('ADDRESS', 0, 30)], catalog))).toEqual(['ADDRESS:0-30']);
  });
  it('проигравший отбрасывается целиком; непересекающиеся остаются; разные потоки независимы', () => {
    const r = resolveOverlaps([e('INN', 0, 10), e('PHONE', 5, 20), e('EMAIL', 25, 30, 'validated'), e('PHONE', 5, 20, 'labeled', 'rule', 's2')], catalog);
    expect(ids(r)).toEqual(['INN:0-10', 'EMAIL:25-30', 'PHONE:5-20']);
  });
  it('пользовательская категория aboveBuiltin выигрывает у PERSON на пересечении', () => {
    const cat = buildCatalog({ customCategories: [{ id: 'custom:project', priority: 'aboveBuiltin', kind: 'dictionary' }] });
    expect(ids(resolveOverlaps([e('PERSON', 0, 10), e('custom:project', 3, 12)], cat))).toEqual(['custom:project:3-12']);
  });
});

// WP11-D (ревью, Ц1): PERSON правил и PERSON модели, пересекающиеся с выходом модели за правило, — объединение с уровнем правила
describe('PERSON: правило ∪ модель (WP11-D)', () => {
  /** Сущность с текстом из строки потока. */
  const at = (text, sub, confidence, source, extra = {}) => {
    const start = text.indexOf(sub);
    return { ...e('PERSON', start, start + sub.length, confidence, source), text: sub, normalized: sub.toLowerCase(), ...extra };
  };
  it('правило строго внутри модели («Ван Тхань» ⊂ «Нгуен Ван Тхань») — спан модели, уровень и источник правила', () => {
    const t = 'Встречу ведёт Нгуен Ван Тхань.';
    const [x] = resolveOverlaps([at(t, 'Ван Тхань', 'kb', 'kb'), at(t, 'Нгуен Ван Тхань', 'ner', 'ner')], catalog);
    expect([x.text, x.confidence, x.source, x.normalized]).toEqual(['Нгуен Ван Тхань', 'kb', 'kb', 'нгуен ван тхань']);
  });
  it('частичное пересечение («Сотрудник Кирилл» ∩ «Кирилл Ахмедов») — объединение, профессия в keepPrefix', () => {
    const t = 'Сотрудник Кирилл Ахмедов подготовил отчёт.';
    const [x, ...rest] = resolveOverlaps([at(t, 'Сотрудник Кирилл', 'labeled', 'rule'), at(t, 'Кирилл Ахмедов', 'ner', 'ner')], catalog);
    expect(rest).toEqual([]);
    expect([x.text, x.keepPrefix, x.confidence, x.normalized]).toEqual(['Сотрудник Кирилл Ахмедов', 'Сотрудник '.length, 'labeled', 'кирилл ахмедов']);
  });
  it('модель внутри правила — правило как было; модель на двух лицах правил — не объединяется', () => {
    const t = 'Иванов И.И. и Петров П.П. подписали';
    const a = at(t, 'Иванов И.И.', 'labeled', 'rule');
    const b = at(t, 'Петров П.П.', 'labeled', 'rule');
    const m = at(t, 'Иванов И.И. и Петров', 'ner', 'ner');
    expect(resolveOverlaps([a, b, m], catalog).map((x) => x.text)).toEqual(['Иванов И.И.', 'Петров П.П.']);
    expect(resolveOverlaps([a, at(t, 'Иванов', 'ner', 'ner')], catalog).map((x) => x.text)).toEqual(['Иванов И.И.']);
  });
  it('canonical правила сохраняется у объединения (одна метка с другими вхождениями лица)', () => {
    const t = 'Встречу ведёт Нгуен Ван Тхань.';
    const [x] = resolveOverlaps(
      [at(t, 'Ван Тхань', 'kb', 'kb', { canonical: 'тхань ван', normalized: 'тхань ван' }), at(t, 'Нгуен Ван Тхань', 'ner', 'ner')],
      catalog,
    );
    expect([x.text, x.normalized]).toEqual(['Нгуен Ван Тхань', 'тхань ван']);
  });
});
