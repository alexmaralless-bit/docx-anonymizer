// Документный детектор WP2: PERSON/COMPANY по правилам + база знаний сторон (FR-21–FR-23).
//
// Почему PERSON/COMPANY ищутся здесь, а не потоковыми детекторами: группа «одно значение → один плейсхолдер»
// определяется ключом (category, canonical|normalized). Чтобы «Иванова Петра Сергеевича», «Иванов П.С.»,
// «П.С. Иванов» и «Иванову» получили один плейсхолдер, каждому вхождению нужен общий canonical, а он
// известен только после просмотра всего документа (кто стороны, какие у них ФИО). Потоковый кандидат
// без canonical при равном уровне выиграл бы у KB-варианта того же диапазона (FR-20, шаг 4–5), и группы
// бы не склеились. Поэтому правило и KB работают в одном проходе и каждый диапазон выдаётся ровно один раз.
//
// 1. Правила по всем потокам (кроме авторов, rel-target, field-instr): компании, затем ФИО вне компаний.
// 2. Зоны сторон (FR-22): блок реквизитов (после заголовка из списка или последние 25 % + таблицы
//    с ≥ 2 лейблами ИНН/КПП/ОГРН/счёт) и преамбула (до «1.» или первые 10 %).
// 3. Записи о лицах: ФИО лемматизируются (падеж/род по отчеству), «Фамилия И.О.» присоединяются
//    к полному ФИО по формам фамилии и инициалам. Записи о компаниях — по названию без ОПФ.
// 4. Вхождения правил получают canonical своей записи; для сторон (запись встречена в зоне)
//    ищутся варианты по всему документу — уровень kb.

import { findPersons } from './person.js';
import { findCompanies } from './company.js';
import { tokenize, tokenSeq, escapeRe, pickNonOverlapping, overlaps } from './text.js';
import { lowerE, COMMON_NOUNS, isStopWord } from './lexicon.js';
import { lemmatizeFullName, lemmatizeNamePair, declineSurname, declineFirstName, declinePatronymic, surnameFormsAnyGender, firstNameInfo } from './morph.js';
import { skeleton, skeletonWeight, isCyrillic, crossScriptMatch } from './translit.js';

const MAIN = 'word/document.xml';
const SKIP_ATTR = new Set(['author', 'initials', 'author-id', 'rel-target', 'field-instr']);

export const norm = (s) => lowerE(s.replace(/\s+/g, ' ').trim());

/** Потоки, в которых ищем имена и названия. */
export function scannable(stream) {
  if (stream.type === 'field') return false;
  if (stream.type === 'attr' && SKIP_ATTR.has(stream.attrKind || '')) return false;
  return true;
}

/* ---------------- зоны сторон (FR-22) ---------------- */

// prettier-ignore
const HEADINGS = [
  'реквизиты сторон', 'адреса и реквизиты', 'адреса, реквизиты', 'юридические адреса', 'подписи сторон', 'реквизиты и подписи',
  'адреса и банковские реквизиты', 'реквизиты', 'signatures of the parties', 'details of the parties', 'notices',
  'addresses of the parties', 'signatures',
].map(lowerE);
const TABLE_LABEL_RE = /(?<![\p{L}])(?:инн|кпп|огрн|огрнип|р\/с|к\/с|расч[её]тный сч[её]т|корр?\.? ?сч[её]т|inn|kpp|ogrn|account no)(?![\p{L}])/giu;

function isHeading(text) {
  const t = lowerE(text)
    .replace(/^[\s\d.)ivx]+/i, '')
    .replace(/[\s.:]+$/, '')
    .trim();
  if (!t || t.length > 80) return false;
  return HEADINGS.some((h) => t === h || (t.startsWith(h) && t.length <= h.length + 30) || (t.includes(h) && t.length <= h.length + 20));
}

/** Диапазоны таблиц верхнего уровня в XML части. */
function tableRanges(xml) {
  const out = [];
  const re = /<w:tbl[ >]|<\/w:tbl>/g;
  let depth = 0;
  let start = 0;
  let m;
  while ((m = re.exec(xml))) {
    if (m[0][1] === '/') {
      depth--;
      if (depth === 0) out.push({ start, end: m.index });
    } else {
      if (depth === 0) start = m.index;
      depth++;
    }
  }
  return out;
}

/**
 * @param {import('../../docx/model.js').DocModel} doc
 * @returns {{block: Set<string>, preamble: Set<string>}} pid параграфов
 */
export function findPartyZones(doc) {
  const paras = doc.paragraphs.filter((p) => p.part === MAIN);
  const textOf = (p) => (p.streams.live && doc.streamById.get(p.streams.live)?.text) || '';
  const block = new Set();
  const preamble = new Set();
  const n = paras.length;
  if (!n) return { block, preamble };

  const h = paras.findIndex((p) => isHeading(textOf(p)));
  if (h >= 0) {
    for (let i = h + 1; i < n; i++) block.add(paras[i].pid);
  } else {
    for (let i = Math.floor(n * 0.75); i < n; i++) block.add(paras[i].pid);
    const part = doc.parts.get(MAIN);
    if (part) {
      for (const r of tableRanges(part.xml)) {
        const inside = paras.filter((p) => p.pos >= r.start && p.pos < r.end);
        const labels = inside.reduce((acc, p) => acc + (textOf(p).match(TABLE_LABEL_RE) || []).length, 0);
        if (labels >= 2) for (const p of inside) block.add(p.pid);
      }
    }
  }
  const first = paras.findIndex((p) => /^\s*1\.(?!\d)/.test(textOf(p)));
  const pre = first > 0 ? first : Math.max(1, Math.ceil(n * 0.1));
  for (let i = 0; i < Math.min(pre, n); i++) preamble.add(paras[i].pid);
  return { block, preamble };
}

/* ---------------- записи о лицах ---------------- */

/**
 * @typedef {object} PersonRec
 * @property {'full'|'pair'|'initials'|'other'} kind
 * @property {string} canonical
 * @property {boolean} latin
 * @property {string} surname     лемма (или форма как написано)
 * @property {string} [first]
 * @property {string} [patronymic]
 * @property {string} initials    буквы: «пс»
 * @property {Set<string>} surnameForms
 * @property {Set<string>} firstForms
 * @property {Set<string>} patrForms
 * @property {boolean} party
 */

class PersonBase {
  constructor() {
    /** @type {PersonRec[]} */
    this.recs = [];
  }

  byCanonical(c) {
    return this.recs.find((r) => r.canonical === c);
  }

  add(rec) {
    const ex = this.byCanonical(rec.canonical);
    if (ex) return ex;
    this.recs.push(rec);
    return rec;
  }

  fullRec(l) {
    const canonical = `${l.surname} ${l.first} ${l.patronymic}`;
    return this.add({
      kind: 'full',
      canonical,
      latin: false,
      surname: l.surname,
      first: l.first,
      patronymic: l.patronymic,
      initials: l.first[0] + l.patronymic[0],
      surnameForms: new Set(declineSurname(l.surname, l.gender)),
      firstForms: new Set(declineFirstName(l.first, l.gender)),
      patrForms: new Set(declinePatronymic(l.patronymic, l.gender)),
      party: false,
    });
  }

  /**
   * Присоединяет разбор ФИО к записи (создаёт новую при необходимости).
   * @param {import('./person.js').PersonParse} p
   * @returns {PersonRec}
   */
  link(p) {
    const latin = p.script === 'lat';
    if (p.kind === 'full' && !latin) {
      const l = lemmatizeFullName({
        surname: /** @type {string} */ (p.surname),
        first: /** @type {string} */ (p.first),
        patronymic: /** @type {string} */ (p.patronymic),
      });
      if (l) return this.fullRec(l);
    }
    if (p.kind === 'pair' && p.surname && p.first) {
      const s = lowerE(p.surname);
      const f = lowerE(p.first);
      const hits = this.recs.filter((r) => r.latin === latin && r.first && r.surnameForms.has(s) && r.firstForms.has(f));
      if (hits.length === 1) return hits[0];
      if (latin) {
        return this.add({
          kind: 'pair',
          canonical: `${f} ${s}`,
          latin,
          surname: s,
          first: f,
          initials: f[0],
          surnameForms: new Set([s]),
          firstForms: new Set([f]),
          patrForms: new Set(),
          party: false,
        });
      }
      const lp = lemmatizeNamePair(p.surname, p.first);
      if (lp) {
        return this.add({
          kind: 'pair',
          canonical: `${lp.surname} ${lp.first}`,
          latin,
          surname: lp.surname,
          first: lp.first,
          initials: lp.first[0],
          surnameForms: new Set(declineSurname(lp.surname, lp.gender)),
          firstForms: new Set(declineFirstName(lp.first, lp.gender)),
          patrForms: new Set(),
          party: false,
        });
      }
    }
    if (p.kind === 'initials' && p.surname && p.initials) {
      const s = lowerE(p.surname);
      const ini = p.initials;
      const compatible = (r) =>
        r.initials === ini || (r.initials.startsWith(ini) && ini.length >= 1) || (ini.startsWith(r.initials) && !r.patronymic && r.kind !== 'initials');
      const named = this.recs.filter((r) => r.latin === latin && r.kind !== 'initials' && r.kind !== 'other' && r.surnameForms.has(s) && compatible(r));
      if (named.length === 1) return named[0];
      if (named.length > 1) {
        const exact = named.filter((r) => r.initials === ini);
        if (exact.length === 1) return exact[0];
      }
      const same = this.recs.find((r) => r.kind === 'initials' && r.latin === latin && r.initials === ini && r.surnameForms.has(s));
      if (same) return same;
      return this.add({
        kind: 'initials',
        canonical: `${s} ${ini.split('').join('.')}.`,
        latin,
        surname: s,
        initials: ini,
        surnameForms: latin ? new Set([s]) : surnameFormsAnyGender(s),
        firstForms: new Set(),
        patrForms: new Set(),
        party: false,
      });
    }
    if (p.words.length === 1) {
      // «Mr. Smith» — одиночная фамилия после обращения: к единственной записи с такой фамилией
      const w = lowerE(p.words[0]);
      const hits = this.recs.filter((r) => r.latin === latin && r.kind !== 'other' && r.surnameForms.has(w));
      if (hits.length === 1) return hits[0];
    }
    const canonical = norm(p.words.join(' '));
    return this.add({
      kind: 'other',
      canonical,
      latin,
      surname: lowerE(p.surname || p.words[0]),
      initials: '',
      surnameForms: new Set(),
      firstForms: new Set(),
      patrForms: new Set(),
      party: false,
    });
  }
}

const KIND_ORDER = { full: 0, pair: 1, initials: 2, other: 3 };

/* ---------------- поиск вариантов ---------------- */

const HONORIFIC_BEFORE = /(?:mr|mrs|ms|miss|dr|prof)\.?[ \u00A0]+$/i;

/** Можно ли искать фамилию записи в одиночку (R-6). */
function surnameAloneOk(rec) {
  return rec.surname.length >= 4 && !COMMON_NOUNS.has(rec.surname) && !isStopWord(rec.surname) && firstNameInfo(rec.surname).length === 0;
}

/**
 * Сопоставление последовательности токенов с записью о лице.
 * @param {PersonRec} r
 * @param {import('./text.js').Token[]} a
 * @param {string} text
 */
function personMatches(r, a, text) {
  const low = a.map((t) => lowerE(t.text));
  const isW = a.map((t) => t.t === 'W');
  const S = (k) => isW[k] && r.surnameForms.has(low[k]);
  const F = (k) => isW[k] && r.firstForms.has(low[k]);
  const P = (k) => isW[k] && r.patrForms.has(low[k]);
  const I = (k, ch) => !isW[k] && ch && low[k] === ch;
  const ini = r.initials;
  if (a.length === 3) {
    if (r.patronymic && ((S(0) && F(1) && P(2)) || (F(0) && P(1) && S(2)))) return true;
    if (ini.length === 2 && ((S(0) && I(1, ini[0]) && I(2, ini[1])) || (I(0, ini[0]) && I(1, ini[1]) && S(2)))) return true;
    return false;
  }
  if (a.length === 2) {
    if (r.first && ((S(0) && F(1)) || (F(0) && S(1)))) return true;
    if (r.latin && r.first && ((I(0, r.first[0]) && S(1)) || (F(0) && I(1, r.surname[0])))) return true;
    return false;
  }
  if (a.length === 1 && S(0)) {
    if (r.kind === 'other') return false;
    const honor = HONORIFIC_BEFORE.test(text.slice(Math.max(0, a[0].start - 8), a[0].start));
    return honor || surnameAloneOk(r);
  }
  return false;
}

/** Латинское «Last, First». */
function lastCommaFirst(r, toks, i, text) {
  if (!r.latin || !r.first || i + 1 >= toks.length) return null;
  const a = toks[i];
  const b = toks[i + 1];
  if (a.t !== 'W' || b.t !== 'W' || !/^,[ \u00A0]$/.test(text.slice(a.end, b.start))) return null;
  return r.surnameForms.has(lowerE(a.text)) && r.firstForms.has(lowerE(b.text)) ? { start: a.start, end: b.end } : null;
}

function domainAdjacent(text, start, end) {
  const prev = text[start - 1] || '';
  const next = text[end] || '';
  if (/[@./\\_]/.test(prev)) return true;
  if (next === '@' || next === '_') return true;
  if ((next === '.' || next === '/') && /[\p{L}\p{N}]/u.test(text[end + 1] || '')) return true;
  return false;
}

/**
 * @typedef {object} CompanyRec
 * @property {string} canonical
 * @property {string} core
 * @property {boolean} party
 * @property {'org'|'ip'} kind
 * @property {string} skel
 * @property {'cyr'|'lat'} script
 * @property {string} abbr
 * @property {number} words
 */

function makeCompanyRec(core, kind) {
  const words = core.split(/[\s\u00A0]+/).filter(Boolean);
  const capWords = core.split(/[\s\u00A0-]+/).filter((w) => /^[\p{Lu}]/u.test(w));
  const abbr =
    capWords.length >= 2
      ? capWords
          .map((w) => w[0])
          .join('')
          .toUpperCase()
      : '';
  return {
    canonical: norm(core),
    core,
    party: false,
    kind,
    skel: skeleton(core),
    script: isCyrillic(core) ? 'cyr' : 'lat',
    abbr: abbr.length >= 3 ? abbr : '',
    words: words.length,
  };
}

/* ---------------- детектор ---------------- */

/**
 * @param {import('../../docx/model.js').DocModel} doc
 * @param {import('../../contracts/entity.js').Entity[]} _entities
 * @param {{settings?: any, isEnabled?: (id: string) => boolean}} ctx
 * @returns {import('../../contracts/entity.js').Candidate[]}
 */
export function detectNamesAndKb(doc, _entities, ctx = {}) {
  const isEnabled = ctx.isEnabled || (() => true);
  const wantP = isEnabled('PERSON');
  const wantC = isEnabled('COMPANY');
  if (!wantP && !wantC) return [];
  const govEntities = ctx.settings?.govEntities !== false;

  const streams = doc.streams.filter(scannable);
  const { block, preamble } = findPartyZones(doc);
  const inZone = (s) => !!s.pid && s.part === MAIN && (block.has(s.pid) || preamble.has(s.pid));

  // 1. Правила
  /** @type {Map<string, {companies: import('./company.js').CompanySpan[], persons: import('./person.js').PersonSpan[]}>} */
  const found = new Map();
  for (const s of streams) {
    if (!s.text || !/[\p{Lu}]/u.test(s.text)) continue;
    const companies = findCompanies(s.text, { govEntities });
    const persons = findPersons(s.text).filter((p) => !companies.some((c) => overlaps(c, p)));
    if (companies.length || persons.length) found.set(s.id, { companies, persons });
  }

  // 2–3. Записи
  const people = new PersonBase();
  /** @type {Map<string, CompanyRec>} */
  const companies = new Map();
  /** @type {{stream: any, span: any, parse: any, party: boolean}[]} */
  const personOcc = [];
  for (const s of streams) {
    const f = found.get(s.id);
    if (!f) continue;
    const zone = inZone(s);
    for (const c of f.companies) {
      const key = norm(c.core);
      let rec = companies.get(key);
      if (!rec) companies.set(key, (rec = makeCompanyRec(c.core, c.kind)));
      if (zone) rec.party = true;
      if (c.kind === 'ip' && c.person) {
        const p = c.person;
        const words = text(s, p.start, p.end).split(/[\s\u00A0]+/);
        personOcc.push({
          stream: s,
          span: null,
          parse: p.initials
            ? { kind: 'initials', script: 'cyr', surname: p.surname, initials: p.initials, words }
            : { kind: 'full', script: 'cyr', surname: p.surname, first: p.first, patronymic: p.patronymic, words },
          party: zone,
        });
      }
    }
    for (const p of f.persons) personOcc.push({ stream: s, span: p, parse: p.parse, party: zone });
  }
  personOcc.sort((a, b) => KIND_ORDER[a.parse.kind] - KIND_ORDER[b.parse.kind]);
  const recOf = new Map();
  for (const o of personOcc) {
    const rec = people.link(o.parse);
    if (o.party) rec.party = true;
    recOf.set(o, rec);
  }

  // Межалфавитные и сокращённые названия правил → запись стороны
  // (главная — первая встреченная запись стороны с тем же «скелетом» в другом алфавите или с такой аббревиатурой)
  const sameCompany = (a, b) =>
    a === b || (a.script !== b.script && crossScriptMatch(a.core, b.core)) || (!!a.abbr && b.core === a.abbr) || (!!b.abbr && a.core === b.abbr);
  const companyCanonical = (rec) => {
    for (const p of companies.values()) if (p.kind === 'org' && p.party && sameCompany(p, rec)) return p.canonical;
    return rec.canonical;
  };

  /** @type {import('../../contracts/entity.js').Candidate[]} */
  const out = [];
  /** @type {Map<string, {start: number, end: number}[]>} */
  const occupied = new Map();
  const occupy = (sid, span) => {
    let arr = occupied.get(sid);
    if (!arr) occupied.set(sid, (arr = []));
    arr.push(span);
  };

  // 4а. Вхождения правил
  for (const s of streams) {
    const f = found.get(s.id);
    if (!f) continue;
    for (const c of f.companies) {
      const rec = /** @type {CompanyRec} */ (companies.get(norm(c.core)));
      const canonical = companyCanonical(rec);
      out.push({
        streamId: s.id,
        category: 'COMPANY',
        start: c.start,
        end: c.end,
        keepPrefix: c.keepPrefix,
        keepSuffix: c.keepSuffix,
        confidence: 'labeled',
        source: 'rule',
        ...(canonical !== norm(c.core) ? { canonical } : {}),
      });
      occupy(s.id, c);
    }
  }
  for (const o of personOcc) {
    if (!o.span) continue;
    const rec = recOf.get(o);
    const t = norm(text(o.stream, o.span.start, o.span.end));
    out.push({
      streamId: o.stream.id,
      category: 'PERSON',
      start: o.span.start,
      end: o.span.end,
      confidence: 'labeled',
      source: o.span.labeled ? 'label' : 'rule',
      ...(rec.canonical !== t ? { canonical: rec.canonical } : {}),
    });
    occupy(o.stream.id, o.span);
  }

  // 4б. Варианты сторон по всему документу (уровень kb)
  const partyPeople = people.recs.filter((r) => r.party && r.kind !== 'other');
  const partyCompanies = [...companies.values()].filter((r) => r.party && r.kind === 'org');
  const bareRes = partyCompanies.map((r) => ({
    rec: r,
    re: new RegExp(
      `(?<![\\p{L}\\p{N}])${r.core
        .split(/[\s\u00A0]+/)
        .map(escapeRe)
        .join('[ \\u00A0]+')}(?![\\p{L}\\p{N}])`,
      'giu',
    ),
    abbrRe: r.abbr ? new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(r.abbr)}(?![\\p{L}\\p{N}])`, 'gu') : null,
  }));

  if (partyPeople.length || partyCompanies.length) {
    for (const s of streams) {
      const t = s.text;
      if (!t || !/[\p{Lu}]/u.test(t)) continue;
      const busy = occupied.get(s.id) || [];
      /** @type {{start: number, end: number, category: string, canonical: string}[]} */
      const cands = [];
      const free = (sp) => !busy.some((b) => overlaps(b, sp));

      if (partyPeople.length) {
        const toks = tokenize(t);
        for (let i = 0; i < toks.length; i++) {
          for (const n of [3, 2, 1]) {
            const a = tokenSeq(t, toks, i, n);
            if (!a) continue;
            const hits = partyPeople.filter((r) => r.latin === (a[0].script === 'lat') && personMatches(r, a, t));
            if (hits.length === 1) cands.push({ start: a[0].start, end: a[n - 1].end, category: 'PERSON', canonical: hits[0].canonical });
          }
          for (const r of partyPeople) {
            const lc = lastCommaFirst(r, toks, i, t);
            if (lc) cands.push({ ...lc, category: 'PERSON', canonical: r.canonical });
          }
        }
      }

      for (const { rec, re, abbrRe } of bareRes) {
        const single = rec.words === 1;
        const common = single && COMMON_NOUNS.has(rec.canonical);
        for (const m of t.matchAll(re)) {
          const start = /** @type {number} */ (m.index);
          const end = start + m[0].length;
          if (domainAdjacent(t, start, end)) continue;
          if (single && !/^[\p{Lu}\d]/u.test(m[0])) continue;
          if (common && !(/[«"“„']/.test(t[start - 1] || '') && /[»"”“']/.test(t[end] || ''))) continue;
          cands.push({ start, end, category: 'COMPANY', canonical: rec.canonical });
        }
        if (abbrRe) {
          for (const m of t.matchAll(abbrRe)) {
            const start = /** @type {number} */ (m.index);
            if (!domainAdjacent(t, start, start + m[0].length)) cands.push({ start, end: start + m[0].length, category: 'COMPANY', canonical: rec.canonical });
          }
        }
        // транслитерация (ГОСТ 7.79-2000 Б / ИКАО / английское написание): совпадение «скелета» в другом алфавите
        if (skeletonWeight(rec.skel) >= 3) {
          const other = rec.script === 'cyr' ? 'lat' : 'cyr';
          const words = tokenize(t).filter((x) => x.t === 'W' && x.script === other);
          for (let i = 0; i + rec.words <= words.length; i++) {
            const a = tokenSeq(t, words, i, rec.words);
            if (!a) continue;
            const start = a[0].start;
            const end = a[a.length - 1].end;
            if (domainAdjacent(t, start, end)) continue;
            if (crossScriptMatch(t.slice(start, end), rec.core)) cands.push({ start, end, category: 'COMPANY', canonical: rec.canonical });
          }
        }
      }

      for (const c of pickNonOverlapping(cands.filter(free))) {
        out.push({ streamId: s.id, category: c.category, start: c.start, end: c.end, confidence: 'kb', source: 'kb', canonical: c.canonical });
      }
    }
  }

  return out.filter((c) => isEnabled(/** @type {string} */ (c.category)));
}

function text(stream, start, end) {
  return stream.text.slice(start, end);
}
