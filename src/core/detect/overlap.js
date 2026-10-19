// Разрешение пересечений кандидатов (FR-20). Ядро — не трогать без теста overlap.spec.
import { LEVEL_RANK } from '../categories.js';

/**
 * Сравнение «кто сильнее»: отрицательное число — a сильнее b.
 * 1) user; 2) уровень; 3) приоритет категории; 4) раньше начался; 5) длиннее.
 * @param {import('../contracts/entity.js').Entity} a
 * @param {import('../contracts/entity.js').Entity} b
 * @param {Map<string, {priority: number}>} catById
 */
export function compareStrength(a, b, catById) {
  const ua = a.source === 'user' ? 0 : 1;
  const ub = b.source === 'user' ? 0 : 1;
  if (ua !== ub) return ua - ub;
  const la = LEVEL_RANK[a.confidence] ?? 9;
  const lb = LEVEL_RANK[b.confidence] ?? 9;
  if (la !== lb) return la - lb;
  const pa = catById.get(a.category)?.priority ?? 999;
  const pb = catById.get(b.category)?.priority ?? 999;
  if (pa !== pb) return pa - pb;
  if (a.start !== b.start) return a.start - b.start;
  return b.end - b.start - (a.end - a.start);
}

/**
 * Оставляет непересекающиеся сущности; проигравший отбрасывается целиком (не обрезается).
 * Сущности разных потоков не пересекаются по определению.
 * Точные дубликаты (тот же поток, диапазон и категория) схлопываются в один.
 * @param {import('../contracts/entity.js').Entity[]} entities
 * @param {{byId: Map<string, {priority: number}>}} catalog
 * @returns {import('../contracts/entity.js').Entity[]} отсортированы по (streamId-порядку входа, start)
 */
export function resolveOverlaps(entities, catalog) {
  /** @type {Map<string, import('../contracts/entity.js').Entity[]>} */
  const byStream = new Map();
  for (const e of entities) {
    if (e.end <= e.start) continue;
    let arr = byStream.get(e.streamId);
    if (!arr) byStream.set(e.streamId, (arr = []));
    arr.push(e);
  }
  const out = [];
  for (const all of byStream.values()) {
    // Находка модели целиком внутри более длинной находки правил/KB/пользователя не вытесняет её (0.4, найдено корпусом жанров):
    // адрес без метки имеет уровень weak < ner, и обрывок «Новосибирск» от модели отбрасывал весь адрес «630002, г. Новосибирск,
    // ул. Советская, д. 77» — индекс и дом оставались открытыми. Правило сильнее по полноте: модель здесь лишь подтверждает часть.
    const list = all.filter(
      (e) => e.source !== 'ner' || !all.some((k) => k.source !== 'ner' && k.start <= e.start && e.end <= k.end && k.end - k.start > e.end - e.start),
    );
    const ranked = [...list].sort((a, b) => compareStrength(a, b, catalog.byId));
    const kept = [];
    for (const e of ranked) {
      if (kept.some((k) => e.start < k.end && k.start < e.end)) continue;
      kept.push(e);
    }
    kept.sort((a, b) => a.start - b.start);
    out.push(...kept);
  }
  return out;
}
