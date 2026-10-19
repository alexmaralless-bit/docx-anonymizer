// КОНТРАКТ: модель сущностей. Подробности — docs/contracts.md §1.
// Два уровня:
//   Entity      — одно найденное место (span) в одном потоке, координаты virtualText;
//   EntityGroup — «значение» (одно нормализованное значение → один плейсхолдер), список вхождений.

/** @typedef {import('../categories.js').Level} Level */

/** Источник кандидата. `list` — список компаний для маскирования (0.4, WP11-A): маскируется и при выключенной COMPANY. */
export const SOURCES = Object.freeze(['rule', 'label', 'kb', 'user', 'ner', 'list']);

/** Уровни уверенности по убыванию (FR-20). */
export const LEVELS = Object.freeze(['validated', 'labeled', 'kb', 'ner', 'weak']);

/**
 * Кандидат, который возвращает детектор. Ядро дополняет его до Entity.
 * @typedef {object} Candidate
 * @property {number} start            начало в virtualText потока (включительно)
 * @property {number} end              конец (исключительно)
 * @property {Level} confidence        уровень уверенности
 * @property {'rule'|'label'|'kb'|'user'|'ner'|'list'} [source='rule']
 * @property {string} [validator]      имя пройденного валидатора ('inn', 'luhn', …)
 * @property {string} [category]       только для document-детекторов; потоковые получают категорию из регистрации
 * @property {string} [streamId]       только для document-детекторов
 * @property {number} [keepPrefix=0]   сколько символов в начале сохраняется вне плейсхолдера (ОПФ и кавычки: «ООО «»)
 * @property {number} [keepSuffix=0]   сколько символов в конце сохраняется («»»)
 * @property {string} [canonical]      нормализованное значение «главной» сущности, если это её вариант (KB: склонения, инициалы)
 * @property {string} [subtype]        'author' и т.п.
 * @property {number} [score]          0–1, для NER
 */

/**
 * Найденное место (span). Координаты — в virtualText потока `streamId`.
 * @typedef {object} Entity
 * @property {string} id
 * @property {string} category         'PERSON' | 'INN' | … | 'custom:<slug>'
 * @property {string} text             исходный фрагмент virtualText[start..end)
 * @property {string} normalized       normalizeValue(category, text) — или canonical для вариантов
 * @property {number} start
 * @property {number} end
 * @property {string} streamId
 * @property {'rule'|'label'|'kb'|'user'|'ner'} source
 * @property {Level} confidence
 * @property {string} [validator]
 * @property {boolean} enabled
 * @property {string} [placeholder]    назначается при группировке
 * @property {number} keepPrefix
 * @property {number} keepSuffix
 * @property {string} [canonical]
 * @property {string} [subtype]
 * @property {number} [score]
 */

/**
 * Вхождение значения (элемент EntityGroup.occurrences).
 * @typedef {object} Occurrence
 * @property {string} id               'o17'
 * @property {string} streamId
 * @property {string} part
 * @property {string|null} pid
 * @property {string} stream           тип потока: live/deleted/field/attr/meta
 * @property {number} start
 * @property {number} end
 * @property {string} text
 * @property {number} keepPrefix
 * @property {number} keepSuffix
 * @property {'rule'|'label'|'kb'|'user'|'ner'} source
 * @property {Level} confidence
 * @property {string} [variantOf]      original группы, если текст вхождения отличается
 */

/**
 * Значение: всё, что получает один плейсхолдер. Это то, что видит пользователь в таблице
 * и что уходит в ENTITIES (§5.4) и в applyDecisions.
 * @typedef {object} EntityGroup
 * @property {string} id               'e1' — стабилен в пределах сессии документа
 * @property {string} category
 * @property {string} value            исходное значение (основная форма)
 * @property {string} normalized
 * @property {string} placeholder      токен '[ФИО_1]' (без обёртки ОПФ)
 * @property {Level} level             лучший уровень среди вхождений
 * @property {'rule'|'label'|'kb'|'user'|'ner'} source
 * @property {string|null} validated   имя валидатора или null
 * @property {boolean} enabled         решение пользователя: заменять или нет
 * @property {string} [replacement]    ручная замена пользователя (FR-26) — побеждает режим
 * @property {string[]} [excludedOccurrences]  id вхождений, которые не заменять
 * @property {Occurrence[]} occurrences
 */

/**
 * Решение пользователя по группе (поле APPLY.decisions[] протокола §5.4).
 * @typedef {object} Decision
 * @property {string} entityId
 * @property {'replace'|'skip'} action
 * @property {string} [replacement]
 * @property {string[]} [excludedOccurrences]
 */

/**
 * Накладывает решения на группы (новые объекты, исходные не меняются).
 * Группы без решения остаются как есть.
 * @param {EntityGroup[]} groups
 * @param {Decision[]} [decisions]
 * @returns {EntityGroup[]}
 */
export function mergeDecisions(groups, decisions = []) {
  const byId = new Map(decisions.map((d) => [d.entityId, d]));
  return groups.map((g) => {
    const d = byId.get(g.id);
    if (!d) return g;
    return {
      ...g,
      enabled: d.action !== 'skip',
      replacement: d.replacement != null && d.replacement !== '' ? d.replacement : g.replacement,
      excludedOccurrences: d.excludedOccurrences || g.excludedOccurrences || [],
    };
  });
}
