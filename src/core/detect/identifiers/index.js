// WP1: детекторы идентификаторов (INN, KPP, OGRN, BIK, ACCOUNT, CARD, IBAN, SWIFT, SNILS,
// PASSPORT, SSN, TAXID, EMAIL, PHONE, URL, BIRTHDATE, CONTRACT, AMOUNT).
// Контракт — docs/contracts.md §2. Сейчас здесь только ВРЕМЕННЫЙ детектор EMAIL
// для проверки конвейера; WP1 заменяет его настоящим.

/** @param {{registerDetector: typeof import('../../contracts/detector.js').registerDetector}} api */
export function register(api) {
  api.registerDetector('EMAIL', dummyEmail, { name: 'dummy-email' });
}

/** @type {import('../../contracts/detector.js').DetectFn} */
function dummyEmail(text) {
  const out = [];
  const re = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
  let m;
  while ((m = re.exec(text))) out.push({ start: m.index, end: m.index + m[0].length, confidence: 'validated', validator: 'email' });
  return out;
}
