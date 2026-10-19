// ADDRESS по правилам: цепочка компонентов через запятую (индекс, г., ул., д., кв., обл., пр-т, корп., стр., офис…;
// EN: «10 Downing Street», «Suite 5», почтовые индексы UK/US). Нужно ≥ 2 компонента.
// Уровень: labeled — если перед цепочкой лейбл адреса; weak — без лейбла, но с индексом и ≥ 3 компонентами.

import { labelBeforeRe, hasLabelBefore } from './text.js';
import { isStopWord, wordList } from './lexicon.js';

// prettier-ignore
export const ADDRESS_LABELS_RU = [
  ...wordList(`адрес|юридический адрес|фактический адрес|почтовый адрес|адрес регистрации|адрес места жительства|место нахождения|местонахождение|место жительства|зарегистрирован по адресу|зарегистрированный по адресу|зарегистрированная по адресу|проживающий по адресу|проживающая по адресу|находящийся по адресу|расположенный по адресу|адрес доставки|адрес объекта|юр. адрес|факт. адрес`),
];
// prettier-ignore
export const ADDRESS_LABELS_EN = [
  'address', 'registered office', 'registered address', 'located at', 'mailing address', 'business address', 'principal office',
  'principal place of business', 'residing at', 'domiciled at', 'delivery address',
];
const LABEL_RE = labelBeforeRe([...ADDRESS_LABELS_RU, ...ADDRESS_LABELS_EN]);

// Типы с названием ПОСЛЕ («ул. Ленина»). Сопоставляются по тексту в нижнем регистре.
const NAME_TYPES =
  'г\\.|гор\\.|город|пос\\.|пгт\\.?|с\\.|дер\\.|д\\.|ул\\.|улица|пер\\.|переулок|пр-т|пр-кт|просп\\.|проспект|пр\\.|ш\\.|шоссе|' +
  'наб\\.|набережная|б-р|бул\\.|бульвар|пл\\.|площадь|мкр\\.?|мкрн\\.?|микрорайон|туп\\.|тупик|проезд|пр-д|аллея|линия|тер\\.|' +
  'обл\\.|область|р-н|район|респ\\.|республика|край|кв-л|квартал|сп\\.|снт';
// Типы с номером («д. 1», «офис 5»)
const NUM_TYPES =
  'д\\.|дом|корп\\.|корпус|к\\.|стр\\.|строение|кв\\.|квартира|оф\\.|офис|пом\\.|помещение|эт\\.|этаж|комн\\.|комната|' +
  'лит\\.|литера|литер|вл\\.|влд\\.|владение|уч\\.|участок|а/я|абонентский ящик|п/я|каб\\.|кабинет';
// Типы ПОСЛЕ названия («Московская обл.», «Ленинский пр-т»)
const SUFFIX_TYPES = 'обл\\.|область|край|р-н|район|пр-т|проспект|ш\\.|шоссе|пер\\.|переулок|наб\\.|бульвар|б-р|ул\\.|улица|АО|респ\\.';

const W = '[ \\u00A0]';
const CAP_NAME = `(?:\\d{1,3}-?[а-яё]{0,2}${W}+)?[А-ЯЁA-Z0-9][\\p{L}\\d.-]*(?:${W}+[А-ЯЁ][\\p{L}.-]*){0,3}`;
const NUM = `№?${W}*(?:\\d+[а-яёa-z]?(?:[/-]\\d+[а-яёa-z]?)?|[А-ЯЁA-Z](?![\\p{L}\\d]))`;

const RE_INDEX = /\d{6}(?!\d)/y;
const RE_NUM_TYPED = new RegExp(`(?:${NUM_TYPES})${W}*${NUM}`, 'iuy');
const RE_NAME_TYPE = new RegExp(`(?:${NAME_TYPES})${W}*`, 'iuy');
const RE_CAP_NAME = new RegExp(CAP_NAME, 'uy');
const RE_SUFFIX_TYPED = new RegExp(`[А-ЯЁ][\\p{L}-]*(?:${W}[А-ЯЁа-яё][\\p{L}-]*){0,2}${W}+(?:${SUFFIX_TYPES})(?![\\p{L}])`, 'uy');
const RE_COUNTRY =
  /(?:Российская Федерация|Россия|РФ|Russian Federation|Russia|USA|U\.S\.A\.|United States(?: of America)?|United Kingdom|UK|England|Germany|France)(?![\p{L}])/uy;

const EN_STREET_TYPES =
  'Street|St\\.?|Avenue|Ave\\.?|Road|Rd\\.?|Boulevard|Blvd\\.?|Lane|Ln\\.?|Drive|Dr\\.?|Way|Place|Pl\\.?|Square|Sq\\.?|Court|Ct\\.?|' +
  'Terrace|Close|Parkway|Pkwy\\.?|Highway|Hwy\\.?|Embankment|Row|Gardens|Crescent';
const RE_EN_STREET = new RegExp(`\\d+[A-Za-z]?(?:-\\d+)?${W}+(?:[A-Z][a-z]+${W}+){1,3}(?:${EN_STREET_TYPES})(?![\\p{L}])`, 'uy');
// «88 Deansgate,» — номер и название улицы без слова-типа (только перед запятой: дальше город с индексом, ревью WP11-D)
const RE_EN_NUM_NAME = new RegExp(`\\d{1,4}[A-Za-z]?${W}+[A-Z][a-z]+(?:${W}[A-Z][a-z]+)?(?=,)`, 'uy');
const RE_EN_UNIT = new RegExp(
  `(?:(?:Flat|Suite|Ste\\.?|Floor|Fl\\.?|Apt\\.?|Apartment|Unit|Room|Office|Building|Bldg\\.?)${W}*#?\\d+[A-Za-z]?|\\d+(?:st|nd|rd|th)${W}+Floor|P\\.?${W}?O\\.?${W}+Box${W}+\\d+)(?![\\p{L}\\d])`,
  'uy',
);
const POSTCODE = `(?:[A-Z]{1,2}\\d[A-Z\\d]?${W}?\\d[A-Z]{2}|[A-Z]{2}${W}+\\d{5}(?:-\\d{4})?)(?![\\p{L}\\p{N}])`;
const RE_EN_POSTCODE = new RegExp(POSTCODE, 'uy');
const RE_EN_CITY_POSTCODE = new RegExp(`[A-Z][a-z]+(?:${W}[A-Z][a-z]+){0,2}[,]?${W}+${POSTCODE}`, 'uy');
const RE_EN_ZIP_CITY = new RegExp(`\\d{5}(?:-\\d{4})?${W}+[A-Z][a-z]+(?:${W}[A-Z][a-z]+){0,2}(?![\\p{L}])`, 'uy');
const RE_CITY = /[А-ЯЁA-Z][\p{Ll}]+(?:-[А-ЯЁA-Z]?[\p{Ll}]+)*(?:[ \u00A0][А-ЯЁA-Z][\p{Ll}]+){0,2}(?![\p{L}])/uy;

const SEP = /(?:[ \u00A0\t]*[,;][ \u00A0\t]*|[ \u00A0\t]+)/y;

function sticky(re, text, pos) {
  re.lastIndex = pos;
  const m = re.exec(text);
  return m ? m[0] : null;
}

/**
 * Компонент адреса в позиции pos.
 * @returns {{end: number, weight: number, index: boolean} | null}
 */
function component(text, lower, pos) {
  let m;
  if ((m = sticky(RE_INDEX, text, pos))) return { end: pos + m.length, weight: 1, index: true };
  if ((m = sticky(RE_EN_STREET, text, pos))) return { end: pos + m.length, weight: 1, index: false };
  if ((m = sticky(RE_EN_ZIP_CITY, text, pos))) return { end: pos + m.length, weight: 2, index: true };
  if ((m = sticky(RE_NUM_TYPED, lower, pos))) return { end: pos + m.length, weight: 1, index: false };
  if ((m = sticky(RE_NAME_TYPE, lower, pos))) {
    const name = sticky(RE_CAP_NAME, text, pos + m.length);
    if (name) return { end: pos + m.length + name.replace(/[.,]$/, '').length, weight: 1, index: false };
  }
  if ((m = sticky(RE_SUFFIX_TYPED, text, pos))) return { end: pos + m.length, weight: 1, index: false };
  if ((m = sticky(RE_EN_UNIT, text, pos))) return { end: pos + m.length, weight: 1, index: false };
  if ((m = sticky(RE_EN_CITY_POSTCODE, text, pos))) return { end: pos + m.length, weight: 2, index: true };
  if ((m = sticky(RE_EN_POSTCODE, text, pos))) return { end: pos + m.length, weight: 1, index: true };
  if ((m = sticky(RE_EN_NUM_NAME, text, pos))) return { end: pos + m.length, weight: 1, index: false };
  return null;
}

/** Заполнитель внутри цепочки (страна, город без типа): веса не имеет. */
function filler(text, pos) {
  const m = sticky(RE_COUNTRY, text, pos) || sticky(RE_CITY, text, pos);
  return m ? { end: pos + m.length } : null;
}

/**
 * Цепочка компонентов, начиная с pos.
 * @returns {{start: number, end: number, weight: number, index: boolean} | null}
 */
function chainAt(text, lower, pos) {
  let p = pos;
  let weight = 0;
  let index = false;
  let end = -1;
  for (let guard = 0; guard < 40; guard++) {
    const c = component(text, lower, p);
    if (c) {
      weight += c.weight;
      index = index || c.index;
      end = c.end;
      p = c.end;
    } else {
      if (end < 0) return null; // цепочка начинается только с компонента
      const f = filler(text, p);
      if (!f) break;
      p = f.end;
    }
    const s = sticky(SEP, text, p);
    if (!s) break;
    p += s.length;
  }
  return end > pos ? { start: pos, end, weight, index } : null;
}

/* ---------- адрес после метки и «Город, Улица 12-5» без типов (WP11-D, отложенный набор ревью) ---------- */

/** Метки адреса в любой форме: «адрес», «по адресу», «проживающую», «зарегистрированный», «место жительства», «доставка»… */
export const VALUE_LABEL_SRC = String.raw`(?<![\p{L}])(?:адрес\p{L}*|проживающ\p{L}*|проживает|проживаю|зарегистрирован\p{L}*|мест[оа](?:\s+|\u00A0)(?:жительства|регистрации|нахождения|проживания)|местонахождени\p{L}*|доставк\p{L}*|расположенн\p{L}*|находящ\p{L}*|address|lives\s+at|located\s+at|resides\s+at|residing\s+at|domiciled\s+at)(?![\p{L}])`;
const VALUE_LABEL_RE = new RegExp(VALUE_LABEL_SRC, 'giu');
/** Слова-типы внутри адреса со строчной: «г.», «ул.», «д.», «кв.», «область», «проспект», «flat», «de»… */
const TYPE_WORD_RE = new RegExp(`^(?:${NAME_TYPES}|${NUM_TYPES}|${SUFFIX_TYPES}|по|на|de|du|la|le|del|di|da|van|von|flat|apt\\.?|suite|unit|floor)$`, 'iu');
/** Сокращения, после точки которых предложение не кончается. */
const ABBR_BEFORE_DOT_RE =
  /(?<![\p{L}])(?:г|гор|ул|д|кв|пр|просп|обл|корп|стр|оф|пер|наб|пос|с|дер|респ|мкр|мкрн|пом|эт|р-н|б-р|ш|пл|туп|лит|комн|каб|apt|st|rd|ave)$/iu;

/**
 * Значение после метки адреса до конца строки или предложения: «Адрес: Москва, Тверская 12-5», «проживающую по адресу:
 * г. Казань, ул. Чистопольская, д. 61, кв. 88, представлять…» (до слова со строчной, которое не тип адреса),
 * «Lives at 12 Rue de Rivoli, Paris». Между меткой и значением — до 40 символов до двоеточия («Почтовый адрес Заказчика
 * для корреспонденции: …»). Значение — с цифрой и словом с заглавной или типом адреса (не дата «12.05.2015»).
 * @param {string} text
 * @returns {{start: number, end: number}[]}
 */
function labeledValues(text) {
  const out = [];
  VALUE_LABEL_RE.lastIndex = 0;
  let m;
  while ((m = VALUE_LABEL_RE.exec(text))) {
    let p = m.index + m[0].length;
    const tail = text.slice(p, p + 60);
    const colon = /^[^:\n.;!?]{0,40}:/u.exec(tail);
    if (colon) p += colon[0].length;
    else {
      const po = /^[ \u00A0]+по[ \u00A0]+адресу/iu.exec(tail);
      if (po) p += po[0].length;
    }
    const sep = /^[ \u00A0\t:—–-]*/u.exec(text.slice(p));
    p += sep ? sep[0].length : 0;
    const start = p;
    let end = start;
    // слова значения по порядку: стоп на строчном слове не из типов, на «;», «|», «(», переводе строки, конце предложения
    const WORD = /([\p{L}\p{N}][\p{L}\p{N}'’/-]*)(\.?)|([,])|([;|(\n])|(\s+[—–]\s+)|(\s+)|(.)/guy;
    WORD.lastIndex = start;
    let w;
    let words = 0;
    while ((w = WORD.exec(text))) {
      if (w[4] || w[5] || w[7]) break;
      if (w[3] || w[6]) continue;
      const word = w[1];
      const lowerStart = /^\p{Ll}/u.test(word);
      if (lowerStart && !TYPE_WORD_RE.test(word + w[2]) && !TYPE_WORD_RE.test(word)) break;
      end = w.index + word.length + (w[2] && (ABBR_BEFORE_DOT_RE.test(word) || TYPE_WORD_RE.test(word + '.')) ? 1 : 0);
      words++;
      // точка после обычного слова или числа — конец предложения
      if (w[2] && !ABBR_BEFORE_DOT_RE.test(word) && !TYPE_WORD_RE.test(word + '.')) break;
      if (end - start > 160) break;
    }
    // число в конце — дата или сумма («…Пролетарская 12, 15 сентября»), а не номер дома: не в адресе
    const num = /,[ \u00A0]*\d{1,4}$/u.exec(text.slice(start, end));
    if (num && NOT_HOUSE_AFTER_RE.test(text.slice(end, end + 12))) end -= num[0].length;
    const value = text.slice(start, end);
    if (words >= 2 && /\d/.test(value) && /(?:^|[\s,])(?:\p{Lu}|(?:г|ул|д|пр-т|обл)\.)/u.test(value)) out.push({ start, end });
  }
  return out;
}

/** «Тольятти, Революционная 52-14», «Москва, Тверская 12»: город, улица с заглавной и номер дома — без «г.», «ул.», «д.». */
const CITY_STREET_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])[А-ЯЁ][а-яё]+(?:-[А-ЯЁ]?[а-яё]+)*,${W}+[А-ЯЁ][а-яё]+(?:${W}[А-ЯЁа-яё][а-яё]+)?,?${W}+\\d{1,3}[а-я]?(?:[/-]\\d{1,3}[а-я]?)?(?![\\p{L}\\d]|[.,]\\d)`,
  'gu',
);

/**
 * @param {string} text
 * @returns {{start: number, end: number, confidence: 'labeled'|'weak', components: number}[]}
 */
export function findAddresses(text) {
  const out = chainAddresses(text);
  // значение после метки: шире цепочки — заменяет её (адрес закрыт целиком), иначе — добавляется
  const extra = [];
  for (const v of labeledValues(text)) {
    if (extra.some((a) => a.start < v.end && v.start < a.end)) continue; // «проживающую по адресу» — две метки, одно значение
    const inner = out.filter((a) => a.start >= v.start && a.end <= v.end);
    if (out.some((a) => a.start <= v.start && a.end >= v.end)) continue;
    if (out.some((a) => a.start < v.end && v.start < a.end && !inner.includes(a))) continue;
    for (const a of inner) out.splice(out.indexOf(a), 1);
    extra.push({ start: v.start, end: v.end, confidence: /** @type {const} */ ('labeled'), components: 2 });
  }
  for (const m of text.matchAll(CITY_STREET_RE)) {
    const start = /** @type {number} */ (m.index);
    const end = start + m[0].length;
    if ([...out, ...extra].some((a) => a.start < end && start < a.end)) continue;
    const city = m[0].split(',')[0];
    if (isStopWord(city)) continue;
    extra.push({ start, end, confidence: /** @type {const} */ ('weak'), components: 2 });
  }
  // дом, квартира, корпус после запятой: «…проспект Октября, 48, кв. 17», «…шоссе 35, строение 2» (WP11-D, ревью 3)
  return [...out, ...extra].map((a) => ({ ...a, end: addressTailEnd(text, a.end) })).sort((a, b) => a.start - b.start);
}

/** Слова после числа, при которых оно не номер дома: даты, годы, суммы, штуки. */
export const NOT_HOUSE_SRC =
  'январ|феврал|март|апрел|ма[яй]|июн|июл|август|сентябр|октябр|ноябр|декабр|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|год|г\\.|лет|руб|шт|%';
const NOT_HOUSE_AFTER_RE = new RegExp(`^${W}*(?:${NOT_HOUSE_SRC})`, 'iu');
/** Часть адреса после запятой: «, 48», «, кв. 17», «, корпус 2», «, строение 2», «, подъезд 3» (не дата и не сумма). */
const ADDRESS_TAIL_RE = new RegExp(
  `^,${W}*(?:(?:кв\\.|квартира|корп\\.|корпус|к\\.|стр\\.|строение|оф\\.|офис|пом\\.|помещение|подъезд|под\\.|эт\\.|этаж|литера|лит\\.)${W}*\\d{1,4}[а-я]?|\\d{1,3}[а-я]?(?:[/-]\\d{1,3}[а-я]?)?)(?![\\p{L}\\d]|[.,:]\\d|${W}*(?:${NOT_HOUSE_SRC}))`,
  'iu',
);

/**
 * Конец адреса вместе с частями после запятой («, 48, кв. 17»): иначе дом и квартира оставались в тексте рядом с адресом.
 * @param {string} text @param {number} end
 */
export function addressTailEnd(text, end) {
  for (let guard = 0; guard < 4; guard++) {
    const m = ADDRESS_TAIL_RE.exec(text.slice(end, end + 30));
    if (!m) break;
    end += m[0].length;
  }
  return end;
}

/**
 * Цепочки компонентов (0.1): «123456, г. Москва, ул. Ленина, д. 1».
 * @param {string} text
 * @returns {{start: number, end: number, confidence: 'labeled'|'weak', components: number}[]}
 */
function chainAddresses(text) {
  const out = [];
  const lower = text.toLowerCase();
  const starts = /(?<![\p{L}\p{N}])[\p{L}\p{N}]/gu;
  let m;
  while ((m = starts.exec(text))) {
    const pos = m.index;
    const ch = chainAt(text, lower, pos);
    if (!ch || ch.weight < 2) continue;
    const labeled = hasLabelBefore(text, pos, LABEL_RE);
    if (labeled) out.push({ start: ch.start, end: ch.end, confidence: 'labeled', components: ch.weight });
    else if (ch.weight >= 3 && ch.index) out.push({ start: ch.start, end: ch.end, confidence: 'weak', components: ch.weight });
    else continue;
    starts.lastIndex = ch.end;
  }
  return out;
}

/** Потоковый детектор ADDRESS (контракт §2). */
export function detectAddress(text) {
  return findAddresses(text).map((a) => ({ start: a.start, end: a.end, confidence: a.confidence, source: a.confidence === 'labeled' ? 'label' : 'rule' }));
}
