// Маппинг «плейсхолдер → значение» (FR-27, FR-28). Никогда не пишется в storage (FR-29).
import { BUILTIN_IDS } from './categories.js';

export const MAPPING_SCHEMA_VERSION = 1;
export const TOOL_NAME = 'DOCX Anonymizer';

/**
 * Запись маппинга. Поля сверх ТЗ: `token` (то, что реально стоит в тексте, без обёртки ОПФ)
 * и `value` (значение, на которое deanonymize заменяет token).
 * @typedef {object} MappingEntry
 * @property {string} placeholder   полная форма как в документе: 'ООО «[КОМПАНИЯ_1]»'
 * @property {string} token         '[КОМПАНИЯ_1]' (в режимах mask/delete — фактический текст замены)
 * @property {string} category
 * @property {string} original      исходное значение основной формы с обёрткой: 'ООО «Ромашка»'
 * @property {string} value         исходное значение без обёртки: 'Ромашка'
 * @property {string[]} variants
 * @property {number} occurrences
 * @property {string} source
 * @property {string[]} parts
 */

/**
 * @typedef {object} Mapping
 * @property {number} schemaVersion
 * @property {string} createdAt
 * @property {{name: string, version: string}} tool
 * @property {'placeholder'|'mask'|'delete'} mode
 * @property {string} language
 * @property {{name: string, sha256?: string, resultName?: string}[]} documents
 * @property {MappingEntry[]} entries
 */

/**
 * @param {{groups: import('./contracts/entity.js').EntityGroup[], applied: Map<string, {token: string, occurrences: number, parts: Set<string>, firstForm?: string}>,
 *          mode: string, language: string, documents: object[], createdAt?: string, toolVersion?: string}} input
 * @returns {Mapping}
 */
export function buildMapping(input) {
  const entries = [];
  for (const g of input.groups) {
    const a = input.applied.get(g.id);
    if (!a) continue;
    const baseOcc = g.occurrences.find((o) => !o.variantOf) || g.occurrences[0];
    const original = baseOcc.text.slice(0, baseOcc.keepPrefix) + g.value + baseOcc.text.slice(baseOcc.text.length - baseOcc.keepSuffix);
    const placeholder = a.firstForm || baseOcc.text.slice(0, baseOcc.keepPrefix) + a.token + baseOcc.text.slice(baseOcc.text.length - baseOcc.keepSuffix);
    const variants = [...new Set(g.occurrences.map((o) => o.text).filter((t) => t !== original))];
    entries.push({
      placeholder,
      token: a.token,
      category: g.category,
      original,
      value: g.value,
      variants,
      occurrences: a.occurrences,
      source: g.source,
      parts: [...a.parts],
    });
  }
  const catOrder = (c) => {
    const i = BUILTIN_IDS.indexOf(c);
    return i < 0 ? 1000 : i;
  };
  const num = (t) => {
    const m = /_(\d+)\]$/.exec(t);
    return m ? Number(m[1]) : 0;
  };
  entries.sort((a, b) => catOrder(a.category) - catOrder(b.category) || a.category.localeCompare(b.category) || num(a.token) - num(b.token));
  return {
    schemaVersion: MAPPING_SCHEMA_VERSION,
    createdAt: input.createdAt || new Date().toISOString(),
    tool: { name: TOOL_NAME, version: input.toolVersion || '0.1.0' },
    mode: /** @type {any} */ (input.mode),
    language: input.language,
    documents: /** @type {any} */ (input.documents),
    entries,
  };
}

/**
 * Склеивает маппинги нескольких файлов одной отправки (сквозная нумерация уже обеспечена
 * общим PlaceholderAllocator; здесь только объединение записей).
 * @param {Mapping[]} list
 * @returns {Mapping}
 */
export function mergeMappings(list) {
  if (!list.length) throw new Error('Пустой список маппингов');
  const byToken = new Map();
  for (const m of list) {
    for (const e of m.entries) {
      const key = `${e.category}\u0000${e.token}\u0000${e.value}`;
      const prev = byToken.get(key);
      if (!prev) byToken.set(key, { ...e, variants: [...e.variants], parts: [...e.parts] });
      else {
        prev.occurrences += e.occurrences;
        prev.variants = [...new Set([...prev.variants, ...e.variants])];
        prev.parts = [...new Set([...prev.parts, ...e.parts])];
      }
    }
  }
  return { ...list[0], documents: list.flatMap((m) => m.documents), entries: [...byToken.values()] };
}
