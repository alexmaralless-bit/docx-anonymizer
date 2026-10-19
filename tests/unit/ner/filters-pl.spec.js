// Фильтры модельных людей и мест (версия 0.4, WP11-D, Ц2, К6, `docs/contracts.md` §8.3): стоп-список, формулы вежливости
// и служебные слова, слово со строчной буквы, PER без слова-имени в заголовке/ячейке/капсом — отброшены; служебные
// слова по краям отрезаются; LOC → ADDRESS — только рядом с признаками адреса (одиночный город — не ПДн).
// Раннер вызывает фильтр в обоих режимах (стаб-провайдер NER в analyze). Все имена и адреса вымышленные.
import { describe, it, expect, beforeEach } from 'vitest';
import { filterPersonLocSpans, hasAddressContext, nameLike, orgStreetsAsLoc } from '../../../src/core/ner/filters-pl.js';
import { createOrgFilterContext } from '../../../src/core/ner/filters.js';
import { buildStoplist } from '../../../src/core/ner/stoplist.js';
import { fromText } from '../../../src/core/text/model.js';
import { analyze } from '../../../src/core/detect/runner.js';
import { clearDetectors, registerBuiltinDetectors } from '../../../src/core/index.js';
import { defaultSettings } from '../../../src/core/settings.js';

const span = (text, word, label, score = 0.95) => {
  const i = text.indexOf(word);
  if (i < 0) throw new Error(`нет «${word}» в тексте`);
  return { start: i, end: i + word.length, label, score };
};
/** Что осталось после фильтра: тексты спанов. */
const kept = (text, words, label, extra = {}) =>
  filterPersonLocSpans(
    words.map((w) => span(text, w, label)),
    { stoplist: buildStoplist(), text, ...extra },
  ).map((s) => text.slice(s.start, s.end));

describe('PER', () => {
  it('формулы вежливости, служебные слова, продукты и аббревиатуры — отброшены', () => {
    expect(kept('[09:02] Ершов Кирилл: Здравствуйте, не приходит УПД.', ['Здравствуйте'], 'PER')).toEqual([]);
    expect(kept('Логин: введите адрес почты.', ['Логин'], 'PER')).toEqual([]);
    expect(kept('Ок. Почта m.example@example.test.', ['Ок. Почта'], 'PER')).toEqual([]);
    expect(kept('Excel, ЭДО, 1С:Бухгалтерия', ['Excel, ЭДО'], 'PER')).toEqual([]);
    expect(kept('Контур.Диадок, Excel', ['Диадок'], 'PER')).toEqual([]);
    expect(kept('Обработка ПДн по закону.', ['ПДн'], 'PER')).toEqual([]);
    expect(kept('Procurement Manager', ['Procurement Manager'], 'PER')).toEqual([]);
  });

  it('служебные слова по краям отрезаются, имя остаётся', () => {
    expect(kept('Главный бухгалтер ________ (Фролова Главный бухгалтер', ['Фролова Главный'], 'PER')).toEqual(['Фролова']);
    expect(kept('Спасибо Ивану Петрову за помощь.', ['Спасибо Ивану Петрову'], 'PER')).toEqual(['Ивану Петрову']);
    expect(kept('Менеджер Анна Соколова на связи.', ['Менеджер Анна Соколова'], 'PER')).toEqual(['Анна Соколова']);
  });

  it('одно слово со строчной буквы — отброшено; имя в предложении — сохранено', () => {
    expect(kept('позвоните менеджеру завтра', ['менеджеру'], 'PER')).toEqual([]);
    expect(kept('Документы передал Кравчук, экспедитор.', ['Кравчук'], 'PER')).toEqual(['Кравчук']);
    expect(kept('Отчёт подготовила Зульфия Ахметова.', ['Зульфия Ахметова'], 'PER')).toEqual(['Зульфия Ахметова']);
    expect(kept('Meeting with John Smith on Monday.', ['John Smith'], 'PER')).toEqual(['John Smith']);
  });

  it('одно слово без признаков имени в заголовке, ячейке или капсом — отброшено; фамилия в ячейке — сохранена', () => {
    expect(kept('Тарифы', ['Тарифы'], 'PER', { blockKind: 'h2' })).toEqual([]);
    expect(kept('Интеграции', ['Интеграции'], 'PER', { blockKind: 'cell' })).toEqual([]);
    expect(kept('ВНЕДРЕНИЕ', ['ВНЕДРЕНИЕ'], 'PER')).toEqual([]);
    expect(kept('Самойлова', ['Самойлова'], 'PER', { blockKind: 'cell' })).toEqual(['Самойлова']);
    // одно слово в обычном тексте без признаков имени — модели верим (редкая фамилия)
    expect(kept('Груз сопровождает Квятковски.', ['Квятковски'], 'PER')).toEqual(['Квятковски']);
  });

  it('nameLike: имя, фамилия, отчество, инициал, латинское имя', () => {
    for (const w of ['Анна', 'Петрову', 'Сергеевич', 'А', 'John', 'Smith']) expect(nameLike(w), w).toBe(true);
    for (const w of ['Здравствуйте', 'Тарифы', 'Jira', 'Оптимальный']) expect(nameLike(w), w).toBe(false);
  });

  it('другие метки фильтр не трогает', () => {
    const text = 'Jira и ООО «Ромашка»';
    const out = filterPersonLocSpans([span(text, 'Jira', 'ORG'), span(text, 'ООО «Ромашка»', 'ORG')], { text });
    expect(out).toHaveLength(2);
  });
});

describe('LOC → ADDRESS только в адресе', () => {
  it('город, продукт, слово таблицы вне адреса — отброшены', () => {
    expect(kept('Филиал в Казани работает по московскому времени.', ['Казани'], 'LOC')).toEqual([]);
    expect(kept('Банк получателя: АО «Волжский Банк», г. Нижний Новгород', ['Нижний Новгород'], 'LOC')).toEqual([]);
    expect(kept('Баги заводим в Jira.', ['Jira'], 'LOC')).toEqual([]);
    expect(kept('Python, Docker, PostgreSQL', ['Python', 'Docker'], 'LOC')).toEqual([]);
    expect(kept('Сальдо начальное', ['Сальдо'], 'LOC')).toEqual([]);
    expect(kept('Английский — B2', ['Английский'], 'LOC')).toEqual([]);
    expect(kept('III квартал 2026', ['III'], 'LOC')).toEqual([]);
    expect(kept('г. Москва, 15 сентября 2026 г.', ['Москва'], 'LOC')).toEqual([]);
    // инициал «Д.» — не «д.» с номером дома
    expect(kept('Подписал Иванов Д.А., Москва', ['Москва'], 'LOC')).toEqual([]);
  });

  it('рядом индекс, улица, дом, офис, номер дома, street — сохранён', () => {
    expect(kept('630002, г. Новосибирск, ул. Советская', ['Новосибирск'], 'LOC')).toEqual(['Новосибирск']);
    expect(kept('Москва, Тверская, 7', ['Тверская'], 'LOC')).toEqual(['Тверская, 7']);
    expect(kept('Казань, проспект Победы, офис 4', ['Казань'], 'LOC')).toEqual(['Казань']);
    expect(kept('Office: 45 King Street, Manchester', ['Manchester'], 'LOC')).toEqual(['Manchester']);
    expect(hasAddressContext('Москва, д. 5', 0, 6)).toBe(true);
    expect(hasAddressContext('Москва — столица', 0, 6)).toBe(false);
  });
});

describe('ревью WP11-D: адресные метки, номер дома, оборванное имя, омонимы', () => {
  it('LOC рядом с адресной меткой или номером дома — ADDRESS, номер дома и квартира — в спане', () => {
    expect(kept('Адрес: Москва, Тверская 12-5', ['Москва', 'Тверская'], 'LOC')).toEqual(['Москва', 'Тверская 12-5']);
    expect(kept('Доставка: Пермь, Ленина 54/2', ['Ленина'], 'LOC')).toEqual(['Ленина 54/2']);
    expect(kept('Адрес регистрации: Тюмень, Республики 61', ['Тюмень'], 'LOC')).toEqual(['Тюмень']);
    expect(kept('Место жительства — Самарская область, Сызрань, Советская 7', ['Сызрань'], 'LOC')).toEqual(['Сызрань']);
    expect(kept('Курьер приедет на Лесную 14 в Воронеже', ['Лесную', 'Воронеже'], 'LOC')).toEqual(['Лесную 14', 'Воронеже']);
    expect(kept('Живу в Казани, на Баумана 9, квартира 3', ['Баумана'], 'LOC')).toEqual(['Баумана 9, квартира 3']);
    expect(kept('Lives at 12 Rue de Rivoli, Paris', ['Paris'], 'LOC')).toEqual(['Paris']);
    expect(kept('Тольятти, Революционная 52-14', ['Революционная'], 'LOC')).toEqual(['Революционная 52-14']);
    // не номер дома: дата, год, «1С», сумма
    expect(kept('Москва 15 сентября', ['Москва'], 'LOC')).toEqual([]);
    expect(kept('Открыть 1С и выбрать раздел', ['Открыть'], 'LOC')).toEqual([]);
  });

  it('PER модели, оборванный перед словарной фамилией, продолжается («Tomasz» → «Tomasz Wiśniewski»)', () => {
    expect(kept('Please contact Tomasz Wiśniewski if needed.', ['Tomasz'], 'PER')).toEqual(['Tomasz Wiśniewski']);
    expect(kept('Отчёт подготовил Кирилл Ахмедов.', ['Кирилл'], 'PER')).toEqual(['Кирилл Ахмедов']);
    // следующее слово — не фамилия: не продолжается
    expect(kept('Спросите Анну Завтра утром', ['Анну'], 'PER')).toEqual(['Анну']);
  });

  it('омоним в начале предложения перед предлогом или в перечислении — не человек, если в документе нет человека с этим именем', () => {
    for (const [t, w] of [
      ['Вера в продукт — главное для продавца.', 'Вера'],
      ['Роман о жизни купца вышел в прошлом году.', 'Роман'],
      ['Любовь к делу важнее зарплаты.', 'Любовь'],
      ['Вера, надежда, любовь — так называется выставка.', 'Вера'],
    ])
      expect(kept(t, [w], 'PER'), t).toEqual([]);
    expect(kept('Вера в отпуске до понедельника.', ['Вера'], 'PER', { pairedWords: new Set(['вера']) })).toEqual(['Вера']);
    expect(kept('Вера сказала, что отчёт готов.', ['Вера'], 'PER')).toEqual(['Вера']);
    expect(kept('Сегодня Вера в отпуске.', ['Вера'], 'PER')).toEqual(['Вера']);
  });
});

describe('раннер: фильтр PER/LOC в обоих режимах (стаб-провайдер)', () => {
  beforeEach(() => {
    clearDetectors();
    registerBuiltinDetectors();
  });
  const stub = (pairs) => ({
    name: 'stub',
    init: async () => {},
    detect: async (text) =>
      pairs.flatMap(([w, label]) => {
        const i = text.indexOf(w);
        return i < 0 ? [] : [{ start: i, end: i + w.length, label, score: 0.99 }];
      }),
  });

  it('ложные PER/LOC отброшены, человек и адрес из модели сохранены', async () => {
    const doc = fromText([
      { kind: 'h2', text: 'Контакты', page: 1 },
      { kind: 'p', text: 'Здравствуйте, баги заводим в Jira, созвон в Zoom.', page: 1 },
      { kind: 'p', text: 'Филиал в Казани работает с понедельника; груз принимает Квятковски.', page: 1 },
      { kind: 'p', text: 'Офис: Лесная, 12, Тверь', page: 1 },
    ]);
    const provider = stub([
      ['Контакты', 'LOC'],
      ['Здравствуйте', 'PER'],
      ['Jira', 'LOC'],
      ['Zoom', 'LOC'],
      ['Казани', 'LOC'],
      ['Квятковски', 'PER'],
      ['Лесная', 'LOC'],
    ]);
    for (const settings of [defaultSettings(), { ...defaultSettings(), commercial: true }]) {
      const r = await analyze(doc, settings, { nerProvider: provider });
      const ner = r.entities.filter((e) => e.source === 'ner').map((e) => `${e.category}:${e.text}`);
      expect(ner).toEqual(['PERSON:Квятковски', 'ADDRESS:Лесная, 12']);
    }
  });

  it('контекст документа — общий с фильтром ORG: пользовательский стоп-список работает и для PER', async () => {
    const doc = fromText([{ kind: 'p', text: 'Отчёт выгружен в Квазар и отправлен.', page: 1 }]);
    const provider = stub([['Квазар', 'PER']]);
    const s = defaultSettings();
    expect((await analyze(doc, s, { nerProvider: provider })).entities.map((e) => e.text)).toEqual(['Квазар']);
    expect(createOrgFilterContext(doc, { nerStoplist: ['Квазар'] }).stoplist.size).toBeGreaterThan(0);
    expect((await analyze(doc, { ...s, nerStoplist: ['Квазар'] }, { nerProvider: provider })).entities).toEqual([]);
  });
});

describe('ревью WP11-D (3): улица-ORG перед номером дома, «, корпус N»', () => {
  it('ORG модели перед номером дома — LOC; ORG в кавычках, капсом или без номера — как был', () => {
    const t = 'Заказ — клиенту на Профсоюзную 104, корпус 2, Москва.';
    expect(orgStreetsAsLoc([span(t, 'Профсоюзную', 'ORG')], t).map((x) => x.label)).toEqual(['LOC']);
    expect(kept(t, ['Профсоюзную'], 'LOC')).toEqual(['Профсоюзную 104, корпус 2']);
    const q = 'Поставщик ООО «Вектор» 12 раз срывал сроки, а Ромашка работает.';
    expect(orgStreetsAsLoc([span(q, 'Вектор', 'ORG'), span(q, 'Ромашка', 'ORG')], q).map((x) => x.label)).toEqual(['ORG', 'ORG']);
  });
});

describe('ревью WP11-D (3): LOC модели на фамилии вне адреса — PER', () => {
  it('«представитель подрядчика Лисицын» (LOC) — PER; город и «г. Пушкин» — нет', () => {
    const t = 'Сообщаю, что на объект приезжал представитель подрядчика Лисицын.';
    expect(filterPersonLocSpans([span(t, 'Лисицын', 'LOC')], { text: t }).map((x) => `${x.label}:${t.slice(x.start, x.end)}`)).toEqual(['PER:Лисицын']);
    for (const [u, w] of [
      ['Филиал в Казани работает по московскому времени.', 'Казани'],
      ['Переехали в г. Пушкин в прошлом году.', 'Пушкин'],
      ['Встреча прошла в Самаре.', 'Самаре'],
    ])
      expect(filterPersonLocSpans([span(u, w, 'LOC')], { text: u }), u).toEqual([]);
  });
});
