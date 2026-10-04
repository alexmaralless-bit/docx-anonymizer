// Транслитерация RU → EN: ГОСТ 7.79-2000 (система Б) и ИКАО (Doc 9303, загранпаспорта РФ с 2014 г.),
// плюс «скелет» — грубый фонетический ключ для сопоставления написаний в разных алфавитах
// («Ромашка-Трейд» ↔ «Romashka-Trade» ↔ «Romashka-Trejd»).

// prettier-ignore
const GOST_B = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'j', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'x', ц: 'cz', ч: 'ch', ш: 'sh', щ: 'shh', ъ: '``', ы: "y'", ь: '`', э: "e'",
  ю: 'yu', я: 'ya',
};

// prettier-ignore
const ICAO = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: 'ie', ы: 'y', ь: '', э: 'e',
  ю: 'iu', я: 'ia',
};

function apply(text, table, special) {
  let out = '';
  const chars = [...text];
  chars.forEach((ch, i) => {
    const low = ch.toLowerCase();
    let t = special ? special(low, chars[i + 1]) : undefined;
    if (t === undefined) t = table[low];
    if (t === undefined) {
      out += ch;
      return;
    }
    if (ch !== low && t) {
      const nextUpper = chars[i + 1] && chars[i + 1] !== chars[i + 1].toLowerCase();
      t = nextUpper || chars.length === 1 ? t.toUpperCase() : t[0].toUpperCase() + t.slice(1);
    }
    out += t;
  });
  return out;
}

/** ГОСТ 7.79-2000, система Б: «ц» → «c» перед i, e, y, j, иначе «cz». */
export function translitGostB(text) {
  return apply(text, GOST_B, (low, next) => {
    if (low !== 'ц') return undefined;
    const n = (next || '').toLowerCase();
    return n && 'иеый'.includes(n) ? 'c' : 'cz';
  });
}

/** ИКАО Doc 9303. */
export function translitIcao(text) {
  return apply(text, ICAO);
}

const HAS_CYR = /[а-яё]/i;
export const isCyrillic = (s) => HAS_CYR.test(s);

/**
 * Фонетический «скелет»: латиница без гласных, диграфы свёрнуты, двойные согласные схлопнуты.
 * Одинаков для «Трейд», «Trejd», «Treid», «Trade»; для «Вектор» и «Vector».
 * @param {string} text
 */
export function skeleton(text) {
  let t = translitIcao(text.toLowerCase());
  t = t
    .replace(/shch|shh|sch/g, 'Щ')
    .replace(/sh/g, 'Ш')
    .replace(/ch/g, 'Ч')
    .replace(/zh/g, 'Ж')
    .replace(/kh/g, 'Х')
    .replace(/ts|tz|cz/g, 'Ц')
    .replace(/ck/g, 'k')
    .replace(/ph/g, 'f')
    .replace(/x/g, 'ks')
    .replace(/[cq]/g, 'k')
    .replace(/w/g, 'v')
    .replace(/[aeiouyjh'`ʹ"]/g, '')
    .replace(/[\s\u00A0]+/g, ' ')
    .replace(/(.)\1+/g, '$1');
  return t.trim();
}

/**
 * Скелеты латинского написания: обычный и с «x» как «х» (ГОСТ 7.79 Б пишет «х» как «x»).
 * @param {string} text
 * @returns {string[]}
 */
export function latinSkeletons(text) {
  const a = skeleton(text);
  const b = /x/i.test(text) ? skeleton(text.replace(/x/g, 'kh').replace(/X/g, 'Kh')) : a;
  return a === b ? [a] : [a, b];
}

/** Число «согласных» в скелете (без разделителей) — порог против случайных совпадений. */
export function skeletonWeight(sk) {
  return sk.replace(/[\s-]/g, '').length;
}

/**
 * Одно и то же название в разных алфавитах? Скелеты совпадают и длины латинских написаний близки
 * («Вектор» ≠ «Viktoriya», хотя скелет у обоих «vktr»).
 * @param {string} a
 * @param {string} b
 */
export function crossScriptMatch(a, b) {
  const sa = isCyrillic(a) ? [skeleton(a)] : latinSkeletons(a);
  const sb = isCyrillic(b) ? [skeleton(b)] : latinSkeletons(b);
  if (!sa.some((x) => sb.includes(x) && skeletonWeight(x) >= 3)) return false;
  const la = translitIcao(a).length;
  const lb = translitIcao(b).length;
  return Math.abs(la - lb) <= Math.max(2, Math.round(Math.max(la, lb) * 0.2));
}
