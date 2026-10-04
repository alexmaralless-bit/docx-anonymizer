// PERSON по правилам (без NER): «Фамилия Имя Отчество» (по отчеству), «Фамилия И.О.», «И.О. Фамилия»,
// «Имя Фамилия» (по словарю имён), латиница («Ivan Petrov», «Petrov I.S.»), а также 2–3 слова с заглавной
// после лейбла («в лице [должность]», «ФИО:», «represented by», «Mr.», подпись «____ / … /»).

import { tokenize, gapOk, labelBeforeRe, hasLabelBefore, pickNonOverlapping } from './text.js';
import { isStopWord, lowerE, POSITION_RE_SRC, AMBIGUOUS_NAMES_RU, FIRST_NAMES_EN } from './lexicon.js';
import { patronymicInfo, firstNameInfo } from './morph.js';

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
const TOPONYM_BEFORE_RE =
  /(?:(?<![\p{L}])(?:ул|пр|просп|пер|пл|наб|б-р|бул|ш|им|г|гор|пос|с|д|дер|мкр|р-н|обл|ст)\.|(?<![\p{L}])(?:улица|улицы|проспект|переулок|площадь|имени|набережная|бульвар|шоссе|пр-т|город|села|деревня|станция|street|avenue|road))[ \u00A0]*$/iu;

const DEFAULT_LABEL_RE = labelBeforeRe([...PERSON_LABELS_RU, ...PERSON_LABELS_EN], POSITION_RE_SRC);

/**
 * @typedef {object} PersonParse
 * @property {'full'|'pair'|'initials'|'other'} kind
 * @property {'cyr'|'lat'} script
 * @property {string} [surname]
 * @property {string} [first]
 * @property {string} [patronymic]
 * @property {string} [initials]   буквы инициалов в нижнем регистре: «пс»
 * @property {string[]} words
 */

/**
 * @typedef {object} PersonSpan
 * @property {number} start
 * @property {number} end
 * @property {boolean} labeled
 * @property {PersonParse} parse
 */

const isFirstRu = (w) => firstNameInfo(w).length > 0 && !AMBIGUOUS_NAMES_RU.has(lowerE(w));
const isFirstEn = (w) => FIRST_NAMES_EN.has(lowerE(w));
const okWord = (tok) => tok.t === 'W' && !isStopWord(tok.text) && tok.text.length >= 2;

/**
 * @param {string} text
 * @param {{labelRe?: RegExp}} [opts]
 * @returns {PersonSpan[]}
 */
export function findPersons(text, opts = {}) {
  const labelRe = opts.labelRe || DEFAULT_LABEL_RE;
  const toks = tokenize(text);
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
  const push = (arr, labeled, parse) =>
    spans.push({ start: arr[0].start, end: arr[arr.length - 1].end, labeled, parse: { ...parse, script: arr[0].script, words: arr.map((t) => t.text) } });

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
          push(w2, labeled || honorific || isFirstEn(a.text), { kind: 'pair', first: a.text, surname: b.text });
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
  return pickNonOverlapping(spans, (s) => (s.labeled ? 1 : 0)).filter((s) => !TOPONYM_BEFORE_RE.test(text.slice(Math.max(0, s.start - 14), s.start)));
}
