// WP2: PERSON / COMPANY / ADDRESS по лейблам и шаблонам + база знаний сторон (FR-21–FR-24):
// морфология падежей, инициалы, транслитерация. Контракт — docs/contracts.md §2.
//
// ADDRESS — потоковый детектор (адрес не зависит от остального документа).
// PERSON и COMPANY — документный детектор 'kb' (см. kb.js: правило и база знаний работают в одном
// проходе, чтобы все формы одного лица/компании получили общий canonical и один плейсхолдер).
import { detectAddress } from './address.js';
import { detectNamesAndKb } from './kb.js';

export { findPersons } from './person.js';
export { findCompanies } from './company.js';
export { findAddresses } from './address.js';
export { detectNamesAndKb, findPartyZones } from './kb.js';

/** @param {{registerDetector: Function, registerDocumentDetector: Function}} api */
export function register(api) {
  api.registerDetector('ADDRESS', detectAddress, { name: 'address' });
  api.registerDocumentDetector('kb', detectNamesAndKb);
}
