#!/usr/bin/env node
// Корпус жанров (версия 0.4, Ц4, К5, `docs/contracts.md` §8.4): деловые документы за пределами договоров — коммерческое
// предложение, деловое письмо, счёт и УПД, акт сверки, регламент/инструкция, презентация (только PDF), резюме, переписка;
// `letter` и `resume` — ещё и на английском. Для каждого документа — DOCX (кроме `deck`), PDF (Chromium Playwright, как
// scripts/gen-pdf-fixtures.mjs), снимок разметки `<имя>.pdf.txt` и gold `{entities: [{key, category, value, opf?}],
// negatives: [{value, category, mode?}]}`:
//   - entities — все значения pii/ids и названия организаций (COMPANY: `opf: true` — с ОПФ, `false` — «Студия + Название»);
//     формы в тексте перечислены отдельно (именительный, родительный, «Фамилия И.О.»), как в tests/fixtures/docs;
//     «ИП Фамилия И.О.» — PERSON со значением без «ИП» (решение владельца 1: «ИП » остаётся вне плейсхолдера);
//   - negatives — заголовки капсом и нумерованные, аббревиатуры, продукты, бренд «Студия <Бренд>» (`mode: 'normal'` —
//     только для обычного режима: в коммерческом бренд — организация), которые не должны стать сущностью.
// Синтетический аналог КП Sitimlab — `proposal/kp-lunopark` (обложка капсом, «01 О нас»…«05 Цены», таблица цен, ЭДО/ВЭД/УПД/MVP,
// Word/Excel, реквизиты с ИНН/КПП/счётом/БИК, контактное лицо). Все данные ВЫМЫШЛЕННЫЕ (ИНН, ОГРН, счета, карты — с верными
// контрольными суммами из scripts/make-sample.mjs). ГПСЧ mulberry32 (как scripts/gen-ner-eval.mjs) с фиксированным сидом на
// документ — генерация детерминирована: DOCX побайтно, снимки PDF — по извлечённому тексту (байты PDF Chromium недетерминированы).
//
// Использование: npm run gen-genre-fixtures [-- --update-snapshots] [--only=<жанр|имя,…>] [--out=<каталог>] [--no-pdf]
//   снимки .pdf.txt перезаписываются только с --update-snapshots (или если снимка ещё нет), как в tests/fixtures/pdf
// Из кода: buildGenreDocs() → [{genre, name, lang, docx?, html, pdf: {landscape?}, gold}], buildGenrePdf(browser, d)
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack, tbl, cell, title } from './gen-fixtures.mjs';
import { unescapeXml } from '../src/core/docx/xml.js';
import { inn10, inn12, ogrn13, account, r, p, B } from './make-sample.mjs';
import { documentToHtml, documentXml, htmlPage, htmlToPdf, layoutSnapshot } from './gen-pdf-fixtures.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const GENRES_DIR = join(root, 'tests/fixtures/genres');
export const GENRE_SEED = 20261019;
export const GENRES = ['proposal', 'letter', 'invoice', 'reconciliation', 'manual', 'deck', 'resume', 'chat'];

/* ---------- ГПСЧ (mulberry32, как scripts/gen-ner-eval.mjs) ---------- */

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
  const digits = (n) => Array.from({ length: n }, () => int(10)).join('');
  return { next, int, digits, pick: (arr) => arr[int(arr.length)], range: (a0, b0) => a0 + int(b0 - a0 + 1) };
}

/** Сид документа: от имени, чтобы добавление документа не сдвигало остальные. */
function seedOf(name) {
  let h = GENRE_SEED;
  for (const ch of name) h = (Math.imul(h ^ ch.codePointAt(0), 16777619) + 0x9e3779b9) >>> 0;
  return h;
}

/* ---------- вымышленные словари ---------- */

// prettier-ignore
const PEOPLE = [
  { f: 'Соколова', i: 'Дарья', o: 'Андреевна', gen: 'Соколовой Дарьи Андреевны', dat: 'Соколовой Дарье Андреевне', lat: 'd.sokolova', w: true },
  { f: 'Ершов', i: 'Кирилл', o: 'Валерьевич', gen: 'Ершова Кирилла Валерьевича', dat: 'Ершову Кириллу Валерьевичу', lat: 'k.ershov' },
  { f: 'Морозов', i: 'Андрей', o: 'Викторович', gen: 'Морозова Андрея Викторовича', dat: 'Морозову Андрею Викторовичу', lat: 'a.morozov' },
  { f: 'Кузнецова', i: 'Ольга', o: 'Владимировна', gen: 'Кузнецовой Ольги Владимировны', dat: 'Кузнецовой Ольге Владимировне', lat: 'o.kuznetsova', w: true },
  { f: 'Белов', i: 'Игорь', o: 'Сергеевич', gen: 'Белова Игоря Сергеевича', dat: 'Белову Игорю Сергеевичу', lat: 'i.belov' },
  { f: 'Лебедева', i: 'Марина', o: 'Павловна', gen: 'Лебедевой Марины Павловны', dat: 'Лебедевой Марине Павловне', lat: 'm.lebedeva', w: true },
  { f: 'Григорьев', i: 'Денис', o: 'Олегович', gen: 'Григорьева Дениса Олеговича', dat: 'Григорьеву Денису Олеговичу', lat: 'd.grigoriev' },
  { f: 'Тихонова', i: 'Елена', o: 'Игоревна', gen: 'Тихоновой Елены Игоревны', dat: 'Тихоновой Елене Игоревне', lat: 'e.tikhonova', w: true },
  { f: 'Савельев', i: 'Максим', o: 'Петрович', gen: 'Савельева Максима Петровича', dat: 'Савельеву Максиму Петровичу', lat: 'm.saveliev' },
  { f: 'Орлова', i: 'Наталья', o: 'Юрьевна', gen: 'Орловой Натальи Юрьевны', dat: 'Орловой Наталье Юрьевне', lat: 'n.orlova', w: true },
  { f: 'Зайцев', i: 'Павел', o: 'Николаевич', gen: 'Зайцева Павла Николаевича', dat: 'Зайцеву Павлу Николаевичу', lat: 'p.zaitsev' },
  { f: 'Фролова', i: 'Анна', o: 'Михайловна', gen: 'Фроловой Анны Михайловны', dat: 'Фроловой Анне Михайловне', lat: 'a.frolova', w: true },
  { f: 'Комаров', i: 'Роман', o: 'Алексеевич', gen: 'Комарова Романа Алексеевича', dat: 'Комарову Роману Алексеевичу', lat: 'r.komarov' },
  { f: 'Воронина', i: 'Светлана', o: 'Дмитриевна', gen: 'Ворониной Светланы Дмитриевны', dat: 'Ворониной Светлане Дмитриевне', lat: 's.voronina', w: true },
  { f: 'Новиков', i: 'Артём', o: 'Ильич', gen: 'Новикова Артёма Ильича', dat: 'Новикову Артёму Ильичу', lat: 'a.novikov' },
  { f: 'Полякова', i: 'Вера', o: 'Константиновна', gen: 'Поляковой Веры Константиновны', dat: 'Поляковой Вере Константиновне', lat: 'v.polyakova', w: true },
];
// prettier-ignore
const COMPANIES = [
  ['Северный Ветер', 'severny-veter'], ['Лунный Берег', 'lunny-bereg'], ['Вектор Плюс', 'vector-plus'], ['Гранит-Строй', 'granit-stroy'],
  ['Орион Трейд', 'orion-trade'], ['Кедровый Бор', 'kedr-bor'], ['Альтаир-М', 'altair-m'], ['Синяя Птица', 'sinyaya-ptica'],
  ['Меридиан Логистик', 'meridian-log'], ['Тихая Гавань', 'tihaya-gavan'], ['Белый Парус', 'bely-parus'], ['Полярная Звезда', 'polar-star'],
  ['Янтарный Край', 'yantar-kray'], ['Зелёный Остров', 'zeleny-ostrov'], ['Ясный Полдень', 'yasny-polden'], ['Серебряный Ключ', 'serebr-klyuch'],
];
const BANKS = ['Северный Кредит', 'Волжский Расчётный Банк', 'Первый Торговый Банк', 'Капитал-Резерв'];
// город, индекс (3 первые цифры), код телефона, регион ИНН, улицы
// prettier-ignore
const CITIES = [
  { city: 'Москва', zip: '123', tel: '495', reg: '77', streets: ['ул. Ленина', 'ул. Профсоюзная', 'Ленинский пр-т', 'ул. Садовая-Кудринская'] },
  { city: 'Санкт-Петербург', zip: '190', tel: '812', reg: '78', streets: ['ул. Садовая', 'Невский пр-т', 'ул. Рубинштейна', 'Лиговский пр-т'] },
  { city: 'Казань', zip: '420', tel: '843', reg: '16', streets: ['ул. Баумана', 'ул. Пушкина', 'пр-т Победы'] },
  { city: 'Новосибирск', zip: '630', tel: '383', reg: '54', streets: ['Красный пр-т', 'ул. Гоголя', 'ул. Советская'] },
  { city: 'Екатеринбург', zip: '620', tel: '343', reg: '66', streets: ['ул. Малышева', 'ул. Мира', 'пр-т Ленина'] },
  { city: 'Нижний Новгород', zip: '603', tel: '831', reg: '52', streets: ['ул. Большая Покровская', 'ул. Минина', 'ул. Белинского'] },
];
// prettier-ignore
const EN_PEOPLE = [
  { first: 'Emily', last: 'Clarke', lat: 'e.clarke' }, { first: 'James', last: 'Whitmore', lat: 'j.whitmore' },
  { first: 'Oliver', last: 'Bennett', lat: 'o.bennett' }, { first: 'Sophie', last: 'Harrington', lat: 's.harrington' },
];
// prettier-ignore
const EN_COMPANIES = [['Northwind Systems', 'Ltd.', 'northwind'], ['Bluegate Trading', 'LLC', 'bluegate'], ['Silverline Analytics', 'Inc.', 'silverline']];

/* ---------- построитель документа и gold ---------- */

/** Документ: тело WordprocessingML, gold и вспомогательные функции, которые сразу пишут gold. */
function newDoc(genre, name, lang = 'ru') {
  const rng = rngFrom(seedOf(name));
  const entities = [];
  const negatives = [];
  const used = new Set();
  const d = {
    genre,
    name,
    lang,
    rng,
    entities,
    negatives,
    /** Сущность gold (повтор того же значения не дублируется). */
    add(category, value, extra = {}) {
      if (!entities.some((e) => e.category === category && e.value === value)) entities.push({ key: `e${entities.length + 1}`, category, value, ...extra });
      return value;
    },
    /** Отрицательный пример: не должен стать сущностью (category — чем его можно принять). */
    neg(value, category = 'COMPANY', mode) {
      if (!negatives.some((n) => n.value === value)) negatives.push(mode ? { value, category, mode } : { value, category });
      return value;
    },
    /** Человек из словаря без повторов внутри документа. */
    person(filter = () => true) {
      const pool = PEOPLE.filter((x) => !used.has(x.f) && filter(x));
      const x = rng.pick(pool);
      used.add(x.f);
      return x;
    },
    company() {
      const pool = COMPANIES.filter(([n]) => !used.has(n));
      const [n, dom] = rng.pick(pool);
      used.add(n);
      return { name: n, dom };
    },
    city() {
      return rng.pick(CITIES);
    },
  };
  return d;
}

/* формы имени: каждая используемая форма — отдельное значение gold */
const PF = {
  full: (x) => `${x.f} ${x.i} ${x.o}`,
  gen: (x) => x.gen,
  dat: (x) => x.dat,
  short: (x) => `${x.f} ${x.i[0]}.${x.o[0]}.`,
  shortGen: (x) => `${x.gen.split(' ')[0]} ${x.i[0]}.${x.o[0]}.`,
  shortDat: (x) => `${x.dat.split(' ')[0]} ${x.i[0]}.${x.o[0]}.`,
  fl: (x) => `${x.i} ${x.f}`,
  lf: (x) => `${x.f} ${x.i}`,
};
/** Фамилия в той же форме — для проверки частичной утечки (фамилия целым словом в результате). */
const SURNAME = {
  gen: (x) => x.gen.split(' ')[0],
  dat: (x) => x.dat.split(' ')[0],
  shortGen: (x) => x.gen.split(' ')[0],
  shortDat: (x) => x.dat.split(' ')[0],
};
const per = (d, x, form = 'full') => d.add('PERSON', PF[form](x), { surname: (SURNAME[form] || ((y) => y.f))(x) });
/** «ООО «Название»»: COMPANY — название без ОПФ и кавычек. */
const co = (d, c, opf = 'ООО') => `${opf} «${d.add('COMPANY', c.name, { opf: true })}»`;
const bank = (d) => `АО «${d.add('COMPANY', d.rng.pick(BANKS), { opf: true })}»`;

/* реквизиты с верными контрольными суммами */
function requisites(d, city, { bank = true, ogrn: withOgrn = true } = {}) {
  const inn = d.add('INN', inn10(city.reg + d.rng.digits(7)));
  const p12 = `12${d.rng.range(1, 6)}${city.reg}${d.rng.digits(7)}`;
  const ogrn = withOgrn ? d.add('OGRN', ogrn13(p12)) : '';
  if (!bank) return { inn, ogrn };
  const kpp = d.add('KPP', `${inn.slice(0, 4)}01001`);
  const bik = d.add('BIK', `04${city.reg}${d.rng.digits(5)}`);
  const rs = d.add('ACCOUNT', account(bik, `40702810${d.rng.digits(12)}`, 'rs'));
  const ks = d.add('ACCOUNT', account(bik, `301018104${d.rng.digits(8)}${bik.slice(-3)}`, 'ks'));
  return { inn, kpp, ogrn, bik, rs, ks };
}
function ipRequisites(d, city, { bank = true } = {}) {
  const inn = d.add('INN', inn12(city.reg + d.rng.digits(8)));
  const p14 = `3${d.rng.range(10, 24)}${city.reg}${d.rng.digits(9)}`;
  const ogrnip = d.add('OGRN', p14 + String((BigInt(p14) % 13n) % 10n));
  if (!bank) return { inn, ogrnip };
  const bik = d.add('BIK', `04${city.reg}${d.rng.digits(5)}`);
  const rs = d.add('ACCOUNT', account(bik, `40802810${d.rng.digits(12)}`, 'rs'));
  return { inn, ogrnip, bik, rs };
}
const address = (d, city, kind = 'офис') =>
  d.add('ADDRESS', `${city.zip}${d.rng.digits(3)}, г. ${city.city}, ${d.rng.pick(city.streets)}, д. ${d.rng.range(1, 120)}, ${kind} ${d.rng.range(2, 450)}`);
/**
 * Городской телефон из заведомо невыдаваемого диапазона: местный номер с «0» в начале не выделяется абонентам
 * («+7 (843) 022-33-44»); добавочный номер — часть значения («…, доб. 105»).
 */
const phone = (d, city, ext = false) =>
  d.add('PHONE', `+7 (${city.tel}) 0${d.rng.digits(2)}-${d.rng.digits(2)}-${d.rng.digits(2)}${ext ? `, доб. ${d.rng.range(100, 299)}` : ''}`);
/** Мобильный — из резервного диапазона «+7 (999) 00x-xx-xx» (не выдаётся абонентам). */
const mobile = (d) => d.add('PHONE', `+7 (999) 00${d.rng.int(10)}-${d.rng.digits(2)}-${d.rng.digits(2)}`);
const email = (d, local, dom) => d.add('EMAIL', `${local}@${dom}.example`);
function card(d) {
  const body = `400000${d.rng.digits(9)}`; // тестовый BIN Visa 400000
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let x = Number(body[14 - i]);
    if (i % 2 === 0) x = x * 2 > 9 ? x * 2 - 9 : x * 2;
    sum += x;
  }
  const n = body + ((10 - (sum % 10)) % 10);
  return d.add('CARD', n.replace(/(\d{4})(?=\d)/g, '$1 '));
}

/* ---------- WordprocessingML: заголовки, списки, стили ---------- */

const h = (t, lvl = 1) => p(r(t), `<w:pStyle w:val="Heading${lvl}"/>`);
const li = (t) => p(r(t), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>');
const capsLine = (t) => p(r(t, B));
const right = (t) => p(r(t), '<w:jc w:val="right"/>');
/** Отрицательные примеры: заголовок/капс-строка тоже записывается в negatives. */
const H = (d, t, lvl = 1) => h(d.neg(t), lvl);
const CAPS = (d, t) => capsLine(d.neg(t));
const TITLE = (d, t) => title(d.neg(t));
/** Слова-аббревиатуры и продукты в тексте → negatives (проверка «ни в одной категории»). */
const negs = (d, ...words) => words.forEach((w) => d.neg(w));

const W_ML = 'application/vnd.openxmlformats-officedocument.wordprocessingml';
const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault/></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="a"/><w:next w:val="a"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="a"/><w:next w:val="a"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>' +
  '</w:styles>';
const NUMBERING =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>' +
  '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>';

/** DOCX документа: стили заголовков, нумерация списков, свойства (автор — один из людей gold). */
function docxOf(d, body, { docTitle, creator }) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return pack({
    body,
    core: `<dc:title>${esc(docTitle)}</dc:title><dc:creator>${esc(creator)}</dc:creator>`,
    app: '<Company></Company>',
    extra: { 'word/styles.xml': STYLES, 'word/numbering.xml': NUMBERING },
    rels: '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>',
    contentTypeParts: [['word/numbering.xml', `${W_ML}.numbering+xml`]],
  });
}

/** Готовый документ жанра: DOCX + HTML для печати в PDF (из того же document.xml). */
function finish(d, body, meta) {
  const docx = docxOf(d, body, meta);
  const xml = documentXml(docx);
  // значения, которых нет в тексте документа (только автор в docProps), помечаются meta: в PDF их нет
  const text = [...xml.matchAll(/<w:t\b[^>]*>([^<]*)<\/w:t>/g)].map((m) => unescapeXml(m[1])).join('\n');
  for (const e of d.entities) if (!text.includes(e.value)) e.meta = true;
  const html = htmlPage(documentToHtml(xml));
  return { genre: d.genre, name: d.name, lang: d.lang, docx, html, pdf: {}, gold: { entities: d.entities, negatives: d.negatives } };
}

/** Сумма с разрядами через пробел («45 000»), без Intl — одинаково на любой сборке Node. */
const money = (d, lo, hi, step = 1000) => String(d.rng.range(lo / step, hi / step) * step).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/* ---------- 1. Коммерческое предложение ---------- */

/** Синтетический аналог КП Sitimlab (К4): студия-бренд, нумерованные разделы, таблица цен, реквизиты ООО. */
function kpLunopark() {
  const d = newDoc('proposal', 'kp-lunopark');
  const spb = CITIES[1];
  const client = d.company();
  const manager = d.person((x) => x.w);
  const director = d.person((x) => !x.w);
  d.add('COMPANY', 'Лунопарк', { opf: false });
  d.neg('Студия Лунопарк', 'COMPANY', 'normal');
  negs(d, 'ЭДО', 'ВЭД', 'ТН ВЭД', 'УПД', 'MVP', 'Word', 'Excel', 'Telegram', 'PDF', '1С', 'НДС', 'УСН', 'КЭП');
  const req = requisites(d, spb);
  const site = d.add('URL', 'https://lunopark.example');
  const body = [
    TITLE(d, 'КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ'),
    title('Студия Лунопарк'),
    p(r(`Автоматизация документооборота для ${co(d, client)}`), '<w:jc w:val="center"/>'),
    p(r('Подготовлено 14 октября 2026 г.'), '<w:jc w:val="center"/>'),
    H(d, '01 О нас'),
    p(
      r(
        'Студия Лунопарк с 2019 года делает сервисы для работы с документами: шаблоны договоров, выгрузки в Excel и интеграции с ЭДО. ' +
          'Мы работаем с компаниями из сферы ВЭД, логистики и строительства.',
      ),
    ),
    CAPS(d, 'ПОЧЕМУ ТАК'),
    li(d.neg('Готовые шаблоны в Word')),
    li('Проверка реквизитов перед отправкой'),
    li(d.neg('Новый документ или шаблон за минуту')),
    H(d, '02 Задача'),
    p(
      r(
        `Сейчас менеджеры ${co(d, client)} заполняют УПД и счета вручную в Excel, сверяют коды ТН ВЭД по таблицам и пересылают файлы в Telegram. ` +
          'На один комплект документов уходит до 40 минут, ошибки в реквизитах находятся уже после отправки.',
      ),
    ),
    H(d, '03 Что входит'),
    CAPS(d, 'ВХОДИТ'),
    li('Аудит текущих шаблонов и процессов'),
    li(d.neg('MVP за 4 недели')),
    li(d.neg('Интеграция с 1С и ЭДО')),
    li('Обучение сотрудников'),
    CAPS(d, 'НЕ ВХОДИТ'),
    li(d.neg('Доработка учётной системы')),
    H(d, '04 Этапы и сроки'),
    tbl(
      [
        [cell('Этап'), cell('Срок'), cell('Результат')],
        [cell('Аудит'), cell('1 неделя'), cell(d.neg('Отчёт в PDF'))],
        [cell('MVP'), cell('4 недели'), cell('Рабочий прототип')],
        [cell('Внедрение'), cell('2 недели'), cell('Инструкция для сотрудников')],
      ],
      3,
    ),
    H(d, '05 Цены'),
    tbl(
      [
        [cell('Работа'), cell('Стоимость')],
        [cell('Аудит документов'), cell(`${money(d, 30000, 60000)} ₽`)],
        [cell('Разработка MVP'), cell(`${money(d, 200000, 350000)} ₽`)],
        [cell('Внедрение и обучение'), cell(`${money(d, 40000, 90000)} ₽`)],
      ],
      2,
    ),
    p(r('Цены указаны без НДС (УСН). Оплата — 50 % предоплаты по счёту, остаток после подписания акта; документы подписываем КЭП через ЭДО.')),
    H(d, '06 Контакты'),
    p(r(`Менеджер проекта: ${per(d, manager)}, тел. ${mobile(d)}, e-mail ${email(d, manager.lat, 'lunopark')}`)),
    p(r(`Сайт: ${site}`)),
    CAPS(d, 'РЕКВИЗИТЫ'),
    p(r(co(d, { name: 'Лунопарк Диджитал' }))),
    p(r(`ИНН ${req.inn}, КПП ${req.kpp}, ОГРН ${req.ogrn}`)),
    p(r(`Юридический адрес: ${address(d, spb)}`)),
    p(r(`р/с ${req.rs} в ${bank(d)}, БИК ${req.bik}, к/с ${req.ks}`)),
    p(r(`Генеральный директор ${per(d, director, 'short')}`)),
  ].join('');
  return finish(d, body, { docTitle: 'Коммерческое предложение', creator: per(d, manager) });
}

/** КП агентства с реквизитами ИП (ИП — человек: PERSON без «ИП»). */
function kpAgency(name, brandWord, brand, sections) {
  const d = newDoc('proposal', name);
  const city = d.city();
  const client = d.company();
  const owner = d.person();
  const contact = d.person((x) => x.w);
  const dom = brand === 'Светлячок' ? 'svetlyachok' : 'polden-buro';
  d.add('COMPANY', brand, { opf: false });
  d.neg(`${brandWord} ${brand}`, 'COMPANY', 'normal');
  negs(d, 'CRM', 'Bitrix24', 'KPI', 'API', 'SEO', 'Google', 'Яндекс', 'Excel', 'НДС', 'ТЗ');
  const req = ipRequisites(d, city);
  const body = [
    TITLE(d, sections.cover),
    title(`${brandWord} ${brand}`),
    p(r(`для ${co(d, client, d.rng.pick(['ООО', 'АО']))}`), '<w:jc w:val="center"/>'),
    H(d, `01 ${sections.about}`),
    p(r(`${brandWord} ${brand} — команда из 12 человек. Внедряем CRM на базе Bitrix24, настраиваем сквозную аналитику и отчёты по KPI в Excel.`)),
    CAPS(d, 'НАШИ ПРИНЦИПЫ'),
    li('Сначала ТЗ, потом работа'),
    li(d.neg('Прозрачные сроки')),
    li(d.neg('Отчёт каждую неделю')),
    H(d, `02 ${sections.task}`),
    p(
      r(
        `Задача ${co(d, client, 'ООО')} — собрать заявки с сайта, из Яндекс и Google в одну воронку, подключить API телефонии и ` +
          'видеть конверсию по каждому каналу без ручных выгрузок.',
      ),
    ),
    H(d, `03 ${sections.scope}`),
    li('Аудит воронки продаж'),
    li(d.neg('Настройка CRM')),
    li('Интеграция API телефонии'),
    li(d.neg('SEO-аудит сайта')),
    H(d, `04 ${sections.price}`),
    tbl(
      [
        [cell('Пакет'), cell('Состав'), cell('Цена')],
        [cell(d.neg('Старт')), cell('Аудит и ТЗ'), cell(`${money(d, 20000, 50000)} ₽`)],
        [cell(d.neg('Оптимальный')), cell('CRM + интеграции'), cell(`${money(d, 120000, 220000)} ₽`)],
        [cell(d.neg('Максимум')), cell('CRM, API, обучение, поддержка 3 месяца'), cell(`${money(d, 250000, 400000)} ₽`)],
      ],
      3,
    ),
    p(r('НДС не облагается (применяется упрощённая система налогообложения).')),
    H(d, `05 ${sections.why}`),
    p(r(`Больше 60 внедрений за пять лет. ${brandWord} ${brand} входит в число партнёров Bitrix24.`)),
    H(d, '06 Контакты'),
    p(r(`Аккаунт-менеджер — ${per(d, contact)}, ${mobile(d)}, ${email(d, contact.lat, dom)}`)),
    CAPS(d, 'РЕКВИЗИТЫ'),
    p(r(`ИП ${per(d, owner)}`)),
    p(r(`ИНН ${req.inn}, ОГРНИП ${req.ogrnip}`)),
    p(r(`Адрес: ${address(d, city)}`)),
    p(r(`р/с ${req.rs}, БИК ${req.bik}`)),
    p(r(`_____________ / ИП ${per(d, owner, 'short')} /`)),
  ].join('');
  return finish(d, body, { docTitle: sections.cover, creator: per(d, contact) });
}

/* ---------- 2. Деловое письмо ---------- */

function letterSchedule() {
  const d = newDoc('letter', 'letter-schedule');
  const spb = CITIES[1];
  const from = d.company();
  const to = d.company();
  const addressee = d.person((x) => !x.w);
  const manager = d.person((x) => x.w);
  const director = d.person((x) => !x.w);
  negs(d, 'ЭДО', 'Excel', 'УПД', 'КЭП');
  const body = [
    title(co(d, from)),
    // шапка одной строкой: в PDF центрированная строка переносится и рвёт адрес почты (известный недочёт, KNOWN_GAPS)
    p(r(`${address(d, spb)} · тел. ${phone(d, spb)} · ${email(d, 'info', from.dom)}`), '<w:jc w:val="center"/>'),
    p(r(`Исх. № ${d.rng.range(100, 999)} от 12.10.2026`)),
    right(`Генеральному директору ${co(d, to)}`),
    right(per(d, addressee, 'shortDat')),
    p(r('О согласовании графика поставок', B)),
    p(r(`Уважаемый ${d.add('PERSON', `${addressee.i} ${addressee.o}`)}!`)),
    p(
      r(
        'В связи с переходом на ЭДО просим подтвердить график поставок на IV квартал 2026 года. Таблицу в Excel направляем отдельным файлом; ' +
          'закрывающие документы (УПД) будут подписаны КЭП через оператора электронного документооборота.',
      ),
    ),
    p(r(`Контактное лицо по вопросам поставок — менеджер ${per(d, manager, 'short')}, тел. ${phone(d, spb)}, ${email(d, manager.lat, from.dom)}.`)),
    p(r('Приложение: график поставок на 2 л. в 1 экз.')),
    p(r('С уважением,')),
    p(r(`Генеральный директор ${co(d, from)}`)),
    p(r(`_____________ ${per(d, director, 'short')}`)),
  ].join('');
  return finish(d, body, { docTitle: 'Письмо о графике поставок', creator: per(d, manager, 'full') });
}

function letterGuarantee() {
  const d = newDoc('letter', 'letter-guarantee');
  const city = d.city();
  const from = d.company();
  const to = d.company();
  const director = d.person((x) => !x.w);
  const accountant = d.person((x) => x.w);
  const req = requisites(d, city);
  negs(d, 'НДС');
  const body = [
    title(co(d, from)),
    p(r(`ИНН ${req.inn} / КПП ${req.kpp}, ОГРН ${req.ogrn}`), '<w:jc w:val="center"/>'),
    p(r(`${address(d, city)}, тел. ${phone(d, city)}`), '<w:jc w:val="center"/>'),
    p(r(`Исх. № ${d.rng.range(10, 99)}/26 от 05.10.2026`)),
    right(`${co(d, to)}`),
    TITLE(d, 'ГАРАНТИЙНОЕ ПИСЬМО'),
    p(
      r(
        `${co(d, from)} гарантирует оплату поставленного товара по счёту № ${d.rng.range(100, 999)} от 01.10.2026 на сумму ` +
          `${money(d, 100000, 900000)} руб., в том числе НДС 20 %, в срок до 30.11.2026.`,
      ),
    ),
    p(r(`Оплата будет произведена с расчётного счёта ${req.rs} в ${bank(d)}, БИК ${req.bik}, к/с ${req.ks}.`)),
    p(r(`Товар отгружен со склада, договор аренды которого подготовило ${d.add('COMPANY', 'Агентство недвижимости Тихий Двор', { opf: false })}.`)),
    p(r(`Генеральный директор _____________ ${per(d, director, 'short')}`)),
    p(r(`Главный бухгалтер _____________ ${per(d, accountant, 'short')}`)),
    p(r('М. П.')),
  ].join('');
  return finish(d, body, { docTitle: 'Гарантийное письмо', creator: per(d, accountant, 'full') });
}

function letterReply() {
  const d = newDoc('letter', 'letter-reply');
  const kzn = CITIES[2];
  const from = d.company();
  const citizen = d.person((x) => x.w);
  const head = d.person((x) => !x.w);
  const executor = d.person((x) => x.w);
  negs(d, 'PDF', 'Госуслуги', 'Telegram');
  const body = [
    title(co(d, from)),
    p(r(`Служба качества · ${email(d, 'quality', from.dom)} · ${phone(d, kzn)}`), '<w:jc w:val="center"/>'),
    right(per(d, citizen, 'shortDat')),
    right(address(d, kzn, 'кв.')),
    p(r(`Исх. № К-${d.rng.range(1000, 9999)} от 16.10.2026`)),
    p(r(`Уважаемая ${d.add('PERSON', `${citizen.i} ${citizen.o}`)}!`)),
    p(
      r(
        `Ваше обращение от 02.10.2026 о сроках доставки рассмотрено. Заказ № ${d.rng.range(100000, 999999)} передан в службу доставки 14.10.2026; ` +
          'копию накладной в PDF направляем на адрес электронной почты, указанный в обращении.',
      ),
    ),
    p(
      r(
        `Доставку по Казани выполняет ${d.add('COMPANY', 'Северная транспортная компания', { opf: false })}; ` +
          'уведомления о статусе заказа можно получать в Telegram или в личном кабинете — подписка оформляется без Госуслуги.',
      ),
    ),
    p(r(`Руководитель службы качества _____________ ${per(d, head, 'short')}`)),
    p(r(`Исп.: ${per(d, executor, 'short')}, ${phone(d, kzn)}`)),
  ].join('');
  return finish(d, body, { docTitle: 'Ответ на обращение', creator: per(d, executor, 'full') });
}

function letterEn() {
  const d = newDoc('letter', 'letter-en', 'en');
  const [fromName, fromSuf, fromDom] = EN_COMPANIES[0];
  const [toName, toSuf] = EN_COMPANIES[1];
  const recipient = EN_PEOPLE[3];
  const manager = EN_PEOPLE[1];
  const signer = EN_PEOPLE[0];
  d.add('COMPANY', fromName, { opf: true });
  d.add('COMPANY', toName, { opf: true });
  negs(d, 'MVP', 'API', 'CRM', 'Excel', 'PDF', 'SLA');
  const body = [
    title(`${fromName} ${fromSuf}`),
    p(r(`${d.add('ADDRESS', '12 Baker Street, London W1U 6TY')} · ${d.add('PHONE', '+44 20 7946 0958')}`), '<w:jc w:val="center"/>'),
    p(r('15 October 2026')),
    p(r(`Ms. ${d.add('PERSON', `${recipient.first} ${recipient.last}`, { surname: recipient.last })}`)),
    p(r('Procurement Manager')),
    p(r(`${toName} ${toSuf}`)),
    p(r(d.add('ADDRESS', '45 King Street, Manchester M2 4LQ'))),
    p(r('Re: Pilot integration proposal', B)),
    p(r(`Dear Ms. ${d.add('PERSON', recipient.last, { surname: recipient.last })},`)),
    p(
      r(
        'Thank you for the meeting last week. As agreed, we propose a four-week MVP: the API connector to your CRM, a daily Excel export ' +
          'and PDF reports for the finance team. The SLA for the pilot is 99.5 % availability.',
      ),
    ),
    p(
      r(
        `Please contact our account manager ${d.add('PERSON', `${manager.first} ${manager.last}`, { surname: manager.last })} at ${d.add('PHONE', '+44 20 7946 0321')} or ` +
          `${email(d, manager.lat, fromDom)} to schedule the kickoff.`,
      ),
    ),
    p(r('Sincerely,')),
    p(r(d.add('PERSON', `${signer.first} ${signer.last}`, { surname: signer.last }))),
    p(r(`Head of Partnerships, ${fromName} ${fromSuf}`)),
  ].join('');
  return finish(d, body, { docTitle: 'Pilot proposal', creator: `${signer.first} ${signer.last}` });
}

/* ---------- 3. Счёт и УПД ---------- */

function invoice(name, { vat = true } = {}) {
  const d = newDoc('invoice', name);
  const city = d.city();
  const seller = d.company();
  const buyer = d.company();
  const head = d.person((x) => !x.w);
  const accountant = d.person((x) => x.w);
  const req = requisites(d, city, { ogrn: false });
  const city2 = d.city();
  const binn = d.add('INN', inn10(city2.reg + d.rng.digits(7)));
  const bkpp = d.add('KPP', `${binn.slice(0, 4)}01001`);
  negs(d, 'Bitrix24', 'CRM', 'НДС');
  const a = money(d, 100000, 250000);
  const body = [
    tbl([
      [cell(`Банк получателя: ${bank(d)}, г. ${city.city}`), cell(`БИК ${req.bik}`, `к/с ${req.ks}`)],
      [cell(`ИНН ${req.inn}   КПП ${req.kpp}`), cell(`Сч. № ${req.rs}`)],
      [cell(`Получатель: ${co(d, seller)}`), cell('')],
    ]),
    TITLE(d, `Счёт на оплату № ${d.rng.range(100, 999)} от 15 октября 2026 г.`),
    p(r(`Поставщик (Исполнитель): ${co(d, seller)}, ИНН ${req.inn}, КПП ${req.kpp}, ${address(d, city)}, тел. ${phone(d, city)}`)),
    p(r(`Покупатель (Заказчик): ${co(d, buyer)}, ИНН ${binn}, КПП ${bkpp}, ${address(d, city2)}`)),
    p(r(`Основание: договор № ${d.rng.range(10, 99)}/ПС-2026 от 01.09.2026`)),
    tbl(
      [
        [cell('№'), cell('Товары (работы, услуги)'), cell('Кол-во'), cell('Сумма, руб.')],
        [cell('1'), cell('Лицензия Bitrix24 «Профессиональный», 12 мес.'), cell('1'), cell(`${a},00`)],
        [cell('2'), cell('Настройка CRM и обучение'), cell('8 ч'), cell('64 000,00')],
        [cell(''), cell('Итого'), cell(''), cell(d.neg('к оплате', 'COMPANY'))],
      ],
      4,
    ),
    p(r(vat ? 'В том числе НДС 20 %.' : 'Без налога (НДС).')),
    p(r('Оплата данного счёта означает согласие с условиями поставки товара. Счёт действителен в течение 5 банковских дней.')),
    p(r(`Руководитель _____________ ${per(d, head, 'short')}`)),
    p(r(`Бухгалтер _____________ ${per(d, accountant, 'short')}`)),
  ].join('');
  return finish(d, body, { docTitle: 'Счёт на оплату', creator: per(d, accountant, 'full') });
}

function upd() {
  const d = newDoc('invoice', 'upd-ip');
  const nsk = CITIES[3];
  const seller = d.person((x) => !x.w);
  const buyer = d.company();
  const keeper = d.person();
  const req = ipRequisites(d, nsk, { bank: false });
  const city2 = d.city();
  const binn = d.add('INN', inn10(city2.reg + d.rng.digits(7)));
  const bkpp = d.add('KPP', `${binn.slice(0, 4)}01001`);
  negs(d, 'УПД', 'ЭДО', 'ТН ВЭД', 'НДС');
  const body = [
    TITLE(d, 'УНИВЕРСАЛЬНЫЙ ПЕРЕДАТОЧНЫЙ ДОКУМЕНТ'),
    p(r(`Счёт-фактура № ${d.rng.range(100, 999)} от 20.10.2026 · Статус: 1`)),
    p(r(`Продавец: ИП ${per(d, seller)}`)),
    p(r(`Адрес: ${address(d, nsk)}`)),
    p(r(`ИНН продавца: ${req.inn}, ОГРНИП ${req.ogrnip}`)),
    p(r(`Покупатель: ${co(d, buyer)}`)),
    p(r(`Адрес: ${address(d, city2)}`)),
    p(r(`ИНН/КПП покупателя: ${binn}/${bkpp}`)),
    tbl(
      [
        [cell('Код ТН ВЭД'), cell('Наименование'), cell('Кол-во'), cell('Стоимость без НДС')],
        [cell('8471300000'), cell('Ноутбук 14", серый'), cell('3'), cell(`${money(d, 150000, 300000)},00`)],
        [cell('8528521000'), cell('Монитор 27"'), cell('3'), cell(`${money(d, 60000, 120000)},00`)],
      ],
      4,
    ),
    p(r('Документ составлен в электронном виде и передан через ЭДО; УПД подписан квалифицированной подписью.')),
    p(r(`Товар (груз) передал: ИП ${per(d, seller, 'short')}`)),
    p(r(`Товар (груз) получил: кладовщик ${per(d, keeper, 'short')}`)),
  ].join('');
  return finish(d, body, { docTitle: 'УПД', creator: per(d, seller, 'full') });
}

/* ---------- 4. Акт сверки ---------- */

function reconciliation(name, { ip = false } = {}) {
  const d = newDoc('reconciliation', name);
  const a = d.company();
  const accA = d.person((x) => x.w);
  const accB = d.person();
  const city = d.city();
  const aName = co(d, a, ip ? 'ООО' : d.rng.pick(['ООО', 'АО']));
  let bName;
  let bNom;
  if (ip) {
    bNom = `ИП ${per(d, accB)}`;
    bName = `ИП ${per(d, accB, 'short')}`;
  } else {
    bNom = co(d, d.company());
    bName = bNom;
  }
  const inn = d.add('INN', inn10(city.reg + d.rng.digits(7)));
  negs(d, 'УПД', 'ЭДО');
  const sum = money(d, 50000, 200000);
  const intro = ip
    ? `Мы, нижеподписавшиеся, главный бухгалтер ${aName} ${per(d, accA)}, с одной стороны, и ${bNom}, с другой стороны, составили настоящий акт сверки о том, что состояние взаимных расчётов по данным учёта следующее:`
    : `Мы, нижеподписавшиеся, главный бухгалтер ${aName} ${per(d, accA)}, с одной стороны, и главный бухгалтер ${bNom} ${per(d, accB)}, с другой стороны, составили настоящий акт сверки о том, что состояние взаимных расчётов по данным учёта следующее:`;
  const body = [
    TITLE(d, 'АКТ СВЕРКИ ВЗАИМНЫХ РАСЧЁТОВ'),
    p(r('за период: 01.07.2026 – 30.09.2026'), '<w:jc w:val="center"/>'),
    p(r(`между ${aName} (ИНН ${inn}) и ${bName} по договору № ${d.rng.range(10, 99)}/Д от 10.01.2026`), '<w:jc w:val="center"/>'),
    p(r(intro)),
    tbl(
      [
        [cell('Дата'), cell('Документ'), cell('Дебет'), cell('Кредит')],
        [cell(d.neg('Сальдо начальное')), cell(''), cell(`${sum},00`), cell('')],
        [cell('03.07.2026'), cell(`Продажа (УПД № ${d.rng.range(100, 400)})`), cell('85 400,00'), cell('')],
        [cell('15.07.2026'), cell(`Оплата (п/п № ${d.rng.range(1000, 9999)})`), cell(''), cell(`${sum},00`)],
        [cell('21.08.2026'), cell(`Продажа (УПД № ${d.rng.range(401, 800)})`), cell('42 700,00'), cell('')],
        [cell(d.neg('Обороты за период')), cell(''), cell('128 100,00'), cell(`${sum},00`)],
        [cell(d.neg('Сальдо конечное')), cell(''), cell('128 100,00'), cell('')],
      ],
      4,
    ),
    p(r(`По данным ${aName} на 30.09.2026 задолженность в пользу ${aName} составляет 128 100,00 руб.`)),
    p(r('Акт направлен через ЭДО; расхождения просим сообщить в течение 10 дней.')),
    tbl([
      [cell(`От ${aName}`), cell(`От ${bName}`)],
      [
        cell(`Главный бухгалтер ________ (${per(d, accA, 'short')})`),
        cell(`${ip ? 'Индивидуальный предприниматель' : 'Главный бухгалтер'} ________ (${per(d, accB, 'short')})`),
      ],
    ]),
  ].join('');
  return finish(d, body, { docTitle: 'Акт сверки', creator: per(d, accA, 'full') });
}

/* ---------- 5. Регламент и инструкция ---------- */

function manualEdo() {
  const d = newDoc('manual', 'reglament-edo');
  const kzn = CITIES[2];
  const org = d.company();
  const ceo = d.person((x) => x.w);
  const head = d.person((x) => x.w);
  const support = d.person((x) => !x.w);
  negs(d, 'ЭДО', 'КЭП', 'УПД', 'ТЗ', '1С', 'PDF', 'Диадок');
  const body = [
    right(`УТВЕРЖДАЮ`),
    right(`Генеральный директор ${co(d, org)}`),
    right(`_____________ ${per(d, ceo, 'short')}`),
    right('«01» октября 2026 г.'),
    TITLE(d, 'РЕГЛАМЕНТ РАБОТЫ С ЭЛЕКТРОННЫМИ ДОКУМЕНТАМИ'),
    H(d, '1. ОБЩИЕ ПОЛОЖЕНИЯ'),
    p(r(`1.1. Регламент определяет порядок обмена документами ${co(d, org)} с контрагентами через ЭДО.`)),
    p(r('1.2. Регламент обязателен для сотрудников бухгалтерии, отдела продаж и склада.')),
    H(d, '2. ТЕРМИНЫ И СОКРАЩЕНИЯ'),
    li(d.neg('ЭДО — электронный документооборот')),
    li('КЭП — квалифицированная электронная подпись'),
    li('УПД — универсальный передаточный документ'),
    li('ТЗ — техническое задание'),
    H(d, '3. ПОРЯДОК ДЕЙСТВИЙ'),
    li(d.neg('Открыть 1С')),
    li(d.neg('Создать документ')),
    li(d.neg('Сохранить в PDF')),
    li(d.neg('Отправить через Диадок')),
    p(r('3.1. Документ считается полученным, когда контрагент подписал его КЭП. Срок подписания УПД — 3 рабочих дня.')),
    H(d, '4. ОТВЕТСТВЕННЫЕ'),
    p(r(`4.1. За работу с ЭДО отвечает руководитель отдела бухгалтерии ${per(d, head)}, тел. ${phone(d, kzn, true)}, ` + `${email(d, head.lat, org.dom)}.`)),
    p(r(`4.2. Техническая поддержка: ${per(d, support, 'short')}, ${email(d, 'support', org.dom)}.`)),
    H(d, '5. ЗАКЛЮЧИТЕЛЬНЫЕ ПОЛОЖЕНИЯ'),
    p(r('5.1. Регламент вступает в силу с даты утверждения. Изменения вносятся приказом генерального директора.')),
  ].join('');
  return finish(d, body, { docTitle: 'Регламент ЭДО', creator: per(d, head, 'full') });
}

function manualCrm() {
  const d = newDoc('manual', 'instruction-crm');
  const msk = CITIES[0];
  const org = d.company();
  const admin = d.person((x) => !x.w);
  negs(d, 'CRM', 'Bitrix24', 'Telegram', 'Google', 'Excel', 'QR', 'API');
  const body = [
    TITLE(d, 'ИНСТРУКЦИЯ ПО ПОДКЛЮЧЕНИЮ К CRM'),
    p(r(`для сотрудников ${co(d, org)}`), '<w:jc w:val="center"/>'),
    H(d, 'Шаг 1. Вход'),
    p(r('Откройте Bitrix24 по ссылке из приглашения и войдите через корпоративную почту Google.')),
    p(r(d.neg('Рисунок 1 — Окно входа'))),
    H(d, 'Шаг 2. Профиль'),
    tbl(
      [
        [cell('Поле'), cell('Что указать')],
        [cell(d.neg('Логин')), cell('Корпоративная почта')],
        [cell(d.neg('Отдел')), cell('Из списка')],
        [cell(d.neg('Телефон')), cell('Рабочий, в формате +7')],
      ],
      2,
    ),
    H(d, 'Шаг 3. Уведомления'),
    li(d.neg('Telegram-бот')),
    li(d.neg('QR-код в профиле')),
    li('Выгрузка сделок в Excel по API'),
    CAPS(d, 'ВАЖНО'),
    p(r('Не пересылайте пароль в мессенджерах. Если доступ не работает, напишите администратору.')),
    p(r(`Сервер CRM и оборудование связи поставил ${d.add('COMPANY', 'Уральский завод точных приборов', { opf: false })} по договору 2025 года.`)),
    H(d, 'Контакты'),
    p(r(`Администратор CRM: ${per(d, admin)}, ${phone(d, msk)}, ${email(d, admin.lat, org.dom)}`)),
  ].join('');
  return finish(d, body, { docTitle: 'Инструкция CRM', creator: per(d, admin, 'full') });
}

function manualPd() {
  const d = newDoc('manual', 'policy-pd');
  const city = d.city();
  const org = d.company();
  const resp = d.person((x) => !x.w);
  const req = requisites(d, city, { bank: false });
  negs(d, 'ПДн', 'РФ', 'СМС');
  const body = [
    TITLE(d, 'ПОЛИТИКА ОБРАБОТКИ ПЕРСОНАЛЬНЫХ ДАННЫХ'),
    p(r(`${co(d, org)} (ИНН ${req.inn}, ОГРН ${req.ogrn}, адрес: ${address(d, city)})`), '<w:jc w:val="center"/>'),
    H(d, '1. Общие положения'),
    p(r('1.1. Политика действует в отношении всех ПДн, которые оператор получает от клиентов и посетителей сайта, в соответствии с законодательством РФ.')),
    H(d, '2. Какие данные мы обрабатываем'),
    li('фамилия, имя, отчество'),
    li('номер телефона'),
    li('адрес электронной почты'),
    li('история заказов'),
    H(d, '3. Цели обработки'),
    li(d.neg('Исполнение договора')),
    li(d.neg('Отправка СМС о статусе заказа')),
    li(d.neg('Улучшение сервиса')),
    H(d, '4. Ответственный'),
    p(
      r(
        `4.1. Ответственный за организацию обработки ПДн — ${per(d, resp)}, ${email(d, 'privacy', org.dom)}. ` +
          `Запросы субъектов ПДн принимаются по адресу оператора и по телефону ${phone(d, city)}.`,
      ),
    ),
  ].join('');
  return finish(d, body, { docTitle: 'Политика ПДн', creator: per(d, resp, 'full') });
}

/* ---------- 6. Презентация (только PDF) ---------- */

const DECK_CSS = `
  @page { size: 254mm 143mm; margin: 0; }
  body { font-family: 'Liberation Sans', 'DejaVu Sans', sans-serif; margin: 0; color: #111; }
  section { width: 254mm; height: 143mm; box-sizing: border-box; padding: 14mm 18mm; break-after: page; overflow: hidden; }
  h1 { font-size: 34pt; margin: 0 0 8mm; }
  h2 { font-size: 26pt; margin: 0 0 6mm; }
  p { font-size: 15pt; margin: 0 0 4mm; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { font-size: 16pt; margin: 0 0 3mm; }
  table { border-collapse: collapse; width: 100%; font-size: 14pt; }
  td { border: 0.5pt solid #444; padding: 2mm 4mm; }
`;
const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Слайд: {h1|h2, p: [], li: [], table: [[]]}. Заголовки и пункты — отрицательные примеры, если не помечены иначе. */
function deckHtml(slides) {
  const sec = (s) =>
    `<section>${s.h1 ? `<h1>${escHtml(s.h1)}</h1>` : ''}${s.h2 ? `<h2>${escHtml(s.h2)}</h2>` : ''}` +
    (s.p || []).map((x) => `<p>${escHtml(x)}</p>`).join('') +
    (s.li?.length ? `<ul>${s.li.map((x) => `<li>• ${escHtml(x)}</li>`).join('')}</ul>` : '') +
    (s.table ? `<table>${s.table.map((row) => `<tr>${row.map((c) => `<td>${escHtml(c)}</td>`).join('')}</tr>`).join('')}</table>` : '') +
    '</section>';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>${DECK_CSS}</style></head><body>${slides.map(sec).join('')}</body></html>`;
}
const deckDoc = (d, slides) => ({
  genre: d.genre,
  name: d.name,
  lang: d.lang,
  docx: null,
  html: deckHtml(slides),
  pdf: { deck: true },
  gold: { entities: d.entities, negatives: d.negatives },
});

function deckStudio() {
  const d = newDoc('deck', 'deck-studio');
  const lead = d.person((x) => x.w);
  const c1 = d.company();
  const c2 = d.company();
  d.add('COMPANY', 'Лунопарк', { opf: false });
  d.neg('СТУДИЯ ЛУНОПАРК', 'COMPANY', 'normal');
  d.neg('Студия Лунопарк', 'COMPANY', 'normal');
  negs(d, 'MVP', 'ЭДО', 'Excel', 'Word', '1С');
  const site = d.add('URL', 'https://lunopark.example');
  return deckDoc(d, [
    { h1: 'СТУДИЯ ЛУНОПАРК', p: [d.neg('Цифровые продукты для документооборота')] },
    { h2: d.neg('О НАС'), li: [d.neg('7 лет на рынке'), d.neg('40+ проектов'), 'Шаблоны в Word и Excel', 'Интеграции с 1С и ЭДО'] },
    { h2: d.neg('НАМ ДОВЕРЯЮТ'), li: [co(d, c1), co(d, c2, 'АО')] },
    { h2: d.neg('КАК МЫ РАБОТАЕМ'), li: [d.neg('01 Аудит'), d.neg('02 MVP'), d.neg('03 Внедрение'), d.neg('04 Поддержка')] },
    {
      h2: d.neg('СТОИМОСТЬ'),
      table: [
        ['Пакет', 'Срок', 'Цена'],
        [d.neg('Старт'), '2 недели', `${money(d, 50000, 90000)} ₽`],
        ['MVP', '4 недели', `${money(d, 200000, 300000)} ₽`],
      ],
    },
    { h2: d.neg('КОНТАКТЫ'), p: [`${per(d, lead, 'fl')} — руководитель проектов`, mobile(d), email(d, 'hello', 'lunopark'), site] },
  ]);
}

function deckPitch() {
  const d = newDoc('deck', 'deck-pitch');
  const org = d.company();
  const ceo = d.person((x) => !x.w);
  const cto = d.person((x) => x.w);
  negs(d, 'SaaS', 'B2B', 'MVP', 'API', 'CRM', 'ERP', 'ROI');
  return deckDoc(d, [
    { h1: d.neg('ДОКУМЕНТЫ БЕЗ РУТИНЫ'), p: [`${co(d, org)} · инвестиционная презентация · 2026`] },
    { h2: d.neg('ПРОБЛЕМА'), li: ['Менеджеры тратят 30 % времени на документы', 'Ошибки в реквизитах стоят денег', d.neg('Нет единой базы')] },
    { h2: d.neg('ПРОДУКТ'), li: ['SaaS для B2B-продаж', 'API к CRM и ERP', d.neg('MVP готов')] },
    {
      h2: d.neg('РЫНОК'),
      table: [
        ['Сегмент', 'Компаний', 'Объём'],
        ['Малый бизнес', '1,2 млн', '18 млрд ₽'],
        ['Средний бизнес', '45 тыс.', '9 млрд ₽'],
      ],
    },
    { h2: d.neg('КОМАНДА'), li: [`${per(d, ceo, 'fl')} — CEO`, `${per(d, cto, 'fl')} — CTO`] },
    { h2: d.neg('ИНВЕСТИЦИИ'), p: ['Ищем 25 млн ₽ на 18 месяцев. ROI для клиента — окупаемость за 4 месяца.', `${email(d, ceo.lat, org.dom)}`] },
  ]);
}

function deckReport() {
  const d = newDoc('deck', 'deck-report');
  const client = d.company();
  const owner = d.person((x) => x.w);
  negs(d, 'KPI', 'NPS', 'CRM', 'SEO');
  return deckDoc(d, [
    { h1: d.neg('ИТОГИ КВАРТАЛА'), p: [`Проект для ${co(d, client, 'АО')}`, d.neg('III квартал 2026')] },
    {
      h2: 'KPI',
      table: [
        ['Показатель', 'План', 'Факт'],
        ['Заявки', '1 200', '1 340'],
        ['Конверсия', '4,5 %', '5,1 %'],
        ['NPS', '45', '52'],
      ],
    },
    { h2: d.neg('ЧТО СДЕЛАНО'), li: ['Перенесли заявки в CRM', 'SEO-аудит и правки сайта', d.neg('Новые отчёты')] },
    { h2: d.neg('ПЛАНЫ'), li: [d.neg('Сквозная аналитика'), d.neg('Обучение отдела продаж')] },
    { h2: d.neg('ОТВЕТСТВЕННЫЙ'), p: [`${per(d, owner)}, руководитель проекта`, mobile(d)] },
  ]);
}

/* ---------- 7. Резюме ---------- */

function resume(name, { skills, role, prevRole, bday }) {
  const d = newDoc('resume', name);
  const city = d.city();
  const x = d.person();
  const ref = d.person((y) => y.f !== x.f);
  const c1 = d.company();
  const c2 = d.company();
  negs(d, ...skills);
  const body = [
    title(per(d, x)),
    p(r(role), '<w:jc w:val="center"/>'),
    p(r(`Дата рождения: ${d.add('BIRTHDATE', bday)}`)),
    p(r(`Телефон: ${mobile(d)}`)),
    p(r(`E-mail: ${email(d, x.lat, 'mail')}`)),
    p(r(`Адрес: ${address(d, city, 'кв.')}`)),
    H(d, 'ОПЫТ РАБОТЫ'),
    p(r(`2021 — н. в. ${co(d, c1)}, ${role.toLowerCase()}`)),
    li(d.neg('Запуск отдела с нуля')),
    li(`Внедрение ${skills[0]} и ${skills[1]} в работу отдела`),
    p(r(`2017 — 2021 ${co(d, c2, 'АО')}, ${prevRole}`)),
    H(d, 'НАВЫКИ'),
    li(skills.slice(0, 3).join(', ')),
    li(skills.slice(3).join(', ')),
    li(d.neg('Английский — B2')),
    H(d, 'ОБРАЗОВАНИЕ'),
    p(r('Высшее экономическое, 2013')),
    H(d, 'РЕКОМЕНДАЦИИ'),
    p(r(`${per(d, ref)}, руководитель отдела ${co(d, c1)}, ${phone(d, city)}`)),
  ].join('');
  return finish(d, body, { docTitle: 'Резюме', creator: per(d, x) });
}

function resumeEn() {
  const d = newDoc('resume', 'resume-en', 'en');
  const x = EN_PEOPLE[2];
  const ref = EN_PEOPLE[3];
  const [c1, s1, dom1] = EN_COMPANIES[1];
  const [c2, s2] = EN_COMPANIES[2];
  d.add('COMPANY', c1, { opf: true });
  d.add('COMPANY', c2, { opf: true });
  negs(d, 'Excel', 'SQL', 'Python', 'Tableau', 'Jira', 'KPI');
  const body = [
    title(d.add('PERSON', `${x.first} ${x.last}`, { surname: x.last })),
    p(r('Senior Data Analyst'), '<w:jc w:val="center"/>'),
    p(r(`Date of birth: ${d.add('BIRTHDATE', '3 June 1992')}`)),
    p(r(`Phone: ${d.add('PHONE', '+44 7700 900123')}`)),
    p(r(`Email: ${email(d, x.lat, 'mail')}`)),
    p(r(`Address: ${d.add('ADDRESS', '45 King Street, Manchester M2 4LQ')}`)),
    H(d, 'EXPERIENCE'),
    p(r(`2020 — present: ${c1} ${s1}, Senior Analyst`)),
    li(d.neg('Built KPI dashboards')),
    li('Automated Excel reports with Python and SQL'),
    p(r(`2016 — 2020: ${c2} ${s2}, Analyst`)),
    H(d, 'SKILLS'),
    li('Excel, SQL, Python'),
    li('Tableau, Jira'),
    H(d, 'REFERENCES'),
    p(r(`${d.add('PERSON', `${ref.first} ${ref.last}`, { surname: ref.last })}, Head of Analytics, ${c1} ${s1}, ${email(d, ref.lat, dom1)}`)),
  ].join('');
  return finish(d, body, { docTitle: 'CV', creator: `${x.first} ${x.last}` });
}

/* ---------- 8. Переписка ---------- */

/** Выгрузка чата: «[дата время] Имя Фамилия: текст» — по абзацу на сообщение. */
const msg = (when, who, text) => p(r(`[${when}] ${who}: ${text}`));

function chatSales() {
  const d = newDoc('chat', 'chat-sales');
  const a = d.person((x) => x.w);
  const b = d.person((x) => !x.w);
  const org = d.company();
  const city = d.city();
  const inn = d.add('INN', inn10(city.reg + d.rng.digits(7)));
  const kpp = d.add('KPP', `${inn.slice(0, 4)}01001`);
  negs(d, 'КП', 'PDF', 'ЭДО', 'Диадок', 'WhatsApp', 'Zoom', 'Word', 'Excel');
  const A = per(d, a, 'fl');
  const Bn = per(d, b, 'fl');
  const body = [
    TITLE(d, 'Переписка с клиентом'),
    msg('12.10.2026 10:15', A, 'Добрый день! Отправила КП в PDF, посмотрите, пожалуйста.'),
    msg('12.10.2026 10:20', Bn, `${d.add('PERSON', a.i)}, спасибо, гляну сегодня. По ЭДО работаем через Диадок.`),
    msg('12.10.2026 10:21', Bn, `Мой телефон ${mobile(d)}, лучше писать в WhatsApp.`),
    msg('12.10.2026 10:24', A, 'Созвонимся в Zoom в 15:00? Ссылку пришлю на почту.'),
    msg('12.10.2026 10:30', Bn, `Ок. Почта ${email(d, b.lat, org.dom)}. Реквизиты для договора: ${co(d, org)}, ИНН ${inn}, КПП ${kpp}.`),
    msg('12.10.2026 10:33', A, 'Договор пришлю в Word, счёт — в Excel.'),
  ].join('');
  return finish(d, body, { docTitle: 'Чат', creator: A });
}

function chatTeam() {
  const d = newDoc('chat', 'chat-team');
  const a = d.person((x) => !x.w);
  const b = d.person((x) => x.w);
  const c = d.person((x) => x.w);
  const client = d.company();
  negs(d, 'MVP', 'Jira', 'Яндекс.Диск', 'API', 'QA');
  const A = per(d, a, 'fl');
  const Bn = per(d, b, 'fl');
  const body = [
    TITLE(d, 'Чат проекта'),
    msg('14.10.2026 09:02', A, 'Коллеги, MVP выкатили на тестовый стенд, баги заводим в Jira.'),
    msg('14.10.2026 09:10', Bn, `Отчёт для ${co(d, client, 'АО')} загрузила на Яндекс.Диск.`),
    msg('14.10.2026 09:12', A, `${d.add('PERSON', b.i)}, добрый день! Пришли контакты бухгалтерии клиента, пожалуйста.`),
    msg('14.10.2026 09:15', Bn, `${email(d, 'buh', client.dom)}, главный бухгалтер ${per(d, c)}, ${mobile(d)}.`),
    msg('14.10.2026 09:40', A, 'Спасибо! API отдадим после QA в пятницу.'),
  ].join('');
  return finish(d, body, { docTitle: 'Чат проекта', creator: A });
}

function chatSupport() {
  const d = newDoc('chat', 'chat-support');
  const a = d.person((x) => !x.w);
  const org = d.company();
  const city = d.city();
  const inn = d.add('INN', inn10(city.reg + d.rng.digits(7)));
  negs(d, 'УПД', '1С', 'ЭДО');
  const A = per(d, a, 'lf');
  const url = d.add('URL', 'https://lunopark.example/help/edo');
  const body = [
    TITLE(d, 'Обращение в поддержку'),
    msg('20.10.2026 09:02', A, 'Здравствуйте, не приходит УПД из 1С.'),
    msg('20.10.2026 09:05', 'Поддержка', 'Добрый день! Уточните ИНН организации.'),
    msg('20.10.2026 09:07', A, `ИНН ${inn}, ${co(d, org)}.`),
    msg('20.10.2026 09:10', 'Поддержка', `Проверьте, что в 1С включён обмен с ЭДО. Инструкция: ${url}`),
    msg('20.10.2026 09:12', A, `Оплатить продление можно картой ${card(d)}?`),
    msg('20.10.2026 09:13', 'Поддержка', 'Пожалуйста, не присылайте номер карты в чат — оплата только по счёту.'),
  ].join('');
  return finish(d, body, { docTitle: 'Поддержка', creator: A });
}

/* ---------- корпус ---------- */

/** Все документы корпуса (без PDF): детерминированы. */
export function buildGenreDocs() {
  return [
    kpLunopark(),
    kpAgency('kp-svetlyachok', 'Агентство', 'Светлячок', {
      cover: 'КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ НА ВНЕДРЕНИЕ CRM',
      about: 'Кто мы',
      task: 'Задача',
      scope: 'Состав работ',
      price: 'Стоимость',
      why: 'Почему мы',
    }),
    kpAgency('kp-polden', 'Бюро', 'Полдень', {
      cover: 'ПРЕДЛОЖЕНИЕ О СОТРУДНИЧЕСТВЕ',
      about: 'О бюро',
      task: 'Что нужно сделать',
      scope: 'Что входит',
      price: 'Цены',
      why: 'Наш опыт',
    }),
    letterSchedule(),
    letterGuarantee(),
    letterReply(),
    letterEn(),
    invoice('invoice-services'),
    invoice('invoice-licenses', { vat: false }),
    upd(),
    reconciliation('reconciliation-ooo'),
    reconciliation('reconciliation-ip', { ip: true }),
    reconciliation('reconciliation-ao'),
    manualEdo(),
    manualCrm(),
    manualPd(),
    deckStudio(),
    deckPitch(),
    deckReport(),
    resume('resume-pm', {
      role: 'Руководитель проектов',
      prevRole: 'аналитик',
      bday: '14.05.1991',
      skills: ['Jira', 'Confluence', 'Miro', 'Excel', 'Power BI'],
    }),
    resume('resume-dev', {
      role: 'Разработчик',
      prevRole: 'младший разработчик',
      bday: '02.11.1994',
      skills: ['Python', 'PostgreSQL', 'Docker', 'GitLab', 'Linux'],
    }),
    resume('resume-accountant', {
      role: 'Главный бухгалтер',
      prevRole: 'бухгалтер',
      bday: '23.08.1986',
      skills: ['1С:Бухгалтерия', 'Контур.Диадок', 'СБИС', 'Excel', 'ЭДО'],
    }),
    resumeEn(),
    chatSales(),
    chatTeam(),
    chatSupport(),
  ];
}

/** PDF документа корпуса: A4 из DOCX (как tests/fixtures/pdf) или слайды 16:9 для `deck`. */
export async function buildGenrePdf(browser, d) {
  if (!d.pdf.deck) return htmlToPdf(browser, d.html, null);
  const page = await browser.newPage();
  try {
    await page.setContent(d.html, { waitUntil: 'load' });
    return new Uint8Array(await page.pdf({ width: '254mm', height: '143mm', printBackground: false, preferCSSPageSize: true }));
  } finally {
    await page.close();
  }
}

/* ---------- CLI ---------- */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const update = process.argv.includes('--update-snapshots');
  const noPdf = process.argv.includes('--no-pdf');
  const outArg = process.argv.find((a) => a.startsWith('--out='));
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.slice('--only='.length).split(',') : null;
  const out = resolve(outArg ? outArg.slice('--out='.length) : GENRES_DIR);
  const docs = buildGenreDocs().filter((d) => !only || only.includes(d.genre) || only.includes(d.name));
  const browser = noPdf ? null : await chromium.launch({ channel: 'chromium' });
  try {
    for (const d of docs) {
      const dir = join(out, d.genre);
      mkdirSync(dir, { recursive: true });
      const base = join(dir, d.name);
      writeFileSync(`${base}.gold.json`, JSON.stringify(d.gold, null, 2) + '\n');
      if (d.docx) writeFileSync(`${base}.docx`, d.docx);
      let note = '';
      if (browser) {
        const pdf = await buildGenrePdf(browser, d);
        writeFileSync(`${base}.pdf`, pdf);
        const snap = `${base}.pdf.txt`;
        if (update || !existsSync(snap)) {
          writeFileSync(snap, await layoutSnapshot(pdf));
          note = ', снимок записан';
        } else note = ', снимок не тронут (--update-snapshots)';
      }
      console.log(`${d.genre}/${d.name}: ${d.docx ? `docx ${d.docx.length} байт, ` : ''}gold ${d.gold.entities.length}/${d.gold.negatives.length}${note}`);
    }
  } finally {
    await browser?.close();
  }
}
