// WP7, К2: морфологическое покрытие словарного детектора. 300 сгенерированных троек (сид фиксирован):
// фамилия из словаря (-ов/-ев/-ин/-ский и на согласный), имя по роду из словаря, отчество от мужского имени.
// Документ из 12 абзацев: 6 — «Имя Фамилия» в каждом падеже (словарный путь), 6 — полная тройка в каждом падеже.
// Ожидание: ровно одна группа PERSON с 12 вхождениями; проходимость ≥ 95 %.
import { describe, it, expect, beforeAll } from 'vitest';
import { registerNames, analyzeParagraphs, allOnSettings } from './helpers.js';
import { getDicts } from '../../../src/core/detect/names/dict/index.js';
import { declineSurname, declineFirstName, declinePatronymic, firstNameInfo } from '../../../src/core/detect/names/morph.js';
import { isStopWord, COMMON_NOUNS } from '../../../src/core/detect/names/lexicon.js';

/** mulberry32 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// отчества от мужских имён
const PATRONYMICS = {
  иван: 'иванович',
  петр: 'петрович',
  сергей: 'сергеевич',
  андрей: 'андреевич',
  николай: 'николаевич',
  александр: 'александрович',
  дмитрий: 'дмитриевич',
  олег: 'олегович',
  борис: 'борисович',
  виктор: 'викторович',
  юрий: 'юрьевич',
  михаил: 'михайлович',
  владимир: 'владимирович',
  алексей: 'алексеевич',
  павел: 'павлович',
  роман: 'романович',
  максим: 'максимович',
  игорь: 'игоревич',
  евгений: 'евгеньевич',
  анатолий: 'анатольевич',
  ринат: 'ринатович',
  ильдар: 'ильдарович',
  тимур: 'тимурович',
  глеб: 'глебович',
};
const PATR_KEYS = Object.keys(PATRONYMICS);

const cap = (w) =>
  w
    .split('-')
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join('-');
const femOf = (s) =>
  s
    .replace(/(ов|ев|ин|ын)$/, '$1а')
    .replace(/ский$/, 'ская')
    .replace(/цкий$/, 'цкая');

const PAIR_CTX = [
  (x) => `Ответственный исполнитель ${x} подтвердил получение.`,
  (x) => `Получено от ${x} без замечаний.`,
  (x) => `Оригиналы вернуть ${x} лично.`,
  (x) => `Назначить ${x} ответственным за приёмку.`,
  (x) => `Согласовано с ${x} заранее.`,
  (x) => `Сведения о ${x} уточнены.`,
];
const FULL_CTX = [
  (x) => `Акт подписал ${x} в присутствии комиссии.`,
  (x) => `Заявление от ${x} принято.`,
  (x) => `Уведомление направить ${x} почтой.`,
  (x) => `Пригласить ${x} на совещание.`,
  (x) => `Встреча с ${x} перенесена.`,
  (x) => `Вопрос о ${x} снят.`,
];

function makeTriples(n, seed) {
  const d = getDicts();
  const rand = rng(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const surnames = [...d.ruSurnames].filter(
    (s) => !s.includes('-') && s.length >= 5 && (/(?:ов|ев|ин|ский)$/.test(s) || /[бвгджзклмнпрстфхчшщ]$/.test(s)) && !/(?:ич|ых|их)$/.test(s),
  );
  const good = (w) => w.length >= 4 && !d.ruAmbiguous.has(w) && !COMMON_NOUNS.has(w) && !isStopWord(w) && !d.ruSurnames.has(w);
  // имена из большого словаря, вне курируемого списка (словарный путь): мужские на согласный/-й, женские на -а/-я
  const male = [...d.ruFirst].filter(([w, g]) => g === 'm' && good(w) && /(?:[бвгдзклмнпрстф]|[аеоуэ]й)$/.test(w) && !firstNameInfo(w).length).map(([w]) => w);
  const female = [...d.ruFirst].filter(([w, g]) => g === 'f' && good(w) && /[^и][ая]$/.test(w) && !firstNameInfo(w).length).map(([w]) => w);
  const out = [];
  for (let i = 0; i < n; i++) {
    const g = rand() < 0.5 ? 'm' : 'f';
    const sm = pick(surnames);
    const surname = g === 'm' ? sm : femOf(sm);
    const first = pick(g === 'm' ? male : female);
    const pm = PATRONYMICS[pick(PATR_KEYS)];
    const patronymic = g === 'm' ? pm : pm.replace(/ич$/, 'на');
    out.push({ g, surname, first, patronymic });
  }
  return out;
}

function documentFor({ g, surname, first, patronymic }) {
  const S = declineSurname(surname, g).map(cap);
  const F = declineFirstName(first, g).map(cap);
  const P = declinePatronymic(patronymic, g).map(cap);
  const paras = [];
  for (let c = 0; c < 6; c++) paras.push(PAIR_CTX[c](c % 2 ? `${S[c]} ${F[c]}` : `${F[c]} ${S[c]}`));
  for (let c = 0; c < 6; c++) paras.push(FULL_CTX[c](`${S[c]} ${F[c]} ${P[c]}`));
  return paras;
}

describe('К2: 300 троек во всех падежах склеиваются в одну группу', () => {
  beforeAll(() => registerNames());

  it('проходимость ≥ 95 %', async () => {
    const triples = makeTriples(300, 20261015);
    let ok = 0;
    const failed = [];
    for (const t of triples) {
      const r = await analyzeParagraphs(documentFor(t), allOnSettings());
      const groups = r.groups.filter((x) => x.category === 'PERSON');
      if (groups.length === 1 && groups[0].occurrences.length === 12) ok++;
      else failed.push(`${t.surname} ${t.first} ${t.patronymic}: групп ${groups.length}, вхождений ${groups.map((x) => x.occurrences.length).join('+')}`);
    }
    const rate = ok / triples.length;
    console.log(`К2: ${ok}/${triples.length} (${(rate * 100).toFixed(1)} %)`);
    if (failed.length) console.log(failed.slice(0, 20).join('\n'));
    expect(rate).toBeGreaterThanOrEqual(0.95);
  }, 120000);
});
