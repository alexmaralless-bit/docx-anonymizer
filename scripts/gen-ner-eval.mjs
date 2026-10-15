#!/usr/bin/env node
// Генератор корпуса оценки NER (WP9, К8): предложения в стиле договоров с gold-спанами PER/ORG/LOC.
// Все данные ВЫМЫШЛЕННЫЕ: ФИО собираются из словарей словарного детектора (src/core/detect/names/dict) и склоняются
// морфологией names/morph.js; названия компаний и банков придуманы; города и регионы — общеупотребительные топонимы.
// Сид фиксирован — корпус воспроизводим.
//
// Соглашение о gold-спанах (то, что анонимизатор должен закрыть):
//   PER — ФИО как написано, в любом падеже и форме («Иванова Петра Сергеевича», «П. С. Иванов», «Иванов П. С.»
//         вместе с точкой последнего инициала), без должности и без «ИП»;
//   ORG — название вместе с ОПФ и кавычками, как в фикстуре COMPANY («ООО «Ромашка»», «Northwind Systems Ltd.»),
//         без ОПФ — в кавычках (««Меридиан»») или голое («Технопромсервис»);
//   LOC — топоним без родового слова: город, регион, страна, улица без «ул.» («Москве», «Ленина», «Московской области»).
//
// Использование: node scripts/gen-ner-eval.mjs [каталог]   (по умолчанию tests/fixtures/ner)
// Из кода: import { buildNerEval } from './scripts/gen-ner-eval.mjs' → {ru, en}
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDicts } from '../src/core/detect/names/dict/index.js';
import { declineSurname, declineFirstName, declinePatronymic } from '../src/core/detect/names/morph.js';
import { MALE_NAMES_RU, FEMALE_NAMES_RU, AMBIGUOUS_NAMES_RU, FIRST_NAMES_EN, lowerE } from '../src/core/detect/names/lexicon.js';

export const SEED = 20261015;
const N_RU = 240;
const N_EN = 120;

/** mulberry32 — детерминированный ГПСЧ. */
function rngFrom(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n) => Math.floor(next() * n);
  return { next, int, pick: (arr) => arr[int(arr.length)], chance: (p) => next() < p };
}

const cap = (s) => s.replace(/(^|[-\s])(\p{L})/gu, (_, p, c) => p + c.toUpperCase());

/* ---------- сущности ---------- */

/** Отчества — от распространённых мужских имён (им. падеж, м/ж). */
const PATRONYMICS = {
  Иван: ['Иванович', 'Ивановна'],
  Сергей: ['Сергеевич', 'Сергеевна'],
  Алексей: ['Алексеевич', 'Алексеевна'],
  Андрей: ['Андреевич', 'Андреевна'],
  Николай: ['Николаевич', 'Николаевна'],
  Владимир: ['Владимирович', 'Владимировна'],
  Александр: ['Александрович', 'Александровна'],
  Михаил: ['Михайлович', 'Михайловна'],
  Пётр: ['Петрович', 'Петровна'],
  Павел: ['Павлович', 'Павловна'],
  Дмитрий: ['Дмитриевич', 'Дмитриевна'],
  Юрий: ['Юрьевич', 'Юрьевна'],
  Василий: ['Васильевич', 'Васильевна'],
  Евгений: ['Евгеньевич', 'Евгеньевна'],
  Виктор: ['Викторович', 'Викторовна'],
  Олег: ['Олегович', 'Олеговна'],
  Игорь: ['Игоревич', 'Игоревна'],
  Борис: ['Борисович', 'Борисовна'],
  Геннадий: ['Геннадьевич', 'Геннадьевна'],
  Анатолий: ['Анатольевич', 'Анатольевна'],
  Григорий: ['Григорьевич', 'Григорьевна'],
  Фёдор: ['Фёдорович', 'Фёдоровна'],
  Степан: ['Степанович', 'Степановна'],
  Роман: ['Романович', 'Романовна'],
  Константин: ['Константинович', 'Константиновна'],
  Леонид: ['Леонидович', 'Леонидовна'],
  Максим: ['Максимович', 'Максимовна'],
  Аркадий: ['Аркадьевич', 'Аркадьевна'],
  Валерий: ['Валерьевич', 'Валерьевна'],
  Ринат: ['Ринатович', 'Ринатовна'],
  Тимур: ['Тимурович', 'Тимуровна'],
  Эдуард: ['Эдуардович', 'Эдуардовна'],
  Яков: ['Яковлевич', 'Яковлевна'],
  Илья: ['Ильич', 'Ильинична'],
  Никита: ['Никитич', 'Никитична'],
  Лев: ['Львович', 'Львовна'],
};

const CASE = { nom: 0, gen: 1, dat: 2, acc: 3, ins: 4, pre: 5 };

function makePeople(rng) {
  const d = getDicts();
  const inDict = (n) => d.ruFirst.has(lowerE(n)) && !AMBIGUOUS_NAMES_RU.has(lowerE(n));
  const male = MALE_NAMES_RU.filter(inDict);
  const female = FEMALE_NAMES_RU.filter(inDict);
  // Редкие имена словаря (длиннее 3 букв, однозначный род) — для разнообразия
  const rareM = [...d.ruFirst].filter(([w, g]) => g === 'm' && w.length > 3 && !d.ruAmbiguous.has(w) && /[бвгдзклмнпрст]$/.test(w)).map(([w]) => w);
  const rareF = [...d.ruFirst].filter(([w, g]) => g === 'f' && w.length > 3 && !d.ruAmbiguous.has(w) && /(?:ина|ана|ета|ила|ия)$/.test(w)).map(([w]) => w);
  const surnames = [...d.ruSurnames].filter((s) => /(?:ов|ев|ин|ын|ский|цкий)$/.test(s) && s.length >= 5);
  const otherSurnames = [...d.ruSurnames].filter((s) => /(?:ко|ук|юк|ич|ян|дзе|швили)$/.test(s) && s.length >= 5);
  const patrKeys = Object.keys(PATRONYMICS);

  /** Персона: формы имени, отчества и фамилии по падежам. */
  return function person() {
    const g = rng.chance(0.55) ? 'm' : 'f';
    const first = rng.chance(0.85) ? rng.pick(g === 'm' ? male : female) : cap(rng.pick(g === 'm' ? rareM : rareF));
    const patr = PATRONYMICS[rng.pick(patrKeys)][g === 'm' ? 0 : 1];
    const sm = rng.chance(0.85) ? rng.pick(surnames) : rng.pick(otherSurnames);
    const sNom = g === 'm' ? sm : /(?:ов|ев|ин|ын)$/.test(sm) ? sm + 'а' : /(?:ский|цкий)$/.test(sm) ? sm.slice(0, -2) + 'ая' : sm;
    // морфология работает с «ё» → «е»; «ё» основы возвращается на ту же позицию (Пётр → Петра → Пётра? нет: Петра)
    const keepYo = (form, orig) => Array.from(form, (ch, i) => (ch === 'е' && orig[i] === 'ё' ? 'ё' : ch)).join('');
    const F = declineFirstName(first, g).map((f) => keepYo(cap(f), first));
    const P = declinePatronymic(patr, g).map((f) => keepYo(cap(f), patr));
    const S = declineSurname(sNom, g).map(cap);
    const ini = (w) => w[0].toUpperCase() + '.';
    return {
      g,
      /** @param {keyof CASE} c @param {string} form */
      form(c, form) {
        const i = CASE[c];
        switch (form) {
          case 'fio':
            return `${S[i]} ${F[i]} ${P[i]}`;
          case 'iof':
            return `${F[i]} ${P[i]} ${S[i]}`;
          case 'if':
            return `${F[i]} ${S[i]}`;
          case 'fi':
            return `${S[i]} ${F[i]}`;
          case 'io':
            return `${F[i]} ${P[i]}`;
          case 'f_io':
            return rng.chance(0.5) ? `${S[i]} ${ini(first)} ${ini(patr)}` : `${S[i]} ${ini(first)}${ini(patr)}`;
          case 'io_f':
            return rng.chance(0.5) ? `${ini(first)} ${ini(patr)} ${S[i]}` : `${ini(first)}${ini(patr)} ${S[i]}`;
          case 's':
            return S[i];
          default:
            throw new Error(form);
        }
      },
    };
  };
}

// prettier-ignore
const BRAND_A = ['Ромашка', 'Вектор', 'Меридиан', 'Гранит', 'Лотос', 'Прогресс', 'Север', 'Альтаир', 'Орион', 'Сфера', 'Импульс', 'Кедр',
  'Росток', 'Магистраль', 'Эталон', 'Горизонт', 'Перспектива', 'Сигма', 'Атлант', 'Березка', 'Каскад', 'Паллада', 'Стрела', 'Феникс'];
// prettier-ignore
const BRAND_B = ['', '', '', '-Строй', '-Трейд', '-Сервис', ' Плюс', '-М', ' Групп', '-Инвест', '-Логистик', '-Технологии', ' Девелопмент'];
// prettier-ignore
const BARE_ORGS = ['Технопромсервис', 'Волгаэнергосбыт', 'Уралстройинвест', 'Севзапкабель', 'Дальтрансфлот', 'Агропромкомплект',
  'Сибмонтажавтоматика', 'Промтехснаб', 'Энергомашкомплекс', 'Южтрубопроводстрой'];
const OPF_SHORT = ['ООО', 'АО', 'ПАО', 'ЗАО', 'НКО', 'АНО'];
const OPF_LONG = ['Общество с ограниченной ответственностью', 'Акционерное общество', 'Публичное акционерное общество'];
const BANKS = ['Северный Кредит', 'Волжский Расчётный Банк', 'Банк Меридиан', 'Капитал-Резерв', 'Первый Торговый Банк'];
const QUOTES = [
  ['«', '»'],
  ['«', '»'],
  ['«', '»'],
  ['"', '"'],
  ['“', '”'],
];
// prettier-ignore
const EN_ORG_NAMES = ['Northwind Systems', 'Bluegate Trading', 'Silverline Analytics', 'Harbor Point Logistics', 'Redstone Capital',
  'Greenfield Software', 'Oakridge Partners', 'Brightwave Media', 'Ironbridge Holdings', 'Stonebrook Pharma', 'Clearwater Energy'];
const EN_SUFFIX = ['Ltd.', 'LLC', 'Inc.', 'GmbH', 'Corp.', 'PLC', 'Limited'];

/** Города: им., род., дат., вин., предл. */
// prettier-ignore
const CITIES = [
  ['Москва', 'Москвы', 'Москве', 'Москву', 'Москве'], ['Казань', 'Казани', 'Казани', 'Казань', 'Казани'],
  ['Новосибирск', 'Новосибирска', 'Новосибирску', 'Новосибирск', 'Новосибирске'],
  ['Екатеринбург', 'Екатеринбурга', 'Екатеринбургу', 'Екатеринбург', 'Екатеринбурге'],
  ['Нижний Новгород', 'Нижнего Новгорода', 'Нижнему Новгороду', 'Нижний Новгород', 'Нижнем Новгороде'],
  ['Санкт-Петербург', 'Санкт-Петербурга', 'Санкт-Петербургу', 'Санкт-Петербург', 'Санкт-Петербурге'],
  ['Самара', 'Самары', 'Самаре', 'Самару', 'Самаре'], ['Тверь', 'Твери', 'Твери', 'Тверь', 'Твери'],
  ['Ярославль', 'Ярославля', 'Ярославлю', 'Ярославль', 'Ярославле'], ['Краснодар', 'Краснодара', 'Краснодару', 'Краснодар', 'Краснодаре'],
  ['Владивосток', 'Владивостока', 'Владивостоку', 'Владивосток', 'Владивостоке'], ['Омск', 'Омска', 'Омску', 'Омск', 'Омске'],
  ['Калуга', 'Калуги', 'Калуге', 'Калугу', 'Калуге'], ['Тула', 'Тулы', 'Туле', 'Тулу', 'Туле'], ['Пермь', 'Перми', 'Перми', 'Пермь', 'Перми'],
  ['Ростов-на-Дону', 'Ростова-на-Дону', 'Ростову-на-Дону', 'Ростов-на-Дону', 'Ростове-на-Дону'], ['Мытищи', 'Мытищ', 'Мытищам', 'Мытищи', 'Мытищах'],
];
// prettier-ignore
const REGIONS = [
  ['Московская область', 'Московской области'], ['Республика Татарстан', 'Республики Татарстан'], ['Краснодарский край', 'Краснодарского края'],
  ['Ленинградская область', 'Ленинградской области'], ['Свердловская область', 'Свердловской области'], ['Приморский край', 'Приморского края'],
];
const STREETS = ['Ленина', 'Садовая', 'Гагарина', 'Мира', 'Пушкина', 'Лесная', 'Советская', 'Профсоюзная', 'Чкалова', 'Первомайская', 'Заводская'];
const EN_CITIES = ['London', 'New York', 'Berlin', 'Toronto', 'Dublin', 'Chicago', 'Manchester', 'Boston', 'Sydney', 'Edinburgh', 'Seattle'];
const EN_STATES = ['California', 'Delaware', 'Texas', 'Ontario', 'Bavaria', 'Scotland'];
const EN_STREETS = ['Baker Street', 'Elm Street', 'Maple Avenue', 'King Street', 'Oxford Road', 'Harbor Drive'];

/* ---------- сборка предложений ---------- */

/** Сегменты (строки и [label, text]) → {text, spans}. */
function assemble(parts) {
  let text = '';
  const spans = [];
  for (const p of parts) {
    if (typeof p === 'string')
      text += p.startsWith('.') && text.endsWith('.') ? p.slice(1) : p; // «… А. С.» + «.»
    else {
      spans.push({ start: text.length, end: text.length + p[1].length, label: p[0] });
      text += p[1];
    }
  }
  return { text, spans };
}

function ruTemplates(rng) {
  const person = makePeople(rng);
  const P = (c = 'nom', forms = ['fio']) => ['PER', person().form(c, rng.pick(forms))];
  const brand = () => rng.pick(BRAND_A) + rng.pick(BRAND_B);
  const q = (name) => {
    const [a, b] = rng.pick(QUOTES);
    return a + name + b;
  };
  const orgOpf = () => ['ORG', `${rng.chance(0.8) ? rng.pick(OPF_SHORT) : rng.pick(OPF_LONG)} ${q(brand())}`];
  const orgQ = () => ['ORG', q(brand())];
  const orgBare = () => ['ORG', rng.pick(BARE_ORGS)];
  const bank = () => ['ORG', `${rng.pick(['АО', 'ПАО'])} ${q(rng.pick(BANKS))}`];
  const city = (c = 0) => ['LOC', rng.pick(CITIES)[c]];
  const region = (c = 0) => ['LOC', rng.pick(REGIONS)[c]];
  const street = () => ['LOC', rng.pick(STREETS)];
  const num = (a, b) => String(a + rng.int(b - a + 1));
  const date = () => `${num(10, 28)}.${String(1 + rng.int(12)).padStart(2, '0')}.202${rng.int(7)}`;
  const role = () => rng.pick(['генерального директора', 'директора', 'исполнительного директора', 'управляющего']);
  const ALL = ['fio', 'iof', 'if', 'fi', 'f_io', 'io_f'];

  return [
    () => [
      orgOpf(),
      ', именуемое в дальнейшем «Заказчик», в лице ',
      role(),
      ' ',
      P('gen', ['fio', 'f_io']),
      ', действующего на основании Устава, с одной стороны',
    ],
    () => [
      'и ',
      orgOpf(),
      ', именуемое в дальнейшем «Исполнитель», в лице ',
      role(),
      ' ',
      P('gen', ['fio']),
      ', действующего на основании доверенности № ',
      num(1, 99),
      ' от ',
      date(),
      ', с другой стороны.',
    ],
    () => ['Ответственным за приёмку работ со стороны Заказчика назначен ', P('nom', ['fio', 'if', 'iof']), '.'],
    () => ['Копию акта направить ', P('dat', ['fio', 'io_f', 'if']), ' по адресу: г. ', city(), ', ул. ', street(), ', д. ', num(1, 120), '.'],
    () => ['Работы выполняются на объекте Заказчика в ', city(4), '.'],
    () => ['Подрядчик вправе привлечь субподрядчика — ', orgQ(), ' — только с письменного согласия Заказчика.'],
    () => ['Со стороны Исполнителя документы подписывает ', P('nom', ['f_io', 'io_f', 'fio']), '.'],
    () => ['Технические требования согласованы с ', P('ins', ['if', 'fio', 'iof']), ' (', orgOpf(), ').'],
    () => ['Банк получателя: ', bank(), ', БИК 0445259', num(10, 99), '.'],
    () => ['Письмо ', P('gen', ['if', 'io_f', 'fio']), ' от ', date(), ' получено и рассмотрено.'],
    () => [
      P('nom', ['fio']),
      ', паспорт серии ',
      num(10, 99),
      ' ',
      num(10, 99),
      ' № ',
      num(100000, 999999),
      ', адрес регистрации: ',
      region(),
      ', г. ',
      city(),
      ', ул. ',
      street(),
      ', д. ',
      num(1, 60),
      '.',
    ],
    () => ['Представитель ', orgOpf(), ' ', P('nom', ['if', 'fio']), ' прибыл в ', city(3), ' для проведения проверки.'],
    () => ['В переговорах также участвовали ', P('nom', ['if', 'fi']), ' и ', P('nom', ['if', 'fi']), '.'],
    () => ['Груз доставляется из ', city(1), ' в ', city(3), ' силами ', orgOpf(), '.'],
    () => ['Лицензиаром по настоящему договору выступает компания ', ['ORG', `${rng.pick(EN_ORG_NAMES)} ${rng.pick(EN_SUFFIX)}`], '.'],
    () => ['Получатель: ИП ', P('nom', ['fio', 'f_io']), ', ОГРНИП ', num(300000000, 399999999), num(100000, 999999), '.'],
    () => ['Контактное лицо — ', P('nom', ['io', 'if']), ', тел. +7 (9', num(10, 99), ') ', num(100, 999), '-', num(10, 99), '-', num(10, 99), '.'],
    () => ['По поручению ', P('gen', ['f_io', 'io_f']), ' оплата производится через ', bank(), '.'],
    () => ['Поставка осуществляется на склад Покупателя на территории ', region(1), '.'],
    () => ['Споры рассматриваются в Арбитражном суде г. ', city(), '.'],
    () => ['Гарантом исполнения обязательств выступает ', orgBare(), ', а поручителем — ', P('nom', ['fio']), '.'],
    () => ['Акт сверки подписан бухгалтером ', P('ins', ['if', 'fio', 'f_io']), ' ', date(), '.'],
    () => ['Протокол разногласий передан юристу ', orgQ(), ' ', P('dat', ['if', 'io_f']), '.'],
    () => ['Доверенность выдана ', P('dat', ['fio', 'iof']), ' сроком на один год.'],
    () => ['Сведения о персонале: водитель ', P('nom', ALL), ', экспедитор ', P('nom', ALL), '.'],
    () => ['Ключи от помещения передаются ', P('dat', ['fi', 'if']), ' по акту приёма-передачи.'],
    () => ['Филиал ', orgOpf(), ' в ', city(4), ' обеспечивает сервисное обслуживание оборудования.'],
    () => ['Оборудование производства ', orgBare(), ' поставляется со склада в ', city(4), '.'],
    () => ['Поставщик гарантирует, что ', P('nom', ['if', 'fio']), ' обладает необходимой квалификацией.'],
    () => ['Счёт выставлен на имя ', P('gen', ['fio', 'f_io']), ' (место жительства — г. ', city(), ').'],
    () => ['Мы, нижеподписавшиеся, ', P('nom', ['fio']), ' и ', P('nom', ['fio']), ', составили настоящий акт.'],
    () => ['Заявка согласована руководителем проекта ', P('ins', ['if', 'io_f']), ' и направлена в ', orgOpf(), '.'],
    () => ['Обучение персонала проводится специалистами ', orgQ(), ' на площадке в ', city(4), '.'],
    () => ['Решение принято на основании служебной записки ', P('gen', ['io_f', 'f_io']), '.'],
    // без сущностей (ложные срабатывания на заглавных словах договора)
    () => ['Стороны обязуются сохранять конфиденциальность условий настоящего Договора в течение ', num(2, 5), ' лет.'],
    () => ['Исполнитель уплачивает Заказчику неустойку в размере 0,1 % от стоимости Работ за каждый день просрочки.'],
    () => ['Приложение № ', num(1, 5), ' является неотъемлемой частью Договора.'],
    () => ['Акт сдачи-приёмки подписывается Сторонами в течение ', num(3, 10), ' рабочих дней.'],
    () => ['Цена Товара включает НДС ', num(10, 20), ' % и расходы на доставку.'],
    () => ['Все уведомления направляются Сторонами в письменной форме заказным письмом.'],
    () => ['Настоящий Договор вступает в силу с момента подписания и действует до ', date(), '.'],
    () => ['Гарантийный срок на Оборудование составляет ', num(12, 36), ' месяцев.'],
  ];
}

function enTemplates(rng) {
  const d = getDicts();
  // как в ru: в основном распространённые имена (лексикон WP2, есть в словаре), реже — любые из словаря
  const common = [...FIRST_NAMES_EN].filter((w) => d.enFirst.has(w) && /^[a-z]+$/.test(w));
  const firsts = [...d.enFirst].filter((w) => w.length > 3);
  const lasts = [...d.enSurnames].filter((w) => w.length > 3);
  // голая фамилия ('tl') — только после обращения (Mr. Smith), как пишут в договорах
  const name = (form = rng.pick(['fl', 'fl', 'fml', 'il'])) => {
    const f = cap(rng.chance(0.8) ? rng.pick(common) : rng.pick(firsts));
    const l = cap(rng.pick(lasts));
    if (form === 'fml') return ['PER', `${f} ${cap(rng.pick(firsts))[0]}. ${l}`];
    if (form === 'il') return ['PER', `${f[0]}. ${l}`];
    if (form === 'tl') return ['PER', l];
    return ['PER', `${f} ${l}`];
  };
  const title = () => rng.pick(['Mr. ', 'Ms. ', 'Dr. ', 'Mrs. ']);
  const org = () => ['ORG', `${rng.pick(EN_ORG_NAMES)} ${rng.pick(EN_SUFFIX)}`];
  const orgBare = () => ['ORG', rng.pick(EN_ORG_NAMES)];
  const city = () => ['LOC', rng.pick(EN_CITIES)];
  const state = () => ['LOC', rng.pick(EN_STATES)];
  const num = (a, b) => String(a + rng.int(b - a + 1));
  return [
    () => ['This Agreement is made between ', org(), ', a company incorporated in ', state(), ', and ', org(), '.'],
    () => ['The Supplier is represented by its Director, ', name(), '.'],
    () => ['All notices shall be sent to ', name(), ' at ', num(1, 200), ' ', ['LOC', rng.pick(EN_STREETS)], ', ', city(), '.'],
    () => ['The Services will be performed at the Client premises in ', city(), '.'],
    () => ['Signed on behalf of ', org(), ' by ', name(rng.pick(['fl', 'fml'])), ', Chief Executive Officer.'],
    () => ['Any dispute shall be resolved by the courts of ', state(), '.'],
    () => ['The project manager, ', title(), name(rng.pick(['tl', 'fl'])), ', shall approve each milestone.'],
    () => [name(), ' and ', name(), ' attended the kick-off meeting in ', city(), '.'],
    () => ['Payments shall be made to the account held with ', ['ORG', `${rng.pick(EN_ORG_NAMES)} Bank`], '.'],
    () => ['The Licensor, ', orgBare(), ', grants a non-exclusive license to the Licensee.'],
    () => ['Questions regarding invoices should be addressed to ', name(rng.pick(['fl', 'il'])), '.'],
    () => ['The goods will be shipped from ', city(), ' to ', city(), ' by ', org(), '.'],
    () => ['Witnessed by ', name(rng.pick(['fml', 'fl'])), ' on the date written above.'],
    () => ['According to ', title(), name('tl'), ', the delivery was completed on time.'],
    () => ['The parties agree that ', name(), ' will act as the escrow agent.'],
    // без сущностей
    () => ['The Contractor shall indemnify the Client against all claims arising from the Services.'],
    () => ['This Agreement shall remain in force for a period of ', num(1, 5), ' years.'],
    () => ['Late payments shall bear interest at ', num(1, 9), ' % per annum.'],
    () => ['Each Party shall keep the terms of this Agreement confidential.'],
  ];
}

function generate(templates, n) {
  const out = [];
  const seen = new Set();
  for (let k = 0; out.length < n && k < n * 20; k++) {
    const t = templates[k % templates.length];
    const s = assemble(t());
    if (seen.has(s.text)) continue;
    seen.add(s.text);
    out.push(s);
  }
  return out;
}

export function buildNerEval({ seed = SEED } = {}) {
  const rng = rngFrom(seed);
  const ru = generate(ruTemplates(rng), N_RU);
  const en = generate(enTemplates(rng), N_EN);
  const meta = (lang) => ({
    comment: `WP9 (К8): синтетический корпус оценки NER (${lang}), договорной стиль, данные вымышленные. Генератор — scripts/gen-ner-eval.mjs, сид ${seed}. Соглашение о спанах — в шапке генератора.`,
    seed,
  });
  return { ru: { ...meta('ru'), sentences: ru }, en: { ...meta('en'), sentences: en } };
}

/* ---------- CLI ---------- */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const out = resolve(process.argv[2] || join(root, 'tests/fixtures/ner'));
  await mkdir(out, { recursive: true });
  const { ru, en } = buildNerEval();
  for (const [name, data] of [
    ['eval-ru.json', ru],
    ['eval-en.json', en],
  ]) {
    const body =
      '{\n' +
      `  "comment": ${JSON.stringify(data.comment)},\n  "seed": ${data.seed},\n  "sentences": [\n` +
      data.sentences.map((s) => '    ' + JSON.stringify(s)).join(',\n') +
      '\n  ]\n}\n';
    await writeFile(join(out, name), body);
    const by = {};
    for (const s of data.sentences) for (const sp of s.spans) by[sp.label] = (by[sp.label] || 0) + 1;
    console.log(`${name}: ${data.sentences.length} предложений, спаны ${JSON.stringify(by)}`);
  }
}
