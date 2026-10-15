// PERSON по правилам (без NER): «Фамилия Имя Отчество» (по отчеству), «Фамилия И.О.», «И.О. Фамилия»,
// «Имя Фамилия» (по словарю имён), латиница («Ivan Petrov», «Petrov I.S.»), а также 2–3 слова с заглавной
// после лейбла («в лице [должность]», «ФИО:», «represented by», «Mr.», подпись «____ / … /»).

import { tokenize, gapOk, labelBeforeRe, hasLabelBefore, pickNonOverlapping } from './text.js';
import { isStopWord, lowerE, POSITION_RE_SRC, AMBIGUOUS_NAMES_RU, FIRST_NAMES_EN, NON_PERSON_PAIRS, ORG_TAIL_WORDS_EN } from './lexicon.js';
import { patronymicInfo, firstNameInfo, lemmaCandidates } from './morph.js';

// prettier-ignore
export const PERSON_LABELS_RU = [
  'в лице', 'фио', 'ф.и.о.', 'ф. и. о.', 'на имя', 'подписант', 'контактное лицо', 'ответственное лицо', 'представитель',
  'исполнитель:', 'директор', 'генеральный директор', 'руководитель', 'гражданин', 'гражданка', 'гр.', 'подпись', 'уполномоченное лицо',
  'доверенное лицо', 'получатель:', 'заявитель', 'ученик', 'сотрудник', 'работник', 'арендатор:', 'заказчик:',
];
// prettier-ignore
export const PERSON_LABELS_EN = [
  'represented by', 'name:', 'full name', 'attn:', 'attn.', 'attention:', 'signed by', 'signature:', 'signatory', 'contact person',
  'director:', 'ceo:', 'by:', 'per:', 'mr.', 'mrs.', 'ms.', 'dr.', 'mr', 'mrs', 'ms', 'dr', 'prof.',
];
const HONORIFIC_RE = /(?<![\p{L}])(?:mr|mrs|ms|miss|dr|prof|sir)\.?[ \u00A0]+$/iu;
const SIGNATURE_RE = /_{2,}[ \u00A0]*\/[ \u00A0]*$/u;
// «ул. Академика Королёва», «им. Ивана Франко», «г. Николаев» — часть адреса/названия, не лицо
export const TOPONYM_BEFORE_RE =
  /(?:(?<![\p{L}])(?:ул|пр|просп|пер|пл|наб|б-р|бул|ш|им|г|гор|пос|с|д|дер|мкр|р-н|обл|ст)\.|(?<![\p{L}])(?:улица|улицы|проспект|переулок|площадь|имени|набережная|бульвар|шоссе|пр-т|город|села|деревня|станция|street|avenue|road))[ \u00A0]*$/iu;

const DEFAULT_LABEL_RE = labelBeforeRe([...PERSON_LABELS_RU, ...PERSON_LABELS_EN], POSITION_RE_SRC);

// Хвост названия после латинской пары: «… International», «…, Inc.», «… & Co.», «… and Partners» (слово — с заглавной)
const ORG_TAIL_RE = /^(?:,?[ \u00A0]{1,2}([A-Z][A-Za-z]*)(?![\p{L}\p{N}-])|[ \u00A0]*&|[ \u00A0]{1,2}and[ \u00A0]{1,2}([A-Z][A-Za-z]*)(?![\p{L}\p{N}-]))/u;
// «Bank of America Merrill Lynch», «University of …» — «of» после слова с заглавной: пара — часть названия
const OF_BEFORE_RE = /(?<![\p{L}])\p{Lu}[\p{L}'’-]*[ \u00A0]+of[ \u00A0]+$/u;

/**
 * Латинская пара «First Last» — часть названия организации (FR-23, ревью WP-N1): за ней идёт слово из
 * ORG_TAIL_WORDS_EN или «&», либо перед ней «<Слово> of».
 * @param {string} text
 * @param {number} start
 * @param {number} end
 */
export function latinOrgContext(text, start, end) {
  const m = ORG_TAIL_RE.exec(text.slice(end, end + 40));
  if (m) {
    const w = m[1] || m[2];
    if (!w || ORG_TAIL_WORDS_EN.has(w.toLowerCase())) return true;
  }
  return OF_BEFORE_RE.test(text.slice(Math.max(0, start - 40), start));
}

/**
 * @typedef {object} PersonParse
 * @property {'full'|'pair'|'initials'|'fm'|'other'} kind   fm — «Имя Отчество» (словарный детектор)
 * @property {'cyr'|'lat'} script
 * @property {string} [surname]
 * @property {string} [first]
 * @property {string} [patronymic]
 * @property {string} [initials]   буквы инициалов в нижнем регистре: «пс»
 * @property {string[]} words
 * @property {{surname?: string, first: string, patronymic?: string, gender: 'm'|'f'}} [lemma]  леммы (словарный детектор)
 */

/**
 * @typedef {object} PersonSpan
 * @property {number} start
 * @property {number} end
 * @property {boolean} labeled
 * @property {PersonParse} parse
 * @property {boolean} [dict]   найдено словарным детектором (person-dict.js, WP7) — уровень kb
 * @property {boolean} [nameOnly] латинская пара найдена только по курируемому имени («Jack Daniels»), без лейбла и обращения
 */

const isFirstRu = (w) => firstNameInfo(w).length > 0 && !AMBIGUOUS_NAMES_RU.has(lowerE(w));
const isFirstEn = (w) => FIRST_NAMES_EN.has(lowerE(w));

/** «Иван Купала», «Ивана Купалы», «Лада Веста» — устойчивые сочетания, не лица (WP7, NON_PERSON_PAIRS). */
function nonPersonPair(span) {
  const p = span.parse;
  if ((span.labeled && !span.nameOnly) || p.kind !== 'pair' || !p.first || !p.surname) return false;
  const f = lowerE(p.first);
  const s = lowerE(p.surname);
  if (NON_PERSON_PAIRS.has(lowerE(p.words.join(' ')))) return true;
  if (p.script !== 'cyr') return false;
  for (const fi of firstNameInfo(f)) {
    for (const sl of [s, ...lemmaCandidates(s, 'surname', fi.gender, fi.cases).slice(0, 2)]) {
      if (NON_PERSON_PAIRS.has(`${fi.lemma} ${sl}`) || NON_PERSON_PAIRS.has(`${sl} ${fi.lemma}`)) return true;
    }
  }
  return false;
}
const okWord = (tok) => tok.t === 'W' && !isStopWord(tok.text) && tok.text.length >= 2;

/**
 * @param {string} text
 * @param {{labelRe?: RegExp, toks?: import('./text.js').Token[]}} [opts] `toks` — готовая токенизация `text` (WP7: общая со словарным детектором)
 * @returns {PersonSpan[]}
 */
export function findPersons(text, opts = {}) {
  const labelRe = opts.labelRe || DEFAULT_LABEL_RE;
  const toks = opts.toks || tokenize(text);
  /** @type {PersonSpan[]} */
  const spans = [];
  const seq = (i, n) => {
    if (i + n > toks.length) return null;
    const arr = toks.slice(i, i + n);
    for (let k = 1; k < n; k++) if (!gapOk(text, arr[k - 1], arr[k])) return null;
    const script = arr[0].script;
    if (arr.some((t) => t.script !== script)) return null;
    return arr;
  };
  const push = (arr, labeled, parse, extra = {}) =>
    spans.push({
      start: arr[0].start,
      end: arr[arr.length - 1].end,
      labeled,
      ...extra,
      parse: { ...parse, script: arr[0].script, words: arr.map((t) => t.text) },
    });

  for (let i = 0; i < toks.length; i++) {
    const t0 = toks[i];
    const labeled = hasLabelBefore(text, t0.start, labelRe, 80) || SIGNATURE_RE.test(text.slice(Math.max(0, t0.start - 40), t0.start));
    const honorific = HONORIFIC_RE.test(text.slice(Math.max(0, t0.start - 8), t0.start));

    // 1. Три слова: ФИО по отчеству (СИО / ИОФ) или любые три слова после лейбла
    const w3 = seq(i, 3);
    if (w3 && w3.every(okWord)) {
      if (w3[0].script === 'cyr' && patronymicInfo(w3[2].text)) {
        push(w3, labeled, { kind: 'full', surname: w3[0].text, first: w3[1].text, patronymic: w3[2].text });
        continue;
      }
      if (w3[0].script === 'cyr' && patronymicInfo(w3[1].text) && !patronymicInfo(w3[2].text)) {
        push(w3, labeled, { kind: 'full', first: w3[0].text, patronymic: w3[1].text, surname: w3[2].text });
        continue;
      }
      if (labeled && w3[0].script === 'lat') {
        push(w3, true, { kind: 'pair', first: w3[0].text, surname: w3[2].text });
        continue;
      }
    }
    // 2. «Фамилия И.О.» / «Фамилия И. О.»
    const wii = seq(i, 3);
    if (wii && okWord(wii[0]) && wii[1].t === 'I' && wii[2].t === 'I') {
      push(wii, labeled, { kind: 'initials', surname: wii[0].text, initials: lowerE(wii[1].text + wii[2].text) });
      continue;
    }
    // 3. «И.О. Фамилия»
    const iiw = seq(i, 3);
    if (iiw && iiw[0].t === 'I' && iiw[1].t === 'I' && okWord(iiw[2])) {
      push(iiw, labeled, { kind: 'initials', surname: iiw[2].text, initials: lowerE(iiw[0].text + iiw[1].text) });
      i += 2;
      continue;
    }
    // 4. «Имя Фамилия» / «Фамилия Имя» по словарю имён; после лейбла — любые два слова
    const w2 = seq(i, 2);
    if (w2 && w2.every(okWord) && !(w2[0].caps && w2[1].caps && !labeled)) {
      const [a, b] = w2;
      if (a.script === 'cyr') {
        if (isFirstRu(a.text) && !isFirstRu(b.text)) {
          push(w2, labeled, { kind: 'pair', first: a.text, surname: b.text });
          i += 1;
          continue;
        }
        if (isFirstRu(b.text) && !isFirstRu(a.text)) {
          push(w2, labeled, { kind: 'pair', surname: a.text, first: b.text });
          i += 1;
          continue;
        }
        if (labeled) {
          push(w2, true, { kind: 'other', surname: a.text });
          i += 1;
          continue;
        }
      } else {
        if (isFirstEn(a.text) || labeled || honorific) {
          const nameOnly = !labeled && !honorific;
          if (nameOnly && ORG_TAIL_WORDS_EN.has(b.text.toLowerCase())) continue; // «Charles International»
          push(w2, true, { kind: 'pair', first: a.text, surname: b.text }, nameOnly ? { nameOnly } : {});
          i += 1;
          continue;
        }
      }
    }
    // 5. После лейбла: «Фамилия И.», «И. Фамилия»; после обращения — одиночная фамилия
    if (labeled || honorific) {
      const wi = seq(i, 2);
      if (wi && okWord(wi[0]) && wi[1].t === 'I') {
        push(wi, true, { kind: 'initials', surname: wi[0].text, initials: lowerE(wi[1].text) });
        continue;
      }
      if (wi && wi[0].t === 'I' && okWord(wi[1])) {
        push(wi, true, { kind: 'initials', surname: wi[1].text, initials: lowerE(wi[0].text) });
        i += 1;
        continue;
      }
      if (honorific && okWord(t0) && !t0.caps) {
        push([t0], true, { kind: 'other', surname: t0.text });
        continue;
      }
    }
  }
  // Пересечения внутри PERSON: размеченные лейблом и более длинные — сильнее
  // латинская пара только по имени — не часть названия фирмы («Raymond James Financial» нет в списке, но «… & Co.» — да)
  return pickNonOverlapping(spans, (s) => (s.labeled ? 1 : 0)).filter(
    (s) =>
      !TOPONYM_BEFORE_RE.test(text.slice(Math.max(0, s.start - 14), s.start)) && !nonPersonPair(s) && !(s.nameOnly && latinOrgContext(text, s.start, s.end)),
  );
}
