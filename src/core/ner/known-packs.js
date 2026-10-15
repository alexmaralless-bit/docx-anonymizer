// Известные (опубликованные в GitHub Releases проекта) пакеты модели NER (WP8). Пакет, чей SHA-256 архива есть в списке,
// помечается «проверен»; остальные устанавливаются только после подтверждения пользователя. Список пополняет WP9
// при публикации релиза модели (sha256 печатает `npm run pack:model`).

/** @type {ReadonlyArray<{id: string, version: string, sha256: string}>} */
export const KNOWN_PACKS = Object.freeze([]);

/**
 * @param {string} sha256  SHA-256 всего zip-файла пакета (hex)
 * @returns {{id: string, version: string, sha256: string} | null}
 */
export function findKnownPack(sha256) {
  return KNOWN_PACKS.find((p) => p.sha256 === sha256) || null;
}
