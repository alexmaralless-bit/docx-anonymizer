// ADDRESS по правилам: цепочка компонентов через запятую (индекс, г., ул., д., кв., обл., пр-т, корп., стр., офис…;
// EN: «10 Downing Street», «Suite 5», почтовые индексы UK/US). Нужно ≥ 2 компонента.
// Уровень: labeled — если перед цепочкой лейбл адреса; weak — без лейбла, но с индексом и ≥ 3 компонентами.

import { labelBeforeRe, hasLabelBefore } from './text.js';

// prettier-ignore
export const ADDRESS_LABELS_RU = [
  'адрес', 'юридический адрес', 'фактический адрес', 'почтовый адрес', 'адрес регистрации', 'адрес места жительства',
  'место нахождения', 'местонахождение', 'место жительства', 'зарегистрирован по адресу', 'зарегистрированный по адресу',
  'зарегистрированная по адресу', 'проживающий по адресу', 'проживающая по адресу', 'находящийся по адресу', 'расположенный по адресу',
  'адрес доставки', 'адрес объекта', 'юр. адрес', 'факт. адрес',
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
const RE_EN_UNIT = new RegExp(
  `(?:(?:Suite|Ste\\.?|Floor|Fl\\.?|Apt\\.?|Apartment|Unit|Room|Office|Building|Bldg\\.?)${W}*#?\\d+[A-Za-z]?|\\d+(?:st|nd|rd|th)${W}+Floor|P\\.?${W}?O\\.?${W}+Box${W}+\\d+)(?![\\p{L}\\d])`,
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

/**
 * @param {string} text
 * @returns {{start: number, end: number, confidence: 'labeled'|'weak', components: number}[]}
 */
export function findAddresses(text) {
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
