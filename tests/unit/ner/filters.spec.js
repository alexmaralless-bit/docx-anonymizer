// Фильтры модельных организаций (версия 0.4, К10, `docs/contracts.md` §8.3): заголовок капсом, строка списка из 1–3 слов,
// аббревиатура и продукт из стоп-списка, ячейка без ОПФ — отброшены; «ООО «Ромашка»», «Ромашка-Трейд» в предложении,
// «Студия Ромашка» — сохранены; `nerStoplist` дополняет список; вид блока PDF (h1/li/cell) и DOCX (Heading1, таблица)
// доходит до фильтра через раннер (стаб-провайдер NER в analyze). Все названия вымышленные.
import { describe, it, expect, beforeEach } from 'vitest';
import { createOrgFilterContext, filterOrgSpans, isCapsLine } from '../../../src/core/ner/filters.js';
import { buildStoplist, stopKey } from '../../../src/core/ner/stoplist.js';
import { parseDocx } from '../../../src/core/docx/model.js';
import { fromText } from '../../../src/core/text/model.js';
import { analyze } from '../../../src/core/detect/runner.js';
import { clearDetectors } from '../../../src/core/contracts/index.js';
import { defaultSettings } from '../../../src/core/settings.js';
import { makeDocx, run, para } from '../../helpers/docx.js';
import { commercialSettings } from '../names/helpers.js';

/** Спан ORG на подстроку `word` (первое вхождение). */
const org = (text, word, score = 0.95) => {
  const i = text.indexOf(word);
  if (i < 0) throw new Error(`нет «${word}» в тексте`);
  return { start: i, end: i + word.length, label: 'ORG', score };
};
const kept = (text, words, extra = {}, docCtx = {}) =>
  filterOrgSpans(
    words.map((w) => org(text, w)),
    { ...docCtx, text, ...extra },
  ).map((s) => text.slice(s.start, s.end));

/** Документ из абзацев текстовой модели: [kind, text]. */
const textDoc = (blocks) =>
  fromText(blocks.map(([kind, text], i) => ({ kind, text, page: 1, ...(kind === 'cell' ? { table: { index: 0, row: i, col: 0, cols: 1 } } : {}) })));

describe('правило 1: короткая строка-заголовок, пункт списка, ячейка', () => {
  it('заголовок капсом, нумерованный заголовок, строка с двоеточием, пункт и ячейка без ОПФ — отброшены', () => {
    expect(kept('ПОЧЕМУ ТАК', ['ПОЧЕМУ ТАК'], { blockKind: 'p' })).toEqual([]);
    expect(kept('ВХОДИТ', ['ВХОДИТ'], { blockKind: 'p' })).toEqual([]);
    expect(kept('05 Цены', ['Цены'], { blockKind: 'h2' })).toEqual([]);
    expect(kept('1.2. Наши Партнёры', ['Наши Партнёры'], { blockKind: 'heading' })).toEqual([]);
    expect(kept('Контакты:', ['Контакты'], { blockKind: 'p' })).toEqual([]);
    expect(kept('Новый документ или', ['Новый документ или'], { blockKind: 'li' })).toEqual([]);
    expect(kept('Ромашка-Трейд', ['Ромашка-Трейд'], { blockKind: 'cell' })).toEqual([]);
  });

  it('спан — не вся строка, строка длиннее 3 слов или обычный абзац — правило не срабатывает', () => {
    // обычный абзац из двух слов с заглавной (не капс, не «:») — может быть подписью организации
    expect(kept('Ромашка Трейд', ['Ромашка Трейд'], { blockKind: 'p' })).toEqual(['Ромашка Трейд']);
    // пункт списка — предложение: название внутри
    expect(kept('Поставка оборудования для Лунный Берег', ['Лунный Берег'], { blockKind: 'li' })).toEqual(['Лунный Берег']);
    // ячейка из пяти слов
    expect(kept('Заказчик Лунный Берег по договору поставки', ['Лунный Берег'], { blockKind: 'cell' })).toEqual(['Лунный Берег']);
  });

  it('ОПФ, кавычки и «Студия + Название» сохраняют короткую строку', () => {
    expect(kept('ООО «Ромашка»', ['Ромашка'], { blockKind: 'cell' })).toEqual(['Ромашка']);
    expect(kept('ООО «Ромашка»', ['ООО «Ромашка»'], { blockKind: 'h1' })).toEqual(['ООО «Ромашка»']);
    expect(kept('Northwind Systems Ltd.', ['Northwind Systems'], { blockKind: 'cell' })).toEqual(['Northwind Systems']);
    expect(kept('Общество с ограниченной ответственностью «Ромашка»', ['Ромашка'], { blockKind: 'heading' })).toEqual(['Ромашка']);
    expect(kept('«Лунопарк»', ['Лунопарк'], { blockKind: 'li' })).toEqual(['Лунопарк']);
    expect(kept('Студия Ромашка', ['Студия Ромашка'], { blockKind: 'h1' })).toEqual(['Студия Ромашка']);
    expect(kept('СТУДИЯ РОМАШКА', ['СТУДИЯ РОМАШКА'], { blockKind: 'p' })).toEqual(['СТУДИЯ РОМАШКА']);
  });
});

describe('правило 2: стоп-список аббревиатур и продуктов', () => {
  it('аббревиатуры и продукты отброшены в любом контексте, в том числе в падеже и через «и»', () => {
    const t = 'Документы передаём через ЭДО, коды ТН ВЭД и УПД готовим в 1С, отчёты — в Word и Excel, MVP за месяц.';
    expect(kept(t, ['ЭДО', 'ТН ВЭД', 'УПД', '1С', 'Word и Excel', 'MVP'])).toEqual([]);
    expect(kept('Созвон в Телеграме или в Яндексе', ['Телеграме', 'Яндексе'])).toEqual([]);
    expect(kept('Отчёт выгружен из Bitrix24 и Google Docs', ['Bitrix24', 'Google Docs'])).toEqual([]);
  });

  it('латиница — только точное совпадение: Canvas, Zoomer, Wordex не путаются с Canva, Zoom, Word', () => {
    const t = 'Партнёры проекта — Canvas, Zoomer и Wordex, все из Казани.';
    expect(kept(t, ['Canvas', 'Zoomer', 'Wordex'])).toEqual(['Canvas', 'Zoomer', 'Wordex']);
    expect(kept('Встреча в Zoom, макет в Canva', ['Zoom', 'Canva'])).toEqual([]);
  });

  it('варианты написания: 1С/1C (латинская C), регистр, «ё»', () => {
    expect(stopKey('1С')).toBe(stopKey('1C'));
    expect(stopKey('ЭДО')).toBe(stopKey('эдо'));
    expect(kept('Учёт в 1C:Бухгалтерия', ['1C:Бухгалтерия'])).toEqual([]);
    expect(kept('Работаем в YANDEX и в яндекс', ['YANDEX', 'яндекс'])).toEqual([]);
  });

  it('продукт в кавычках — тоже продукт; с ОПФ — организация', () => {
    expect(kept('в формате «Excel»', ['Excel'])).toEqual([]);
    expect(kept('договор с ООО «Телеграм-Сервис»', ['Телеграм-Сервис'])).toEqual(['Телеграм-Сервис']);
  });

  it('settings.nerStoplist дополняет список (без учёта регистра)', () => {
    const doc = textDoc([['p', 'Модуль Спектр-Аналитика внедрён у заказчика']]);
    const text = doc.streams[0].text;
    const base = createOrgFilterContext(doc, defaultSettings());
    expect(kept(text, ['Спектр-Аналитика'], { blockKind: 'p' }, base)).toEqual(['Спектр-Аналитика']);
    const ctx = createOrgFilterContext(doc, { ...defaultSettings(), nerStoplist: ['спектр-аналитика', 42, ''] });
    expect(kept(text, ['Спектр-Аналитика'], { blockKind: 'p' }, ctx)).toEqual([]);
    expect(buildStoplist(['Лунопарк']).has(stopKey('ЛУНОПАРК'))).toBe(true);
  });
});

describe('правило 3: слово встречается только в капс-строках и заголовках', () => {
  it('слово капс-заголовка, которое в тексте не имя собственное, отброшено; имя из текста — сохранено', () => {
    const doc = textDoc([
      ['h1', 'ЧТО ВХОДИТ В СТОИМОСТЬ РАБОТ'],
      ['p', 'В стоимость входит дизайн и вёрстка. Работы выполняет Лунный Берег по договору.'],
      ['h2', 'ОТЗЫВ КОМПАНИИ ЛУННЫЙ БЕРЕГ О ПРОЕКТЕ'],
    ]);
    const ctx = createOrgFilterContext(doc, defaultSettings());
    expect(kept(doc.streams[0].text, ['ВХОДИТ'], { blockKind: 'h1' }, ctx)).toEqual([]);
    expect(kept(doc.streams[2].text, ['ЛУННЫЙ БЕРЕГ'], { blockKind: 'h2' }, ctx)).toEqual(['ЛУННЫЙ БЕРЕГ']);
    // слово с заглавной только в начале предложения — не имя собственное
    expect(kept(doc.streams[2].text, ['ОТЗЫВ'], { blockKind: 'h2' }, ctx)).toEqual([]);
  });

  it('падежная форма из текста засчитывается («Вектора» → «ВЕКТОР»)', () => {
    const doc = textDoc([
      ['p', 'ПРОЕКТЫ ДЛЯ ВЕКТОРА И ПАРТНЁРОВ'],
      ['p', 'Мы сделали для Вектора три проекта.'],
    ]);
    const ctx = createOrgFilterContext(doc, defaultSettings());
    expect(kept(doc.streams[0].text, ['ВЕКТОРА'], { blockKind: 'p' }, ctx)).toEqual(['ВЕКТОРА']);
  });

  it('название внутри предложения не трогается', () => {
    const doc = textDoc([['p', 'Поставщик Ромашка-Трейд обязуется поставить товар в срок.']]);
    const ctx = createOrgFilterContext(doc, defaultSettings());
    expect(kept(doc.streams[0].text, ['Ромашка-Трейд'], { blockKind: 'p' }, ctx)).toEqual(['Ромашка-Трейд']);
  });

  it('isCapsLine: ≥ 90 % заглавных среди ≥ 3 букв', () => {
    expect(isCapsLine('КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ')).toBe(true);
    expect(isCapsLine('05 ЦЕНЫ')).toBe(true);
    expect(isCapsLine('ООО «Ромашка»')).toBe(false);
    expect(isCapsLine('ИП')).toBe(false);
  });

  it('метки PER и LOC фильтр не трогает', () => {
    const t = 'ПОЧЕМУ ТАК';
    const spans = [{ start: 0, end: 6, label: 'PER', score: 0.9 }, { start: 7, end: 10, label: 'LOC', score: 0.9 }, org(t, 'ПОЧЕМУ ТАК')];
    expect(filterOrgSpans(spans, { text: t, blockKind: 'h1' }).map((s) => s.label)).toEqual(['PER', 'LOC']);
  });
});

describe('правила по прогону корпуса жанров (2б, 4, 5, слово целиком)', () => {
  it('2б: часть спана из стоп-списка, остальное — не имена собственные документа', () => {
    const doc = textDoc([
      ['cell', 'Настройка CRM и обучение'],
      ['p', 'Проект внедряет Вектор CRM для отдела продаж.'],
    ]);
    const ctx = createOrgFilterContext(doc, defaultSettings());
    expect(kept(doc.streams[0].text, ['Настройка CRM'], { blockKind: 'cell' }, ctx)).toEqual([]);
    // «Вектор» в тексте — имя собственное (с заглавной не в начале предложения): «Вектор CRM» сохраняется
    expect(kept(doc.streams[1].text, ['Вектор CRM'], { blockKind: 'p' }, ctx)).toEqual(['Вектор CRM']);
  });

  it('4: слово со строчной буквы — фраза, а не название; частицы названий допускаются', () => {
    expect(kept('Интеграция с 1С и ЭДО', ['Интеграция с 1С и ЭДО'], { blockKind: 'li' })).toEqual([]);
    expect(kept('Automated Excel reports with Python', ['Automated Excel reports'], { blockKind: 'li' })).toEqual([]);
    expect(kept('Запросы субъектов ПДн принимаются', ['субъектов ПДн'])).toEqual([]);
    expect(kept('Партнёр — Альфа и Омега, давний клиент', ['Альфа и Омега'])).toEqual(['Альфа и Омега']);
    expect(kept('Счёт в Bank of Northwind получен', ['Bank of Northwind'])).toEqual(['Bank of Northwind']);
  });

  it('4 (ревью): организации со строчными словами внутри предложения сохраняются', () => {
    const cases = [
      ['Груз доставила Северная транспортная компания точно в срок.', 'Северная транспортная компания'],
      ['Оборудование поставил Уральский завод точных приборов в прошлом месяце.', 'Уральский завод точных приборов'],
      ['Договор аренды подготовило Агентство недвижимости Ромашка по нашему запросу.', 'Агентство недвижимости Ромашка'],
    ];
    for (const [t, w] of cases) expect(kept(t, [w], { blockKind: 'p' }), w).toEqual([w]);
    // та же фраза пунктом списка или короткой строкой — отбрасывается
    expect(kept('Уральский завод точных приборов', ['Уральский завод точных приборов'], { blockKind: 'li' })).toEqual([]);
    // в предложении: спан со служебным словом в конце — фраза
    expect(kept('Создайте Новый документ или шаблон в редакторе.', ['Новый документ или'], { blockKind: 'p' })).toEqual([]);
    // весь абзац со строчными словами и тире с пробелами — тоже фразы
    expect(kept('Счёт на оплату № 530 от 15 октября 2026 г.', ['Счёт на оплату № 530 от 15 октября 2026 г.'], { blockKind: 'p' })).toEqual([]);
    expect(kept('Войдите через почту. Рисунок 1 — Окно входа', ['Рисунок 1 — Окно входа'], { blockKind: 'p' })).toEqual([]);
  });

  it('5 (ревью): «Ромашка» из «Ромашка-2000» и «Вектор» из «Исполнитель/Вектор» — не обрывки кода', () => {
    expect(kept('Поставщик Ромашка-2000 обязуется поставить товар.', ['Ромашка'])).toEqual(['Ромашка']);
    expect(kept('Стороны: Исполнитель/Вектор подписали акт.', ['Вектор'])).toEqual(['Вектор']);
  });

  it('1 (ревью): капс-шапка, название из которой употребляется в тексте как имя собственное, сохраняется', () => {
    const doc = textDoc([
      ['p', 'ВЕКТОР ПЛЮС'],
      ['p', 'Уважаемые коллеги, компания Вектор Плюс благодарит вас.'],
    ]);
    const ctx = createOrgFilterContext(doc, defaultSettings());
    expect(kept(doc.streams[0].text, ['ВЕКТОР ПЛЮС'], { blockKind: 'p' }, ctx)).toEqual(['ВЕКТОР ПЛЮС']);
  });

  it('5: обрывок кода или номера договора отброшен', () => {
    expect(kept('Основание: договор № 17/ПС-2026 от 01.09.2026', ['ПС'])).toEqual([]);
    expect(kept('Шифр АБ-12 в журнале', ['АБ'])).toEqual([]);
  });

  it('6: адрес и должность — не организация; формулы вежливости — в стоп-списке', () => {
    expect(kept('12 Baker Street, London W1U 6TY', ['12 Baker Street', 'London W1U 6TY'])).toEqual([]);
    expect(kept('Senior Data Analyst', ['Senior Data Analyst'], { blockKind: 'p' })).toEqual([]);
    expect(kept('The contract with Asset Manager Group was signed.', ['Asset Manager'])).toEqual(['Asset Manager']);
    expect(kept('Thank you for the meeting', ['Thank'])).toEqual([]);
    expect(kept('Работает в Harbor Point Logistics с 2020 года', ['Harbor Point Logistics'])).toEqual(['Harbor Point Logistics']);
  });

  it('слово целиком вокруг спана: «Диск» из «Яндекс.Диск», «Бухгалтерия» из «1С:Бухгалтерия»', () => {
    expect(kept('Отчёт загрузила на Яндекс.Диск вчера', ['Диск'])).toEqual([]);
    expect(kept('Учёт ведём в 1С:Бухгалтерия', ['Бухгалтерия'])).toEqual([]);
  });
});

describe('интеграция: вид блока DOCX и PDF доходит до фильтра через analyze', () => {
  /** Стаб-провайдер: ORG на каждое слово из списка, найденное в потоке. */
  const stub = (words) => ({
    name: 'stub',
    init: async () => {},
    detect: async (text) => words.filter((w) => text.includes(w)).map((w) => org(text, w)),
  });
  const orgs = (r) => r.groups.filter((g) => g.category === 'COMPANY').map((g) => g.value);
  beforeEach(() => clearDetectors());

  it('DOCX: Heading1 из двух слов и ячейка таблицы — отброшены; ОПФ в ячейке и название в предложении — сохранены', async () => {
    const pStyle = (t, style) => `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${run(t)}</w:p>`;
    const cell = (t) => `<w:tc>${para(run(t))}</w:tc>`;
    const xml =
      pStyle('Наши Клиенты', 'Heading1') +
      para(run('Поставщик Ромашка-Трейд обязуется поставить товар.')) +
      `<w:tbl><w:tr>${cell('Лунный Берег')}${cell('ООО &#171;Северный Ветер&#187;')}</w:tr></w:tbl>`;
    const doc = parseDocx(makeDocx(xml));
    expect(doc.paragraphs[0].kind).toBe('heading');
    const provider = stub(['Наши Клиенты', 'Ромашка-Трейд', 'Лунный Берег', 'Северный Ветер']);
    const r = await analyze(doc, commercialSettings({ nerThresholdOrg: 0.85 }), { nerProvider: provider });
    expect(orgs(r).sort()).toEqual(['Ромашка-Трейд', 'Северный Ветер']);
    // без фильтра (обычная строка) «Наши Клиенты» прошло бы: проверка, что отброс — из-за вида блока
    const plain = parseDocx(makeDocx(para(run('Наши Клиенты'))));
    expect(orgs(await analyze(plain, commercialSettings(), { nerProvider: provider }))).toEqual(['Наши Клиенты']);
  });

  it('PDF (fromText): h1 капсом, пункт li и ячейка cell отброшены; предложение и стоп-список — как в DOCX', async () => {
    const doc = textDoc([
      ['h1', 'КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ'],
      ['li', 'Лунный Берег'],
      ['cell', 'Вектор Плюс'],
      ['p', 'Поставщик Ромашка-Трейд обязуется передать УПД через ЭДО.'],
    ]);
    const provider = stub(['КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ', 'Лунный Берег', 'Вектор Плюс', 'Ромашка-Трейд', 'УПД', 'ЭДО']);
    const r = await analyze(doc, commercialSettings(), { nerProvider: provider });
    expect(orgs(r)).toEqual(['Ромашка-Трейд']);
    // обычный режим: модельные организации не выдаются вовсе
    expect(orgs(await analyze(doc, defaultSettings(), { nerProvider: provider }))).toEqual([]);
  });
});
