// Правила и проверка пользовательских категорий (FR-44, FR-45). Чистый JS: используется и ядром, и страницей настроек.

export const REGEX_MAX_LEN = 500;
export const KINDS = Object.freeze(['dictionary', 'labeled', 'pattern']);
export const SHAPES = Object.freeze(['digits', 'letters', 'alnum', 'any']);
export const CUSTOM_VALIDATORS = Object.freeze(['none', 'luhn', 'mod97', 'inn', 'ogrn', 'snils']);
export const PREFIX_RE = /^[\p{L}\p{N}_]{1,24}$/u;
const DICT_MAX = 5000;

/**
 * Проверка регулярного выражения без выполнения на тексте: длина, флаги, lookbehind, компиляция, пустое совпадение.
 * @param {string} regex
 * @param {string} flags
 * @returns {{ok: true} | {ok: false, code: 'EMPTY'|'TOO_LONG'|'BAD_FLAGS'|'LOOKBEHIND'|'SYNTAX'|'MATCHES_EMPTY', message?: string}}
 */
export function checkRegexSource(regex, flags = '') {
  if (typeof regex !== 'string' || !regex) return { ok: false, code: 'EMPTY' };
  if (regex.length > REGEX_MAX_LEN) return { ok: false, code: 'TOO_LONG' };
  if (typeof flags !== 'string' || !/^[iu]*$/.test(flags) || new Set(flags).size !== flags.length) return { ok: false, code: 'BAD_FLAGS' };
  if (hasLookbehind(regex)) return { ok: false, code: 'LOOKBEHIND' };
  let re;
  try {
    re = new RegExp(regex, flags);
  } catch (err) {
    return { ok: false, code: 'SYNTAX', message: String(err.message || err) };
  }
  if (re.test('')) return { ok: false, code: 'MATCHES_EMPTY' };
  return { ok: true };
}

/** Ищет `(?<=` / `(?<!` вне экранирования и вне классов символов. */
export function hasLookbehind(src) {
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === '(' && src[i + 1] === '?' && src[i + 2] === '<' && (src[i + 3] === '=' || src[i + 3] === '!')) return true;
  }
  return false;
}

/**
 * Структурная проверка CustomCategory. Возвращает список проблем `{field, code}` (пусто — всё хорошо).
 * @param {any} cc
 * @returns {{field: string, code: string}[]}
 */
export function validateCustomCategory(cc) {
  const errs = [];
  const bad = (field, code = 'INVALID') => errs.push({ field, code });
  if (!cc || typeof cc !== 'object' || Array.isArray(cc)) return [{ field: 'category', code: 'INVALID' }];
  if (typeof cc.id !== 'string' || !/^custom:[a-z0-9_-]{1,40}$/.test(cc.id)) bad('id');
  const name = cc.label?.ru;
  if (typeof name !== 'string' || !name.trim() || name.length > 60) bad('label.ru', 'REQUIRED');
  if (cc.label?.en !== undefined && (typeof cc.label.en !== 'string' || cc.label.en.length > 60)) bad('label.en');
  if (!PREFIX_RE.test(cc.placeholderPrefix?.ru ?? '')) bad('placeholderPrefix.ru', 'PREFIX');
  if (!PREFIX_RE.test(cc.placeholderPrefix?.en ?? '')) bad('placeholderPrefix.en', 'PREFIX');
  if (typeof cc.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(cc.color)) bad('color');
  if (cc.enabled !== undefined && typeof cc.enabled !== 'boolean') bad('enabled');
  if (cc.priority !== 'belowBuiltin' && cc.priority !== 'aboveBuiltin') bad('priority');
  if (!KINDS.includes(cc.kind)) {
    bad('kind');
    return errs;
  }
  const vOk = (v) => v === undefined || CUSTOM_VALIDATORS.includes(v);
  if (cc.kind === 'dictionary') {
    const d = cc.dictionary;
    const vals = d?.values;
    if (!Array.isArray(vals) || !vals.length || vals.length > DICT_MAX || !vals.every((v) => typeof v === 'string' && v.trim() && v.length <= 200))
      bad('dictionary.values', 'DICT');
    if (typeof d?.caseSensitive !== 'boolean') bad('dictionary.caseSensitive');
    if (typeof d?.wholeWord !== 'boolean') bad('dictionary.wholeWord');
  } else if (cc.kind === 'labeled') {
    const l = cc.labeled;
    const list = (a) => Array.isArray(a) && a.every((x) => typeof x === 'string' && x.trim() && x.length <= 80);
    if (!list(l?.labels?.ru ?? []) || !list(l?.labels?.en ?? [])) bad('labeled.labels');
    else if (!(l.labels.ru?.length || l.labels.en?.length)) bad('labeled.labels', 'REQUIRED');
    if (!SHAPES.includes(l?.shape)) bad('labeled.shape');
    const inRange = (n) => Number.isInteger(n) && n >= 1 && n <= 64;
    if (!inRange(l?.minLen)) bad('labeled.minLen');
    if (!inRange(l?.maxLen)) bad('labeled.maxLen');
    else if (inRange(l?.minLen) && l.minLen > l.maxLen) bad('labeled.maxLen', 'RANGE');
    if (!vOk(l?.validator)) bad('labeled.validator');
  } else {
    const p = cc.pattern;
    const r = checkRegexSource(p?.regex, p?.flags ?? '');
    if (!r.ok) bad('pattern.regex', r.code);
    if (!vOk(p?.validator)) bad('pattern.validator');
    if (p?.labels !== undefined) {
      const list = (a) => Array.isArray(a) && a.every((x) => typeof x === 'string' && x.trim() && x.length <= 80);
      if (!list(p.labels?.ru ?? []) || !list(p.labels?.en ?? [])) bad('pattern.labels');
    }
  }
  return errs;
}
