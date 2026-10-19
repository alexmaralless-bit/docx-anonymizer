// Окна для NER-модели (WP9, ТЗ §5.2 NLP): поток режется на окна из целых слов по `maxLen` субтокенов
// ([CLS] … [SEP]) с перекрытием `stride` слов — сущность на границе окна видна целиком хотя бы в одном окне.

/**
 * @typedef {object} NerWindow
 * @property {number} wordFrom          первое слово окна (индекс в массиве слов)
 * @property {number} wordTo            за последним словом окна (не включительно)
 * @property {number[]} ids             [CLS] субтокены слов [SEP]; длина ≤ maxLen
 * @property {number[]} wordStartIndex  для слова wordFrom + k — индекс его первого субтокена в ids (−1 — у слова нет субтокенов)
 */

/**
 * @param {number[][]} wordIds  субтокены каждого слова (wordpiece.encodeWords)
 * @param {{maxLen: number, stride: number, cls: number, sep: number}} opts
 *   слово длиннее maxLen − 2 субтокенов усекается до maxLen − 2 (метка берётся по первому субтокену, хвост не нужен)
 * @returns {NerWindow[]}
 */
export function makeWindows(wordIds, { maxLen, stride, cls, sep }) {
  const budget = maxLen - 2;
  if (!(budget >= 1)) throw new Error('maxLen слишком мал');
  const n = wordIds.length;
  const lens = wordIds.map((w) => Math.min(w.length, budget));
  /** @type {NerWindow[]} */
  const out = [];
  let from = 0;
  while (from < n) {
    let to = from;
    let used = 0;
    while (to < n && used + lens[to] <= budget) used += lens[to++];
    const ids = [cls];
    const wordStartIndex = [];
    for (let k = from; k < to; k++) {
      wordStartIndex.push(lens[k] ? ids.length : -1);
      for (let j = 0; j < lens[k]; j++) ids.push(wordIds[k][j]);
    }
    ids.push(sep);
    out.push({ wordFrom: from, wordTo: to, ids, wordStartIndex });
    if (to >= n) break;
    // следующее окно начинается за stride слов до конца текущего, но всегда продвигается хотя бы на слово
    from = Math.max(from + 1, to - stride);
  }
  return out;
}

/** Сокращения, после точки которых предложение не кончается («г. Омск», «ул. Мира», «Acme Inc. Group»). */
const ABBR = new Set(
  'г|гг|ул|пр|просп|пер|д|кв|корп|стр|обл|р-н|им|тел|см|ст|т|п|пп|ч|рис|табл|руб|коп|тыс|млн|млрд|др|проф|акад|inc|ltd|corp|co|mr|mrs|ms|dr|prof|st|no|vs|jr|sr|e.g|i.e'
    .split('|')
    .map((s) => s.toLowerCase()),
);
const END_RE = /^[.!?…]+$/u;
const OPENERS_RE = /^[«„“"'([]$/u;
const UPPER_START_RE = /^\p{Lu}/u;
const INITIAL_RE = /^\p{Lu}$/u;
const BREAK_RE = /[\n\r\u2028\u2029\uFFFC]/u;

/**
 * Границы предложений по словам pretokenize (опция провайдера splitSentences, WP9): после «.», «!», «?», «…», за
 * которыми идёт слово с заглавной буквы (или открывающая кавычка/скобка перед ним), и на переносе строки. После
 * точки однобуквенного инициала («Т.Е. Ходенковым») и сокращения («г. Омск») граница не ставится. Каждое предложение
 * режется на окна отдельно: модель обучена на предложениях, а склейка «… Антонина. Груз …» тянет PER через точку.
 * @param {{start: number, end: number, text: string}[]} words
 * @param {string} text
 * @param {{minWords?: number}} [opts]  предложение короче minWords слов с буквами идёт вместе со следующим
 * @returns {[number, number][]}  [from, to) по индексам слов, покрывают все слова подряд
 */
export function sentenceRanges(words, text, { minWords = MIN_SENTENCE_WORDS } = {}) {
  /** @type {[number, number][]} */
  const out = [];
  let from = 0;
  for (let i = 1; i < words.length; i++) {
    // короткий обрывок («Добрый день!», «Приложение 1.») идёт вместе со следующим предложением: без контекста
    // модель путает типы; перенос строки — граница всегда
    if (isBoundary(words, text, i) && (letterWords(words, from, i) >= minWords || hardBreak(words, text, i))) {
      out.push([from, i]);
      from = i;
    }
  }
  if (words.length) out.push([from, words.length]);
  return out;
}

/** Предложение короче стольких слов с буквами склеивается со следующим. */
const MIN_SENTENCE_WORDS = 4;
const LETTER_RE = /\p{L}/u;
const letterWords = (words, from, to) => {
  let n = 0;
  for (let k = from; k < to; k++) if (LETTER_RE.test(words[k].text)) n++;
  return n;
};
const hardBreak = (words, text, i) => BREAK_RE.test(text.slice(words[i - 1].end, words[i].start));

/** Начинается ли новое предложение со слова i. */
function isBoundary(words, text, i) {
  const prev = words[i - 1];
  if (hardBreak(words, text, i)) return true;
  if (!END_RE.test(prev.text) || i < 2) return false;
  // «.» вплотную за словом; «Т.» и «г.» — не конец
  const before = words[i - 2];
  if (prev.text === '.' && before.end === prev.start && (INITIAL_RE.test(before.text) || ABBR.has(before.text.toLowerCase()))) return false;
  // за знаком — пробел и слово с заглавной (возможно, после открывающей кавычки или скобки)
  if (words[i].start === prev.end) return false;
  const next = OPENERS_RE.test(words[i].text) && words[i + 1] ? words[i + 1] : words[i];
  return UPPER_START_RE.test(next.text);
}
