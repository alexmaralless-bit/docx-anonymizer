// Общие средства детекторов идентификаторов: лейблы (§4.3) и границы цифровых идентификаторов.
//
// Лейбл — слово/фраза в пределах 40 символов перед кандидатом (в той же строке потока), после которой допускаются
// `:`, `№`, `#`, пробелы, табуляция («strict»). «lenient» — между лейблом и кандидатом допустимы 1–3 слова без цифр
// («ИНН Покупателя 5004001234»). Лейблы берутся из каталога (`category.labels`) плюс локальные дополнения.
import { buildCatalog } from '../../categories.js';

/** Окно просмотра перед кандидатом (символов). */
export const LABEL_WINDOW = 40;

/** Не внутри слова/числа и не продолжение «цифры-разделителя» (12-7736050003, 1.7736050003). */
export const NB = '(?<![\\p{L}\\p{N}])(?<!\\d[-./])';
/** Не продолжается буквой/цифрой и не «цифра-разделитель-цифра» (7736050003-1, 7736050003.5). */
export const NA = '(?![\\p{L}\\p{N}])(?![-.,]\\d)';

/** Дополнительные лейблы (данные каталога менять не нужно). */
const EXTRA_LABELS = {
  INN: {
    ru: ['идентификационный номер налогоплательщика', 'инн/кпп', 'инн / кпп'],
    en: ['inn/kpp', 'tax identification number', 'taxpayer identification number'],
  },
  KPP: { ru: [], en: [] },
  OGRN: { ru: ['огрн/огрнип', 'основной государственный регистрационный номер'], en: ['ogrnip'] },
  ACCOUNT: {
    ru: [
      'р/сч',
      'р/с',
      'расч. счет',
      'расч. счёт',
      'расчётный счёт №',
      'л/с',
      'лицевой счет',
      'лицевой счёт',
      'счет получателя',
      'счёт получателя',
      'номер счета',
      'номер счёта',
      'счёт',
      'счет',
    ],
    en: ['account number', 'account #', 'bank account', 'a/c', 'acct'],
  },
  BIK: { ru: ['бик банка'], en: [] },
  CARD: { ru: ['банковская карта', 'карта №', 'номер банковской карты', 'pan'], en: ['card number', 'credit card', 'debit card', 'pan'] },
  IBAN: { ru: [], en: ['iban no.', 'iban number'] },
  SWIFT: { ru: ['свифт'], en: ['swift/bic', 'bic/swift', 'swift bic'] },
  SNILS: { ru: ['страховое свидетельство', 'снилс №'], en: [] },
  PASSPORT: { ru: ['паспорт №', 'серия и номер', 'серии', 'загранпаспорт', 'паспорт гражданина рф'], en: ['passport number', 'passport #'] },
  SSN: { ru: [], en: ['ssn #', 'social security no.'] },
  TAXID: { ru: ['vat no.'], en: ['vat no.', 'vat number', 'vat id', 'tax number', 'tax identification'] },
  PHONE: {
    ru: ['тел', 'тел./факс', 'т/ф', 'моб', 'контактный телефон', 'номер телефона', 'whatsapp', 'viber', 'telegram'],
    en: ['telephone', 'cell', 'whatsapp', 'tel.', 'phone no.', 'phone number', 'mob'],
  },
  BIRTHDATE: {
    ru: ['д/р', 'дата рожд.', 'рожд.', 'день рождения'],
    en: ['birth date', 'birthday', 'birth', 'born'],
  },
};

/** Категории, чьи лейблы участвуют в разрешении «чей это лейбл» (CONTRACT/AMOUNT — нет). */
const LABEL_CATEGORIES = ['PASSPORT', 'SNILS', 'INN', 'OGRN', 'ACCOUNT', 'CARD', 'IBAN', 'SWIFT', 'BIK', 'KPP', 'SSN', 'TAXID', 'PHONE', 'BIRTHDATE'];

const GAP = '[ \\t\\u00a0:–—-]*(?:(?:№|#|N[oо]\\.?)[ \\t\\u00a0:]*)?';
const FILLER = '(?:[ \\t\\u00a0]+[\\p{L}.«»"\'()-]+){1,3}';

const labelSrc = (l) =>
  l
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/[её]/gi, '[её]')
    .replace(/\\\./g, '\\.?')
    .replace(/\s+/g, '[ \\t\\u00a0]+');

/** @type {WeakMap<object, {cat: string, strict: RegExp, lenient: RegExp}[]>} */
const cache = new WeakMap();
let defaultCatalog = null;

function compile(catalog) {
  const out = [];
  for (const id of LABEL_CATEGORIES) {
    const cat = catalog.byId.get(id);
    if (!cat) continue;
    const extra = EXTRA_LABELS[id] || { ru: [], en: [] };
    const all = [...new Set([...(cat.labels?.ru || []), ...(cat.labels?.en || []), ...extra.ru, ...extra.en])].filter(Boolean);
    if (!all.length) continue;
    all.sort((a, b) => b.length - a.length);
    const alt = all.map(labelSrc).join('|');
    const head = `(?<![\\p{L}\\p{N}])(?:${alt})`;
    out.push({ cat: id, strict: new RegExp(`${head}${GAP}$`, 'iu'), lenient: new RegExp(`${head}${FILLER}${GAP}$`, 'iu') });
  }
  return out;
}

function compiled(catalog) {
  const c = catalog || (defaultCatalog ||= buildCatalog({}));
  let v = cache.get(c);
  if (!v) cache.set(c, (v = compile(c)));
  return v;
}

/**
 * Какие категории имеют лейбл прямо перед позицией `start` (в пределах 40 символов, в той же строке).
 * @param {string} text
 * @param {number} start
 * @param {{catalog?: any}} [ctx]
 * @returns {Map<string, 'strict'|'lenient'>}
 */
export function labelHits(text, start, ctx = {}) {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const w = text.slice(Math.max(lineStart, start - LABEL_WINDOW), start);
  const hits = new Map();
  if (!w) return hits;
  for (const c of compiled(ctx.catalog)) {
    if (c.strict.test(w)) hits.set(c.cat, 'strict');
    else if (c.lenient.test(w)) hits.set(c.cat, 'lenient');
  }
  return hits;
}

/**
 * Состояние лейблов для кандидата категории `own`: `mine` — свой лейбл есть; `foreign` — прямо перед кандидатом
 * стоит (strict) лейбл ДРУГОЙ категории, а своего нет (кандидат без лейбла в таком случае не берём).
 */
export function labelState(text, start, ctx, own) {
  const hits = labelHits(text, start, ctx);
  const mine = hits.get(own) || null;
  let foreign = false;
  if (!mine) for (const [c, k] of hits) if (c !== own && k === 'strict') foreign = true;
  return { mine, foreign };
}

/** Кандидаты по регулярке (с флагом g) → [{start, end, text, groups}]. */
export function* scan(text, re) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m[0] === '') {
      re.lastIndex++;
      continue;
    }
    yield { start: m.index, end: m.index + m[0].length, text: m[0], m };
  }
}

/**
 * Коды товаров (WP11-D, корпус жанров: код ТН ВЭД «8471300000» проходит контрольную сумму ИНН, EAN-13 — ОГРН). Группа
 * ключевых слов задаёт длины кода, которые подавляются: ТН ВЭД и HS — 10 цифр, штрихкод/EAN/GTIN — 8, 13, 14 (12-значный
 * UPC совпал бы с ИНН физлица — при сомнении ИНН маскируется), артикул/SKU/«код товара» — любая длина. ОКПД2 и ОКВЭД
 * пишутся с точками и с ИНН не путаются — не подавляют ничего.
 */
const SP = '[ \\t\\u00a0]';
// before — ключевое слово сразу перед числом: между ними только «:», «№», «#», тире и, может быть, предыдущие коды списка
// («Код ТН ВЭД 8471300000 8528521000»); слово или «.»/«;» между ними обрывают контекст («Арт. 15. Получатель …»)
const GOODS_KEYWORDS = [
  { lengths: new Set([10]), src: `тн${SP}*вэд(?:${SP}*еаэс)?|hs(?:${SP}*-?${SP}*code)?|commodity${SP}+code` },
  { lengths: new Set([8, 13, 14]), src: 'штрих-?код\\p{L}*|баркод\\p{L}*|ean(?:-?(?:8|13))?|gtin|barcode' },
  {
    lengths: null,
    src: `артикул\\p{L}*|арт\\.|sku|код\\p{L}*${SP}+(?:товар|продукци|издели|номенклатур)\\p{L}*|номенклатурн\\p{L}*${SP}+номер\\p{L}*|part${SP}+(?:no\\.?|number)|item${SP}+code`,
  },
].map((g) => ({
  lengths: g.lengths,
  before: new RegExp(`(?<![\\p{L}\\p{N}])(?:${g.src})${SP}*(?:[:№#—–-]${SP}*)*(?:[A-Za-z]*\\d[\\w-]*${SP}*,?${SP}+)*$`, 'iu'),
  word: new RegExp(`(?<![\\p{L}\\p{N}])(?:${g.src})(?![\\p{L}])`, 'giu'),
}));
/** Служебные слова заголовка столбца вокруг ключевого слова: «Код ТН ВЭД», «Номер артикула», «HS code». */
const HEADER_FILLER_RE = /(?<![\p{L}])(?:код|кода|номер|номера|code|no|number|№)(?![\p{L}])/giu;

/**
 * Число длины `len` стоит в контексте кода товара: ключевое слово сразу перед ним (окно 40 символов той же строки) или
 * заголовок столбца (`ctx.stream.columnHeader`, раннер) — только код товара, без других слов («Код ТН ВЭД», «Артикул»;
 * не «ИНН / ОКВЭД», не «Артикул/Получатель»). Детектор ИНН/ОГРН без своего лейбла такое число не берёт; при сомнении
 * (другое слово между ключевым и числом, смешанный заголовок, длина не кода) — берёт: лучше замаскировать код, чем
 * открыть ИНН (решение владельца 1).
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @param {{stream?: {columnHeader?: string}}} [ctx]
 */
export function goodsCodeContext(text, start, end, ctx = {}) {
  const len = text.slice(start, end).replace(/\D/g, '').length;
  const fits = (g) => !g.lengths || g.lengths.has(len);
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const left = text.slice(Math.max(lineStart, start - LABEL_WINDOW), start);
  if (GOODS_KEYWORDS.some((g) => fits(g) && g.before.test(left))) return true;
  const header = ctx?.stream?.columnHeader;
  if (!header) return false;
  const hits = GOODS_KEYWORDS.filter((g) => {
    g.word.lastIndex = 0;
    return g.word.test(header);
  });
  if (!hits.length || !hits.every(fits)) return false;
  let rest = header;
  for (const g of GOODS_KEYWORDS) rest = rest.replace(g.word, ' ');
  return !/\p{L}/u.test(rest.replace(HEADER_FILLER_RE, ' '));
}
