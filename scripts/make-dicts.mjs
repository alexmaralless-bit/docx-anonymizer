#!/usr/bin/env node
// Генератор словарей ФИО для словарного детектора (WP7, FR-23, ступень 1 NER).
// Источники (лицензии совместимы с MIT, тексты — в src/core/detect/names/dict/NOTICE.md):
//   datacoon/russiannames — BSD-3-Clause, © 2018 Ivan Begtin: русские фамилии и имена с частотами и родом;
//   natasha/natasha — MIT: список имён-омонимов (maybe_first.txt) и фамилии (last.txt, только для метрики);
//   US Census 1990 (имена) и 2010 (фамилии) — public domain.
// Версии зафиксированы: SHA коммитов GitHub и sha256 каждого скачанного файла (SOURCES).
//
// Использование:
//   npm run dicts                         — скачать (в кэш) и перегенерировать src/core/detect/names/dict/*.js
//   npm run dicts -- --check              — сравнить регенерацию с закоммиченными модулями (код выхода 1 при расхождении)
//   npm run dicts -- --cache=<каталог>    — каталог кэша загрузок
// Сеть используется только здесь (src/** сетевых API не содержит, NFR-01).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { parquetReadObjects } from 'hyparquet';
import { encodeList } from '../src/core/detect/names/dict/codec.js';
import { lowerE, isStopWord, COMMON_NOUNS, STOP_EXACT, AMBIGUOUS_NAMES_RU, MALE_NAMES_RU, FEMALE_NAMES_RU } from '../src/core/detect/names/lexicon.js';
import { patronymicInfo } from '../src/core/detect/names/morph.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'src/core/detect/names/dict');

const DATACOON_SHA = 'ac26a24a9bf0ac05e3330668c5103400a1cbf4ea';
const NATASHA_SHA = '08ae8452db9391f7c19730e61201cd442014a242';
const GH = (repo, sha, path) => `https://raw.githubusercontent.com/${repo}/${sha}/${path}`;

export const SOURCES = {
  retrieved: '2026-10-15',
  datacoon: {
    repo: 'https://github.com/datacoon/russiannames',
    sha: DATACOON_SHA,
    license: 'BSD-3-Clause, Copyright (c) 2018, Ivan Begtin',
  },
  natasha: {
    repo: 'https://github.com/natasha/natasha',
    sha: NATASHA_SHA,
    license: 'MIT, Copyright (c) 2016 Natasha project',
  },
  census1990: { url: 'https://www2.census.gov/topics/genealogy/1990surnames/', license: 'public domain (U.S. Census Bureau)' },
  census2010: { url: 'https://www2.census.gov/topics/genealogy/2010surnames/', license: 'public domain (U.S. Census Bureau)' },
  files: {
    'surnames.parquet': {
      url: GH('datacoon/russiannames', DATACOON_SHA, 'russiannames/data/surnames.parquet'),
      sha256: '292a6d97dc58252432b8426e33d2d753a10a1182d6e46a3dd5df31832aaccfe6',
    },
    'names.parquet': {
      url: GH('datacoon/russiannames', DATACOON_SHA, 'russiannames/data/names.parquet'),
      sha256: 'f5406cf3049175e0e6fcca2355d11796e0dd5e26ef2ac433d239438ac4b407f4',
    },
    'datacoon-LICENSE': {
      url: GH('datacoon/russiannames', DATACOON_SHA, 'LICENSE'),
      sha256: '611034a0fcc7239acb6fb18dc1f13de3ce0ba81722b569ac18f7cc796af19dbf',
    },
    'natasha-maybe_first.txt': {
      url: GH('natasha/natasha', NATASHA_SHA, 'natasha/data/dict/maybe_first.txt'),
      sha256: 'a7332838d7abb71159e73201a6f64f7dd271b51c3fd18604d837b3d3b7786163',
    },
    'natasha-last.txt': {
      url: GH('natasha/natasha', NATASHA_SHA, 'natasha/data/dict/last.txt'),
      sha256: 'f1a31c1470b24c1a299dd9c32d24efcb87caf887d4b2c69f13686e7be153cec4',
    },
    'natasha-LICENSE': {
      url: GH('natasha/natasha', NATASHA_SHA, 'LICENSE'),
      sha256: '2cb1d5fde9ca1ebab1e23d5f29d2462dcc5532a9cb296cc9ddc8b5d1e3ce9bac',
    },
    'dist.male.first': {
      url: 'https://www2.census.gov/topics/genealogy/1990surnames/dist.male.first',
      sha256: '0a5078ef6effe3b483d15b0f7f95047662126c9bfb624ecd5e5b978fc0f2470b',
    },
    'dist.female.first': {
      url: 'https://www2.census.gov/topics/genealogy/1990surnames/dist.female.first',
      sha256: 'bd2f310fc4e5d5e5ea122c9d4342c9821145823118eb20db1647f305ec77b358',
    },
    'names.zip': {
      url: 'https://www2.census.gov/topics/genealogy/2010surnames/names.zip',
      sha256: '117c41cb4668727b7627b2845b6df3f83eb2a22a1813f42c0ff4bdcab86de135',
    },
  },
};

/* ---------- параметры отбора ---------- */

const RU_SURNAMES_TOP = 50000;
const RU_NAME_MIN_COUNT = 3;
const EN_FIRST_MAX_RANK = 5000;
const EN_SURNAMES_TOP = 10000;

/** Женская форма фамилии → мужская лемма. */
const FEM_TO_MASC = [
  [/ова$/, 'ов'],
  [/ева$/, 'ев'],
  [/ина$/, 'ин'],
  [/ына$/, 'ын'],
  [/ская$/, 'ский'],
  [/цкая$/, 'цкий'],
];

// Служебные и частые слова, которые в данных встречаются как «имена» (ошибки разметки источника)
// prettier-ignore
const RU_FUNCTION_WORDS = [
  'она', 'они', 'оно', 'его', 'ему', 'ней', 'нее', 'них', 'нам', 'вам', 'вас', 'нас', 'мне', 'меня', 'тебя', 'себя', 'все', 'всех', 'весь',
  'вся', 'это', 'эта', 'этот', 'тот', 'том', 'тем', 'там', 'тут', 'как', 'так', 'при', 'для', 'над', 'под', 'без', 'про', 'или', 'либо',
  'если', 'когда', 'где', 'кто', 'что', 'чем', 'уже', 'еще', 'даже', 'только', 'также', 'тоже', 'был', 'была', 'были', 'было', 'есть',
  'нет', 'да', 'ага', 'ого', 'ура', 'все', 'сам', 'сама', 'сами', 'свой', 'своя', 'наш', 'ваш', 'мой', 'моя', 'твой', 'один', 'одна',
  'два', 'две', 'три', 'сто', 'год', 'дом', 'мир', 'день', 'ночь', 'мама', 'папа', 'баба', 'дед', 'дядя', 'тетя', 'сын', 'дочь',
];

// Имена-омонимы частых нарицательных и слов договоров (вдобавок к COMMON_NOUNS, AMBIGUOUS_NAMES_RU и natasha maybe_first):
// в паре «Имя Фамилия» без лейбла они считаются неоднозначными (нужна словарная фамилия и согласование)
// prettier-ignore
const RU_NAME_AMBIGUOUS_EXTRA = [
  'марс', 'победа', 'заря', 'роза', 'лилия', 'ангел', 'слава', 'мила', 'майя', 'лада', 'нега', 'рада', 'лев', 'сила', 'алмаз', 'рубин',
  'жемчуг', 'аврора', 'ленина', 'сталина', 'октябрина', 'революция', 'мира', 'фея', 'сапфир', 'мая', 'август', 'июль', 'февраль', 'ислам',
  'идея', 'муза', 'нота', 'ода', 'вега', 'янус', 'ирис', 'волга', 'нева', 'ока', 'кама', 'дон', 'урал', 'алтай', 'север', 'весна', 'лето',
  'зима', 'осень', 'звезда', 'мечта', 'радость', 'надежда', 'вера', 'любовь', 'роса', 'буран', 'ураган', 'булат', 'гранат',
  // омонимы словарных слов (сверка с орфографическим словарём при генерации)
  'авангард', 'адонис', 'амур', 'анис', 'атлас', 'атом', 'базар', 'барий', 'баян', 'бек', 'борей', 'вольт', 'гелий', 'гений', 'герц', 'грант',
  'граф', 'грач', 'дамба', 'динар', 'ива', 'идеал', 'имам', 'индус', 'интерн', 'ион', 'казан', 'карп', 'коммунар', 'лавр', 'логин', 'маис',
  'майор', 'меркурий', 'мина', 'мотель', 'мулла', 'мурза', 'павлин', 'палладий', 'радий', 'разум', 'рев', 'рева', 'риф', 'садик', 'свет',
  'сервер', 'сирень', 'софа', 'сурик', 'узбек', 'усик', 'фикус', 'философ', 'флер', 'флюс', 'франк', 'хан', 'электрон', 'азалия', 'броня',
  'вина', 'глина', 'гортензия', 'грация', 'искра', 'камелия', 'лира', 'магия', 'майна', 'мера', 'миля', 'новелла', 'резеда', 'рута', 'сатира',
  'хризантема', 'целина', 'элита', 'эра', 'юна', 'абонент', 'дань', 'джихад', 'линь', 'раса', 'сан', 'чао', 'воля', 'пальмира', 'виола',
  'паша', 'максим', 'цезарь', 'наполеон', 'эмир', 'халиф', 'хаджи',
];

// Английские «имена», совпадающие с частыми словами (Census 1990): в словарь EN-имён не попадают
// prettier-ignore
const EN_FIRST_EXCLUDE = [
  'abbey', 'aide', 'alpha', 'amber', 'an', 'angel', 'angelic', 'angle', 'art', 'august', 'aura', 'autumn', 'bee', 'bell', 'belle', 'berry',
  'bill', 'birdie', 'blanch', 'blossom', 'bong', 'brain', 'brandy', 'brook', 'brooks', 'buck', 'bud', 'buddy', 'bunny', 'buster', 'camellia',
  'candy', 'caprice', 'carmine', 'carry', 'celesta', 'chance', 'charity', 'chase', 'chastity', 'cherish', 'cherry', 'chi', 'chin', 'china',
  'christen', 'christian', 'chuck', 'clay', 'clement', 'cliff', 'conception', 'coral', 'coy', 'crystal', 'curt', 'dahlia', 'daisy', 'dale',
  'dawn', 'dean', 'deb', 'delta', 'desire', 'destiny', 'diamond', 'dick', 'dimple', 'dolly', 'dot', 'dung', 'dusty', 'earl', 'earnest',
  'ebony', 'echo', 'eddy', 'else', 'emerald', 'era', 'eve', 'fairy', 'faith', 'fanny', 'fawn', 'fern', 'flora', 'forest', 'foster', 'frank',
  'freeman', 'gala', 'gale', 'garland', 'garnet', 'garret', 'gay', 'genesis', 'genie', 'ginger', 'glen', 'glory', 'golden', 'grace', 'grant',
  'guy', 'ha', 'hang', 'hank', 'harmony', 'heath', 'heather', 'herb', 'holly', 'honey', 'hope', 'hue', 'hung', 'hunter', 'hyacinth', 'in',
  'iris', 'ivory', 'ivy', 'jack', 'jade', 'jasmine', 'jewel', 'junior', 'karma', 'king', 'kit', 'kitty', 'lacy', 'lady', 'lance', 'lane',
  'laurel', 'lea', 'lean', 'liberty', 'lily', 'loan', 'long', 'lore', 'love', 'ma', 'magnolia', 'major', 'man', 'manual', 'many', 'maple',
  'margarita', 'marine', 'mark', 'marlin', 'marquis', 'marry', 'marvel', 'mason', 'max', 'maxima', 'may', 'melody', 'mercy', 'merry', 'meta',
  'mi', 'mica', 'miles', 'min', 'miss', 'misty', 'moon', 'my', 'myrtle', 'noble', 'nova', 'novella', 'nu', 'numbers', 'olive', 'omega',
  'opal', 'pa', 'page', 'pansy', 'pasty', 'pat', 'patience', 'pearl', 'pearly', 'peg', 'penny', 'piper', 'porter', 'precious', 'prince',
  'princess', 'prudence', 'queen', 'randy', 'raven', 'ray', 'reed', 'rich', 'robin', 'rocky', 'rod', 'rose', 'rosemary', 'rosette', 'rosy',
  'royal', 'ruby', 'rusty', 'sage', 'sandy', 'sang', 'sari', 'savanna', 'savannah', 'scarlet', 'season', 'see', 'shad', 'sherry', 'shin',
  'sierra', 'so', 'sol', 'son', 'song', 'soon', 'sparkle', 'spring', 'star', 'sterling', 'stormy', 'sun', 'sung', 'sunny', 'sunshine', 'tad',
  'tam', 'tanner', 'tawny', 'temple', 'tequila', 'tiara', 'tiny', 'trinity', 'valentine', 'van', 'velvet', 'vi', 'viva', 'wade', 'walker',
  'wan', 'ward', 'warren', 'will', 'willow', 'windy', 'winter', 'yen', 'yon', 'young', 'yuk', 'general', 'morgan', 'apple', 'office',
];

// Фамилии-омонимы частых нарицательных и слов договоров, которых нет в COMMON_NOUNS/стоп-словах
// prettier-ignore
const RU_SURNAME_EXCLUDE = [
  'вектор', 'ромашка', 'москва', 'директор', 'офис', 'проект', 'план', 'отдел', 'склад', 'завод', 'цех', 'магазин', 'рынок', 'порт',
  'вокзал', 'театр', 'музей', 'школа', 'институт', 'университет', 'академия', 'клуб', 'парк', 'сад', 'мост', 'храм', 'собор', 'кремль',
  'новгород', 'петербург', 'киев', 'минск', 'казань', 'самара', 'тула', 'уфа', 'пенза', 'тверь', 'орел', 'курск', 'омск', 'томск',
  'кострома', 'вологда', 'калуга', 'рязань', 'смоленск', 'брянск', 'липецк', 'тамбов', 'саратов', 'воронеж', 'ростов', 'краснодар',
  'сочи', 'ялта', 'крым', 'кавказ', 'сибирь', 'урал', 'волга', 'дон', 'нева', 'ока', 'кама', 'лена', 'обь', 'енисей', 'байкал', 'амур',
  'европа', 'азия', 'америка', 'африка', 'германия', 'франция', 'англия', 'италия', 'испания', 'польша', 'украина', 'беларусь', 'китай',
  'япония', 'индия', 'турция', 'грузия', 'армения', 'казахстан', 'узбекистан', 'бог', 'господь', 'христос', 'царь', 'бутик', 'банкир',
  // частые слова деловых текстов
  'книга', 'правда', 'правило', 'практика', 'класс', 'знак', 'модель', 'камера', 'музыка', 'фигура', 'точка', 'шкала', 'курс', 'рейс',
  'пресс', 'приз', 'штаб', 'шеф', 'бланк', 'блок', 'дума', 'спец', 'способ', 'поправка', 'приставка', 'дорога', 'рабочий', 'студент',
  'старик', 'ребенок', 'мальчик', 'девочка', 'капитан', 'сержант', 'бригадир', 'комендант', 'беседа', 'война', 'охота', 'песня', 'птица',
  'книжка', 'ручка', 'папка', 'карта', 'марка', 'сумма', 'смета', 'реестр', 'журнал', 'архив', 'кабинет', 'кредит', 'депозит', 'вклад',
  'итог', 'пункт', 'раздел', 'глава', 'статья', 'лист', 'страница', 'форма', 'бланк', 'печать', 'штамп', 'гриф', 'код', 'номер', 'серия',
  'тара', 'груз', 'заказ', 'поставка', 'отгрузка', 'доставка', 'монтаж', 'ремонт', 'сервис', 'гарантия', 'лицензия', 'патент', 'бренд',
  'холдинг', 'концерн', 'трест', 'фонд', 'биржа', 'рынок', 'торг', 'тендер', 'аукцион', 'конкурс', 'лот', 'сделка', 'обмен', 'зачет',
  'новый', 'старый', 'главный', 'русский', 'московский', 'полный', 'общий', 'единый', 'северный', 'южный', 'западный', 'восточный',
  'центральный', 'новгородский', 'красный', 'белый', 'черный', 'зеленый', 'синий', 'золотой', 'серебряный', 'железный', 'каменный',
];

/* ---------- загрузка ---------- */

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function fetchFile(cache, name) {
  const { url, sha256: want } = SOURCES.files[name];
  const path = join(cache, name);
  if (existsSync(path)) {
    const buf = await readFile(path);
    if (sha256(buf) === want) return buf;
  }
  // curl учитывает http(s)_proxy окружения (fetch в Node 22 — нет); без curl — fetch
  let buf;
  try {
    execFileSync('curl', ['-sfL', '--retry', '2', '-A', 'docx-anonymizer-make-dicts', '-o', path, url], { stdio: 'inherit' });
    buf = await readFile(path);
  } catch {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  }
  const got = sha256(buf);
  if (got !== want) throw new Error(`${name}: sha256 ${got} ≠ ${want}`);
  await writeFile(path, buf);
  return buf;
}

async function readParquet(buf) {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return parquetReadObjects({ file: ab, columns: ['text', 'count', 'gender'] });
}

/* ---------- сборка списков ---------- */

const RU_RE = /^[а-я]+(?:-[а-я]+)*$/;

function mascOf(w) {
  for (const [re, rep] of FEM_TO_MASC) if (re.test(w)) return w.replace(re, rep);
  return w;
}

/** Русские имена: лемма → род. */
function buildRuFirst(rows, maybeFirst, surnameCounts) {
  /** @type {Map<string, {m: number, f: number, u: number, all: number}>} */
  const acc = new Map();
  for (const r of rows) {
    const w = lowerE(String(r.text || '').trim());
    if (!/^[а-я]{3,}(?:-[а-я]{2,})?$/.test(w)) continue;
    let a = acc.get(w);
    if (!a) acc.set(w, (a = { m: 0, f: 0, u: 0, all: 0 }));
    const c = Number(r.count) || 0;
    a.all += c;
    if (r.gender === 'm' || r.gender === 'f' || r.gender === 'u') a[r.gender] += c;
  }
  const fn = new Set(RU_FUNCTION_WORDS);
  /** @type {Map<string, 'm'|'f'|'u'>} */
  const out = new Map();
  for (const [w, a] of acc) {
    if (a.all < RU_NAME_MIN_COUNT) continue;
    if (a.m + a.f + a.u === 0) continue;
    // «Николаев», «Борисов» в списке имён — ошибки разметки источника: чаще встречаются как фамилии
    if ((surnameCounts.get(w) || 0) > a.all) continue;
    if (fn.has(w) || isStopWord(w) || patronymicInfo(w)) continue;
    if (/(?:ович|евич|овна|евна|ична|ский|цкий|ская|цкая)$/.test(w)) continue;
    const big = Math.max(a.m, a.f);
    const small = Math.min(a.m, a.f);
    const g = a.u > big || (small > 0 && small >= 0.1 * big) ? 'u' : a.m >= a.f ? 'm' : 'f';
    out.set(w, g);
  }
  // курируемые списки lexicon.js — всегда в словаре
  for (const n of MALE_NAMES_RU) if (!out.has(lowerE(n))) out.set(lowerE(n), 'm');
  for (const n of FEMALE_NAMES_RU) if (!out.has(lowerE(n))) out.set(lowerE(n), 'f');
  const ambiguousSrc = new Set([...AMBIGUOUS_NAMES_RU, ...COMMON_NOUNS, ...maybeFirst, ...STOP_EXACT, ...RU_NAME_AMBIGUOUS_EXTRA].map(lowerE));
  const ambiguous = [...out.keys()].filter((w) => ambiguousSrc.has(w));
  return { names: out, ambiguous };
}

/** Частоты фамилий по мужской лемме (женские формы приведены к мужским). */
function surnameCounts(rows) {
  /** @type {Map<string, number>} */
  const acc = new Map();
  for (const r of rows) {
    let w = lowerE(String(r.text || '').trim());
    if (w.length < 3 || !RU_RE.test(w)) continue;
    if (r.gender !== 'm') w = w.split('-').map(mascOf).join('-');
    acc.set(w, (acc.get(w) || 0) + (Number(r.count) || 0));
  }
  return acc;
}

/** Русские фамилии: мужские леммы, top N по частоте. */
function buildRuSurnames(acc, nameLemmas) {
  const exclude = new Set(RU_SURNAME_EXCLUDE);
  const ok = (w) =>
    !exclude.has(w) && !COMMON_NOUNS.has(w) && !nameLemmas.has(w) && !w.split('-').some((p) => p.length < 2 || isStopWord(p) || COMMON_NOUNS.has(p));
  return [...acc]
    .filter(([w]) => ok(w))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, RU_SURNAMES_TOP)
    .map(([w]) => w);
}

function buildEnFirst(male, female) {
  const out = new Set();
  const exclude = new Set(EN_FIRST_EXCLUDE);
  for (const txt of [male, female]) {
    for (const line of txt.split('\n')) {
      const m = /^([A-Z]+)\s+[\d.]+\s+[\d.]+\s+(\d+)\s*$/.exec(line);
      if (!m || Number(m[2]) > EN_FIRST_MAX_RANK) continue;
      const w = m[1].toLowerCase();
      if (w.length < 3 || exclude.has(w) || COMMON_NOUNS.has(w) || STOP_EXACT.has(w) || isStopWord(w)) continue;
      out.add(w);
    }
  }
  return [...out];
}

function buildEnSurnames(csv) {
  const rows = [];
  for (const line of csv.split('\n').slice(1)) {
    const [name, rank] = line.split(',');
    const w = (name || '').toLowerCase();
    const k = Number(rank);
    if (!k || !/^[a-z]{2,}$/.test(w)) continue;
    rows.push([w, k]);
  }
  return rows
    .sort((a, b) => a[1] - b[1])
    .slice(0, EN_SURNAMES_TOP)
    .map(([w]) => w);
}

/* ---------- модули ---------- */

const header = (what, src, n) =>
  `// СГЕНЕРИРОВАНО scripts/make-dicts.mjs — не редактировать вручную (npm run dicts). WP7, FR-23.\n` +
  `// ${what}: ${n} записей. Формат — front-coding (codec.js).\n` +
  `// Источник: ${src}\n` +
  `// Дата выгрузки: ${SOURCES.retrieved}. Лицензии и атрибуция — NOTICE.md.\n`;

const lit = (s) => '`' + s + '`';

function modules({ ruSurnames, ruFirst, ambiguous, enFirst, enSurnames }) {
  const dc = `${SOURCES.datacoon.repo} @ ${SOURCES.datacoon.sha} (${SOURCES.datacoon.license})`;
  const byG = (g) => [...ruFirst].filter(([, x]) => x === g).map(([w]) => w);
  return {
    'ru-surnames.js':
      header(
        'Русские фамилии (мужские леммы, женские формы приведены к мужским, top по частоте)',
        dc + ', russiannames/data/surnames.parquet',
        ruSurnames.length,
      ) + `export default ${lit(encodeList(ruSurnames))};\n`,
    'ru-first.js':
      header(
        'Русские имена (леммы) по роду; AMBIGUOUS — омонимы нарицательных',
        `${dc}, russiannames/data/names.parquet; омонимы — ${SOURCES.natasha.repo} @ ${SOURCES.natasha.sha} (${SOURCES.natasha.license}), natasha/data/dict/maybe_first.txt`,
        ruFirst.size,
      ) +
      `export const MALE = ${lit(encodeList(byG('m')))};\n` +
      `export const FEMALE = ${lit(encodeList(byG('f')))};\n` +
      `export const UNISEX = ${lit(encodeList(byG('u')))};\n` +
      `export const AMBIGUOUS = ${lit(encodeList(ambiguous))};\n`,
    'en-first.js':
      header(
        'Английские имена (ранг ≤ 5000, муж. и жен.)',
        `US Census 1990, ${SOURCES.census1990.url} (dist.male.first, dist.female.first), public domain`,
        enFirst.length,
      ) + `export default ${lit(encodeList(enFirst))};\n`,
    'en-surnames.js':
      header('Английские фамилии (top 10 000)', `US Census 2010, ${SOURCES.census2010.url} (names.zip), public domain`, enSurnames.length) +
      `export default ${lit(encodeList(enSurnames))};\n`,
  };
}

function notice(bsd, mit) {
  return `# Словари ФИО: источники и лицензии

Модули \`ru-surnames.js\`, \`ru-first.js\`, \`en-first.js\`, \`en-surnames.js\` сгенерированы \`scripts/make-dicts.mjs\`
(\`npm run dicts\`, выгрузка ${SOURCES.retrieved}) из перечисленных ниже наборов данных. Данные отфильтрованы
(нижний регистр, «ё» → «е», без стоп-слов и нарицательных), фамилии приведены к мужской лемме и упакованы front-coding (\`codec.js\`).

## datacoon/russiannames

- Репозиторий: ${SOURCES.datacoon.repo}, коммит \`${SOURCES.datacoon.sha}\`
- Файлы: \`russiannames/data/surnames.parquet\`, \`russiannames/data/names.parquet\`
- Используется в: \`ru-surnames.js\`, \`ru-first.js\`
- Лицензия: BSD-3-Clause

\`\`\`
${bsd.trim()}
\`\`\`

## natasha/natasha

- Репозиторий: ${SOURCES.natasha.repo}, коммит \`${SOURCES.natasha.sha}\`
- Файл: \`natasha/data/dict/maybe_first.txt\` (имена-омонимы нарицательных); \`last.txt\` — только для метрики генератора, в расширение не входит
- Используется в: \`ru-first.js\` (\`AMBIGUOUS\`)
- Лицензия: MIT (Natasha project)

\`\`\`
${mit.trim()}
\`\`\`

## U.S. Census Bureau

- 1990 Census, Frequently Occurring Names: ${SOURCES.census1990.url} (\`dist.male.first\`, \`dist.female.first\`) → \`en-first.js\`
- 2010 Census, Frequently Occurring Surnames: ${SOURCES.census2010.url} (\`names.zip\`) → \`en-surnames.js\`
- Лицензия: public domain — работы федерального правительства США не охраняются авторским правом (17 U.S.C. § 105).
`;
}

/* ---------- CLI ---------- */

async function main() {
  const check = process.argv.includes('--check');
  const cacheArg = process.argv.find((a) => a.startsWith('--cache='));
  const cache = resolve(cacheArg ? cacheArg.slice('--cache='.length) : '/home/alexf14/.local/tmp/claude-1000/docx-anon-dicts');
  await mkdir(cache, { recursive: true });
  const get = (n) => fetchFile(cache, n);

  const t0 = performance.now();
  const [surRows, nameRows] = [await readParquet(await get('surnames.parquet')), await readParquet(await get('names.parquet'))];
  const maybeFirst = (await get('natasha-maybe_first.txt'))
    .toString('utf8')
    .split('\n')
    .map((l) => lowerE(l.replace(/#.*/, '').trim()))
    .filter(Boolean);
  const natashaLast = new Set(
    (await get('natasha-last.txt'))
      .toString('utf8')
      .split('\n')
      .map((l) => lowerE(l.trim()))
      .filter(Boolean),
  );
  const zip = unzipSync(new Uint8Array(await get('names.zip')));
  const census2010 = strFromU8(zip['Names_2010Census.csv']);

  const surCounts = surnameCounts(surRows);
  const { names: ruFirst, ambiguous } = buildRuFirst(nameRows, maybeFirst, surCounts);
  const ruSurnames = buildRuSurnames(surCounts, new Set(ruFirst.keys()));
  const enFirst = buildEnFirst((await get('dist.male.first')).toString('latin1'), (await get('dist.female.first')).toString('latin1'));
  const enSurnames = buildEnSurnames(census2010);

  const files = modules({ ruSurnames, ruFirst, ambiguous, enFirst, enSurnames });
  files['NOTICE.md'] = notice((await get('datacoon-LICENSE')).toString('utf8'), (await get('natasha-LICENSE')).toString('utf8'));

  const g = (x) => [...ruFirst.values()].filter((v) => v === x).length;
  const inNatasha = ruSurnames.filter((w) => natashaLast.has(w)).length;
  console.log(`ru-surnames: ${ruSurnames.length}; в natasha last.txt: ${inNatasha} (${((100 * inNatasha) / ruSurnames.length).toFixed(1)} %)`);
  console.log(`ru-first: ${ruFirst.size} (m ${g('m')}, f ${g('f')}, u ${g('u')}), омонимов ${ambiguous.length}`);
  console.log(`en-first: ${enFirst.length}; en-surnames: ${enSurnames.length}`);
  for (const [name, text] of Object.entries(files)) console.log(`  ${name}: ${Buffer.byteLength(text)} байт`);
  console.log(`за ${Math.round(performance.now() - t0)} мс`);

  if (check) {
    const bad = [];
    for (const [name, text] of Object.entries(files)) {
      const p = join(OUT, name);
      if (!existsSync(p) || (await readFile(p, 'utf8')) !== text) bad.push(name);
    }
    if (bad.length) {
      console.error(`расходятся с регенерацией: ${bad.join(', ')}`);
      process.exit(1);
    }
    console.log('словари совпадают с регенерацией');
    return;
  }
  await mkdir(OUT, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(OUT, name), text);
  console.log(`записано в ${OUT}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
