// ЕДИНСТВЕННЫЙ каталог встроенных категорий (FR-17). Только данные — реализации детекторов
// регистрируются отдельно через registerDetector (src/core/contracts/detector.js).
// Порядок массива = приоритет категорий FR-20 (выше в списке — важнее).

/**
 * @typedef {'validated'|'labeled'|'kb'|'ner'|'weak'} Level
 * @typedef {'text'|'lower'|'alnum'|'alnumUpper'} NormalizeKind
 * @typedef {'pii'|'ids'|'commercial'} CategoryGroup
 *
 * @typedef {object} CategoryDef
 * @property {string} id                     'PERSON' | … | 'custom:<slug>'
 * @property {{ru: string, en: string}} label
 * @property {{ru: string, en: string}} placeholderPrefix   без скобок и номера: 'ФИО' → [ФИО_1]
 * @property {string} color                  цвет метки в UI
 * @property {boolean} defaultOn
 * @property {CategoryGroup} group        группа политики 0.4: 'pii' и 'ids' маскируются всегда, 'commercial' — по переключателю `commercial`
 * @property {Level[]} allowedLevels         кандидаты других уровней отбрасываются ядром
 * @property {{ru: string[], en: string[]}} labels  лейблы-подсказки для детекторов
 * @property {string|null} validator         имя валидатора в core/validators.js (WP1)
 * @property {number} priority               меньше = важнее (FR-20 шаг 3)
 * @property {boolean} builtin
 * @property {NormalizeKind} normalize       правило нормализации значения (FR-25)
 * @property {boolean} [numeric]             маска/режимы для числовых идентификаторов
 */

const L = (ru, en) => ({ ru, en });

/** @type {Omit<CategoryDef, 'priority'|'builtin'>[]} */
const BUILTIN = [
  {
    id: 'PASSPORT',
    group: 'pii',
    label: L('Паспорт', 'Passport'),
    placeholderPrefix: L('ПАСПОРТ', 'PASSPORT'),
    color: '#c0392b',
    defaultOn: true,
    allowedLevels: ['labeled'],
    validator: 'passport',
    normalize: 'alnumUpper',
    numeric: true,
    labels: L(['паспорт', 'серия', 'выдан', 'код подразделения'], ['passport', 'passport no.', 'issued by']),
  },
  {
    id: 'SNILS',
    group: 'pii',
    label: L('СНИЛС', 'SNILS'),
    placeholderPrefix: L('СНИЛС', 'SNILS'),
    color: '#d35400',
    defaultOn: true,
    allowedLevels: ['validated', 'labeled'],
    validator: 'snils',
    normalize: 'alnum',
    numeric: true,
    labels: L(['снилс'], ['snils']),
  },
  {
    id: 'INN',
    group: 'ids',
    label: L('ИНН', 'INN'),
    placeholderPrefix: L('ИНН', 'INN'),
    color: '#e67e22',
    defaultOn: true,
    allowedLevels: ['validated', 'labeled'],
    validator: 'inn',
    normalize: 'alnum',
    numeric: true,
    labels: L(['инн'], ['inn', 'taxpayer id']),
  },
  {
    id: 'OGRN',
    group: 'ids',
    label: L('ОГРН / ОГРНИП', 'OGRN'),
    placeholderPrefix: L('ОГРН', 'OGRN'),
    color: '#f39c12',
    defaultOn: true,
    allowedLevels: ['validated', 'labeled'],
    validator: 'ogrn',
    normalize: 'alnum',
    numeric: true,
    labels: L(['огрн', 'огрнип'], ['ogrn', 'psrn']),
  },
  {
    id: 'ACCOUNT',
    group: 'ids',
    label: L('Банковский счёт', 'Bank account'),
    placeholderPrefix: L('СЧЕТ', 'ACCOUNT'),
    color: '#16a085',
    defaultOn: true,
    allowedLevels: ['validated', 'labeled'],
    validator: 'account',
    normalize: 'alnum',
    numeric: true,
    labels: L(
      ['р/с', 'расчётный счёт', 'расчетный счет', 'к/с', 'корр. счёт', 'корр. счет', 'корреспондентский счёт', 'счёт №', 'счет №'],
      ['account no.', 'acc.', 'account'],
    ),
  },
  {
    id: 'CARD',
    group: 'pii',
    label: L('Банковская карта', 'Card'),
    placeholderPrefix: L('КАРТА', 'CARD'),
    color: '#1abc9c',
    defaultOn: true,
    allowedLevels: ['validated', 'labeled'],
    validator: 'luhn',
    normalize: 'alnum',
    numeric: true,
    labels: L(['карта', 'номер карты'], ['card', 'card no.']),
  },
  {
    id: 'IBAN',
    group: 'ids',
    label: L('IBAN', 'IBAN'),
    placeholderPrefix: L('IBAN', 'IBAN'),
    color: '#27ae60',
    defaultOn: true,
    allowedLevels: ['validated', 'labeled'],
    validator: 'iban',
    normalize: 'alnumUpper',
    numeric: true,
    labels: L(['iban'], ['iban']),
  },
  {
    id: 'SWIFT',
    group: 'ids',
    label: L('SWIFT', 'SWIFT'),
    placeholderPrefix: L('SWIFT', 'SWIFT'),
    color: '#2ecc71',
    defaultOn: true,
    allowedLevels: ['labeled'],
    validator: 'swift',
    normalize: 'alnumUpper',
    numeric: true,
    labels: L(['swift', 'swift-код', 'bic'], ['swift', 'bic', 'swift code']),
  },
  {
    id: 'BIK',
    group: 'ids',
    label: L('БИК', 'BIK'),
    placeholderPrefix: L('БИК', 'BIK'),
    color: '#2980b9',
    defaultOn: true,
    allowedLevels: ['labeled', 'validated'],
    validator: 'bik',
    normalize: 'alnum',
    numeric: true,
    labels: L(['бик'], ['bic', 'bik']),
  },
  {
    id: 'KPP',
    group: 'ids',
    label: L('КПП', 'KPP'),
    placeholderPrefix: L('КПП', 'KPP'),
    color: '#3498db',
    defaultOn: true,
    allowedLevels: ['labeled'],
    validator: 'kpp',
    normalize: 'alnumUpper',
    numeric: true,
    labels: L(['кпп'], ['kpp']),
  },
  {
    id: 'SSN',
    group: 'pii',
    label: L('SSN', 'SSN'),
    placeholderPrefix: L('SSN', 'SSN'),
    color: '#8e44ad',
    defaultOn: true,
    allowedLevels: ['validated', 'labeled'],
    validator: 'ssn',
    normalize: 'alnum',
    numeric: true,
    labels: L(['ssn', 'social security'], ['ssn', 'social security', 'social security number']),
  },
  {
    id: 'TAXID',
    group: 'ids',
    label: L('Налоговый ID (иностр.)', 'Tax ID'),
    placeholderPrefix: L('НАЛОГ_ID', 'TAXID'),
    color: '#9b59b6',
    defaultOn: true,
    allowedLevels: ['labeled'],
    validator: 'taxid',
    normalize: 'alnumUpper',
    numeric: true,
    labels: L(['ein', 'tax id', 'vat', 'utr', 'tin'], ['ein', 'tax id', 'vat', 'utr', 'tin']),
  },
  {
    id: 'EMAIL',
    group: 'pii',
    label: L('Эл. почта', 'Email'),
    placeholderPrefix: L('EMAIL', 'EMAIL'),
    color: '#2c3e50',
    defaultOn: true,
    allowedLevels: ['validated'],
    validator: 'email',
    normalize: 'lower',
    labels: L([], []),
  },
  {
    id: 'URL',
    group: 'ids',
    label: L('Ссылка', 'URL'),
    placeholderPrefix: L('URL', 'URL'),
    color: '#34495e',
    defaultOn: true,
    allowedLevels: ['validated'],
    validator: 'url',
    normalize: 'lower',
    labels: L([], []),
  },
  {
    id: 'PHONE',
    group: 'pii',
    label: L('Телефон', 'Phone'),
    placeholderPrefix: L('ТЕЛ', 'PHONE'),
    color: '#7f8c8d',
    defaultOn: true,
    allowedLevels: ['validated', 'labeled'],
    validator: 'phone',
    normalize: 'alnum',
    numeric: true,
    labels: L(['тел.', 'телефон', 'факс', 'моб.'], ['tel', 'phone', 'fax', 'mobile']),
  },
  {
    id: 'BIRTHDATE',
    group: 'pii',
    label: L('Дата рождения', 'Date of birth'),
    placeholderPrefix: L('ДАТА_РОЖД', 'DOB'),
    color: '#e84393',
    defaultOn: true,
    allowedLevels: ['labeled'],
    validator: 'birthdate',
    normalize: 'text',
    labels: L(['дата рождения', 'д.р.', 'родился', 'родилась', 'г.р.'], ['date of birth', 'dob', 'born on']),
  },
  {
    id: 'PERSON',
    group: 'pii',
    label: L('ФИО', 'Person'),
    placeholderPrefix: L('ФИО', 'PERSON'),
    color: '#d63031',
    defaultOn: true,
    allowedLevels: ['validated', 'labeled', 'ner', 'kb'],
    validator: null,
    normalize: 'lower',
    labels: L(['в лице', 'генеральный директор', 'фио', 'на имя', 'исполнитель:', 'подпись'], ['represented by', 'name:', 'attn:', 'signed by']),
  },
  {
    id: 'COMPANY',
    group: 'commercial',
    label: L('Организация', 'Company'),
    placeholderPrefix: L('КОМПАНИЯ', 'COMPANY'),
    color: '#0984e3',
    defaultOn: true,
    allowedLevels: ['labeled', 'ner', 'kb'],
    validator: 'legalForm',
    normalize: 'lower',
    labels: L(['поставщик:', 'покупатель:', 'именуемое в дальнейшем', 'банк получателя'], ['supplier:', 'buyer:', 'hereinafter', 'beneficiary bank']),
  },
  {
    id: 'ADDRESS',
    group: 'pii',
    label: L('Адрес', 'Address'),
    placeholderPrefix: L('АДРЕС', 'ADDRESS'),
    color: '#00b894',
    defaultOn: true,
    allowedLevels: ['labeled', 'ner', 'weak'],
    validator: 'address',
    normalize: 'lower',
    labels: L(['адрес', 'юридический адрес', 'место нахождения', 'зарегистрирован по адресу'], ['address', 'registered office', 'located at']),
  },
  {
    id: 'CONTRACT',
    group: 'commercial',
    label: L('Номер договора', 'Contract No.'),
    placeholderPrefix: L('ДОГОВОР', 'CONTRACT'),
    color: '#636e72',
    defaultOn: false,
    allowedLevels: ['labeled'],
    validator: null,
    normalize: 'alnumUpper',
    labels: L(['договор №', 'контракт №', 'соглашение №'], ['agreement no.', 'contract no.']),
  },
  {
    id: 'AMOUNT',
    group: 'commercial',
    label: L('Сумма', 'Amount'),
    placeholderPrefix: L('СУММА', 'AMOUNT'),
    color: '#b2bec3',
    defaultOn: false,
    allowedLevels: ['labeled', 'weak'],
    validator: null,
    normalize: 'text',
    labels: L(['цена', 'стоимость', 'сумма'], ['price', 'amount', 'fee']),
  },
];

/** @type {readonly CategoryDef[]} */
export const BUILTIN_CATEGORIES = Object.freeze(BUILTIN.map((c, i) => Object.freeze({ ...c, priority: i + 1, builtin: true })));

export const BUILTIN_IDS = Object.freeze(BUILTIN_CATEGORIES.map((c) => c.id));

/**
 * Группы политики маскирования (версия 0.4, `docs/concept-0.4.md` п. 1): состав и порядок показа в настройках.
 * `pii` (персональные данные) и `ids` (идентификаторы компаний) маскируются безусловно — переключателей у них нет;
 * `commercial` (названия организаций, номера договоров, суммы) включается одним переключателем `settings.commercial`
 * (по умолчанию выключен), внутри действуют прежние переключатели `settings.categories[id]`.
 * @type {Readonly<Record<CategoryGroup, readonly string[]>>}
 */
export const CATEGORY_GROUPS = Object.freeze({
  pii: Object.freeze(BUILTIN_CATEGORIES.filter((c) => c.group === 'pii').map((c) => c.id)),
  ids: Object.freeze(BUILTIN_CATEGORIES.filter((c) => c.group === 'ids').map((c) => c.id)),
  commercial: Object.freeze(BUILTIN_CATEGORIES.filter((c) => c.group === 'commercial').map((c) => c.id)),
});

/** Категории, которые нельзя выключить (группы `pii` и `ids`). */
export const ALWAYS_ON_IDS = Object.freeze([...CATEGORY_GROUPS.pii, ...CATEGORY_GROUPS.ids]);

/** Уровни уверенности по убыванию (FR-20 шаг 2). */
export const LEVEL_RANK = Object.freeze({ validated: 0, labeled: 1, kb: 2, ner: 3, weak: 4 });

/**
 * Эффективный каталог = встроенные + пользовательские категории (FR-17, FR-44).
 * Пользовательские: priority 'aboveBuiltin' → 0 (выше всех), иначе после всех встроенных.
 * @param {{customCategories?: any[]}} [settings]
 * @returns {{list: CategoryDef[], byId: Map<string, CategoryDef>}}
 */
export function buildCatalog(settings = {}) {
  const list = [...BUILTIN_CATEGORIES];
  const n = BUILTIN_CATEGORIES.length;
  (settings.customCategories || []).forEach((cc, i) => {
    if (!cc || !cc.id) return;
    list.push(
      Object.freeze({
        id: cc.id,
        label: { ru: cc.label?.ru || cc.id, en: cc.label?.en || cc.label?.ru || cc.id },
        placeholderPrefix: { ru: cc.placeholderPrefix?.ru || 'ПРОЧЕЕ', en: cc.placeholderPrefix?.en || 'OTHER' },
        color: cc.color || '#8e44ad',
        defaultOn: cc.enabled !== false,
        allowedLevels: ['validated', 'labeled', 'kb', 'weak'],
        labels: { ru: cc.labeled?.labels?.ru || [], en: cc.labeled?.labels?.en || [] },
        validator: cc.pattern?.validator && cc.pattern.validator !== 'none' ? cc.pattern.validator : null,
        priority: cc.priority === 'aboveBuiltin' ? 0 : n + 1 + i,
        builtin: false,
        normalize: 'lower',
        custom: cc,
      }),
    );
  });
  return { list, byId: new Map(list.map((c) => [c.id, c])) };
}

/**
 * Включена ли категория с учётом настроек (политика 0.4, Ц1/К1):
 * группы `pii` и `ids` — всегда; `commercial` — только при `settings.commercial === true`, дальше
 * `settings.categories[id] ?? defaultOn`; пользовательские — поле enabled.
 */
export function isCategoryEnabled(cat, settings = {}) {
  if (!cat.builtin) return cat.defaultOn;
  if (cat.group === 'pii' || cat.group === 'ids') return true;
  if (cat.group === 'commercial' && settings.commercial !== true) return false;
  const v = settings.categories?.[cat.id];
  return typeof v === 'boolean' ? v : cat.defaultOn;
}

/**
 * Нормализация значения для склейки «одно значение → один плейсхолдер» (FR-25).
 * @param {CategoryDef|undefined} cat
 * @param {string} text
 */
export function normalizeValue(cat, text) {
  const base = text.replace(/\s+/g, ' ').trim();
  switch (cat?.normalize) {
    case 'lower':
      return base.toLowerCase().replace(/ё/g, 'е');
    case 'alnum':
      return base.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
    case 'alnumUpper':
      return base.replace(/[^\p{L}\p{N}]/gu, '').toUpperCase();
    default:
      return base;
  }
}
