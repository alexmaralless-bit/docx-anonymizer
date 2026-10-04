// Поиск всех вхождений значения по документу (ADD_ENTITY, FR-31; тесты).

/**
 * @param {import('./docx/model.js').DocModel} doc
 * @param {string} value
 * @param {{caseSensitive?: boolean, wholeWord?: boolean, streamTypes?: string[]}} [opts]
 * @returns {{streamId: string, start: number, end: number, text: string}[]}
 */
export function findOccurrences(doc, value, opts = {}) {
  const { caseSensitive = false, wholeWord = true, streamTypes } = opts;
  if (!value) return [];
  const needle = caseSensitive ? value : value.toLowerCase();
  const out = [];
  for (const s of doc.streams) {
    if (streamTypes && !streamTypes.includes(s.type)) continue;
    const hay = caseSensitive ? s.text : s.text.toLowerCase();
    if (hay.length !== s.text.length) continue; // редкие символы, меняющие длину при lower-case
    let i = hay.indexOf(needle);
    while (i >= 0) {
      const end = i + needle.length;
      if (!wholeWord || (!isWordChar(s.text[i - 1]) && !isWordChar(s.text[end]))) {
        out.push({ streamId: s.id, start: i, end, text: s.text.slice(i, end) });
      }
      i = hay.indexOf(needle, i + 1);
    }
  }
  return out;
}

function isWordChar(ch) {
  return ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
}
