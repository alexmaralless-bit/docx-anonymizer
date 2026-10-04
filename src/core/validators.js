// WP1: валидаторы контрольных сумм и структуры (ТЗ §4.3, §9.1 validators.spec).
// Имена совпадают с полем `validator` каталога (core/categories.js):
//   inn, kpp, ogrn, bik, account, luhn, iban, swift, snils, passport, ssn, taxid, email, url, phone, birthdate, legalForm, address.
// Каждый — (value: string, ctx?: object) => boolean. Пользовательские категории переиспользуют
// inn / ogrn / snils / luhn / mod97 (FR-44).

/** @type {Record<string, (value: string, ctx?: object) => boolean>} */
export const VALIDATORS = {};

/** @param {string} name */
export function getValidator(name) {
  return VALIDATORS[name] || null;
}
