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
