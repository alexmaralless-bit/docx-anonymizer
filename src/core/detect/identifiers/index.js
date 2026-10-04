// WP1: детекторы идентификаторов (INN, KPP, OGRN, BIK, ACCOUNT, CARD, IBAN, SWIFT, SNILS,
// PASSPORT, SSN, TAXID, EMAIL, PHONE, URL, BIRTHDATE, CONTRACT, AMOUNT) — ТЗ §4.3, контракт — docs/contracts.md §2.
// Потоковые детекторы по одному на категорию; плюс документный детектор счетов: ключ по БИК из соседнего потока.
import {
  detectInn,
  detectKpp,
  detectOgrn,
  detectBik,
  detectAccount,
  detectAccountByBikInDocument,
  detectCard,
  detectIban,
  detectSwift,
  detectSnils,
  detectSsn,
  detectTaxId,
} from './numeric.js';
import { detectEmail, detectUrl, detectPhone } from './contact.js';
import { detectPassport, detectBirthdate, detectContract, detectAmount } from './docs.js';

/** Потоковые детекторы по категориям (экспорт — для модульных тестов). */
export const IDENTIFIER_DETECTORS = Object.freeze({
  INN: detectInn,
  KPP: detectKpp,
  OGRN: detectOgrn,
  BIK: detectBik,
  ACCOUNT: detectAccount,
  CARD: detectCard,
  IBAN: detectIban,
  SWIFT: detectSwift,
  SNILS: detectSnils,
  PASSPORT: detectPassport,
  SSN: detectSsn,
  TAXID: detectTaxId,
  EMAIL: detectEmail,
  PHONE: detectPhone,
  URL: detectUrl,
  BIRTHDATE: detectBirthdate,
  CONTRACT: detectContract,
  AMOUNT: detectAmount,
});

/** @param {{registerDetector: Function, registerDocumentDetector: Function}} api */
export function register(api) {
  for (const [category, fn] of Object.entries(IDENTIFIER_DETECTORS)) api.registerDetector(category, fn, { name: `id-${category.toLowerCase()}` });
  api.registerDocumentDetector('id-account-bik', detectAccountByBikInDocument);
}
