// Фильтры модельных организаций (версия 0.4, концепция п. 4, К10; §5.2 NLP `docs/spec-full.md`, `docs/contracts.md` §8.3).
// Модель NER обучена на коротких предложениях Википедии и в деловых документах других жанров принимает за ORG заголовки
// капсом («ВХОДИТ»), нумерованные заголовки («05 Цены»), аббревиатуры (ЭДО, MVP), продукты (Word, Excel) и короткие строки
// списков и таблиц. Раннер (`detect/runner.js`) вызывает фильтр только в коммерческом режиме (COMPANY включена), для
// спанов ORG одного live-потока после порога `nerThresholdOrg`.
//
// Порядок проверок (первое сработавшее решает):
//   0а. ОПФ в спане или вплотную к нему («ООО «Ромашка»», «Northwind Systems Ltd.») — сохранить;
//   (2) спан из стоп-списка (`stoplist.js` ∪ `settings.nerStoplist`): целиком, каждым словом («Word и Excel»), слово целиком
//       вокруг спана («Диск» из «Яндекс.Диск»); кириллица — с падежным окончанием до 2 букв — отбросить;
//   0б. название в кавычках или «Студия/Агентство/Бюро/Компания/Группа компаний/Холдинг + Название» — сохранить;
//   (2б) часть спана из стоп-списка, остальные слова в документе не имена собственные («Настройка CRM») — отбросить;
//   (1) спан — весь поток (вне спана нет букв: допускаются номер раздела и знаки, «05 Цены») из ≤ 3 слов, и поток —
//       заголовок, пункт списка или ячейка (`blockKind` ∈ h1|h2|li|cell|heading; ячейка DOCX — по таблицам части), капсом
//       или с «:» в конце; кроме названия, которое в тексте документа употребляется как имя собственное — отбросить;
//   (3) поток — капс-строка или заголовок, и ни одно слово спана (≤ 8 слов) в обычном тексте документа не написано
//       с заглавной не в начале предложения («ВХОДИТ», «АКТ СВЕРКИ ВЗАИМНЫХ РАСЧЁТОВ») — отбросить;
//   (4) фраза: тире с пробелами в спане; слово со строчной буквы, если спан — весь абзац, короткая строка (≤ 5 слов без
//       точки), заголовок, пункт или ячейка; в предложении — спан со строчного слова в начале или служебного в конце
//       («субъектов ПДн», «Новый документ или») — отбросить;
//   (5) обрывок кода: короткий спан из заглавных с цифрой внутри или вплотную («ПС» из «17/ПС-2026») — отбросить;
//   (6) адрес или должность («45 King Street», «Senior Data Analyst») — отбросить;
//   иначе — сохранить (название внутри предложения: «поставщик Ромашка-Трейд обязуется», «Уральский завод точных приборов»).
// Правила 2б, 4–6 и до 8 слов в правиле 3 — расширение §8.3 по прогону корпуса жанров с моделью 1.0.0 (scripts/eval-genres.mjs).
// Чистый JS без chrome.* и DOM; значения документа в логи не попадают.
import { buildStoplist, stopKey, BUILTIN_STOPLIST } from './stoplist.js';
import { PREFIX_FORMS, FULL_FORMS_RE_SRC, SUFFIX_FORMS_RE_SRC, isNeverMaskOrg, lowerE } from '../detect/names/lexicon.js';

/** Виды блока, короткая строка которых — не название в тексте, а заголовок, пункт или ячейка (правило 1). */
const SHORT_LINE_KINDS = new Set(['h1', 'h2', 'li', 'cell', 'heading']);
/** Виды блока — заголовки (правило 3: слова заголовков не считаются употреблением в тексте). */
const HEADING_KINDS = new Set(['h1', 'h2', 'heading']);
const MAX_SHORT_WORDS = 3;
/** Правило 3: заголовок капсом длиннее — «АКТ СВЕРКИ ВЗАИМНЫХ РАСЧЁТОВ», «РЕГЛАМЕНТ РАБОТЫ С ЭЛЕКТРОННЫМИ ДОКУМЕНТАМИ». */
const MAX_HEADING_WORDS = 8;

const NB = '(?<![\\p{L}\\p{N}])';
const NA = '(?![\\p{L}\\p{N}])';
const SHORT_FORMS = [...PREFIX_FORMS].sort((a, b) => b.length - a.length).join('|');
/** ОПФ в спане (короткие и латинские — с учётом регистра, полные русские — без). */
const OPF_CS_RE = new RegExp(`${NB}(?:${SHORT_FORMS}|${SUFFIX_FORMS_RE_SRC})${NA}`, 'u');
const OPF_FULL_RE = new RegExp(`${NB}(?:${FULL_FORMS_RE_SRC})${NA}`, 'iu');
/** ОПФ (и открывающая кавычка) вплотную перед спаном. */
const OPF_BEFORE_CS_RE = new RegExp(`${NB}(?:${SHORT_FORMS})[\\s\\u00a0]*[«"“„'‘]?[\\s\\u00a0]*$`, 'u');
const OPF_BEFORE_FULL_RE = new RegExp(`${NB}(?:${FULL_FORMS_RE_SRC})[\\s\\u00a0]*[«"“„'‘]?[\\s\\u00a0]*$`, 'iu');
/** Латинская ОПФ сразу после спана («Northwind Systems Ltd.»). */
const OPF_AFTER_RE = new RegExp(`^[»"”“'’]?,?[\\s\\u00a0]*(?:${SUFFIX_FORMS_RE_SRC})${NA}`, 'u');
const QUOTE_RE = /[«»"“”„]/u;
const OPEN_BEFORE_RE = /[«"“„'‘][\s\u00a0]*$/u;
const CLOSE_AFTER_RE = /^[\s\u00a0]*[»"”“'’]/u;

/** Родовое слово организации перед названием (правило `company.js` WP11-A): такой спан не фильтруется. */
const GENERIC_ORG_WORDS = ['студия', 'агентство', 'бюро', 'компания', 'группа компаний', 'холдинг', 'гк', 'studio', 'agency', 'group'];

/** Слово: буквы и цифры, внутри — дефис, апостроф, точка («1С», «Ромашка-Трейд», «Mail.ru»). Учитываются слова с буквой. */
const WORD_RE = /[\p{L}\p{N}]+(?:[-‐‑’'.][\p{L}\p{N}]+)*/gu;
/** Номер раздела в начале строки: «05 », «1.2. », «IV. ». */
const NUMBERING_RE = /^[\s\u00a0]*(?:(?:\d+[.)]?)+|[IVXLC]+[.)])[\s\u00a0]+/u;
const LETTER_RE = /\p{L}/u;

const words = (s) => (s.match(WORD_RE) || []).filter((w) => LETTER_RE.test(w));

/** Капс-строка: ≥ 3 букв, ≥ 90 % из них — заглавные. */
export function isCapsLine(text) {
  let up = 0;
  let all = 0;
  for (const ch of text) {
    if (!LETTER_RE.test(ch)) continue;
    all++;
    if (ch !== ch.toLowerCase() && ch === ch.toUpperCase()) up++;
  }
  return all >= 3 && up / all >= 0.9;
}

/** Два слова с заглавной подряд: «Вера Лукина», «Лукина Вера». */
const PAIR_RE = /(?<![\p{L}\p{N}])(\p{Lu}\p{Ll}+)[ \u00a0](?=(\p{Lu}\p{Ll}+)(?![\p{L}\p{N}]))/gu;

/** Основы слова для сравнения падежных форм: само слово и, для кириллицы ≥ 5 букв, без 1–`cut` последних букв (не короче 4). */
function stems(word, cut) {
  const w = lowerE(word);
  const out = [w];
  if (/^[а-я]/.test(w) && w.length >= 5) for (let k = 1; k <= cut && w.length - k >= 4; k++) out.push(w.slice(0, -k));
  return out;
}

/** Таблицы DOCX: тексты live-потоков абзацев внутри w:tbl основной части (у DOCX `paragraph.kind` ячейки — 'p'). */
function docxCellTexts(doc) {
  const out = new Set();
  const part = doc.parts?.get?.('word/document.xml');
  if (!part?.xml || doc.tables) return out;
  const ranges = [];
  const re = /<w:tbl[ >]|<\/w:tbl>/g;
  let depth = 0;
  let start = 0;
  let m;
  while ((m = re.exec(part.xml))) {
    if (m[0][1] === '/') {
      depth--;
      if (depth === 0) ranges.push([start, m.index]);
    } else {
      if (depth === 0) start = m.index;
      depth++;
    }
  }
  if (!ranges.length) return out;
  for (const p of doc.paragraphs || []) {
    if (p.part !== 'word/document.xml' || !p.streams?.live) continue;
    if (!ranges.some(([a, b]) => p.pos >= a && p.pos < b)) continue;
    const s = doc.streamById.get(p.streams.live);
    if (s?.text) out.add(s.text);
  }
  return out;
}

/**
 * Контекст документа для фильтра: строится один раз на анализ.
 * - `stoplist` — ключи `stopKey` встроенного стоп-списка и `settings.nerStoplist`;
 * - `properStems` — основы слов, которые в обычном тексте (не капс-строка, не заголовок) хоть раз написаны с заглавной
 *   не в начале предложения (правило 3);
 * - `cellTexts` — тексты абзацев в таблицах DOCX (правило 1; у текстовой модели PDF вид ячейки приходит в `blockKind`).
 * @param {import('../docx/model.js').DocModel} doc
 * @param {object} settings  эффективные настройки (`nerStoplist` — пользовательское дополнение стоп-списка)
 * @returns {{stoplist: Set<string>, properStems: Set<string>, cellTexts: Set<string>, pairedWords: Set<string>}}
 */
export function createOrgFilterContext(doc, settings) {
  const kindByPid = new Map((doc?.paragraphs || []).map((p) => [p.pid, p.kind]));
  const properStems = new Set();
  for (const s of doc?.streams || []) {
    if (s.type !== 'live' || !s.text) continue;
    if (HEADING_KINDS.has(kindByPid.get(s.pid) || '') || isCapsLine(s.text)) continue;
    for (const m of s.text.matchAll(WORD_RE)) {
      const w = m[0];
      const first = w[0];
      if (!LETTER_RE.test(first) || first === first.toLowerCase()) continue;
      // начало потока или предложения: «Входит в стоимость…» — не имя собственное
      const before = s.text.slice(0, m.index).replace(/[\s\u00a0]+$/, '');
      if (!before || /[.!?:;•\-–—(«"“]$/.test(before) || /^\d+[.)]?$/.test(before)) continue;
      for (const part of [w, ...w.split(/[-‐‑]/)]) for (const st of stems(part, 3)) properStems.add(st);
    }
  }
  // слова, стоящие в документе рядом с другим словом с заглавной («Вера Лукина», «Лукина Вера»): имя человека документа
  // (фильтр PER/LOC не снимает омоним «Вера в …», если в документе есть Вера, WP11-D)
  const pairedWords = new Set();
  for (const s of doc?.streams || []) {
    if (s.type !== 'live' || !s.text) continue;
    for (const m of s.text.matchAll(PAIR_RE)) {
      pairedWords.add(lowerE(m[1]));
      pairedWords.add(lowerE(m[2]));
    }
  }
  return { stoplist: buildStoplist(settings?.nerStoplist), properStems, cellTexts: docxCellTexts(doc || {}), pairedWords };
}

/** ОПФ в спане или вплотную к нему («ООО «Ромашка»», «Northwind Systems Ltd.»). */
function hasOpf(text, start, end) {
  const span = text.slice(start, end);
  if (OPF_CS_RE.test(span) || OPF_FULL_RE.test(span)) return true;
  const before = text.slice(Math.max(0, start - 80), start);
  return OPF_BEFORE_CS_RE.test(before) || OPF_BEFORE_FULL_RE.test(before) || OPF_AFTER_RE.test(text.slice(end, end + 20));
}

/** Кавычки в спане или вокруг него («Ромашка»). */
function isQuoted(text, start, end) {
  if (QUOTE_RE.test(text.slice(start, end))) return true;
  return OPEN_BEFORE_RE.test(text.slice(Math.max(0, start - 3), start)) && CLOSE_AFTER_RE.test(text.slice(end, end + 3));
}

/** «Студия Лунопарк», «Агентство «Вектор»», «Группа компаний Север»: родовое слово + название с заглавной. */
function isGenericOrgName(span) {
  const t = span.replace(/^[\s\u00a0]+/, '');
  const low = lowerE(t);
  for (const g of GENERIC_ORG_WORDS) {
    if (!low.startsWith(g)) continue;
    const rest = t.slice(g.length);
    const m = /^[\s\u00a0]+([«"“„]?)(\p{L}|\d)/u.exec(rest);
    if (m && (m[1] || m[2] !== m[2].toLowerCase() || /\d/.test(m[2]))) return true;
  }
  return false;
}

const CYR_RE = /[а-яё]/iu;
/**
 * Слово из стоп-списка (ключ `stopKey`), для кириллицы — с падежным окончанием до 2 букв, если основа ≥ 4 символов
 * («Яндексе», «Телеграма»); латиница — только точно: «Canvas», «Zoomer», «Wordex» — не «Canva», «Zoom», «Word».
 * @param {string} key  ключ `stopKey`
 * @param {Set<string>} stoplist
 * @param {string} original  исходное написание (по нему — кириллица или нет: `stopKey` переводит «с», «о»… в латиницу)
 */
export function inStoplist(key, stoplist, original) {
  if (stoplist.has(key)) return true;
  if (!CYR_RE.test(original)) return false;
  for (let k = 1; k <= 2 && key.length - k >= 4; k++) {
    const tail = key.slice(-k);
    if (/^\p{L}+$/u.test(tail) && stoplist.has(key.slice(0, -k))) return true;
  }
  return false;
}

const CONNECTORS = new Set(['и', 'или', 'and', 'or', '&']);
/** Слова спана для правил 2–4: по пробелам и разделителям перечисления. */
const tokens = (span) => span.split(/[\s\u00a0,;/&+]+/).filter((x) => x && /[\p{L}\p{N}]/u.test(x));

const DEGREE_LEAD_RE = /^(?:MSc|BSc|MBA|PhD|MA|BA|MPhil|LLM|LLB)[ \u00a0]/u;
/** Правило 2: спан целиком из стоп-списка — сам по себе или каждым словом («Word и Excel», «Telegram/WhatsApp»). */
export function isStoplisted(span, stoplist) {
  const key = stopKey(span);
  if (!key) return false;
  if (inStoplist(key, stoplist, span)) return true;
  // спан начинается термином из стоп-списка из нескольких слов («Confidential Information secret») или учёной степенью
  // («MSc Computer Science») (WP11-E)
  for (const k of stoplist) if (k.includes(' ') && key.startsWith(`${k} `)) return true;
  if (DEGREE_LEAD_RE.test(span)) return true;
  const parts = tokens(span).filter((x) => !CONNECTORS.has(lowerE(x)));
  return parts.length > 1 && parts.every((x) => inStoplist(stopKey(x), stoplist, x));
}

/** Слово целиком вокруг спана: модель режет «Яндекс.Диск» и «1С:Бухгалтерия» по точке и двоеточию. */
export function wholeWordAround(text, start, end) {
  const W = /[\p{L}\p{N}]/u;
  let a = start;
  let b = end;
  while (a > 0 && (W.test(text[a - 1]) || ('.:-'.includes(text[a - 1]) && a >= 2 && W.test(text[a - 2])))) a--;
  while (b < text.length && (W.test(text[b]) || ('.:-'.includes(text[b]) && W.test(text[b + 1] || '')))) b++;
  return a === start && b === end ? null : text.slice(a, b);
}

/**
 * Правило 2б: часть спана — из стоп-списка, а остальные слова в документе не имена собственные
 * («Настройка CRM», «Интеграция 1С»): без контекста документа не применяется.
 */
function hasStopPart(span, stoplist, properStems) {
  if (!properStems) return false;
  const ws = tokens(span).filter((w) => !CONNECTORS.has(lowerE(w)));
  if (ws.length < 2) return false;
  const stop = ws.filter((w) => inStoplist(stopKey(w), stoplist, w));
  if (!stop.length) return false;
  return ws.every((w) => stop.includes(w) || !stems(w, 2).some((st) => properStems.has(st)));
}

/** Служебные слова, которые бывают внутри названий («Альфа и Омега», «Bank of Scotland»). */
const NAME_PARTICLES = new Set(['и', 'of', 'and', 'the', 'de', 'du', 'la', 'le', 'von', 'van', 'der', 'den', 'für', 'y']);
/** Служебные слова, которыми название не кончается: «Новый документ или», «Интеграция с». */
const FUNCTION_WORDS = new Set(
  'и|или|а|но|с|со|в|во|на|для|по|к|ко|о|об|от|из|за|до|при|без|через|не|and|or|of|for|with|to|in|on|at|by|from|the|a|an'.split('|'),
);
const isLower = (w) => /\p{L}/u.test(w[0]) && w[0] === w[0].toLowerCase() && w[0] !== w[0].toUpperCase();
/**
 * Правило 4: фраза, а не название без ОПФ и кавычек. Слово со строчной буквы (не частица названия) отбрасывает спан
 * в короткой строке (≤ 5 слов без точки в конце), во всём абзаце, в заголовке, пункте списка или ячейке («Новый документ или шаблон»,
 * «Интеграция с 1С и ЭДО», «Automated Excel reports»); в предложении — только спан, который начинается со строчного
 * слова («субъектов ПДн») или кончается служебным («Новый документ или»). «Северная транспортная компания»,
 * «Уральский завод точных приборов», «Агентство недвижимости Ромашка» внутри предложения сохраняются.
 */
function isPhrase(text, span, blockKind, cellTexts, whole) {
  const ws = tokens(span);
  if (!ws.length) return false;
  // тире с пробелами внутри названия не бывает: «Рисунок 1 — Окно входа», «Английский — B2»
  if (/\s[—–]\s/u.test(span)) return true;
  const common = ws.filter((w) => isLower(w) && !NAME_PARTICLES.has(lowerE(w)));
  if (!common.length && !FUNCTION_WORDS.has(lowerE(ws[ws.length - 1]))) return false;
  if (isLower(ws[0]) && !NAME_PARTICLES.has(lowerE(ws[0]))) return true;
  if (FUNCTION_WORDS.has(lowerE(ws[ws.length - 1]))) return true;
  const body = text.replace(NUMBERING_RE, '').trim();
  const shortLine = words(body).length <= 5 && !/[.!?…]$/.test(body);
  // спан — весь абзац («Счёт на оплату № 530 от 15 октября 2026 г.»): строка целиком, а не название в предложении
  return whole || SHORT_LINE_KINDS.has(blockKind || '') || !!cellTexts?.has(text) || isCapsLine(text) || shortLine;
}

/** Правило 6: адрес или должность, а не организация — «45 King Street», «Manchester M2 4LQ», «Senior Data Analyst». */
const ADDRESS_WORD_RE =
  /(?<![\p{L}])(?:Street|St\.|Road|Rd\.|Avenue|Ave\.|Lane|Drive|Boulevard|Square|Place|ул\.|улица|пр-т|проспект|пер\.|переулок|наб\.|шоссе|д\.)(?![\p{L}])|\b[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}\b/u;
const POSITION_WORD_RE =
  /(?<![\p{L}])(?:Analyst|Manager|Director|Engineer|Developer|Officer|Specialist|Consultant|Assistant|Accountant|Designer|Administrator|Coordinator|директор|менеджер|бухгалтер|аналитик|разработчик|руководитель)$/iu;
function isAddressOrPosition(span, after = '') {
  // «Asset Manager Group»: за спаном продолжается название с заглавной — это не должность
  return ADDRESS_WORD_RE.test(span) || (POSITION_WORD_RE.test(span.trim()) && !/^[\s\u00a0]+\p{Lu}/u.test(after));
}

/**
 * Правило 5: обрывок кода или номера — «ПС» из «17/ПС-2026», «АБ-12»: короткий спан из заглавных (≤ 4 букв) с цифрой
 * внутри или вплотную (через «/» или «-»). «Ромашка» из «Ромашка-2000» и «Вектор» из «Исполнитель/Вектор» — не обрывки.
 */
function isCodeFragment(text, start, end) {
  const span = text.slice(start, end);
  const letters = span.match(/\p{L}/gu) || [];
  if (!letters.length || letters.length > 4 || letters.some((ch) => ch !== ch.toUpperCase() || ch === ch.toLowerCase())) return false;
  return /\d/.test(span) || /[\d№][/‐‑-]?$/.test(text.slice(Math.max(0, start - 2), start)) || /^[/‐‑-]?\d/.test(text.slice(end, end + 2));
}

/** Каждое слово спана в обычном тексте документа — имя собственное (с заглавной не в начале предложения). */
function allProper(span, properStems) {
  const ws = words(span);
  return !!properStems && ws.length > 0 && ws.every((w) => stems(w, 2).some((st) => properStems.has(st)));
}

/**
 * Правило 1: спан — вся короткая строка-заголовок/пункт/ячейка/капс/«…:». Исключение — название, которое в тексте
 * документа употребляется как имя собственное («ВЕКТОР ПЛЮС» в шапке и «компания Вектор Плюс благодарит…» в тексте).
 */
function isShortLine(text, start, end, blockKind, cellTexts, properStems) {
  const rest = text.slice(0, start) + ' ' + text.slice(end);
  if (LETTER_RE.test(rest)) return false;
  const body = text.replace(NUMBERING_RE, '');
  if (words(body).length > MAX_SHORT_WORDS) return false;
  if (allProper(text.slice(start, end), properStems)) return false;
  if (SHORT_LINE_KINDS.has(blockKind || '') || cellTexts?.has(text)) return true;
  return isCapsLine(body) || /:[\s\u00a0]*$/.test(body);
}

/** Правило 3: поток — капс или заголовок, и ни одно слово спана не употребляется в тексте как имя собственное. */
function isHeadingOnly(text, span, blockKind, properStems) {
  if (!properStems) return false;
  if (!HEADING_KINDS.has(blockKind || '') && !isCapsLine(text)) return false;
  const ws = words(span);
  if (!ws.length || ws.length > MAX_HEADING_WORDS) return false;
  return ws.every((w) => !stems(w, 2).some((st) => properStems.has(st)) && !w.split(/[-‐‑]/).some((x) => properStems.has(lowerE(x))));
}

/**
 * Отбрасывает ложные спаны ORG модели (заголовки капсом, строки списка из 1–3 слов без ОПФ, аббревиатуры и продукты
 * из стоп-списка, слова, встречающиеся только в капс-строках и заголовках). Остальные метки не трогает.
 * @param {import('../contracts/ner.js').NerSpan[]} spans  спаны одного потока (после порога)
 * @param {{text: string, blockKind?: string, stoplist?: Set<string>, properStems?: Set<string>, cellTexts?: Set<string>}} ctx
 *   текст потока, вид блока (`paragraph.kind`), контекст документа (`createOrgFilterContext`)
 * @returns {import('../contracts/ner.js').NerSpan[]}
 */
export function filterOrgSpans(spans, ctx) {
  const text = String(ctx?.text ?? '');
  const stoplist = ctx?.stoplist || BUILTIN_STOPLIST;
  return spans
    .filter((sp) => {
      if (sp.label !== 'ORG') return true;
      const start = Math.max(0, sp.start);
      const end = Math.min(text.length, sp.end);
      if (end <= start) return false;
      const span = text.slice(start, end);
      // бренд владельца не маскируется никогда (решение владельца 6, WP11-E): раньше ОПФ и родового слова — «ООО «Sitimlab»»,
      // «Студия Sitimlab», «Компания Ситимлаб» тоже; слово бренда в спане — по `isNeverMaskOrg` (любой падеж)
      if (isNeverMaskOrg(span) || (wholeWordAround(text, start, end) && isNeverMaskOrg(wholeWordAround(text, start, end)))) return false;
      // ОПФ — всегда название; стоп-список — раньше кавычек («в формате «Excel»» — продукт)
      if (hasOpf(text, start, end)) return true;
      const around = wholeWordAround(text, start, end);
      if (isStoplisted(span, stoplist) || (around && isStoplisted(around, stoplist))) return false;
      if (isQuoted(text, start, end) || isGenericOrgName(span)) return true;
      if (hasStopPart(span, stoplist, ctx?.properStems)) return false;
      if (isShortLine(text, start, end, ctx?.blockKind, ctx?.cellTexts, ctx?.properStems)) return false;
      if (isHeadingOnly(text, span, ctx?.blockKind, ctx?.properStems)) return false;
      const whole = !LETTER_RE.test(text.slice(0, start) + text.slice(end));
      if (isPhrase(text, span, ctx?.blockKind, ctx?.cellTexts, whole)) return false;
      if (isCodeFragment(text, start, end) || isAddressOrPosition(span, text.slice(end, end + 3))) return false;
      return true;
    })
    .map((sp) => extendGenericTail(text, sp));
}

/** Родовое слово в конце названия (в любом падеже): «Уральский завод», «Северная транспортная компания». */
const GENERIC_TAIL_RE = /(?<![\p{L}])(?:завод|комбинат|компани|групп|фабрик|агентств|бюро|холдинг|институт|университет|банк|фонд)\p{Ll}{0,3}$/iu;
/** Глагол — конец названия: «завод выпускает», «компания поставила». */
const VERB_END_RE = /(?:ть|ться|ти|ет|ут|ют|ит|ат|ят|ал|ала|ало|али|ил|ила|ило|или|ел|ела|ели|ется|ются|ится|ался|алась|ались|ился|илась|ились)$/u;
const GENITIVE_END_RE = /(?:ых|их|ого|его|ой|ей|ов|ев|ий|ия|ии|ья|ьи|ая|яя|ы|и|а|я)$/u;
const MAX_TAIL_WORDS = 5;
/**
 * ORG модели, оборванный на родовом слове, продолжается строчными словами названия (WP11-D, К7: «Уральский завод» →
 * «Уральский завод точных приборов»): до знака препинания, глагола, предлога или союза, не дальше 5 слов.
 * @param {string} text
 * @param {import('../contracts/ner.js').NerSpan} sp
 */
function extendGenericTail(text, sp) {
  if (sp.label !== 'ORG' || !GENERIC_TAIL_RE.test(text.slice(sp.start, sp.end))) return sp;
  let end = sp.end;
  for (let k = 0; k < MAX_TAIL_WORDS; k++) {
    const m = /^[ \u00a0](\p{Ll}[\p{Ll}-]*)(?![\p{L}\p{N}])/u.exec(text.slice(end, end + 40));
    // продолжение названия — родительный падеж («точных приборов», «связи», «машиностроения»), не наречие «точно в срок»
    if (!m || FUNCTION_WORDS.has(lowerE(m[1])) || VERB_END_RE.test(m[1]) || !GENITIVE_END_RE.test(m[1])) break;
    end += m[0].length;
  }
  return end === sp.end ? sp : { ...sp, end };
}
