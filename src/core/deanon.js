// Обратная замена в тексте ответа LLM (FR-36, FR-37).

/**
 * @param {string} text
 * @param {import('./mapping.js').Mapping} mapping
 * @returns {{text: string, unresolved: {text: string, start: number, end: number}[], replaced: number}}
 *   unresolved — конструкции вида [ПРЕФИКС_n], которых нет в маппинге (позиции — в результирующем тексте)
 */
export function deanonymize(text, mapping) {
  /** @type {Map<string, string>} ключ: «префикс_номер» в нижнем регистре, префикс с '_' вместо пробелов/дефисов */
  const table = new Map();
  const prefixes = new Set();
  for (const e of mapping?.entries || []) {
    const m = /^\[(.+)_(\d+)\]$/u.exec(e.token || '');
    if (!m) continue; // режимы mask/delete не восстанавливаются
    const prefix = m[1].toLowerCase();
    prefixes.add(prefix);
    table.set(`${prefix}_${m[2]}`, e.value ?? e.original);
  }
  const unresolved = [];
  let replaced = 0;

  // Известные префиксы: [ФИО_1], ФИО_1, ФИО 1, ФИО-1, [фио_1] — внутри любых обёрток Markdown
  let out = text;
  if (prefixes.size) {
    const alt = [...prefixes]
      .sort((a, b) => b.length - a.length)
      .map((p) => p.split(/_/).map(escapeRe).join('[ _\\-]'))
      .join('|');
    // [ ФИО_1 ] — пробелы допустимы только внутри скобок; без скобок — ФИО_1 / ФИО 1 / ФИО-1
    const re = new RegExp(`\\[\\s*(${alt})[ _\\-](\\d+)\\s*\\]|(?<![\\p{L}\\p{N}])(${alt})[ _\\-](\\d+)(?![\\p{N}])`, 'giu');
    out = text.replace(re, (m, p1, n1, p2, n2) => {
      const p = p1 ?? p2;
      const n = n1 ?? n2;
      const v = table.get(`${p.toLowerCase().replace(/[ -]/g, '_')}_${n}`);
      if (v === undefined) return m;
      replaced++;
      return v;
    });
  }
  // Нераспознанные [ЧТО-ТО_n]
  const re2 = /\[([\p{L}][\p{L}_ -]*?)[ _-](\d+)\]/gu;
  let m;
  while ((m = re2.exec(out))) unresolved.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return { text: out, unresolved, replaced };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
