// Разрешение пересечений кандидатов (FR-20). Ядро — не трогать без теста overlap.spec.
import { LEVEL_RANK, normalizeValue } from '../categories.js';
import { isRoleNoun } from './names/lexicon.js';

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
    const list = mergePersons(all, catalog).filter(
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

/**
 * PERSON правил и PERSON модели, которые пересекаются, но модель выходит за правило («Ван Тхань» ⊂ «Нгуен Ван Тхань»,
 * «Сотрудник Кирилл» ∩ «Кирилл Ахмедов»), — одно лицо: спан — объединение, уровень и источник — правила (WP11-D, Ц1:
 * иначе правило вытесняло модель, и «Нгуен», «Ахмедов» оставались открытыми). Профессия в начале объединения
 * («Сотрудник ») — в keepPrefix. Если модель пересекает два лица правил — не объединяется (два человека, не один).
 * @param {import('../contracts/entity.js').Entity[]} all  сущности одного потока
 * @param {{byId: Map<string, any>}} catalog
 */
function mergePersons(all, catalog) {
  const models = all.filter((e) => e.category === 'PERSON' && e.source === 'ner');
  if (!models.length) return all;
  const drop = new Set();
  const replace = new Map();
  for (const m of models) {
    const rules = all.filter((k) => k.category === 'PERSON' && k.source !== 'ner' && k.start < m.end && m.start < k.end);
    if (rules.length !== 1) continue;
    const k = replace.get(rules[0]) || rules[0];
    if (m.start >= k.start && m.end <= k.end) continue; // модель внутри правила — правило и так шире
    const start = Math.min(k.start, m.start);
    const end = Math.max(k.end, m.end);
    const text = textOfUnion(k, m, start, end);
    if (text === null) continue;
    let keepPrefix = start === k.start ? k.keepPrefix || 0 : 0;
    const keepSuffix = end === k.end ? k.keepSuffix || 0 : 0;
    const lead = /^(\p{L}+)[ \u00A0]+/u.exec(text.slice(keepPrefix));
    if (lead && isRoleNoun(lead[1])) keepPrefix += lead[0].length;
    const core = text.slice(keepPrefix, text.length - keepSuffix);
    const cat = catalog.byId.get('PERSON');
    replace.set(rules[0], {
      ...k,
      start,
      end,
      text,
      keepPrefix,
      keepSuffix,
      normalized: k.canonical ? k.normalized : cat ? normalizeValue(cat, core) : core.toLowerCase(),
    });
    drop.add(m);
  }
  if (!replace.size) return all;
  return all.filter((e) => !drop.has(e)).map((e) => replace.get(e) || e);
}

/** Текст объединения двух пересекающихся спанов по их текстам (позиции — в одном потоке); null — тексты не согласованы. */
function textOfUnion(a, b, start, end) {
  const buf = new Array(end - start).fill(null);
  for (const x of [a, b]) {
    if (typeof x.text !== 'string' || x.text.length !== x.end - x.start) return null;
    for (let i = 0; i < x.text.length; i++) {
      const j = x.start - start + i;
      if (buf[j] !== null && buf[j] !== x.text[i]) return null;
      buf[j] = x.text[i];
    }
  }
  return buf.some((c) => c === null) ? null : buf.join('');
}
