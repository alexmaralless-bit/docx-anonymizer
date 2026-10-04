// WP1: валидаторы контрольных сумм и структуры (ТЗ §4.3, §9.1 validators.spec).
// Имена совпадают с полем `validator` каталога (core/categories.js):
//   inn, kpp, ogrn, bik, account, luhn, iban, mod97, swift, snils, passport, ssn, taxid, email, url, phone, birthdate, legalForm, address.
// Каждый — (value: string, ctx?: object) => boolean. Принимают значение «как в тексте» (с пробелами и дефисами).
// Пользовательские категории переиспользуют inn / ogrn / snils / luhn / mod97 (FR-44).

const onlyDigits = (s) => String(s).replace(/[\s\-.]/g, '');
const isDigits = (s, n) => (n ? new RegExp(`^\\d{${n}}$`).test(s) : /^\d+$/.test(s));

/* ---------- ИНН ---------- */
const INN10_W = [2, 4, 10, 3, 5, 9, 4, 6, 8];
const INN12_W1 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
const INN12_W2 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
const innSum = (d, w) => w.reduce((s, x, i) => s + x * d[i], 0);

/** ИНН юрлица (10 цифр) или физлица/ИП (12 цифр) с контрольными цифрами. */
export function inn(value) {
  const s = onlyDigits(value);
  if (!isDigits(s)) return false;
  const d = s.split('').map(Number);
  if (s.length === 10) return (innSum(d, INN10_W) % 11) % 10 === d[9];
  if (s.length === 12) return (innSum(d, INN12_W1) % 11) % 10 === d[10] && (innSum(d, INN12_W2) % 11) % 10 === d[11];
  return false;
}

/* ---------- КПП ---------- */
/** 9 знаков: 4 цифры + 2 (цифры 01–69 или буквы A–Z) + 3 цифры. */
export function kpp(value) {
  const s = String(value).trim().toUpperCase();
  if (!/^\d{4}[0-9A-Z]{2}\d{3}$/.test(s)) return false;
  const reason = s.slice(4, 6);
  if (/^\d\d$/.test(reason)) {
    const n = Number(reason);
    return n >= 1 && n <= 69;
  }
  return true;
}

/* ---------- ОГРН / ОГРНИП ---------- */
/** 13 цифр (mod 11) или 15 цифр (mod 13). */
export function ogrn(value) {
  const s = onlyDigits(value);
  if (!isDigits(s)) return false;
  if (s.length === 13) return Number((BigInt(s.slice(0, 12)) % 11n) % 10n) === Number(s[12]);
  if (s.length === 15) return Number((BigInt(s.slice(0, 14)) % 13n) % 10n) === Number(s[14]);
  return false;
}

/* ---------- БИК ---------- */
/** 9 цифр, начинаются с `04`. */
export function bik(value) {
  return /^04\d{7}$/.test(onlyDigits(value));
}

/* ---------- счёт ---------- */
const ACC_W = [7, 1, 3];
/** Контрольный ключ (9-я цифра) счёта по БИК: префикс — 3 последние цифры БИК; для корр. счёта (301…/302…) — «0» + 5–6 цифры БИК. */
export function accountKeyOk(account20, bikValue) {
  const a = onlyDigits(account20);
  const b = onlyDigits(bikValue);
  if (!isDigits(a, 20) || !isDigits(b, 9)) return false;
  const corr = a.startsWith('301') || a.startsWith('302');
  const prefix = corr ? `0${b.slice(4, 6)}` : b.slice(6, 9);
  const s = (prefix + a).split('').reduce((acc, x, i) => acc + ((Number(x) * ACC_W[i % 3]) % 10), 0);
  return s % 10 === 0;
}

/** Счёт: 20 цифр; если передан `ctx.bik` — дополнительно проверяется ключ по БИК. */
export function account(value, ctx = {}) {
  const a = onlyDigits(value);
  if (!isDigits(a, 20)) return false;
  return ctx.bik ? accountKeyOk(a, ctx.bik) : true;
}

/* ---------- Луна ---------- */
export function luhn(value) {
  const s = onlyDigits(value);
  if (!isDigits(s) || s.length < 13 || s.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    let d = Number(s[s.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/* ---------- IBAN / mod-97 ---------- */
/** Длины IBAN по странам (реестр SWIFT). */
export const IBAN_LENGTHS = Object.freeze({
  AD: 24,
  AE: 23,
  AL: 28,
  AT: 20,
  AZ: 28,
  BA: 20,
  BE: 16,
  BG: 22,
  BH: 22,
  BR: 29,
  BY: 28,
  CH: 21,
  CR: 22,
  CY: 28,
  CZ: 24,
  DE: 22,
  DK: 18,
  DO: 28,
  EE: 20,
  EG: 29,
  ES: 24,
  FI: 18,
  FO: 18,
  FR: 27,
  GB: 22,
  GE: 22,
  GI: 23,
  GL: 18,
  GR: 27,
  GT: 28,
  HR: 21,
  HU: 28,
  IE: 22,
  IL: 23,
  IQ: 23,
  IS: 26,
  IT: 27,
  JO: 30,
  KW: 30,
  KZ: 20,
  LB: 28,
  LC: 32,
  LI: 21,
  LT: 20,
  LU: 20,
  LV: 21,
  LY: 25,
  MC: 27,
  MD: 24,
  ME: 22,
  MK: 19,
  MR: 27,
  MT: 31,
  MU: 30,
  NL: 18,
  NO: 15,
  PK: 24,
  PL: 28,
  PS: 29,
  PT: 25,
  QA: 29,
  RO: 24,
  RS: 22,
  RU: 33,
  SA: 24,
  SC: 31,
  SE: 24,
  SI: 19,
  SK: 24,
  SM: 27,
  ST: 25,
  SV: 28,
  TL: 23,
  TN: 24,
  TR: 26,
  UA: 29,
  VA: 22,
  VG: 24,
  XK: 20,
});

/** ISO 7064 mod 97-10 над буквенно-цифровой строкой (без проверки длины и страны). */
export function mod97(value) {
  const s = String(value).replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{4,30}$/.test(s)) return false;
  const r = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of r) {
    const v = ch >= 'A' ? ch.charCodeAt(0) - 55 : Number(ch);
    rem = v > 9 ? (rem * 100 + v) % 97 : (rem * 10 + v) % 97;
  }
  return rem === 1;
}

/** IBAN: страна из реестра, длина по стране, mod-97. */
export function iban(value) {
  const s = String(value).replace(/\s/g, '').toUpperCase();
  const len = IBAN_LENGTHS[s.slice(0, 2)];
  return !!len && s.length === len && mod97(s);
}

/* ---------- SWIFT ---------- */
/** ISO-3166 alpha-2 (+ XK). */
export const ISO_COUNTRIES = new Set(
  (
    'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ ' +
    'DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT ' +
    'JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ ' +
    'OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ ' +
    'UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW'
  ).split(' '),
);

/** SWIFT/BIC: 4 буквы банка + страна ISO (5–6) + 2 локация + [3 филиал]. */
export function swift(value) {
  const s = String(value).trim().toUpperCase();
  return /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/.test(s) && ISO_COUNTRIES.has(s.slice(4, 6));
}

/* ---------- СНИЛС ---------- */
/** Контрольное число СНИЛС (проверяется для номеров выше 001-001-998). */
export function snils(value) {
  const s = onlyDigits(value);
  if (!isDigits(s, 11)) return false;
  if (Number(s.slice(0, 9)) <= 1001998) return false;
  const sum = s
    .slice(0, 9)
    .split('')
    .reduce((acc, x, i) => acc + Number(x) * (9 - i), 0);
  let c;
  if (sum < 100) c = sum;
  else if (sum === 100 || sum === 101) c = 0;
  else {
    c = sum % 101;
    if (c === 100) c = 0;
  }
  return c === Number(s.slice(9));
}

/* ---------- паспорт ---------- */
/**
 * Структура: РФ — 10 цифр (регион 01–99, год 2 цифры, номер ≠ 000000); загранпаспорт РФ — 9 цифр;
 * иностранный — 6–12 букв/цифр, минимум одна цифра.
 */
export function passport(value) {
  const s = String(value)
    .replace(/[\s\-№]/g, '')
    .toUpperCase();
  if (/^\d{10}$/.test(s)) return s.slice(0, 2) !== '00' && s.slice(4) !== '000000';
  if (/^\d{9}$/.test(s)) return s.slice(0, 2) !== '00' && s.slice(2) !== '0000000';
  return /^[A-Z0-9]{6,12}$/.test(s) && /\d/.test(s);
}

/* ---------- SSN ---------- */
/** `ddd-dd-dddd`: area ≠ 000/666/9xx, group ≠ 00, serial ≠ 0000. */
export function ssn(value) {
  const m = /^(\d{3})[- ]?(\d{2})[- ]?(\d{4})$/.exec(String(value).trim());
  if (!m) return false;
  const [, area, group, serial] = m;
  return area !== '000' && area !== '666' && area[0] !== '9' && group !== '00' && serial !== '0000';
}

/* ---------- EIN / VAT / UTR ---------- */
function range(a, b) {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}
const EIN_PREFIXES = new Set(
  [...range(1, 6), ...range(10, 16), ...range(20, 27), ...range(30, 48), ...range(50, 68), ...range(71, 77), ...range(80, 88), ...range(90, 95), 98, 99].map(
    (n) => String(n).padStart(2, '0'),
  ),
);
const VAT_FORMATS = {
  DE: /^DE\d{9}$/,
  FR: /^FR[0-9A-Z]{2}\d{9}$/,
  GB: /^GB(?:\d{9}|\d{12}|GD\d{3}|HA\d{3})$/,
  NL: /^NL\d{9}B\d{2}$/,
  IT: /^IT\d{11}$/,
  ES: /^ES[0-9A-Z]\d{7}[0-9A-Z]$/,
  PL: /^PL\d{10}$/,
  CZ: /^CZ\d{8,10}$/,
};

/** EIN `dd-ddddddd` (допустимый префикс), VAT ЕС по странам (DE, FR, GB, NL, IT, ES, PL, CZ), UTR — 10 цифр. */
export function taxid(value) {
  const compact = String(value).trim().replace(/[\s.]/g, '').toUpperCase();
  if (/^\d{2}-?\d{7}$/.test(compact)) return EIN_PREFIXES.has(compact.slice(0, 2));
  if (/^[A-Z]{2}/.test(compact)) {
    const f = VAT_FORMATS[compact.slice(0, 2)];
    return !!f && f.test(compact);
  }
  return /^\d{10}$/.test(compact); // UTR
}

/* ---------- e-mail ---------- */
const FILE_EXT_TLDS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico']);
/** Один `@`, локальная часть без пустых точек, домен с точкой (в т.ч. IDN), TLD ≥ 2 букв. */
export function email(value) {
  const s = String(value);
  const at = s.indexOf('@');
  if (at < 1 || at !== s.lastIndexOf('@')) return false;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (local.length > 64 || /^\.|\.$|\.\./.test(local) || !/^[\p{L}\p{N}._%+'-]+$/u.test(local)) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((l) => l.length >= 1 && l.length <= 63 && /^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u.test(l))) return false;
  const tld = labels[labels.length - 1].toLowerCase();
  if (FILE_EXT_TLDS.has(tld)) return false;
  return /^\p{L}{2,}$/u.test(tld) || /^xn--[a-z0-9-]+$/.test(tld);
}

/* ---------- URL ---------- */
const GTLD = 'com net org info biz edu gov mil int io app dev pro cloud shop club xyz site online store tech рф';
/** TLD, допустимые для «голых» доменов без схемы и без `www.` (2-буквенные — только популярные, чтобы не ловить расширения файлов). */
export const COMMON_TLDS = new Set([...GTLD.split(' '), ...'ru su ua by kz uk de fr nl cz eu cn jp br'.split(' ')]);
const CC_TLDS = new Set([...ISO_COUNTRIES].map((c) => c.toLowerCase()).concat('uk', 'su'));
const tldOk = (tld, strict) => COMMON_TLDS.has(tld) || /^xn--[a-z0-9-]{2,}$/.test(tld) || (!strict && CC_TLDS.has(tld));

/**
 * Домен с известным TLD. Принимает `http(s)://…`, `ftp://…`, `www.…` или просто домен[/путь].
 * Для «голого» домена (без схемы и `www.`) список TLD короче; `ctx.strict` переопределяет.
 */
export function url(value, ctx = {}) {
  let s = String(value).trim();
  const hasScheme = /^(?:https?|ftp):\/\//i.test(s);
  s = s.replace(/^(?:https?|ftp):\/\//i, '');
  const host = s
    .split(/[/?#]/)[0]
    .replace(/^[^@/]*@/, '')
    .replace(/:\d+$/, '');
  if (!host) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return hasScheme && host.split('.').every((o) => Number(o) <= 255);
  if (hasScheme && host.toLowerCase() === 'localhost') return true;
  const labels = host.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((l) => /^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u.test(l))) return false;
  const tld = labels[labels.length - 1].toLowerCase();
  const strict = ctx.strict ?? !(hasScheme || /^www\./i.test(s));
  return tldOk(tld, strict);
}

/* ---------- телефон ---------- */
/**
 * Длина цифр 10–15 (для «+» — 7–15); для РФ (`+7`, `7`, `8` + 10 цифр) — ровно 11 цифр.
 * Добавочный («доб. 12», «ext. 12») не учитывается.
 */
export function phone(value) {
  const raw = String(value).trim();
  const plus = raw.startsWith('+');
  const main = raw.replace(/[\s,;]*(?:доб(?:авочный)?\.?|ext\.?|внутр\.?)\s*\d+\s*$/iu, '');
  const d = main.replace(/\D/g, '');
  if (d.length > 15 || d.length < (plus ? 7 : 10)) return false;
  if (plus && d[0] === '7') return d.length === 11;
  if (!plus && (d[0] === '8' || d[0] === '7') && d.length >= 11) return d.length === 11;
  return true;
}

/* ---------- дата рождения ---------- */
const RU_MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const EN_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const monthIndex = (w) => {
  const x = w.toLowerCase().replace(/\.$/, '').replace(/ё/g, 'е');
  let i = RU_MONTHS.indexOf(x);
  if (i >= 0) return i + 1;
  i = EN_MONTHS.findIndex((m) => m === x || (x.length >= 3 && m.startsWith(x)));
  return i >= 0 ? i + 1 : 0;
};

/** Разбор `dd.mm.yyyy`, `dd/mm/yyyy`, `d month yyyy`, `Month d, yyyy` → {d, m, y} | null (дата должна существовать). */
export function parseDate(text) {
  const s = String(text).trim().replace(/\s+/g, ' ');
  let d;
  let m;
  let y;
  let r;
  if ((r = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(s))) [d, m, y] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /^(\d{1,2})(?:st|nd|rd|th)? ([\p{L}.]+),? (\d{4})$/u.exec(s))) [d, m, y] = [Number(r[1]), monthIndex(r[2]), Number(r[3])];
  else if ((r = /^([\p{L}.]+) (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/u.exec(s))) [d, m, y] = [Number(r[2]), monthIndex(r[1]), Number(r[3])];
  else return null;
  if (!m || m > 12 || d < 1) return null;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= dim ? { d, m, y } : null;
}

/** Реальная дата, год от 1900 до (текущий − 14). `ctx.now` — для детерминированных тестов. */
export function birthdate(value, ctx = {}) {
  const p = parseDate(value);
  if (!p) return false;
  const year = (ctx.now ? new Date(ctx.now) : new Date()).getFullYear();
  return p.y >= 1900 && p.y <= year - 14;
}

/* ---------- ОПФ и адрес (используются WP2; здесь — структурные проверки) ---------- */
const LEGAL_FORM_RE = /(?<![\p{L}\p{N}])(?:ООО|ОАО|ПАО|ЗАО|АО|НКО|ГУП|МУП|ФГУП|ИП|КФХ|LLC|Ltd\.?|Inc\.?|GmbH|S\.A\.|B\.V\.|LLP|PLC|Corp\.?)(?![\p{L}\p{N}])/iu;
/** Содержит ОПФ. */
export function legalForm(value) {
  return LEGAL_FORM_RE.test(String(value));
}

const ADDRESS_COMPONENTS = [
  /(?<!\d)\d{6}(?!\d)/,
  /(?<![\p{L}])(?:г|гор)\.\s?\p{Lu}/u,
  /(?<![\p{L}])(?:ул|улица|проспект|пр-т|пр-кт|пер|переулок|б-р|бульвар|наб|набережная|ш|шоссе|пл|площадь)\.?\s/iu,
  /(?<![\p{L}])(?:д|дом)\.?\s?\d/iu,
  /(?<![\p{L}])(?:кв|квартира|оф|офис|пом|помещение)\.?\s?\d/iu,
  /(?<![\p{L}])(?:корп|корпус|стр|строение)\.?\s?\d/iu,
  /(?<![\p{L}])(?:обл|область|край|респ|республика)\b/iu,
  /\b(?:Street|St\.|Avenue|Ave\.?|Road|Rd\.?|Suite|Floor|Boulevard|Blvd\.?|Lane|Drive)\b/i,
];
/** Не менее двух компонентов адреса (индекс, город, улица, дом, квартира/офис, корпус, область, EN-слова). */
export function address(value) {
  const s = String(value);
  return ADDRESS_COMPONENTS.filter((re) => re.test(s)).length >= 2;
}

/** @type {Record<string, (value: string, ctx?: object) => boolean>} */
export const VALIDATORS = {
  inn,
  kpp,
  ogrn,
  bik,
  account,
  luhn,
  iban,
  mod97,
  swift,
  snils,
  passport,
  ssn,
  taxid,
  email,
  url,
  phone,
  birthdate,
  legalForm,
  address,
};

/** @param {string} name */
export function getValidator(name) {
  return VALIDATORS[name] || null;
}
