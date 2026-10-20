// Фильтры модельных людей и мест (версия 0.4, WP11-D; §5.2 NLP `docs/spec-full.md`, `docs/contracts.md` §8.3, Ц2, Ц5, К6).
// Корпус жанров с моделью 1.0.0 показал 55 отрицательных примеров, ставших сущностью: модель, обученная на WikiANN,
// размечает PER на формулах вежливости и служебных словах («Здравствуйте», «Логин», «Ок. Почта»), LOC — на продуктах
// («Jira», «Python», «Zoom»), словах таблиц («Сальдо», «Дебет», «Кол-во») и отдельных городах. LOC модели становится
// ADDRESS, а одиночный топоним вне адреса — не персональные данные (ADDRESS — адрес человека или организации).
// Раннер (`detect/runner.js`) вызывает фильтр для PER и LOC одного live-потока после порога `nerThreshold` в обоих режимах;
// контекст документа — `createOrgFilterContext` (стоп-список, ячейки DOCX).
//
// Порядок проверок (первое сработавшее решает):
//   1. стоп-список (`stoplist.js` ∪ `settings.nerStoplist`, бренд владельца): спан целиком, каждым словом, слово целиком
//      вокруг спана («Диадок» из «Контур.Диадок») — отбросить;
//   2. служебные слова и формулы вежливости по краям спана (Здравствуйте, Спасибо, Логин, Итого, Сальдо, Дебет, должности…),
//      у PER — и слова со строчной буквы или с цифрами по краям («экспедитор Кравчук» → «Кравчук») отрезаются; от спана
//      ничего не осталось, остаток начинается со строчной или это римская цифра («III») — отбросить;
//   3. спан из одного слова со строчной буквы — отбросить;
//   4. LOC: в спане и в окне ±40 символов того же потока нет признака адреса (индекс, «ул.», «д.», «дом», «кв.», «офис», «пр-т»,
//      «пер.», «street», «st.», «road», номер дома после запятой или сразу после места («Тверская 12-5»), адресная метка
//      («адрес», «проживающий», «зарегистрирован», «место жительства», «доставка», «курьер», «lives at»); пометка города
//      «г.» сама по себе — не признак) — отбросить;
//   5. PER: внутри — слово со строчной буквы (кроме частиц «ван», «де», «оглы») или цифры — отбросить; ни одно слово
//      не похоже на имя, фамилию или отчество (словари `names/dict`, `morph.js`, инициал), и спан — остаток фразы после
//      отрезания, капс («ДОКУМЕНТЫ БЕЗ РУТИНЫ») или одно слово в заголовке, пункте, ячейке — отбросить;
//   иначе — сохранить (возможно, с отрезанными служебными словами).
// Чистый JS без chrome.* и DOM; значения документа в логи не попадают.
import { BUILTIN_STOPLIST, stopKey } from './stoplist.js';
import { isCapsLine, isStoplisted, wholeWordAround, inStoplist } from './filters.js';
import { lowerE, wordList, isNeverMaskOrg, isStopWord, isRoleNoun, ROLE_WORDS } from '../detect/names/lexicon.js';
import { addressTailEnd, NOT_HOUSE_SRC, VALUE_LABEL_SRC } from '../detect/names/address.js';
import { patronymicInfo, firstNameInfo } from '../detect/names/morph.js';
import { bigFirstNameInfo, surnameLemmas, surnameSuffixInfo, isEnFirst, isEnSurname } from '../detect/names/dict/index.js';

/** Виды блока, строка которых — заголовок, пункт или ячейка (правило 5). */
const SHORT_LINE_KINDS = new Set(['h1', 'h2', 'li', 'cell', 'heading']);
/** Окно поиска признаков адреса вокруг LOC (символов в каждую сторону). */
export const ADDRESS_WINDOW = 40;

/**
 * Служебные слова, формулы вежливости, заголовки столбцов и должности: не имя и не место. Ключи `stopKey`;
 * кириллица сравнивается и с падежным окончанием до 2 букв («Контактах», «Сальдо»).
 */
// Группы: вежливость и обращения; интерфейс и учётные данные; таблицы и учёт; структура документов и тарифы; языки (резюме: «Английский —
// B2»); должности (PER «Procurement Manager», «Фролова Главный»).
// prettier-ignore
export const SERVICE_WORDS = [
  ...wordList(`Здравствуйте|Здравствуй|Привет|Приветствую|Добрый|Доброе|Доброго|Спасибо|Благодарю|Пожалуйста|Уважаемый
Уважаемая|Уважаемые|Коллеги|Ок|Окей|Да|Нет|Hello|Hi|Hey|Dear|Thanks|Thank|Regards|Sincerely
Cheers|Yours`),
  ...wordList(`Логин|Пароль|Вход|Выход|Кабинет|Профиль|Настройки|Меню|Кнопка|Поле|Файл|Папка|Ссылка|Почта
Контакты|Контакт|Login|Password|Username|Email|Settings`),
  ...wordList(`Итого|Всего|Сальдо|Дебет|Кредит|Обороты|Оборот|Кол-во|Количество|Сумма|Цена|Стоимость|Дата
Документ|Наименование|Статус|Примечание|Телефон|Адрес|Оплата|Продажа|Total|Subtotal|Balance|Debit
Credit|Qty|Quantity|Price|Amount|Date|Phone|Address`),
  ...wordList(`План|Этап|Шаг|Задача|Раздел|Пункт|Приложение|Таблица|Рисунок|Отчёт|Квартал|Итог|Старт|Базовый
Стандарт|Оптимальный|Максимум|Минимум|Премиум|Plan|Step|Stage|Item|Section`),
  ...wordList(`Английский|Русский|Немецкий|Французский|Испанский|Китайский|Итальянский|English|Russian|German|French`),
  ...wordList(`Директор|Генеральный|Главный|Бухгалтер|Менеджер|Руководитель|Специалист|Инженер|Аналитик|Разработчик
Кладовщик|Курьер|Доставка|Manager|Director|Engineer|Developer|Analyst|Officer|Specialist|Consultant|Assistant|Accountant
Designer|Administrator|Coordinator|Procurement|Senior|Junior`),
];
const SERVICE = new Set(SERVICE_WORDS.map(stopKey));

/** Слово спана: буквы и цифры, внутри — дефис, апостроф, точка; позиции — в тексте потока. */
const WORD_RE = /[\p{L}\p{N}]+(?:[-‐‑’'][\p{L}\p{N}]+)*/gu;
const LETTER_RE = /\p{L}/u;
const ROMAN_RE = /^[IVXLC]+$/;
/** Частицы внутри имён со строчной буквы: «Людвиг ван Бетховен», «Мамед оглы», «Анна де Вера». */
const PARTICLES = new Set([
  ...wordList(`де
да
ди
дю
ла
ле
фон
ван
дер
оглы
кызы
ибн
бин
бен
de
da
di
du
la
le
von
van
der
den
bin
ibn
al
el
del
della
y`),
]);

const isService = (w) => inStoplist(stopKey(w), SERVICE, w);
const isLowerWord = (w) => w[0] === w[0].toLowerCase() && w[0] !== w[0].toUpperCase();

/**
 * Слово похоже на часть имени: имя, фамилия или отчество по словарям и морфологии, латинское имя/фамилия, инициал.
 * @param {string} word
 * @param {string} [next] символ после слова: одиночная заглавная — инициал, только если за ней точка («А.», не «О нас»)
 * @param {boolean} [strict] только словари (без фамилии по суффиксу): для капса, где «ВЗАИМНЫХ» похоже на фамилию
 */
export function nameLike(word, next = '.', strict = false) {
  const w = lowerE(word);
  if (givenNameLike(word, next)) return true;
  if (/^[a-z'’-]+$/.test(w)) return isEnSurname(w);
  if (!/[а-я]/.test(w)) return false;
  return surnameLemmas(w).length > 0 || (!strict && (surnameSuffixInfo(w) || []).length > 0);
}

/** Соседний LOC через запятую или «и»: спан — элемент перечисления мест. */
function inPlaceList(spans, sp, text, start, end) {
  return spans.some(
    (o) => o !== sp && o.label === 'LOC' && LIST_GAP_RE.test(o.start >= end ? text.slice(end, o.start) : o.end <= start ? text.slice(o.end, start) : 'x'),
  );
}
/** Между соседними местами перечисления — только запятая или «и»: «Москва, Тверь, Клин», «Казань и Пермь». */
const LIST_GAP_RE = /^[ \u00a0]*(?:,|и|and)[ \u00a0]*$/u;
/** Столбец таблицы с местами: PER модели в его ячейке — город («Хошимин»), а не человек. */
const PLACE_COLUMN_RE = /(?<![\p{L}])(?:город|населённый пункт|населенный пункт|регион|страна|city|town|country|region)(?![\p{L}])/iu;
/** Роль стороны договора в косвенном падеже: «Займодавца», «Заёмщика», «Арендодателю». */
const ROLE_FORM_RE =
  /^(?:займодав|заимодав|заемщик|арендодател|арендатор|наймодател|нанимател|поручител|залогодател|залогодержател|доверител|поверенн|исполнител|заказчик|подрядчик|поставщик|покупател|продав)/u;
/** Фамилия-прилагательное в косвенном падеже: «Пролетарским», «Октябрьского». */
const ADJ_SURNAME_RE = /(?:ским|ского|скому|ском|цким|цкого|цкому|цком|ской|ную|ным|ного|ному)$/u;
/** Следом — прилагательное со строчной («районным судом»): словосочетание, а не имя. */
const ADJ_NEXT_RE = /^[ \u00a0]+\p{Ll}+(?:ым|им|ого|его|ому|ему|ой|ей|ом|ем|ая|яя|ую|юю|ые|ие|ых|их)(?![\p{L}])/u;

/** Имя-омоним нарицательного (Вера, Надежда, Любовь, Роза, Слава, Роман…). */
function homonymName(word) {
  const infos = bigFirstNameInfo(lowerE(word));
  return infos.length > 0 && infos.every((x) => x.ambiguous);
}
/** Начало потока или предложения (после «.», «!», «?», «…», «:» и пробела). */
const sentenceStart = (text, start) => /(?:^|[.!?…:]\s+|\n)[«"(]?$/u.test(text.slice(Math.max(0, start - 4), start)) || start === 0;
/** Нарицательное употребление: предлог после слова («в», «о», «к», «на») или перечисление со строчной. */
const HOMONYM_TAIL_RE = /^(?:[ \u00a0]+(?:в|во|о|об|к|ко|на|за|для|без|и)[ \u00a0]|[ \u00a0]*,[ \u00a0]*\p{Ll}+[ \u00a0]*(?:,|[ \u00a0]и[ \u00a0]))/u;

/** Имя из словаря, не омоним нарицательного («Олеся», «Ринат»): LOC модели на нём вне адреса — человек (WP11-E). */
const strongFirstName = (w) =>
  /^\p{Lu}\p{Ll}+$/u.test(w) && bigFirstNameInfo(lowerE(w)).some((x) => !x.ambiguous) && bigFirstNameInfo(lowerE(w)).every((x) => !x.ambiguous);

/** Кириллическая фамилия по суффиксу («Лисицын», «Гаврилюк», «Захарченко»), не имя: LOC модели на ней — человек. */
const surnameMorph = (w) => /^\p{Lu}[а-яё]+$/u.test(w) && (surnameSuffixInfo(lowerE(w)) || []).length > 0 && !bigFirstNameInfo(lowerE(w)).length;

/** Фамилия по словарю (без суффиксной догадки): «Ахмедов», «Wiśniewski». */
function surnameLike(word) {
  const w = lowerE(word);
  if (/\p{sc=Latin}/u.test(word)) return isEnSurname(w) && !isEnFirst(w);
  return /[а-я]/.test(w) && surnameLemmas(w).length > 0 && !bigFirstNameInfo(w).length;
}
/** Следующее слово с заглавной через один пробел (с диакритикой, через дефис). */
const NEXT_WORD_RE = /^[ \u00a0](\p{Lu}\p{Ll}+(?:-\p{Lu}\p{Ll}+)?)(?![\p{L}\p{N}])/u;

/** Имя, отчество или инициал (без фамилий): в капс-строке из нескольких слов «НАМ ДОВЕРЯЮТ» фамилии «Нам» мало. */
function givenNameLike(word, next = '.') {
  const w = lowerE(word);
  if (/^\p{Lu}$/u.test(word)) return next === '.'; // инициал «А.»
  if (/^[a-z'’-]+$/.test(w)) return isEnFirst(w);
  if (!/[а-я]/.test(w)) return false;
  return bigFirstNameInfo(w).length > 0 || firstNameInfo(w).length > 0 || !!patronymicInfo(w);
}

/** Признаки адреса рядом с LOC: улица, дом, офис, индекс, номер дома после запятой (§ правило 4). */
// Признаки по порядку: индекс; «д. 5», «кв. 12», «оф. 3» — с номером: «Д.» без номера — инициал («Иванов Д.А.»); британский индекс; ZIP;
// «Невский, 90», «Baker Street, 221b»; не дата «, 15 сентября».
const ADDRESS_STRONG_RE = new RegExp(
  [
    // индекс — не число после тире или «=» («Объём — 145000, Казань», ловушка WP11-E)
    '(?<![—–=-][ \\t\\u00a0]*)(?<!\\d)\\d{6}(?!\\d)',
    '(?<![\\p{L}])(?:ул|пер|пр|просп|пр-т|наб|пл|ш|мкр|б-р)\\.',
    '(?<![\\p{L}])(?:д|кв|оф|стр|корп|пом)\\.?[ \\t\\u00a0]*\\d',
    '(?<![\\p{L}])(?:улица|улицы|улице|проспект|переулок|набережная|шоссе|бульвар|пр-т)(?![\\p{L}])',
    // «дом», «офис», «квартира», «корпус» — только с номером («офис остаётся здесь» — не адрес, ловушка WP11-E)
    '(?<![\\p{L}])(?:дом|дома|офис|офиса|квартира|строение|корпус)[ \\t\\u00a0]*№?[ \\t\\u00a0]*\\d',
    '(?<![\\p{L}])(?:street|st\\.|road|rd\\.|avenue|ave\\.|lane|drive|boulevard|square|suite|floor)(?![\\p{L}])',
    '\\b[A-Z]{1,2}\\d[A-Z\\d]? ?\\d[A-Z]{2}\\b',
    '(?<![—–=-][ \\t\\u00a0]*)(?<![\\p{L}\\d])\\d{5}(?:-\\d{4})?(?!\\d)',
    '(?<!\\d),[ \\t\\u00a0]*\\d{1,3}[а-яa-z]?(?:\\/\\d{1,3})?(?!\\d|[.:,]\\d)(?![ \\t\\u00a0]*(?:' + NOT_HOUSE_SRC + '))',
  ].join('|'),
  'iu',
);
/** Адресные метки в окне потока (ревью WP11-D): адрес лучше замаскировать лишний раз, чем открыть дом и квартиру. */
const ADDRESS_LABEL_RE = new RegExp(`${VALUE_LABEL_SRC}|(?<![\\p{L}])(?:курьер\\p{L}*|живу|resides)(?![\\p{L}])`, 'iu');
/** Номер дома сразу после места: «12», «12-5», «54/2», «9а» (и квартира/офис за ним: «9, квартира 3»). */
const HOUSE_AFTER_RE = new RegExp(`^[ \\t\\u00a0]+\\d{1,3}[а-яa-z]?(?:[/-]\\d{1,3}[а-яa-z]?)?(?![\\d.:,]\\d|\\d)(?![ \\t\\u00a0]*(?:${NOT_HOUSE_SRC}))`, 'iu');
/**
 * LOC в адресном контексте: в спане или в окне ±40 символов вокруг него (тот же поток) есть признак адреса. Пометка города
 * («г. Нижний Новгород» в строке банка) — не признак: город без улицы и дома — не адрес человека или организации.
 * @param {string} text @param {number} start @param {number} end
 */
export function hasAddressContext(text, start, end) {
  // окно не режет слово или число («145000» на краю окна — не «14500», ловушка WP11-E)
  let a = Math.max(0, start - ADDRESS_WINDOW);
  let b = Math.min(text.length, end + ADDRESS_WINDOW);
  while (a > 0 && /[\p{L}\p{N}]/u.test(text[a - 1])) a--;
  while (b < text.length && /[\p{L}\p{N}]/u.test(text[b])) b++;
  const win = text.slice(a, b);
  // «Тверская 12-5», «Лесную 14», «Ленина 54/2»: номер дома сразу после места
  return ADDRESS_STRONG_RE.test(win) || ADDRESS_LABEL_RE.test(win) || !!houseAfter(text, end);
}

/** Номер дома сразу после места; буква дома — строчная («9а»): «1С», «2D» — не дом. */
function houseAfter(text, end) {
  const m = HOUSE_AFTER_RE.exec(text.slice(end, end + 12));
  return m && !/\d\p{Lu}/u.test(m[0]) ? m : null;
}

/**
 * Конец LOC вместе с номером дома и частями адреса после него («на Лесную 14», «Баумана 9, квартира 3», «Профсоюзную 104,
 * корпус 2», «Олимпийский проспект, 10»): иначе номер дома остался бы в тексте рядом с замаскированной улицей.
 * @param {string} text @param {number} end
 */
function houseTailEnd(text, end) {
  const h = houseAfter(text, end);
  return addressTailEnd(text, h ? end + h[0].length : end);
}

/**
 * Улица, которую модель размечает ORG, перед номером дома («на Профсоюзную 104, корпус 2»): в любом режиме — кандидат LOC,
 * дальше — правила LOC → ADDRESS (WP11-D, ревью 3). ORG с ОПФ или в кавычках не трогается.
 * @param {import('../contracts/ner.js').NerSpan[]} spans @param {string} text
 */
export function orgStreetsAsLoc(spans, text) {
  return spans.map((sp) =>
    sp.label === 'ORG' &&
    houseAfter(text, sp.end) &&
    !isNeverMaskOrg(text.slice(sp.start, sp.end)) &&
    !/[«»"]/u.test(text.slice(Math.max(0, sp.start - 1), sp.end + 1)) &&
    !/^\p{Lu}{2,}/u.test(text.slice(sp.start, sp.end))
      ? { ...sp, label: 'LOC' }
      : sp,
  );
}

/**
 * Отбрасывает ложные спаны PER и LOC модели и отрезает служебные слова по краям PER/LOC. Остальные метки не трогает.
 * @param {import('../contracts/ner.js').NerSpan[]} spans  спаны одного потока (после порога)
 * @param {{text: string, blockKind?: string, stoplist?: Set<string>, cellTexts?: Set<string>}} ctx
 *   текст потока, вид блока (`paragraph.kind`), контекст документа (`createOrgFilterContext`)
 * @returns {import('../contracts/ner.js').NerSpan[]}
 */
export function filterPersonLocSpans(spans, ctx) {
  const text = String(ctx?.text ?? '');
  const stoplist = ctx?.stoplist || BUILTIN_STOPLIST;
  const out = [];
  for (const sp of spans) {
    if (sp.label !== 'PER' && sp.label !== 'LOC') {
      out.push(sp);
      continue;
    }
    let start = Math.max(0, sp.start);
    let end = Math.min(text.length, sp.end);
    if (end <= start) continue;
    // 1. стоп-список: продукты, аббревиатуры, бренд владельца
    const around = wholeWordAround(text, start, end);
    if (isStoplisted(text.slice(start, end), stoplist) || (around && isStoplisted(around, stoplist))) continue;
    // 2. служебные слова по краям: «Ок. Почта», «Сальдо начальное», «Procurement Manager», «Фролова Главный»;
    //    у PER — и слова со строчной буквы или с цифрами по краям («экспедитор Кравчук», «Переписка с клиентом»)
    const base = start;
    const ws = [...text.slice(base, end).matchAll(WORD_RE)];
    const per = sp.label === 'PER';
    const service = (w) => LETTER_RE.test(w) && (isService(w) || inStoplist(stopKey(w), stoplist, w));
    const junk = (w) => per && !PARTICLES.has(lowerE(w)) && (!LETTER_RE.test(w) || /\d/.test(w) || isLowerWord(w));
    let a = 0;
    let b = ws.length;
    let trimmed = false;
    while (a < b && (service(ws[a][0]) || junk(ws[a][0]))) a++;
    while (b > a && (service(ws[b - 1][0]) || junk(ws[b - 1][0]))) b--;
    if (a >= b) continue;
    const words = ws.slice(a, b).map((m) => m[0]);
    const nextOf = ws.slice(a, b).map((m) => text[base + /** @type {number} */ (m.index) + m[0].length] || '');
    if (a > 0 || b < ws.length) {
      trimmed = true;
      start = base + /** @type {number} */ (ws[a].index);
      end = base + /** @type {number} */ (ws[b - 1].index) + ws[b - 1][0].length;
      // после отрезания спан начинается со строчной («Сальдо начальное») — не имя и не место
      if (isLowerWord(words[0])) continue;
    }
    if (words.length === 1 && ROMAN_RE.test(words[0])) continue;
    // WP11-E (ловушки финальной проверки): одно слово — шаблонное слово договора или роль стороны («Займодавец»,
    // «Займодавца»); в столбце «Город»/«City» — место, а не человек («Хошимин»)
    if (words.length === 1 && (isRoleNoun(words[0]) || ROLE_WORDS.has(lowerE(words[0])) || ROLE_FORM_RE.test(lowerE(words[0])))) continue;
    // шаблонное слово — только для PER: города («Москва») в словаре шаблонных слов есть, а LOC решает адресный контекст
    if (per && words.length === 1 && isStopWord(words[0])) continue;
    if (per && words.length === 1 && PLACE_COLUMN_RE.test(ctx?.columnHeader || '')) continue;
    // PER модели одним словом в перечислении мест («Москва, Тверь, Клин» — «Клин» как PER, ловушка WP11-E)
    if (per && words.length === 1 && inPlaceList(spans, sp, text, start, end)) continue;
    // 3. одно слово со строчной буквы
    if (words.length === 1 && isLowerWord(words[0])) continue;
    if (sp.label === 'LOC') {
      // 4. LOC — только в адресе
      if (!hasAddressContext(text, start, end)) {
        // LOC на фамилии или имени вне адреса («приезжал представитель подрядчика Лисицын» — модель 1.1.0, ревью 3;
        // «> Олеся, здравствуйте» — модель 1.0.0, WP11-E): человек,
        // а не место — PER (лишнее маскирование города «Пушкин» допустимо, открытая фамилия — нет)
        if (
          words.length === 1 &&
          (surnameMorph(words[0]) || strongFirstName(words[0])) &&
          !/(?<![\p{L}])(?:г|гор|пос|с|дер|ст)\.[ \u00a0]*$/u.test(text.slice(Math.max(0, start - 6), start)) &&
          // перечисление мест («Москва, Тверь, Клин») — место, а не человек (ловушка WP11-E)
          !inPlaceList(spans, sp, text, start, end) &&
          // «на Тверской», «у Садовой» — улица-прилагательное, а не фамилия
          !/(?:ск|цк)(?:ой|ая|ую|ие)$/u.test(lowerE(words[0])) &&
          !PLACE_COLUMN_RE.test(ctx?.columnHeader || '') &&
          !(ADJ_SURNAME_RE.test(lowerE(words[0])) && ADJ_NEXT_RE.test(text.slice(end, end + 30)))
        )
          out.push({ ...sp, start, end, label: 'PER' });
        continue;
      }
      end = houseTailEnd(text, end);
    } else {
      // 5. PER: внутри имени нет слов со строчной буквы (кроме частиц «де», «ван», «оглы») и цифр
      if (words.some(junk)) continue;
      // капс («АКТ СВЕРКИ ВЗАИМНЫХ РАСЧЁТОВ», «О НАС»): имя — только по словарям, суффикс фамилии не в счёт;
      // в капсе из нескольких слов нужно имя, отчество или инициал («ИВАНОВ ИВАН», «ПЕТРОВ П.П.»)
      const caps = words.every((w) => w === w.toUpperCase()) && words.join('').length > 1;
      const named = caps && words.length > 1 ? words.some((w, k) => givenNameLike(w, nextOf[k])) : words.some((w, k) => nameLike(w, nextOf[k], caps));
      if (!named) {
        // без единого слова-имени: остаток фразы («Переписка» из «Переписка с клиентом»), капс-заголовок,
        // одно слово в заголовке, пункте, ячейке
        const line = SHORT_LINE_KINDS.has(ctx?.blockKind || '') || !!ctx?.cellTexts?.has(text) || isCapsLine(text);
        if (trimmed || caps || (words.length === 1 && line)) continue;
      }
    }
    // «Пролетарским районным судом»: прилагательное перед прилагательным со строчной — не фамилия (ловушка WP11-E)
    if (per && words.length === 1 && ADJ_SURNAME_RE.test(lowerE(words[0])) && ADJ_NEXT_RE.test(text.slice(end, end + 30))) continue;
    // «Роман, который мы обсуждали…» — омоним с придаточным: вещь, а не человек (ловушка WP11-E)
    if (per && words.length === 1 && homonymName(words[0]) && /^[ \u00a0]*,[ \u00a0]*котор/u.test(text.slice(end, end + 15))) continue;
    // 6. Омоним нарицательного в начале предложения перед предлогом или в перечислении («Вера в продукт», «Роман о жизни»,
    //    «Любовь к делу», «Вера, надежда, любовь»), если в документе нет человека с этим именем («Вера Лукина») — не имя
    if (per && words.length === 1 && homonymName(words[0]) && sentenceStart(text, start) && !ctx?.pairedWords?.has(lowerE(words[0]))) {
      if (HOMONYM_TAIL_RE.test(text.slice(end, end + 30))) continue;
    }
    // PER модели оборван перед фамилией («Tomasz» из «Tomasz Wiśniewski» — WordPiece не разобрал диакритику; «Кирилл» из
    // «Кирилл Ахмедов»): следующее слово — словарная фамилия, а в спане фамилии нет — спан продолжается (WP11-D)
    if (per && !words.some((w) => surnameLike(w))) {
      const m = NEXT_WORD_RE.exec(text.slice(end, end + 40));
      if (m && surnameLike(m[1]) && !isService(m[1]) && !inStoplist(stopKey(m[1]), stoplist, m[1])) end += m[0].length;
    }
    out.push(start === sp.start && end === sp.end ? sp : { ...sp, start, end });
  }
  return out;
}
