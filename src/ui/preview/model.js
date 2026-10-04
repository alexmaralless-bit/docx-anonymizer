// Модель превью (FR-30): состояние таблицы сущностей без DOM. Тестируется в Node.

/**
 * @typedef {object} Item
 * @property {string} id
 * @property {string} category
 * @property {string} value
 * @property {string} placeholder
 * @property {string} level
 * @property {string} source
 * @property {boolean} enabled
 * @property {string|null} edited          ручная замена пользователя (null — не менялась)
 * @property {Set<string>} excluded        id исключённых вхождений
 * @property {any[]} occurrences
 * @property {number} order                порядок в документе
 */

const key = (e) => `${e.category}\u0000${e.normalized ?? e.value}`;

/**
 * ENTITIES → элементы модели. Локальные правки (галочки, замены) переносятся по ключу
 * «категория + нормализованное значение», когда список пришёл заново (ADD_ENTITY).
 * @param {any[]} entities
 * @param {Item[]} [prev]
 * @returns {Item[]}
 */
export function toItems(entities, prev = []) {
  const old = new Map(prev.map((i) => [i._key, i]));
  return entities.map((e, order) => {
    const p = old.get(key(e));
    const serverReplacement = e.replacement && e.replacement !== e.placeholder ? e.replacement : null;
    const item = {
      id: e.id,
      _key: key(e),
      category: e.category,
      value: e.value,
      placeholder: e.placeholder,
      level: e.level,
      source: e.source,
      enabled: p ? p.enabled : e.enabled !== false,
      edited: p ? p.edited : serverReplacement,
      excluded: p ? new Set(p.excluded) : new Set(),
      occurrences: e.occurrences || [],
      order,
    };
    return item;
  });
}

/** Текст замены для показа в поле ввода. */
export function replacementText(item) {
  return item.edited ?? item.placeholder;
}

/** Установить ручную замену; пустая строка или исходный плейсхолдер = сброс. */
export function setReplacement(item, text) {
  const t = String(text ?? '').trim();
  item.edited = t === '' || t === item.placeholder ? null : t;
}

/**
 * Фильтр: категории (мультивыбор, пустое множество = все) и поиск по значению/замене.
 * @param {Item[]} items
 * @param {{categories?: Set<string>, query?: string}} f
 */
export function filterItems(items, f = {}) {
  const q = (f.query || '').trim().toLowerCase();
  const cats = f.categories && f.categories.size ? f.categories : null;
  return items.filter((i) => {
    if (cats && !cats.has(i.category)) return false;
    if (q && !i.value.toLowerCase().includes(q) && !replacementText(i).toLowerCase().includes(q)) return false;
    return true;
  });
}

/**
 * @param {Item[]} items
 * @param {'order'|'category'|'count'} by
 * @param {string[]} [categoryOrder] порядок категорий каталога
 */
export function sortItems(items, by = 'order', categoryOrder = []) {
  const a = [...items];
  const ci = (c) => {
    const i = categoryOrder.indexOf(c);
    return i < 0 ? 999 : i;
  };
  if (by === 'category') a.sort((x, y) => ci(x.category) - ci(y.category) || x.order - y.order);
  else if (by === 'count') a.sort((x, y) => y.occurrences.length - x.occurrences.length || x.order - y.order);
  else a.sort((x, y) => x.order - y.order);
  return a;
}

/** Массовые действия над видимыми элементами. */
export function setEnabled(items, enabled, pred = () => true) {
  for (const i of items) if (pred(i)) i.enabled = enabled;
}

export const isWeak = (i) => i.level === 'weak';

/** Счётчики «Найдено N, включено M». */
export function summary(items) {
  return { total: items.length, enabled: items.filter((i) => i.enabled).length };
}

/** Категории, реально присутствующие в списке, с числом сущностей — для чипов фильтра. */
export function categoryCounts(items) {
  const m = new Map();
  for (const i of items) m.set(i.category, (m.get(i.category) || 0) + 1);
  return m;
}

/** Число вхождений, которые будут заменены. */
export function plannedReplacements(items) {
  let n = 0;
  for (const i of items) if (i.enabled) n += i.occurrences.filter((o) => !i.excluded.has(o.id)).length;
  return n;
}

/**
 * Решения для APPLY (контракт Decision). Отправляем по всем группам: так сервер точно получает
 * и снятые галочки, и ручные замены, и исключённые вхождения.
 * @param {Item[]} items
 */
export function toDecisions(items) {
  return items.map((i) => {
    const d = { entityId: i.id, action: i.enabled ? 'replace' : 'skip' };
    if (i.edited) d.replacement = i.edited;
    if (i.excluded.size) d.excludedOccurrences = [...i.excluded];
    return d;
  });
}
