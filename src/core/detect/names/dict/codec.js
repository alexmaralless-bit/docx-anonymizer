// Компактная упаковка словарей ФИО (WP7, FR-23): front-coding отсортированного списка.
// Строка = символ режима ('R' — русские слова, 'L' — латиница) + строки через '\n';
// строка = String.fromCharCode(48 + длина общего префикса с предыдущим словом) + суффикс.
// Кириллица биективно отображается в ASCII (а..я → a..z, A..F; '-' → 'G'), поэтому модуль словаря —
// чистый ASCII без экранирования (template literal без '`', '\\' и '${').

const CYR = 'абвгдежзийклмнопрстуфхцчшщъыьэюя';
const ASC = 'abcdefghijklmnopqrstuvwxyzABCDEF';
const TO_ASC = new Map([...CYR].map((c, i) => [c, ASC[i]]).concat([['-', 'G']]));
const TO_CYR = new Map([...TO_ASC].map(([c, a]) => [a, c]));
/** Префикс длиннее не кодируется (символ остаётся в диапазоне '0'..'X'). */
const MAX_PREFIX = 40;

const RU_WORD = /^[а-я]+(?:-[а-я]+)*$/;
const LAT_WORD = /^[a-z]+(?:-[a-z]+)*$/;

/**
 * @param {string[]} words слова в нижнем регистре: только [а-я-] (без «ё») или только [a-z-]
 * @returns {string}
 */
export function encodeList(words) {
  const list = [...new Set(words)].sort();
  const ru = list.some((w) => /[а-я]/.test(w));
  for (const w of list) {
    if (!(ru ? RU_WORD : LAT_WORD).test(w)) throw new Error(`encodeList: недопустимое слово (${w.length} симв.)`);
  }
  const lines = [];
  let prev = '';
  for (const w of list) {
    let p = 0;
    const max = Math.min(prev.length, w.length, MAX_PREFIX);
    while (p < max && prev[p] === w[p]) p++;
    const suffix = w.slice(p);
    lines.push(String.fromCharCode(48 + p) + (ru ? [...suffix].map((c) => TO_ASC.get(c)).join('') : suffix));
    prev = w;
  }
  return (ru ? 'R' : 'L') + lines.join('\n');
}

/**
 * @param {string} s результат encodeList
 * @returns {string[]} слова в порядке сортировки
 */
export function decodeList(s) {
  const ru = s[0] === 'R';
  const body = s.slice(1);
  if (!body) return [];
  const out = [];
  let prev = '';
  for (const line of body.split('\n')) {
    const p = line.charCodeAt(0) - 48;
    let suffix = line.slice(1);
    if (ru) {
      let t = '';
      for (const c of suffix) t += TO_CYR.get(c);
      suffix = t;
    }
    prev = prev.slice(0, p) + suffix;
    out.push(prev);
  }
  return out;
}
