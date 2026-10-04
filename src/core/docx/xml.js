// Однопроходный токенизатор XML (ТЗ §6.1 п.3, вариант «в»).
// Не строит DOM: выдаёт события с именем, сырой строкой атрибутов и смещениями [start, end)
// в исходной строке части. Всё, что не меняется, остаётся нетронутыми символами.

/**
 * @typedef {'open'|'close'|'selfclose'|'text'|'other'} TokenType
 * @typedef {object} Token
 * @property {TokenType} type
 * @property {string} name имя элемента с префиксом (для open/close/selfclose)
 * @property {number} start смещение '<' (или начала текста)
 * @property {number} end смещение после '>' (или конца текста)
 * @property {number} attrStart начало сырой строки атрибутов (после имени)
 * @property {number} attrEnd конец сырой строки атрибутов (перед '>' или '/>')
 */

/**
 * Обходит XML-строку, вызывая onToken для каждого токена. Объект токена переиспользуется —
 * не сохраняйте ссылку на него.
 * @param {string} xml
 * @param {(t: Token) => void} onToken
 */
export function tokenize(xml, onToken) {
  /** @type {Token} */
  const t = { type: 'text', name: '', start: 0, end: 0, attrStart: 0, attrEnd: 0 };
  const n = xml.length;
  let i = 0;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      emitText(i, n);
      break;
    }
    if (lt > i) emitText(i, lt);
    const c1 = xml.charCodeAt(lt + 1);
    if (c1 === 0x3f /* ? */) {
      const e = xml.indexOf('?>', lt + 2);
      i = e < 0 ? n : e + 2;
      emitOther(lt, i);
      continue;
    }
    if (c1 === 0x21 /* ! */) {
      let e;
      if (xml.startsWith('<!--', lt)) {
        e = xml.indexOf('-->', lt + 4);
        i = e < 0 ? n : e + 3;
      } else if (xml.startsWith('<![CDATA[', lt)) {
        e = xml.indexOf(']]>', lt + 9);
        i = e < 0 ? n : e + 3;
      } else {
        e = xml.indexOf('>', lt + 2);
        i = e < 0 ? n : e + 1;
      }
      emitOther(lt, i);
      continue;
    }
    // Тег: ищем '>' вне кавычек
    let j = lt + 1;
    let quote = 0;
    for (; j < n; j++) {
      const c = xml.charCodeAt(j);
      if (quote) {
        if (c === quote) quote = 0;
      } else if (c === 0x22 || c === 0x27) quote = c;
      else if (c === 0x3e) break;
    }
    const gt = j;
    i = gt + 1;
    if (c1 === 0x2f /* / */) {
      let k = lt + 2;
      while (k < gt && !isSpace(xml.charCodeAt(k))) k++;
      t.type = 'close';
      t.name = xml.slice(lt + 2, k);
      t.start = lt;
      t.end = i;
      t.attrStart = t.attrEnd = k;
      onToken(t);
      continue;
    }
    let k = lt + 1;
    while (k < gt && !isSpace(xml.charCodeAt(k)) && xml.charCodeAt(k) !== 0x2f) k++;
    const self = xml.charCodeAt(gt - 1) === 0x2f;
    t.type = self ? 'selfclose' : 'open';
    t.name = xml.slice(lt + 1, k);
    t.start = lt;
    t.end = i;
    t.attrStart = k;
    t.attrEnd = self ? gt - 1 : gt;
    onToken(t);
  }

  function emitText(s, e) {
    t.type = 'text';
    t.name = '';
    t.start = s;
    t.end = e;
    t.attrStart = t.attrEnd = s;
    onToken(t);
  }
  function emitOther(s, e) {
    t.type = 'other';
    t.name = '';
    t.start = s;
    t.end = e;
    t.attrStart = t.attrEnd = s;
    onToken(t);
  }
}

function isSpace(c) {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

/**
 * Находит атрибуты в сырой строке атрибутов.
 * @param {string} xml
 * @param {number} from
 * @param {number} to
 * @returns {{name: string, valueStart: number, valueEnd: number, raw: string}[]} смещения значения без кавычек
 */
export function parseAttrs(xml, from, to) {
  const out = [];
  const re = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  const s = xml.slice(from, to);
  let m;
  while ((m = re.exec(s))) {
    const valueStart = from + m.index + m[0].length - m[2].length + 1;
    const raw = m[3] !== undefined ? m[3] : m[4];
    out.push({ name: m[1], valueStart, valueEnd: valueStart + raw.length, raw });
  }
  return out;
}

/** @param {string} xml @param {number} from @param {number} to @param {string} name */
export function getAttr(xml, from, to, name) {
  for (const a of parseAttrs(xml, from, to)) if (a.name === name) return a;
  return null;
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** XML-unescape: 5 стандартных сущностей и числовые ссылки. */
export function unescapeXml(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (m, g) => {
    if (g[0] === '#') {
      const cp = g[1] === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      try {
        return String.fromCodePoint(cp);
      } catch {
        return m;
      }
    }
    return NAMED[g];
  });
}

/** Экранирование текста элемента (FR-16). */
export function escapeText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Экранирование значения атрибута в двойных кавычках (и одинарных — на всякий случай). */
export function escapeAttr(s) {
  return escapeText(s).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * Применяет замены диапазонов строки. Диапазоны не должны пересекаться
 * (совпадающие точки вставки допустимы). Сборка за один проход слева направо.
 * @param {string} str
 * @param {{from: number, to: number, text: string}[]} edits
 */
export function applyRangeEdits(str, edits) {
  if (!edits.length) return str;
  const sorted = [...edits].sort((a, b) => a.from - b.from || a.to - b.to);
  const parts = [];
  let pos = 0;
  for (const e of sorted) {
    if (e.from < pos) throw new Error('Пересекающиеся правки XML');
    parts.push(str.slice(pos, e.from), e.text);
    pos = e.to;
  }
  parts.push(str.slice(pos));
  return parts.join('');
}
