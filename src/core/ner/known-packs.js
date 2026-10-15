// Известные (опубликованные в GitHub Releases проекта) пакеты модели NER (WP8). Пакет, чей SHA-256 архива есть в списке,
// помечается «проверен»; остальные устанавливаются только после подтверждения пользователя. Список пополняет WP9
// при публикации релиза модели (sha256 печатает `npm run pack:model`).

/** @type {ReadonlyArray<{id: string, version: string, sha256: string}>} */
export const KNOWN_PACKS = Object.freeze([
  // WP9: RuBERT-tiny2 NER (ru/en), int8; docx-anonymizer-ner-rubert-tiny2-ner-ruen-1.0.0.zip, 29 490 436 байт
  Object.freeze({ id: 'rubert-tiny2-ner-ruen', version: '1.0.0', sha256: 'c4541a38e37a86a446199d27062efb117ca3048c551267f71e0f937dfaede691' }),
]);

/**
 * @param {string} sha256  SHA-256 всего zip-файла пакета (hex)
 * @returns {{id: string, version: string, sha256: string} | null}
 */
export function findKnownPack(sha256) {
  return KNOWN_PACKS.find((p) => p.sha256 === sha256) || null;
}
