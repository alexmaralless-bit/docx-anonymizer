// Известные (опубликованные в GitHub Releases проекта) пакеты модели NER (WP8). Пакет, чей SHA-256 архива есть в списке,
// помечается «проверен»; остальные устанавливаются только после подтверждения пользователя. Список пополняет WP9
// при публикации релиза модели (sha256 печатает `npm run pack:model`).

/** @type {ReadonlyArray<{id: string, version: string, sha256: string}>} */
export const KNOWN_PACKS = Object.freeze([
  // WP9: RuBERT-tiny2 NER (ru/en), int8; docx-anonymizer-ner-rubert-tiny2-ner-ruen-1.0.0.zip, 29 517 760 байт
  Object.freeze({ id: 'rubert-tiny2-ner-ruen', version: '1.0.0', sha256: 'ca023f16799f08b1b1d6134fae242461bda6ab79dfe74e34eda1ec6c9a48318f' }),
  // WP11-C (версия 0.4): тот же id, переобучение на жанрах; docx-anonymizer-ner-rubert-tiny2-ner-ruen-1.1.0.zip, 29 541 797 байт.
  // 1.0.0 остаётся в списке: импортированный ранее пакет 1.0.0 по-прежнему «проверен», а полный архив 0.4 ставит 1.1.0 поверх (К9)
  Object.freeze({ id: 'rubert-tiny2-ner-ruen', version: '1.1.0', sha256: '5616d089ed34cb2e299bb1f8af0adb5863e29fa8e8784b37197694f30deea0b8' }),
]);

/**
 * @param {string} sha256  SHA-256 всего zip-файла пакета (hex)
 * @returns {{id: string, version: string, sha256: string} | null}
 */
export function findKnownPack(sha256) {
  return KNOWN_PACKS.find((p) => p.sha256 === sha256) || null;
}
