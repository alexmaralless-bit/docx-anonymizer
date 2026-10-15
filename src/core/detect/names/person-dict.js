// Словарный детектор ФИО (WP7, FR-23, ступень 1 NER): имена третьих лиц без лейблов.
// Правило «два признака из трёх»: имя из словаря (F) в любом падеже, отчество по суффиксу (P),
// фамилия по словарю или по суффиксу (S). Шаблоны: «Имя Фамилия» / «Фамилия Имя», «Имя Отчество» (вид fm),
// ALL CAPS-пара (только со словарной фамилией), латиница «First Last», «First I. Last».
// Полные ФИО и инициалы — забота правил (person.js); их спаны передаются в `opts.skip`.
// Вхождения получают уровень kb (kb.js), поэтому проигрывают правилам и лейблам других категорий (FR-20).

import { tokenize, gapOk, pickNonOverlapping, overlaps } from './text.js';
import { isStopWord, lowerE, COMMON_NOUNS, ROLE_WORDS, GOV_ENTITIES, STOP_EXACT, NON_PERSON_PAIRS } from './lexicon.js';
import { patronymicInfo } from './morph.js';
import { TOPONYM_BEFORE_RE } from './person.js';
import { bigFirstNameInfo, surnameLemmas, surnameSuffixInfo, isEnFirst, isEnSurname } from './dict/index.js';

/** @typedef {import('./text.js').Token} Token */
/** @typedef {import('./person.js').PersonSpan} PersonSpan */
/** @typedef {{lemma: string, gender: 'm'|'f', cases: number[]}} FormInfo */

/**
 * @typedef {object} Sig
 * @property {FormInfo[]} fStrong   сильное имя
 * @property {FormInfo[]} fAmb      имя-омоним нарицательного
 * @property {ReturnType<typeof patronymicInfo>} p
 * @property {FormInfo[]} sDict     словарная фамилия
 * @property {FormInfo[]} sSuf      фамилия по суффиксу (если не словарная)
 */

const okWord = (tok) => tok.t === 'W' && tok.text.length >= 2 && !isStopWord(tok.text);

/** @type {Map<string, Sig>} */
const SIG_MEMO = new Map();

/** Признаки кириллического слова (мемоизация по нижнему регистру). */
function signals(word) {
  const w = lowerE(word);
  let s = SIG_MEMO.get(w);
  if (s) return s;
  if (SIG_MEMO.size >= 50000) SIG_MEMO.clear();
  const f = bigFirstNameInfo(w);
  const p = patronymicInfo(w);
  const nounLike = COMMON_NOUNS.has(w) || ROLE_WORDS.has(w);
  const sDict = p || nounLike ? [] : surnameLemmas(w).filter((x) => !COMMON_NOUNS.has(x.lemma) && !ROLE_WORDS.has(x.lemma));
  const sSuf = p || nounLike || sDict.length ? [] : surnameSuffixInfo(w) || [];
  s = {
    fStrong: f.filter((x) => !x.ambiguous),
    fAmb: f.filter((x) => x.ambiguous),
    p,
    sDict,
    sSuf,
  };
  SIG_MEMO.set(w, s);
  return s;
}

const compatible = (a, b) => a.gender === b.gender && a.cases.some((c) => b.cases.includes(c));

/** Согласованная пара разборов (род совпадает, падежи пересекаются) или null. */
function agree(fs, ss) {
  for (const f of fs) for (const s of ss) if (compatible(f, s)) return { f, s };
  return null;
}

/* ---------------- контекстные проверки ---------------- */

const SENT_END = /[.!?:;\n•…]/;
const SKIP_BACK = /[\s\u00A0«»"“”„'()[\]—–-]/;

/** Позиция — начало предложения: начало текста или `.!?:;\n•` перед ней (пробелы, кавычки, скобки, тире, нумерация «1.2.» пропускаются). */
export function atSentenceStart(text, pos) {
  let i = pos - 1;
  while (i >= 0) {
    const c = text[i];
    if (SKIP_BACK.test(c)) {
      i--;
      continue;
    }
    if (/\d/.test(c)) {
      // нумерация пункта: «1.», «1.2.», «3)» — сразу перед словом
      let j = i;
      while (j >= 0 && /[\d.)]/.test(text[j])) j--;
      const run = text.slice(j + 1, i + 1);
      if (!/[.)]/.test(run)) return false;
      i = j;
      continue;
    }
    return SENT_END.test(c);
  }
  return true;
}

/** Текст — заголовок: ≥ 3 слов с заглавной, все слова (кроме коротких служебных) с заглавной, без отчеств. */
function isHeadingText(text, toks) {
  const caps = toks.filter((t) => t.t === 'W');
  if (caps.length < 3) return false;
  const words = text.match(/\p{L}+/gu) || [];
  if (!words.every((w) => /^\p{Lu}/u.test(w) || w.length <= 3)) return false;
  return !caps.some((t) => t.script === 'cyr' && patronymicInfo(t.text));
}

/** Внутри кавычек: кавычка вплотную или незакрытая «/" перед спаном. */
function insideQuotes(text, start, end) {
  if (/[«"“„']/.test(text[start - 1] || '') || /[»"”“']/.test(text[end] || '')) return true;
  const before = text.slice(Math.max(0, start - 200), start);
  const open = (before.match(/«/g) || []).length;
  const close = (before.match(/»/g) || []).length;
  if (open > close) return true;
  return (before.match(/"/g) || []).length % 2 === 1;
}

/** Слипается с буквой/цифрой/адресом почты/доменом. */
function glued(text, start, end) {
  const prev = text[start - 1] || '';
  const next = text[end] || '';
  if (/[\p{L}\p{N}@._/\\]/u.test(prev)) return true;
  if (/[\p{L}\p{N}@_]/u.test(next)) return true;
  if ((next === '.' || next === '/') && /[\p{L}\p{N}]/u.test(text[end + 1] || '')) return true;
  return false;
}

/* ---------------- детектор ---------------- */

/**
 * @param {string} text
 * @param {{toks?: Token[], skip?: {start: number, end: number}[]}} [opts]
 * @returns {PersonSpan[]}
 */
export function findPersonsByDict(text, opts = {}) {
  const toks = opts.toks || tokenize(text);
  if (toks.length < 2) return [];
  const skip = opts.skip || [];
  let heading = /** @type {boolean | null} */ (null);
  const isHeading = () => (heading === null ? (heading = isHeadingText(text, toks)) : heading);

  /** @type {(PersonSpan & {score: number})[]} */
  const spans = [];
  const seqOk = (arr) => arr.every((t, k) => k === 0 || gapOk(text, arr[k - 1], t)) && arr.every((t) => t.script === arr[0].script);

  /** Общие проверки окна; true — кандидат допустим. */
  const guards = (start, end) => {
    if (skip.some((s) => overlaps(s, { start, end }))) return false;
    if (glued(text, start, end)) return false;
    if (TOPONYM_BEFORE_RE.test(text.slice(Math.max(0, start - 14), start))) return false;
    if (insideQuotes(text, start, end)) return false;
    if (GOV_ENTITIES.has(lowerE(text.slice(start, end).replace(/[\s\u00A0]+/g, ' ')))) return false;
    return true;
  };
  const nonPerson = (...variants) => variants.some((v) => NON_PERSON_PAIRS.has(v));

  for (let i = 0; i + 1 < toks.length; i++) {
    const a = toks[i];
    const b = toks[i + 1];
    if (!okWord(a)) continue;

    /* ---- латиница: «First Last», «First I. Last» ---- */
    if (a.script === 'lat') {
      const la = a.text.toLowerCase();
      if (!isEnFirst(la) || COMMON_NOUNS.has(la) || STOP_EXACT.has(la)) continue;
      const tryLast = (arr, last) => {
        if (!seqOk(arr) || !okWord(last)) return;
        const ll = last.text.toLowerCase();
        if (COMMON_NOUNS.has(ll)) return;
        if (isEnFirst(ll) && !isEnSurname(ll)) return; // два имени подряд
        const dictLast = isEnSurname(ll);
        if ((last.caps || a.caps) && !dictLast) return;
        if (isHeading() && !dictLast) return;
        const start = a.start;
        const end = last.end;
        if (!guards(start, end) || nonPerson(`${la} ${ll}`)) return;
        spans.push({
          start,
          end,
          labeled: false,
          dict: true,
          score: dictLast ? 2 : 1,
          parse: { kind: 'pair', script: 'lat', first: a.text, surname: last.text, words: arr.map((t) => t.text) },
        });
      };
      if (b.t === 'W') tryLast([a, b], b);
      else if (b.t === 'I' && toks[i + 2]?.t === 'W') tryLast([a, b, toks[i + 2]], toks[i + 2]);
      continue;
    }

    /* ---- кириллица: пары ---- */
    if (b.t !== 'W' || !okWord(b) || !seqOk([a, b])) continue;
    const sa = signals(a.text);
    const sb = signals(b.text);
    const start = a.start;
    const end = b.end;
    const caps = a.caps || b.caps;
    const sentStart = atSentenceStart(text, start);
    const surface = `${lowerE(a.text)} ${lowerE(b.text)}`;

    // «Имя Отчество» (fm): род совпадает, падежи пересекаются
    if (sb.p && !caps) {
      const fs = [...sa.fStrong, ...sa.fAmb];
      const pi = { lemma: sb.p.lemma, gender: sb.p.gender, cases: sb.p.cases };
      const fi = fs.find((x) => compatible(x, pi));
      const firstOk = !sentStart || sa.fStrong.some((x) => compatible(x, pi));
      if (fi && firstOk && !isHeading() && guards(start, end)) {
        spans.push({
          start,
          end,
          labeled: false,
          dict: true,
          score: 3,
          parse: {
            kind: 'fm',
            script: 'cyr',
            first: a.text,
            patronymic: b.text,
            words: [a.text, b.text],
            lemma: { first: fi.lemma, patronymic: pi.lemma, gender: pi.gender },
          },
        });
        continue;
      }
    }

    // два сильных имени подряд («Анна Мария») — не пара
    if (sa.fStrong.length && sb.fStrong.length) continue;

    for (const [fTok, sTok, F, S] of /** @type {[Token, Token, Sig, Sig][]} */ ([
      [a, b, sa, sb],
      [b, a, sb, sa],
    ])) {
      const strong = F.fStrong.length > 0;
      if (!strong && !F.fAmb.length) continue;
      const sIsDict = S.sDict.length > 0;
      if (!sIsDict && !S.sSuf.length) continue;
      if (F.p || S.p) continue;
      const fList = strong ? F.fStrong : F.fAmb;
      const sList = sIsDict ? S.sDict : S.sSuf;
      const ag = agree(fList, sList);
      let ok = (strong && sIsDict) || (strong && !!ag) || (!strong && sIsDict && !!ag && !sentStart);
      if (caps && !(strong && sIsDict)) ok = false;
      if (ok && isHeading() && !(strong && sIsDict)) ok = false;
      // начало предложения: первый токен обязан иметь словарное попадание
      if (ok && sentStart) ok = fTok === a ? strong : sIsDict;
      if (!ok || !guards(start, end)) continue;
      const fi = ag ? ag.f : fList[0];
      const si = ag ? ag.s : sList.find((x) => x.gender === fi.gender) || sList[0];
      const lemmaPairs = [`${fi.lemma} ${si.lemma}`, `${si.lemma} ${fi.lemma}`];
      if (nonPerson(surface, ...lemmaPairs)) continue;
      spans.push({
        start,
        end,
        labeled: false,
        dict: true,
        score: (ag ? 2 : 0) + (sIsDict ? 1 : 0) + (strong ? 1 : 0),
        parse: {
          kind: 'pair',
          script: 'cyr',
          first: fTok.text,
          surname: sTok.text,
          words: [a.text, b.text],
          lemma: { surname: si.lemma, first: fi.lemma, gender: ag ? ag.f.gender : si.gender },
        },
      });
      break;
    }
  }
  return pickNonOverlapping(spans, (s) => s.score).map(({ score: _score, ...s }) => s);
}
