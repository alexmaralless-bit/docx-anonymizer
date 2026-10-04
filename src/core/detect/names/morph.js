// Русская морфология ФИО (FR-23): склонение фамилий, имён и отчеств по 6 падежам
// и обратная операция — восстановление именительного падежа (лемматизация) по форме.
// Работает в нижнем регистре с «ё» → «е» (как normalizeValue), поэтому формы годятся
// и для сравнения, и для canonical.
//
// Падежи: 0 им, 1 род, 2 дат, 3 вин, 4 тв, 5 пр.

import { lowerE, MALE_NAMES_RU, FEMALE_NAMES_RU } from './lexicon.js';

/** @typedef {'m'|'f'} Gender */

const SIBILANT = /[жшчщц]$/;
const VELAR_SIB = /[гкхжшчщ]$/;

/** Склонение на -а/-я (1-е склонение): Анна, Наталья, Мария, Никита, Кулига. */
function firstDecl(n) {
  if (/ия$/.test(n)) {
    const s = n.slice(0, -1);
    return [n, s + 'и', s + 'и', s + 'ю', s + 'ей', s + 'и'];
  }
  const s = n.slice(0, -1);
  if (/я$/.test(n)) return [n, s + 'и', s + 'е', s + 'ю', s + 'ей', s + 'е'];
  return [n, s + (VELAR_SIB.test(s) ? 'и' : 'ы'), s + 'е', s + 'у', s + (SIBILANT.test(s) ? 'ей' : 'ой'), s + 'е'];
}

const same = (n) => [n, n, n, n, n, n];
const INDECL_SURNAME = /(?:ко|их|ых|аго|яго|ово|ые|ие|[эиуюеоё])$/;

/**
 * @param {string} nom фамилия в им. падеже (нижний регистр)
 * @param {Gender} g
 * @returns {string[]}
 */
export function declineSurname(nom, g) {
  const n = lowerE(nom);
  if (g === 'f') {
    if (/(?:ова|ева|ина|ына)$/.test(n)) {
      const s = n.slice(0, -1);
      return [n, s + 'ой', s + 'ой', s + 'у', s + 'ой', s + 'ой'];
    }
    if (/ая$/.test(n)) {
      const s = n.slice(0, -2);
      return [n, s + 'ой', s + 'ой', s + 'ую', s + 'ой', s + 'ой'];
    }
    if (INDECL_SURNAME.test(n) && !/[ая]$/.test(n)) return same(n);
    if (/[ая]$/.test(n)) return firstDecl(n);
    return same(n);
  }
  if (/(?:ов|ев|ин|ын)$/.test(n)) return [n, n + 'а', n + 'у', n + 'а', n + 'ым', n + 'е'];
  if (/(?:ий|ый|ой)$/.test(n)) {
    const s = n.slice(0, -2);
    const soft = /ий$/.test(n) && !VELAR_SIB.test(s);
    return [n, s + (soft ? 'его' : 'ого'), s + (soft ? 'ему' : 'ому'), s + (soft ? 'его' : 'ого'), s + (/ий$/.test(n) ? 'им' : 'ым'), s + (soft ? 'ем' : 'ом')];
  }
  if (/[ая]$/.test(n)) return firstDecl(n);
  if (INDECL_SURNAME.test(n)) return same(n);
  if (/[ьй]$/.test(n)) {
    const s = n.slice(0, -1);
    return [n, s + 'я', s + 'ю', s + 'я', s + 'ем', s + 'е'];
  }
  if (/[бвгджзклмнпрстфхцчшщ]$/.test(n)) return [n, n + 'а', n + 'у', n + 'а', n + (SIBILANT.test(n) ? 'ем' : 'ом'), n + 'е'];
  return same(n);
}

/** Имена с беглой гласной и прочие исключения (в нижнем регистре, «ё» → «е»). */
const FIRST_EXCEPTIONS = {
  петр: ['петр', 'петра', 'петру', 'петра', 'петром', 'петре'],
  павел: ['павел', 'павла', 'павлу', 'павла', 'павлом', 'павле'],
  лев: ['лев', 'льва', 'льву', 'льва', 'львом', 'льве'],
  любовь: ['любовь', 'любови', 'любови', 'любовь', 'любовью', 'любови'],
};

/**
 * @param {string} nom имя в им. падеже
 * @param {Gender} g
 */
export function declineFirstName(nom, g) {
  const n = lowerE(nom);
  if (FIRST_EXCEPTIONS[n]) return [...FIRST_EXCEPTIONS[n]];
  if (g === 'f') {
    if (/ь$/.test(n)) {
      const s = n.slice(0, -1);
      return [n, s + 'и', s + 'и', n, n + 'ю', s + 'и'];
    }
    if (/[ая]$/.test(n)) return firstDecl(n);
    return same(n);
  }
  if (/ий$/.test(n)) {
    const s = n.slice(0, -1);
    return [n, s + 'я', s + 'ю', s + 'я', s + 'ем', s + 'и'];
  }
  if (/[йь]$/.test(n)) {
    const s = n.slice(0, -1);
    return [n, s + 'я', s + 'ю', s + 'я', s + 'ем', s + 'е'];
  }
  if (/[ая]$/.test(n)) return firstDecl(n);
  if (/[бвгджзклмнпрстфхцчшщ]$/.test(n)) return [n, n + 'а', n + 'у', n + 'а', n + (SIBILANT.test(n) ? 'ем' : 'ом'), n + 'е'];
  return same(n);
}

/** @param {string} nom отчество в им. падеже (-ич / -на) */
export function declinePatronymic(nom, g) {
  const n = lowerE(nom);
  if (g === 'm') return [n, n + 'а', n + 'у', n + 'а', n + 'ем', n + 'е'];
  const s = n.slice(0, -1);
  return [n, s + 'ы', s + 'е', s + 'у', s + 'ой', s + 'е'];
}

const PATR_M = /^[а-я]{2,}(?:ович|евич|ьич|ич)(а|у|ем|е)?$/;
const PATR_F = /^[а-я]{2,}(?:овн|евн|ичн)(а|ы|е|у|ой|ою)$/;
const PATR_M_CASES = { '': [0], а: [1, 3], у: [2], ем: [4], е: [5] };
const PATR_F_CASES = { а: [0], ы: [1], е: [2, 5], у: [3], ой: [4], ою: [4] };

/**
 * Отчество? Если да — пол, возможные падежи и им. падеж.
 * @param {string} word
 * @returns {{gender: Gender, cases: number[], lemma: string} | null}
 */
export function patronymicInfo(word) {
  const w = lowerE(word);
  let m = PATR_M.exec(w);
  if (m) {
    const end = m[1] || '';
    return { gender: 'm', cases: PATR_M_CASES[end], lemma: w.slice(0, w.length - end.length) };
  }
  m = PATR_F.exec(w);
  if (m) {
    const end = m[1];
    return { gender: 'f', cases: PATR_F_CASES[end], lemma: w.slice(0, w.length - end.length) + 'а' };
  }
  return null;
}

const NOM_ENDINGS = ['', 'а', 'я', 'ь', 'й', 'ий', 'ый', 'ой', 'ая', 'ия'];

/**
 * Возможные именительные формы для `word` (фамилия или имя) при заданном поле.
 * @param {string} word
 * @param {'surname'|'first'} kind
 * @param {Gender} g
 * @param {number[]} [cases] допустимые падежи формы (если известны)
 * @returns {string[]} кандидаты, от наиболее вероятного
 */
export function lemmaCandidates(word, kind, g, cases) {
  const w = lowerE(word);
  const decline = kind === 'surname' ? declineSurname : declineFirstName;
  const out = [];
  if (kind === 'first') {
    for (const [lemma, forms] of Object.entries(FIRST_EXCEPTIONS)) {
      forms.forEach((f, i) => {
        if (f === w && (!cases || cases.includes(i)) && !out.includes(lemma)) out.push(lemma);
      });
    }
  }
  for (let k = 0; k <= Math.min(3, w.length - 2); k++) {
    const base = w.slice(0, w.length - k);
    for (const e of NOM_ENDINGS) {
      const cand = base + e;
      if (out.includes(cand)) continue;
      const forms = decline(cand, g);
      if (forms[0] !== cand) continue;
      const ok = forms.some((f, i) => f === w && (!cases || cases.includes(i)));
      if (ok) out.push(cand);
    }
  }
  const score = (c) => lemmaScore(c, kind, g);
  return out.sort((a, b) => score(b) - score(a));
}

/** Насколько кандидат похож на именительный падеж фамилии/имени (больше — вероятнее). */
function lemmaScore(c, kind, g) {
  if (kind === 'first') {
    if (FIRST_LEMMAS.has(c)) return 3;
    if (g === 'm') return /[бвгджзклмнпрстфхцчшщ]$|[аеиоуыэюя]й$|[лнр]ь$/.test(c) ? 1 : 0;
    return /[ая]$/.test(c) ? 1 : 0;
  }
  if (g === 'm') {
    if (/(?:ский|цкий)$/.test(c)) return 3.2;
    if (/(?:ов|ев|ин|ын|ской|цкой)$/.test(c)) return 3;
    if (/ой$/.test(c)) return 2.1;
    if (/(?:ый|ий)$/.test(c)) return 2;
    if (/[аеиоуыэюя]й$/.test(c)) return 1.5;
    if (/[лнр]ь$/.test(c)) return 1.5;
    if (/ь$/.test(c)) return 0.2;
    if (/[бвгджзклмнпрстфхцчшщ]$/.test(c)) return 1;
    return /[ая]$/.test(c) ? 0.5 : 0;
  }
  if (/(?:ова|ева|ина|ына|ская|цкая)$/.test(c)) return 3;
  if (/ая$/.test(c)) return 2;
  return /[ая]$/.test(c) ? 1 : 0;
}

/** @type {Map<string, {lemma: string, gender: Gender, cases: number[]}[]>} */
const FIRST_FORMS = new Map();
const FIRST_LEMMAS = new Set([...MALE_NAMES_RU, ...FEMALE_NAMES_RU].map(lowerE));
for (const [list, g] of /** @type {[string[], Gender][]} */ ([
  [MALE_NAMES_RU, 'm'],
  [FEMALE_NAMES_RU, 'f'],
])) {
  for (const name of list) {
    const lemma = lowerE(name);
    declineFirstName(lemma, g).forEach((f, i) => {
      let arr = FIRST_FORMS.get(f);
      if (!arr) FIRST_FORMS.set(f, (arr = []));
      let rec = arr.find((x) => x.lemma === lemma && x.gender === g);
      if (!rec) arr.push((rec = { lemma, gender: g, cases: [] }));
      if (!rec.cases.includes(i)) rec.cases.push(i);
    });
  }
}

/**
 * Словарное имя (в любой падежной форме)?
 * @param {string} word
 * @returns {{lemma: string, gender: Gender, cases: number[]}[]}
 */
export function firstNameInfo(word) {
  return FIRST_FORMS.get(lowerE(word)) || [];
}

/**
 * Лемматизация ФИО «Фамилия Имя Отчество» в любом падеже.
 * @param {{surname: string, first: string, patronymic: string}} p
 * @returns {{surname: string, first: string, patronymic: string, gender: Gender} | null}
 */
export function lemmatizeFullName(p) {
  const pi = patronymicInfo(p.patronymic);
  if (!pi) return null;
  const first = lemmaCandidates(p.first, 'first', pi.gender, pi.cases)[0];
  const surname = lemmaCandidates(p.surname, 'surname', pi.gender, pi.cases)[0];
  return {
    surname: surname || lowerE(p.surname),
    first: first || lowerE(p.first),
    patronymic: pi.lemma,
    gender: pi.gender,
  };
}

/**
 * Лемматизация пары «Фамилия Имя» по словарному имени.
 * @returns {{surname: string, first: string, gender: Gender} | null}
 */
export function lemmatizeNamePair(surname, first) {
  const infos = firstNameInfo(first);
  for (const fi of infos) {
    const s = lemmaCandidates(surname, 'surname', fi.gender, fi.cases)[0];
    if (s) return { surname: s, first: fi.lemma, gender: fi.gender };
  }
  return null;
}

/**
 * Все формы фамилии, записанной в неизвестном падеже/роде (для «Сидорова А.В.»):
 * объединение парадигм всех правдоподобных лемм обоих родов.
 * @param {string} word
 * @returns {Set<string>}
 */
export function surnameFormsAnyGender(word) {
  const w = lowerE(word);
  const out = new Set([w]);
  for (const g of /** @type {Gender[]} */ (['m', 'f'])) {
    for (const lemma of lemmaCandidates(w, 'surname', g).slice(0, 2)) for (const f of declineSurname(lemma, g)) out.add(f);
  }
  return out;
}
