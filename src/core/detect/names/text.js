// Общие помощники WP2: токенизация «слов с заглавной» и инициалов, проверка лейблов.

/** Пробелы, допустимые внутри имени/названия (без переносов строк). */
export const SP = '[ \\u00A0]';
export const B = '(?<![\\p{L}\\p{N}])';
export const E = '(?![\\p{L}\\p{N}])';

export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @typedef {object} Token
 * @property {'W'|'I'} t     W — слово с заглавной (или целиком заглавными), I — инициал «П.»
 * @property {string} text   для I — только буква
 * @property {number} start
 * @property {number} end
 * @property {'cyr'|'lat'} script
 * @property {boolean} caps  слово целиком заглавными
 */

// латиница — с диакритикой («Wiśniewski», «Müller», «Dvořák») и с заглавной внутри после Mc/Mac/De/Van («McAllister»,
// «MacDonald», «DeLuca»; WP11-D, отложенный набор ревью)
const LU = '(?:(?=\\p{sc=Latin})\\p{Lu})';
const LL = '(?:(?=\\p{sc=Latin})\\p{Ll})';
const TOKEN_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:([А-ЯЁA-Z])\\.|([А-ЯЁ][а-яё]+(?:-(?:[А-ЯЁ]?[а-яё]+|[А-ЯЁ]+))*|[А-ЯЁ]{2,}(?:-[А-ЯЁ]{2,})*|` +
    `(?:Mc|Mac|Fitz|De|Di|Da|Le|La|Van)${LU}${LL}+|${LU}${LL}+(?:-(?:${LU}?${LL}+|${LU}+))*|${LU}'${LU}${LL}+|${LU}{2,}(?:-${LU}{2,})*)(?![\\p{L}\\p{N}]))`,
  'gu',
);
const LATIN_RE = /\p{sc=Latin}/u;

/**
 * @param {string} text
 * @returns {Token[]}
 */
export function tokenize(text) {
  const out = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const start = /** @type {number} */ (m.index);
    if (m[1]) {
      out.push({ t: 'I', text: m[1], start, end: start + 2, script: /[A-Z]/.test(m[1]) ? 'lat' : 'cyr', caps: true });
    } else {
      const w = m[2];
      const script = LATIN_RE.test(w) ? 'lat' : 'cyr';
      out.push({ t: 'W', text: w, start, end: start + w.length, script, caps: w.length > 1 && w === w.toUpperCase() });
    }
  }
  return out;
}

/** Промежуток между токенами: слово–слово — 1–2 пробела; с инициалом — 0–1 пробел (после слова — 1–2). */
export function gapOk(text, a, b) {
  const gap = text.slice(a.end, b.start);
  if (a.t === 'I' && b.t === 'I') return /^[ \u00A0]?$/.test(gap);
  if (a.t === 'I') return /^[ \u00A0]?$/.test(gap);
  return /^[ \u00A0]{1,2}$/.test(gap);
}

/**
 * Последовательность из n токенов одного алфавита с допустимыми промежутками.
 * @param {string} text
 * @param {Token[]} toks
 * @returns {Token[] | null}
 */
export function tokenSeq(text, toks, i, n) {
  if (i + n > toks.length) return null;
  const arr = toks.slice(i, i + n);
  for (let k = 1; k < n; k++) if (!gapOk(text, arr[k - 1], arr[k])) return null;
  if (arr.some((t) => t.script !== arr[0].script)) return null;
  return arr;
}

/**
 * Регэксп «лейбл перед кандидатом»: лейбл, затем только `:`, `№`, `#`, пробелы, табуляция, тире
 * и (необязательно) фраза `extra` (должность и т.п.). Проверяется на хвосте текста до кандидата.
 * @param {string[]} labels
 * @param {string} [extra] исходник регэкспа для фразы между лейблом и кандидатом
 */
export function labelBeforeRe(labels, extra = '') {
  const alt = [...new Set(labels.map((l) => l.trim().toLowerCase()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map((l) => {
      const src = escapeRe(l).replace(/ /g, '[ \\u00A0]+');
      // буквенный лейбл не может быть хвостом другого слова
      return /^[\p{L}]/u.test(l) ? `(?<![\\p{L}\\p{N}])${src}` : src;
    })
    .join('|');
  const tail = extra ? `(?:${extra}[ \\u00A0\\t]*)?` : '';
  return new RegExp(`(?:${alt})[ \\u00A0\\t:№#.\\-–—]*${tail}$`, 'iu');
}

/**
 * Есть ли лейбл в пределах `window` символов перед позицией `start`.
 * @param {string} text
 * @param {number} start
 * @param {RegExp} re из labelBeforeRe
 * @param {number} [window]
 */
export function hasLabelBefore(text, start, re, window = 40) {
  const before = text.slice(Math.max(0, start - window), start);
  return re.test(before);
}

/** Выбор непересекающихся спанов: длиннее и раньше — лучше; `pref` — дополнительный приоритет (больше — лучше). */
export function pickNonOverlapping(spans, pref = () => 0) {
  const sorted = [...spans].sort((a, b) => pref(b) - pref(a) || b.end - b.start - (a.end - a.start) || a.start - b.start);
  const kept = [];
  for (const s of sorted) if (!kept.some((k) => s.start < k.end && k.start < s.end)) kept.push(s);
  return kept.sort((a, b) => a.start - b.start);
}

export const overlaps = (a, b) => a.start < b.end && b.start < a.end;
