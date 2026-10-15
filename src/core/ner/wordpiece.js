// WordPiece-токенизатор BERT для локального NER (WP9, ТЗ §5.2 NLP): повторяет BertTokenizerFast (HF tokenizers) —
// нормализатор BertNormalizer (clean_text, handle_chinese_chars, strip_accents, lowercase), претокенизатор
// BertPreTokenizer (пробелы и пунктуация) и модель WordPiece (жадный longest-match, префикс «##», UNK).
// Офсеты слов — индексы исходной JS-строки (UTF-16), нормализация в них не участвует. Без сети и DOM (NFR-01).
// Эталон — tests/fixtures/ner/wordpiece-cases.json (tools/ner-train/make_tokenizer_fixture.py).

const CONTROL_RE = /\p{C}/u; // Cc, Cf, Cs, Co, Cn — «прочие» категории, как is_other() в tokenizers
const WHITESPACE_RE = /\p{White_Space}/u;
const PUNCT_RE = /\p{P}/u;
const MN_RE = /\p{Mn}/gu;

/** \t \n \r — пробелы; прочие управляющие (в т.ч. \v, \f, U+0085, U+200B) выбрасываются, слово они не разрывают. */
const isTabLike = (cp) => cp === 9 || cp === 10 || cp === 13;
/** Пунктуация BERT: весь ASCII-диапазон символов, не являющихся буквами/цифрами, плюс Unicode P*. */
const isAsciiPunct = (cp) => (cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126);
/** Иероглифы CJK (диапазоны из BERT _is_chinese_char): каждый — отдельное слово. */
const isCjk = (cp) =>
  (cp >= 0x4e00 && cp <= 0x9fff) ||
  (cp >= 0x3400 && cp <= 0x4dbf) ||
  (cp >= 0x20000 && cp <= 0x2a6df) ||
  (cp >= 0x2a700 && cp <= 0x2b73f) ||
  (cp >= 0x2b740 && cp <= 0x2b81f) ||
  (cp >= 0x2b820 && cp <= 0x2ceaf) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0x2f800 && cp <= 0x2fa1f);

/** Символ, который clean_text удаляет: NUL, U+FFFD и управляющие, кроме \t \n \r. */
const isDropped = (cp, ch) => cp === 0 || cp === 0xfffd || (!isTabLike(cp) && CONTROL_RE.test(ch));

/**
 * @typedef {object} Word
 * @property {string} text   срез исходной строки [start, end)
 * @property {number} start
 * @property {number} end
 */

/**
 * @param {{vocab: string, lowercase?: boolean, stripAccents?: boolean, unk?: string, cls?: string, sep?: string,
 *   pad?: string, maxWordChars?: number, prefix?: string, cacheSize?: number}} opts
 *   vocab — содержимое vocab.txt (токен на строку, id = номер строки)
 */
export function createWordPiece({
  vocab,
  lowercase = false,
  stripAccents = false,
  unk = '[UNK]',
  cls = '[CLS]',
  sep = '[SEP]',
  pad = '[PAD]',
  maxWordChars = 100,
  prefix = '##',
  cacheSize = 50000,
}) {
  /** @type {Map<string, number>} */
  const ids = new Map();
  let maxTokenChars = 1;
  const lines = vocab.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (let i = 0; i < lines.length; i++) {
    const tok = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
    if (!ids.has(tok)) ids.set(tok, i);
    const bare = tok.startsWith(prefix) ? tok.slice(prefix.length) : tok;
    const n = codePointLength(bare);
    if (n > maxTokenChars) maxTokenChars = n;
  }
  const special = (tok) => {
    const id = ids.get(tok);
    if (id === undefined) throw new Error(`В словаре нет спецтокена ${tok}`);
    return id;
  };
  const specials = Object.freeze({ cls: special(cls), sep: special(sep), pad: special(pad), unk: special(unk) });
  /** @type {Map<string, number[]>} */
  const cache = new Map();

  /** Нормализация слова как в BertNormalizer: без управляющих; NFD без Mn; нижний регистр. */
  function normalize(word) {
    let w = '';
    for (const ch of word) {
      const cp = /** @type {number} */ (ch.codePointAt(0));
      if (!isDropped(cp, ch)) w += ch;
    }
    if (stripAccents) w = w.normalize('NFD').replace(MN_RE, '');
    if (lowercase) w = w.toLowerCase();
    return w;
  }

  /** @param {string} word  слово из pretokenize (без пробелов) @returns {number[]} */
  function tokenizeWord(word) {
    const hit = cache.get(word);
    if (hit) return hit;
    const out = wordPiece(normalize(word));
    if (cache.size >= cacheSize) cache.clear();
    cache.set(word, out);
    return out;
  }

  /** Жадный longest-match-first; любой неразобранный остаток делает всё слово UNK (как в BERT). */
  function wordPiece(w) {
    if (!w) return [];
    const chars = Array.from(w);
    if (chars.length > maxWordChars) return [specials.unk];
    /** @type {number[]} */
    const out = [];
    let start = 0;
    while (start < chars.length) {
      let end = Math.min(chars.length, start + maxTokenChars);
      let found = -1;
      while (end > start) {
        const sub = (start > 0 ? prefix : '') + chars.slice(start, end).join('');
        const id = ids.get(sub);
        if (id !== undefined) {
          found = id;
          break;
        }
        end--;
      }
      if (found < 0) return [specials.unk];
      out.push(found);
      start = end;
    }
    return out;
  }

  /**
   * BERT basic tokenizer: пробелы разделяют, пунктуация и иероглифы — отдельные слова, управляющие символы выброшены
   * (внутри слова не разрывают его). Офсеты — в исходной строке.
   * @param {string} text @returns {Word[]}
   */
  function pretokenize(text) {
    /** @type {Word[]} */
    const words = [];
    let start = -1;
    let end = -1;
    const flush = () => {
      if (start >= 0) words.push({ start, end, text: text.slice(start, end) });
      start = -1;
    };
    for (let i = 0; i < text.length;) {
      const cp = /** @type {number} */ (text.codePointAt(i));
      const len = cp > 0xffff ? 2 : 1;
      const ch = len === 2 ? text.slice(i, i + 2) : text[i];
      if (isTabLike(cp)) flush();
      else if (isDropped(cp, ch)) {
        // прозрачен: слово не начинает и не заканчивает
      } else if (WHITESPACE_RE.test(ch)) flush();
      else if (isAsciiPunct(cp) || PUNCT_RE.test(ch) || isCjk(cp)) {
        flush();
        words.push({ start: i, end: i + len, text: ch });
      } else {
        if (start < 0) start = i;
        end = i + len;
      }
      i += len;
    }
    flush();
    return words;
  }

  return {
    pretokenize,
    tokenizeWord,
    /** @param {Word[]} words @returns {number[][]} */
    encodeWords: (words) => words.map((w) => tokenizeWord(w.text)),
    /** @param {string} token @returns {number | undefined} */
    idOf: (token) => ids.get(token),
    specials,
    size: lines.length,
  };
}

function codePointLength(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0xd800 || c > 0xdbff) n++;
  }
  return n;
}
