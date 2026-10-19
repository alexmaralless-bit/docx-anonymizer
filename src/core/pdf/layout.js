// Разметка текста PDF (версия 0.3, Ц2, К4; docs/concept-0.3.md «Как это устроено», п. 2).
// Вход — текстовые элементы страниц pdf.js с координатами (PageItems), выход — блоки документа (Layout):
// абзацы, заголовки, пункты списков, ячейки таблиц, колонтитулы и разрывы страниц. Чистые функции без pdf.js,
// DOM и сети: тестируются в Node на снимках элементов (tests/unit/pdf/layout.spec.js).
//
// Конвейер: normalizeItems → groupLines (строки по базовой линии) → joinWords (слова и сегменты строки) →
// stripRepeating (колонтитулы и номера страниц) → detectColumns (две колонки — слева направо) → detectTables
// (выравнивание сегментов по колонкам) → mergeParagraphs (абзацы, переносы, продолжение на следующей странице) →
// classifyHeading / detectList → блоки. Пороги — в долях кегля строки (size), см. docs/contracts.md §7.

/**
 * Текстовый элемент pdf.js (`page.getTextContent().items`). transform — в пространстве страницы PDF
 * (y вверх, начало — левый нижний угол страницы), width — ширина в тех же единицах.
 * @typedef {{str: string, transform: number[], width: number, height?: number, fontName?: string, hasEOL?: boolean}} PdfTextItem
 */

/**
 * @typedef {object} PageItems
 * @property {number} page     номер страницы с 1
 * @property {number} width
 * @property {number} height
 * @property {PdfTextItem[]} items
 * @property {Record<string, {bold?: boolean, name?: string}>} [fonts]  шрифты страницы (жирность — по имени шрифта)
 */

/**
 * @typedef {object} Block
 * @property {'p'|'h1'|'h2'|'li'|'cell'|'hr'|'header'|'footer'} kind
 * @property {string} text
 * @property {number} page
 * @property {{index: number, row: number, col: number, cols: number}} [table]
 */

/** @typedef {{blocks: Block[], pages: number, warnings: {code: string, details?: object}[]}} Layout */

/**
 * Отрезок текста строки (после склейки слов).
 * @typedef {{text: string, x0: number, x1: number, y: number, size: number, bold: number, chars: number, page: number}} Seg
 */

/** @typedef {{y: number, size: number, page: number, segs: Seg[], runs?: any[]}} Line */

// Пороги (доли кегля). Подобраны по фикстурам Chromium и LibreOffice (спайк S3, docs/contracts.md §7).
export const LINE_TOL = 0.35; // базовые линии ближе 0.35·size — одна строка
export const SPACE_GAP = 0.15; // зазор между элементами > 0.15·size — пробел (явный пробел pdf.js — тоже)
export const SEGMENT_GAP = 2; // зазор > 2·size — разрыв строки на сегменты (колонки, ячейки таблиц)
export const GUTTER_GAP = 0.4; // зазор > 0.4·size — разрыв, если по нему проходит «просвет» колонок (findGutters)
export const PARA_PITCH = 1.3; // шаг строк больше 1.3 обычного — новый абзац
export const INDENT = 1.5; // отступ первой строки > 1.5·size — новый абзац
export const BAND = 0.08; // верхняя и нижняя полосы страницы для колонтитулов (8 % высоты)
export const HEADER_GAP = 1.5; // крайняя строка полосы отделена от текста шагом > 1.5 обычного — колонтитул (stripRepeating)

// eslint-disable-next-line no-control-regex -- управляющие символы из текстового слоя PDF удаляются
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F\uFFFE\uFFFF]/g;
const BULLET_RE = /^[•‒–—○▪■✓\-·◦●►]\s+/u;
const NUMBERING_RE = /^(?:\d{1,3}(?:\.\d{1,3})*\.|\d{1,3}\)|[а-яa-z]\))\s/iu;
/** Сумма или количество в ячейке («120 500,50», «7 000,00», «10») — такие ячейки не переносятся на строку ниже. */
const AMOUNT_RE = /^(?:\d{1,3}(?:[ \u00A0]\d{3})*(?:[.,]\d{1,2})?|\d{1,4})$/u;
const PAGE_NUM_RE = /^(?:-\s*\d+\s*-|\d+|(?:страница|стр\.?|page|p\.)\s*\d+(?:\s*(?:из|of|\/)\s*\d+)?|\d+\s*(?:из|of|\/)\s*\d+)$/iu;
const BOLD_FONT_RE = /bold|black|heavy|semibold|demi|[-,]bd\b|w[6-9]00/i;
/** Моноширинный шрифт по имени (Courier, Liberation Mono, Consolas…) — пробел в нём шириной в символ (findGutters). */
export const MONO_FONT_RE = /mono|courier|consol|menlo|fixed|typewriter/i;
/** Слова-частицы и короткие приставки, дефис перед которыми — часть слова, а не перенос («что-то», «из-за», «пр-т»). */
const KEEP_HYPHEN_RIGHT = new Set(['то', 'либо', 'нибудь', 'таки', 'ка', 'де', 'с', 'за', 'под', 'над', 'т']);
/** «По-видимому», «по-русски», «во-первых»: дефис после «по»/«во» перед такими словами — часть слова. */
const KEEP_HYPHEN_PO = /^(?:\p{L}+(?:ому|ему|ски|цки|ьи)|первых|вторых|третьих|четв[её]ртых|пятых)$/u;

/* ---------------- ориентация страницы ---------------- */

/** Произведение аффинных матриц pdf.js [a, b, c, d, e, f]: сначала m2, затем m1. */
export function mulTransform(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/**
 * Ориентация текста элемента: 0 (обычная), 90 (снизу вверх), 180 (вверх ногами), 270 (сверху вниз) или null
 * (наклон — водяные знаки, повёрнутые подписи).
 * @param {number[]} t transform элемента
 * @returns {0|90|180|270|null}
 */
export function orientationOf(t) {
  const [a, b] = t || [1, 0];
  const n = Math.hypot(a, b);
  if (!n) return null;
  if (Math.abs(b) <= 0.05 * n) return a > 0 ? 0 : 180;
  if (Math.abs(a) <= 0.05 * n) return b > 0 ? 90 : 270;
  return null;
}

/**
 * Элемент читается в обычной ориентации: без поворота и без зеркала (d > 0). Остальное (водяные знаки,
 * вертикальные подписи, текст вверх ногами) разметкой отбрасывается — после orientPage.
 * @param {number[]} t
 */
export function isUpright(t) {
  const [a, b, c, d] = t || [1, 0, 0, 1];
  return a > 0 && d > 0 && Math.abs(b) <= 0.05 * Math.abs(a) + 1e-6 && Math.abs(c) <= 0.05 * Math.abs(d) + 1e-6;
}

/**
 * Страница с повёрнутым содержимым (альбомный лист «по-принтерному»: /Rotate + матрица cm, текст сверху вниз и т.п.)
 * → преобладающая по числу букв ориентация текста становится обычной: координаты элементов поворачиваются вместе со
 * страницей (ширина и высота меняются местами при 90/270). Без этого весь текст страницы отбросился бы как
 * «повёрнутый» и документ ушёл бы пустым (Ц4: тихий сбой). Страница с обычной ориентацией возвращается как есть.
 * @param {PageItems} page
 * @returns {PageItems}
 */
export function orientPage(page) {
  /** @type {Record<number, number>} */
  const letters = { 0: 0, 90: 0, 180: 0, 270: 0 };
  for (const it of page.items || []) {
    const o = orientationOf(it.transform);
    if (o === null) continue;
    letters[o] += (String(it.str || '').match(/\p{L}/gu) || []).length;
  }
  let best = 0;
  for (const o of [90, 180, 270]) if (letters[o] > letters[best]) best = o;
  if (best === 0) return page;
  const W = page.width;
  const H = page.height;
  // поворот системы координат на −best вокруг страницы с переносом в положительные координаты
  const P = best === 90 ? [0, -1, 1, 0, 0, W] : best === 180 ? [-1, 0, 0, -1, W, H] : [0, 1, -1, 0, H, 0];
  const swap = best !== 180;
  return {
    ...page,
    width: swap ? H : W,
    height: swap ? W : H,
    items: (page.items || []).map((it) => ({ ...it, transform: mulTransform(P, it.transform || [1, 0, 0, 1, 0, 0]) })),
  };
}

/* ---------------- элементы → строки → сегменты ---------------- */

/**
 * Элементы страницы → «прогоны» с геометрией сверху вниз. Пробельные элементы pdf.js не выдаются, а помечают
 * соседей (spAfter/spBefore); повёрнутый текст (водяные знаки, вертикальные подписи) отбрасывается (isUpright).
 * @param {PageItems} page
 */
export function normalizeItems(page) {
  const fonts = page.fonts || {};
  /** @type {{text: string, x: number, x1: number, y: number, size: number, bold: boolean, mono: boolean, eol: boolean, spBefore: boolean, spAfter: boolean}[]} */
  const out = [];
  let pendingSpace = false;
  for (const it of page.items || []) {
    const raw = String(it.str ?? '')
      .replace(CONTROL_RE, '')
      .replace(/[\u00A0\u2007\u202F]/g, ' ');
    const t = it.transform || [1, 0, 0, 1, 0, 0];
    if (!raw.trim()) {
      if (raw.length) {
        pendingSpace = true;
        if (out.length) out[out.length - 1].spAfter = true;
      }
      continue;
    }
    const [, , c, d] = t;
    if (!isUpright(t)) continue; // поворот, зеркало
    const size = Math.abs(d) || Math.hypot(c, d) || it.height || 10;
    const lead = raw.length - raw.trimStart().length;
    const trail = raw.length - raw.trimEnd().length;
    const text = raw.trim().replace(/\s+/g, ' ');
    const width = Math.max(0, it.width || 0);
    out.push({
      text,
      x: t[4],
      x1: t[4] + width,
      y: page.height - t[5],
      size,
      bold: !!(it.fontName && (fonts[it.fontName]?.bold ?? BOLD_FONT_RE.test(fonts[it.fontName]?.name || ''))),
      mono: !!(it.fontName && (fonts[it.fontName]?.mono ?? MONO_FONT_RE.test(fonts[it.fontName]?.name || ''))),
      eol: !!it.hasEOL,
      spBefore: pendingSpace || lead > 0,
      spAfter: trail > 0,
    });
    pendingSpace = false;
  }
  return out;
}

/**
 * Группирует прогоны в строки по базовой линии (|Δy| ≤ LINE_TOL·size), строки — сверху вниз, внутри — слева направо.
 * @param {ReturnType<typeof normalizeItems>} runs
 * @returns {{y: number, size: number, runs: ReturnType<typeof normalizeItems>}[]}
 */
export function groupLines(runs) {
  const sorted = runs.map((r, i) => ({ r, i })).sort((p, q) => p.r.y - q.r.y || p.r.x - q.r.x || p.i - q.i);
  /** @type {{y: number, size: number, runs: any[]}[]} */
  const lines = [];
  for (const { r } of sorted) {
    let target = null;
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 3; i--) {
      const L = lines[i];
      const dy = r.y - L.y;
      if (Math.abs(dy) <= LINE_TOL * Math.max(L.size, r.size)) {
        target = L;
        break;
      }
      // надстрочный/подстрочный знак мельче строки (сноски «¹») — часть строки, а не отдельная строка
      if (r.size < 0.8 * L.size && dy >= -0.65 * L.size && dy <= 0.35 * L.size) {
        target = L;
        break;
      }
      if (L.size < 0.8 * r.size && -dy >= -0.65 * r.size && -dy <= 0.35 * r.size && L.runs.every((x) => x.size < 0.8 * r.size)) {
        // строка из одних надстрочных знаков перед строкой основного кегля: переносим её базовую линию
        L.y = r.y;
        target = L;
        break;
      }
    }
    if (target) {
      target.runs.push(r);
      if (r.size > target.size) target.size = r.size;
    } else lines.push({ y: r.y, size: r.size, runs: [r] });
  }
  for (const L of lines) L.runs.sort((a, b) => a.x - b.x);
  return lines;
}

/**
 * Ширина символа строки моноширинного шрифта или 0: шрифт с моноширинным именем (MONO_FONT_RE) у большинства
 * прогонов, либо геометрия — ≥ 4 прогонов от 2 символов с одной шириной символа (±2 %) не уже 0.55·size.
 * В таком шрифте пробел шириной в символ (0.6·size) шире GUTTER_GAP, и «БИК 044525901» резалось бы на ячейки.
 * @param {{size: number, runs: any[]}} L
 */
export function monoCharWidth(L) {
  const runs = L.runs.filter((r) => r.text.length >= 2 && r.x1 > r.x);
  if (!runs.length) return 0;
  const ws = runs.map((r) => (r.x1 - r.x) / r.text.length).sort((a, b) => a - b);
  const med = ws[Math.floor(ws.length / 2)];
  const byName = L.runs.filter((r) => r.mono).length > L.runs.length / 2;
  const byGeometry = runs.length >= 4 && med >= 0.55 * L.size && ws.every((w) => Math.abs(w - med) <= 0.02 * med);
  return byName || byGeometry ? med : 0;
}

/**
 * Разрывы строк по «просветам» колонок (ячейки таблиц, колонки текста): зазор > SEGMENT_GAP·size — разрыв всегда;
 * зазор > GUTTER_GAP·size — разрыв, если в непрерывном участке соседних строк, которые не пересекают этот x текстом,
 * ещё ≥ 2 строки начинают элемент у того же x (±0.3·size). Растянутые пробелы выровненного по ширине абзаца так не
 * проходят: соседние строки перекрывают их словами. В моноширинном шрифте порог — не меньше 1.5 ширины символа:
 * одиночный пробел между словами — не просвет (monoCharWidth).
 * @param {{y: number, size: number, runs: any[]}[]} lines строки страницы
 * @returns {Set<number>[]} для каждой строки — индексы прогонов, перед которыми разрыв
 */
export function findGutters(lines) {
  const splits = lines.map(() => new Set());
  const starts = (L, x, tol) => L.runs.some((r) => Math.abs(r.x - x) <= tol);
  const crosses = (L, x, tol) => L.runs.some((r) => r.x < x - tol && r.x1 > x + tol);
  lines.forEach((L, i) => {
    let right = -Infinity;
    const monoW = monoCharWidth(L);
    L.runs.forEach((r, k) => {
      if (k > 0) {
        const gap = r.x - right;
        const size = Math.max(L.size, r.size);
        if (gap > SEGMENT_GAP * size) splits[i].add(k);
        else if (gap > GUTTER_GAP * size && gap > 1.5 * monoW) {
          const tol = 0.3 * size;
          let count = 1;
          for (const dir of [-1, 1]) {
            for (let j = i + dir; j >= 0 && j < lines.length && Math.abs(j - i) <= 40; j += dir) {
              if (crosses(lines[j], r.x, tol)) break;
              if (starts(lines[j], r.x, tol)) count++;
            }
          }
          if (count >= 3) splits[i].add(k);
        }
      }
      right = Math.max(right, r.x1);
    });
  });
  return splits;
}

/**
 * Склейка прогонов строки в сегменты: зазор > SPACE_GAP·size или явный пробел — пробел; разрыв из findGutters
 * (или зазор > SEGMENT_GAP·size) и конец строки pdf.js (hasEOL) — новый сегмент. Текст, нарисованный дважды
 * (имитация жирного), — один раз.
 * @param {{y: number, size: number, runs: any[]}} line
 * @param {number} [page]
 * @param {Set<number>} [splits] индексы прогонов, перед которыми разрыв (по умолчанию — только SEGMENT_GAP)
 * @returns {Seg[]}
 */
export function joinWords(line, page = 1, splits) {
  /** @type {Seg[]} */
  const segs = [];
  /** @type {any} */
  let cur = null;
  let last = null;
  line.runs.forEach((r, k) => {
    if (last && r.text === last.text && Math.abs(r.x - last.x) < 0.15 * r.size) return; // двойная отрисовка
    if (cur) {
      const gap = r.x - cur.x1;
      const size = Math.max(cur.lastSize, r.size);
      const split = splits ? splits.has(k) : gap > SEGMENT_GAP * size;
      if (split || last.eol) {
        segs.push(finishSeg(cur));
        cur = null;
      } else {
        const space = gap > SPACE_GAP * size || last.spAfter || r.spBefore;
        cur.text += (space ? ' ' : '') + r.text;
        cur.x1 = Math.max(cur.x1, r.x1);
        cur.boldChars += r.bold ? r.text.length : 0;
        if (r.size >= 0.8 * line.size) {
          cur.sizeChars += r.size * r.text.length;
          cur.sizedChars += r.text.length;
        }
        cur.chars += r.text.length;
        cur.lastSize = r.size;
      }
    }
    if (!cur) {
      const main = r.size >= 0.8 * line.size;
      cur = {
        text: r.text,
        x0: r.x,
        x1: r.x1,
        y: line.y,
        boldChars: r.bold ? r.text.length : 0,
        sizeChars: main ? r.size * r.text.length : 0,
        sizedChars: main ? r.text.length : 0,
        chars: r.text.length,
        lastSize: r.size,
        lineSize: line.size,
        page,
      };
    }
    last = r;
  });
  if (cur) segs.push(finishSeg(cur));
  return segs;
}

function finishSeg(c) {
  return {
    text: c.text,
    x0: c.x0,
    x1: c.x1,
    y: c.y,
    size: c.sizedChars ? c.sizeChars / c.sizedChars : c.lineSize,
    bold: c.chars ? c.boldChars / c.chars : 0,
    chars: c.chars,
    page: c.page,
  };
}

/** Строки страницы с сегментами. */
function pageLines(page) {
  const lines = groupLines(normalizeItems(page));
  const splits = findGutters(lines);
  return lines.map((L, i) => ({ y: L.y, size: L.size, page: page.page, segs: joinWords(L, page.page, splits[i]) })).filter((L) => L.segs.length);
}

const lineText = (L) => L.segs.map((s) => s.text).join(' ');

/* ---------------- колонтитулы ---------------- */

const repeatKey = (text) => text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
/** Конец предложения (абзаца) в конце строки: «.», «!», «?», «:», «;», «…» с закрывающими кавычками и скобками. */
const SENTENCE_END_RE = /[.!?:;…][»"”')\]]*$/u;
/** Реквизит с номером («ИНН 7701…», «ОГРН 1…», «р/с 4…») — строка тела договора, а не колонтитул (финальная приёмка 0.3). */
const REQUISITE_RE = /(?:^|[^\p{L}])(?:ИНН|КПП|ОГРНИП|ОГРН|БИК|СНИЛС|р\/с|к\/с)\s*:?\s*\d/iu;

/**
 * Колонтитулы и номера страниц (FR колонтитулов концепции 0.3): номера страниц («3», «- 3 -», «Страница 2 из 4»,
 * «Page 2 of 4») в верхней и нижней полосах (BAND высоты) удаляются. Колонтитул по повтору — только крайние строки
 * полосы: участок подряд идущих от края страницы строк (номера страниц между ними и краем не считаются), текст каждой
 * из которых (цифры → #) повторяется на ≥ 3 страницах или на ≥ 50 % страниц (не меньше двух) и не похож на текст
 * договора: не заголовок (не крупнее 1.15 основного кегля и не жирная), не пункт с нумерацией («2.8. …»), без
 * реквизита с номером («ИНН 7701…»). Участок не должен продолжаться абзацем: сверху — предыдущая страница кончается
 * незавершённым предложением, а следующая строка идёт обычным шагом (≤ PARA_PITCH·pitch); снизу — строка выше идёт
 * обычным шагом без конца предложения. Иначе на perf-50p повторы «(ИНН #), который согласует…», «обязательств по
 * настоящему договору.» и «#. ПОРЯДОК ВЫПОЛНЕНИЯ РАБОТ ЭТАПА #» уходили из тела (финальная приёмка 0.3, К4).
 * Кроме того, одиночная крайняя строка полосы мелким кеглем (≤ 0.85 основного) — колонтитул; крайняя строка полосы
 * обычным кеглем без жирного, отделённая от текста шагом > HEADER_GAP·pitch, — тоже, и на одностраничном документе
 * (колонтитул LibreOffice 12 pt над текстом). Возвращает строки без колонтитулов и сами колонтитулы (по одному на
 * уникальный текст).
 * @param {{page: number, height: number, lines: Line[]}[]} pages
 * @param {number} bodySize медианный кегль документа
 * @param {number} [pitch] обычный шаг строк (0 — правило отделённой строки не применяется)
 * @returns {{pages: {page: number, height: number, lines: Line[]}[], headers: {kind: 'header'|'footer', text: string, page: number}[]}}
 */
export function stripRepeating(pages, bodySize = 0, pitch = 0) {
  const n = pages.length;
  const bandOf = (L, h) => (L.y < BAND * h ? 'top' : L.y > (1 - BAND) * h ? 'bottom' : null);
  const isPageNum = (L) => PAGE_NUM_RE.test(lineText(L).trim());
  const plain = (L) => bodySize > 0 && L.size <= 1.15 * bodySize && L.segs.every((x) => x.bold < 0.5);
  // похожа на текст договора сама по себе (без соседей): заголовок, пункт с нумерацией, реквизит с номером
  const bodyLike = (L) => {
    const text = lineText(L).trim();
    const heading = bodySize > 0 ? !plain(L) : L.segs.some((x) => x.bold >= 0.5);
    return heading || NUMBERING_RE.test(text) || REQUISITE_RE.test(text);
  };
  /** @type {Map<string, Set<number>>} */
  const seen = new Map();
  const keyOf = (band, L) => `${band}\u0000${repeatKey(lineText(L))}`;
  for (const p of pages) {
    for (const L of p.lines) {
      const band = bandOf(L, p.height);
      if (!band || isPageNum(L) || bodyLike(L)) continue;
      const key = keyOf(band, L);
      let set = seen.get(key);
      if (!set) seen.set(key, (set = new Set()));
      set.add(p.page);
    }
  }
  const repeated = (key) => {
    const c = seen.get(key)?.size || 0;
    return c >= 2 && (c >= 3 || c >= 0.5 * n);
  };
  const near = (a, b) => pitch > 0 && Math.abs(a.y - b.y) <= PARA_PITCH * pitch;
  const headers = [];
  const known = new Set();
  /** Последняя строка тела предыдущей страницы (после удаления колонтитулов). */
  let prevTail = null;
  const out = pages.map((p) => {
    const L0 = p.lines;
    const drop = new Set();
    /** @type {Map<number, 'header'|'footer'>} строка → вид колонтитула */
    const marked = new Map();
    const mark = (i, band) => {
      drop.add(i);
      marked.set(i, band === 'top' ? 'header' : 'footer');
    };
    // номера страниц — в обеих полосах
    L0.forEach((L, i) => {
      if (bandOf(L, p.height) && isPageNum(L)) drop.add(i);
    });
    // одиночная мелкая или отделённая от текста крайняя строка полосы (по индексу на странице, как в 0.3 до приёмки)
    L0.forEach((L, i) => {
      const band = bandOf(L, p.height);
      if (!band || drop.has(i)) return;
      const extreme = band === 'top' ? i === 0 : i === L0.length - 1;
      if (!extreme) return;
      const small = bodySize > 0 && L.size <= 0.85 * bodySize;
      const neighbour = band === 'top' ? L0[i + 1] : L0[i - 1];
      const isolated = plain(L) && pitch > 0 && !!neighbour && Math.abs(neighbour.y - L.y) > HEADER_GAP * pitch;
      if (small || isolated) mark(i, band);
    });
    // Повтор: подряд идущие от края страницы строки полосы с повторяющимся текстом, не похожие на текст договора
    // (номера страниц и уже признанные строки между ними пропускаются). Колонтитул — самый длинный такой участок от
    // края, после которого текст не продолжает его как абзац: сверху — предыдущая страница не кончается
    // незавершённым предложением или следующая строка отделена шагом > PARA_PITCH·pitch; снизу — строка выше
    // отделена так же или кончается концом предложения.
    const unfinished = !!prevTail && !SENTENCE_END_RE.test(lineText(prevTail).trim());
    const walk = (band, from, step) => {
      const run = [];
      let inner = null;
      for (let i = from; i >= 0 && i < L0.length; i += step) {
        const L = L0[i];
        if (drop.has(i)) continue;
        if (bandOf(L, p.height) === band && !bodyLike(L) && repeated(keyOf(band, L))) run.push(i);
        else {
          inner = L;
          break;
        }
      }
      const flows = (edgeSide, next) =>
        !!next && (band === 'top' ? unfinished && near(edgeSide, next) : near(next, edgeSide) && !SENTENCE_END_RE.test(lineText(next).trim()));
      for (let k = run.length; k > 0; k--) {
        const next = k < run.length ? L0[run[k]] : inner;
        if (flows(L0[run[k - 1]], next)) continue;
        for (let j = 0; j < k; j++) mark(run[j], band);
        return;
      }
    };
    walk('top', 0, 1);
    walk('bottom', L0.length - 1, -1);
    for (const i of [...marked.keys()].sort((a, b) => a - b)) {
      const kind = /** @type {'header'|'footer'} */ (marked.get(i));
      const text = lineText(L0[i]);
      const k = `${kind}\u0000${repeatKey(text)}`;
      if (!known.has(k)) {
        known.add(k);
        headers.push({ kind, text, page: p.page });
      }
    }
    const lines = L0.filter((_, i) => !drop.has(i));
    if (lines.length) prevTail = lines[lines.length - 1];
    return { ...p, lines };
  });
  return { pages: out, headers };
}

/* ---------------- колонки ---------------- */

/**
 * Две колонки текста: участок подряд идущих строк, сегменты которых лежат каждый в своей половине (≥ 80 % строк
 * участка), по ≥ 3 строки в каждой половине, и строки большей частью заполняют ширину колонки (проза, а не ячейки
 * таблицы). Такой участок переупорядочивается: сначала левая колонка сверху вниз, затем правая.
 * @param {Line[]} lines строки одной страницы сверху вниз
 * @returns {(Line & {col?: {left: number, right: number}})[]}
 */
export function detectColumns(lines) {
  if (lines.length < 6) return lines;
  const minX = Math.min(...lines.map((L) => L.segs[0].x0));
  const maxX = Math.max(...lines.map((L) => L.segs[L.segs.length - 1].x1));
  const mid = (minX + maxX) / 2;
  const tol = (L) => 0.5 * L.size;
  const classify = (L) => {
    const left = L.segs.filter((s) => s.x1 <= mid + tol(L));
    const right = L.segs.filter((s) => s.x0 >= mid - tol(L));
    if (left.length + right.length !== L.segs.length) return null;
    return { left, right };
  };
  const out = [];
  let i = 0;
  while (i < lines.length) {
    let j = i;
    const run = [];
    let lx = null;
    let rx = null;
    while (j < lines.length) {
      const c = classify(lines[j]);
      if (!c) break;
      // в узкой колонке растянутые пробелы выровненного текста дают несколько сегментов в половине — это одна строка колонки
      const left = mergeSegs(c.left);
      const right = mergeSegs(c.right);
      // строка, у которой обе половины начинаются не там, где колонки участка, — уже не колонки (например, таблица)
      const t = 0.5 * lines[j].size;
      if (left.length && right.length && lx !== null && rx !== null && Math.abs(left[0].x0 - lx) > t && Math.abs(right[0].x0 - rx) > t) break;
      if (left.length && lx === null) lx = left[0].x0;
      if (right.length && rx === null) rx = right[0].x0;
      run.push({ L: lines[j], left, right });
      j++;
    }
    // самый длинный начальный участок, похожий на две колонки прозы (за ним может идти таблица с теми же половинами)
    const colW = mid - minX;
    const isProse = (part) => {
      const lefts = part.filter((r) => r.left.length).map((r) => r.left[0]);
      const rights = part.filter((r) => r.right.length).map((r) => r.right[0]);
      if (lefts.length < 3 || rights.length < 3) return null;
      const lx0 = Math.min(...lefts.map((x) => x.x0));
      const rx0 = Math.min(...rights.map((x) => x.x0));
      const full = (segs, x0) => segs.filter((x) => x.x1 - x0 >= 0.75 * colW).length;
      if (full(lefts, lx0) < 0.5 * lefts.length || full(rights, rx0) < 0.5 * rights.length) return null;
      return { lefts, rights, lx0, rx0 };
    };
    let best = null;
    let bestEnd = 0;
    for (let end = run.length; end >= 6; end--) {
      best = isProse(run.slice(0, end));
      if (best) {
        bestEnd = end;
        break;
      }
    }
    if (best) {
      // Граница участка: строка левой половины ниже последней строки правой колонки, набранная иначе, чем колонки
      // (другой кегль или жирная после промежутка), — заголовок на всю ширину после колонок («РЕКВИЗИТЫ…»), а не
      // хвост левой колонки; иначе он ушёл бы между колонками и склеился с правой.
      const lastRight = run
        .slice(0, bestEnd)
        .map((r) => r.right.length > 0)
        .lastIndexOf(true);
      const bodySizes = run.slice(0, bestEnd).flatMap((r) => [...r.left, ...r.right].map((x) => x.size));
      const colSize = bodySizes.sort((a, b) => a - b)[Math.floor(bodySizes.length / 2)] || 0;
      for (let k = lastRight + 1; k < bestEnd; k++) {
        const r = run[k];
        if (r.right.length || !r.left.length) continue;
        const seg = r.left[0];
        const gap = k > 0 ? r.L.y - run[k - 1].L.y : 0;
        const otherSize = colSize > 0 && Math.abs(seg.size - colSize) > 0.15 * colSize;
        const boldAfterGap = seg.bold >= 0.9 && gap > PARA_PITCH * 1.2 * seg.size;
        if (otherSize || boldAfterGap) {
          best = isProse(run.slice(0, k)); // участок уже признан колонками — порог в 6 строк не повторяется
          bestEnd = best ? k : 0;
          break;
        }
      }
    }
    if (best) {
      const { lefts, rights, lx0, rx0 } = best;
      const lRight = Math.max(...lefts.map((x) => x.x1));
      const rRight = Math.max(...rights.map((x) => x.x1));
      for (const x of lefts) out.push({ y: x.y, size: x.size, page: x.page, segs: [x], col: { left: lx0, right: lRight } });
      for (const x of rights) out.push({ y: x.y, size: x.size, page: x.page, segs: [x], col: { left: rx0, right: rRight } });
      i += bestEnd;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out;
}

/** Сегменты одной половины строки → один сегмент (через пробел). */
function mergeSegs(segs) {
  if (segs.length <= 1) return segs;
  const chars = segs.reduce((n, x) => n + x.chars, 0);
  return [
    {
      ...segs[0],
      text: segs.map((x) => x.text).join(' '),
      x1: segs[segs.length - 1].x1,
      chars,
      bold: segs.reduce((n, x) => n + x.bold * x.chars, 0) / (chars || 1),
    },
  ];
}

/* ---------------- таблицы ---------------- */

/**
 * Таблицы: участок строк, в котором ≥ 3 строки из ≥ 2 сегментов с общими x-началами (±0.5·size); строки из одного
 * сегмента внутри участка (продолжение ячейки) допускаются, если начинаются у начала колонки, не выходят за неё и стоят
 * с обычным шагом. Ячейки колонки сверху вниз сливаются в абзац ячейки, если предыдущая строка заполнила ширину
 * колонки (перенос по ширине), иначе — новая строка таблицы. Строки таблицы — по верху первых строк ячеек.
 * @param {Line[]} lines строки страницы (после колонок)
 * @param {number} pitch обычный шаг строк документа
 * @returns {({line: Line} | {table: {cells: {row: number, col: number, text: string, page: number}[], rows: number, cols: number}})[]}
 */
export function detectTables(lines, pitch = 0) {
  const units = [];
  const pageRight = lines.length ? Math.max(...lines.map((L) => L.segs[L.segs.length - 1].x1)) : 0;
  const pageLeft = lines.length ? Math.min(...lines.map((L) => L.segs[0].x0)) : 0;
  let i = 0;
  while (i < lines.length) {
    const L = lines[i];
    if (L.segs.length < 2 || L.col) {
      units.push({ line: L });
      i++;
      continue;
    }
    // участок-кандидат: многосегментные строки с общими началами и продолжения ячеек между ними
    const run = [L];
    const starts = L.segs.map((s) => s.x0);
    let j = i + 1;
    while (j < lines.length) {
      const N = lines[j];
      if (N.col) break;
      const step = N.y - run[run.length - 1].y;
      if (step <= 0 || (pitch && step > 2.5 * pitch)) break;
      const tolN = 0.5 * N.size;
      const match = (s) => starts.findIndex((x) => Math.abs(x - s.x0) <= tolN);
      if (N.segs.length >= 2) {
        if (!N.segs.some((s) => match(s) >= 0)) break;
        for (const s of N.segs) if (match(s) < 0) starts.push(s.x0);
      } else {
        const s = N.segs[0];
        if (match(s) < 0) break;
        if (pitch && step > PARA_PITCH * pitch) break; // продолжение ячейки идёт обычным шагом
        const next = starts.filter((x) => x > s.x0 + tolN).sort((a, b) => a - b)[0];
        if (next !== undefined && s.x1 > next - 0.25 * N.size) break; // строка шире колонки — обычный абзац
      }
      run.push(N);
      j++;
    }
    // одиночные строки после последней многосегментной — не таблица, кроме переноса ячейки последней строки
    // («Главный бухгалтер ____ (Фролова» + «А.М.)»: предыдущая строка колонки дошла до её правого края)
    const lastMulti = run.map((r) => r.segs.length >= 2).lastIndexOf(true);
    let tableLines = run.slice(0, lastMulti + 1);
    const multiLines = tableLines.filter((r) => r.segs.length >= 2);
    const multi = multiLines.length;
    // две строки — таблица, только если ячейки выровнены: одинаковое число сегментов (≥ 2) с общими x-началами
    // (подписи акта сверки «От ООО … | От ООО …» + «Главный бухгалтер … | Главный бухгалтер …», WP11-D)
    const aligned2 = multi === 2 && alignedRows(multiLines[0], multiLines[1]);
    let cols = clusterStarts(tableLines);
    if ((multi >= 3 || aligned2) && cols.length >= 2) {
      tableLines = tableLines.concat(cellTail(run.slice(lastMulti + 1), tableLines, cols, pitch, pageLeft));
      cols = clusterStarts(tableLines);
    }
    if ((multi >= 3 || aligned2) && cols.length >= 2) {
      // в таблице из двух выровненных строк вторая строка — новая строка таблицы, а не перенос ячеек первой
      const rowStarts = aligned2 ? new Set([multiLines[1]]) : undefined;
      units.push({ table: buildTable(tableLines, cols, pitch, pageRight, pageLeft, rowStarts) });
      i += tableLines.length;
    } else {
      units.push({ line: L });
      i++;
    }
  }
  return units;
}

/** Две строки таблицы с выровненными ячейками: одно и то же число сегментов (≥ 2), начала попарно совпадают (±0.5·size). */
function alignedRows(a, b) {
  if (a.segs.length < 2 || a.segs.length !== b.segs.length) return false;
  return a.segs.every((s, k) => Math.abs(s.x0 - b.segs[k].x0) <= 0.5 * Math.max(s.size, b.segs[k].size));
}

/**
 * Перенос ячейки последней строки таблицы: одиночные строки сразу после неё, которые начинаются у начала колонки
 * и продолжают её последнюю ячейку (`continues`: строка выше дошла до правого края колонки, шаг обычный).
 * @param {Line[]} rest строки участка после последней многосегментной
 * @param {Line[]} lines строки таблицы
 * @param {number[]} cols x-начала колонок
 * @param {number} pitch
 * @param {number} pageLeft
 * @returns {Line[]}
 */
function cellTail(rest, lines, cols, pitch, pageLeft) {
  const out = [];
  const size0 = lines[0].size;
  const pad = Math.min(1.5 * size0, Math.max(0.25 * size0, cols[0] - (pageLeft ?? cols[0])));
  let prev = lines[lines.length - 1];
  for (const L of rest) {
    const s = L.segs[0];
    // перенос строки ячейки начинается ровно у её левого края (подпись под таблицей у края текста — на ~0.5·size левее)
    const c = cols.findIndex((x) => Math.abs(x - s.x0) <= 0.2 * s.size);
    if (c < 0 || c + 1 >= cols.length) break; // последняя колонка: правый край неизвестен — не рискуем
    const above = prev.segs.find((x) => Math.abs(x.x0 - cols[c]) <= 0.5 * x.size);
    if (!above || !continues(above, s, cols[c + 1] - 2 * pad, pitch)) break;
    out.push(L);
    prev = L;
  }
  return out;
}

/**
 * x-начала колонок таблицы. Колонка — кластер начал сегментов многосегментных строк (±0.5·size), поддержанный ≥ 2
 * строками, либо кластер правых краёв (числа и суммы, выровненные вправо: «10» и «2» в колонке «Кол-во»), если
 * сегменты не попали ни в одну колонку по началу. Колонка по началу внутри колонки по правому краю («2», «1» под
 * «10») — та же колонка: её начало сдвигается к самому левому сегменту.
 * @param {Line[]} lines
 * @returns {number[]}
 */
function clusterStarts(lines) {
  const segs = lines.filter((L) => L.segs.length >= 2).flatMap((L) => L.segs);
  /** @param {(s: Seg) => number} key @param {boolean} toMin */
  const clusterBy = (key, toMin) => {
    /** @type {{v: number, members: Seg[]}[]} */
    const cl = [];
    for (const s of segs) {
      const v = key(s);
      const c = cl.find((k) => Math.abs(k.v - v) <= 0.5 * s.size);
      if (c) {
        c.members.push(s);
        if (toMin) c.v = Math.min(c.v, v);
      } else cl.push({ v, members: [s] });
    }
    return cl.filter((c) => c.members.length >= 2);
  };
  const left = clusterBy((s) => s.x0, true);
  const inLeft = new Set(left.flatMap((c) => c.members));
  const cols = left.map((c) => ({ x0: c.v, x1: Math.max(...c.members.map((m) => m.x1)) }));
  for (const c of clusterBy((s) => s.x1, false)) {
    const free = c.members.filter((m) => !inLeft.has(m));
    if (!free.length) continue;
    const x0 = Math.min(...free.map((m) => m.x0));
    const tol = 0.5 * free[0].size;
    const host = cols.find((k) => k.x0 >= x0 - tol && k.x0 <= c.v + tol && k.x1 <= c.v + tol);
    if (host) host.x0 = Math.min(host.x0, x0);
    else if (!cols.some((k) => x0 >= k.x0 - tol && x0 <= k.x1)) cols.push({ x0, x1: c.v });
  }
  return cols.map((c) => c.x0).sort((a, b) => a - b);
}

/**
 * @param {Line[]} lines @param {number[]} cols @param {number} pitch @param {number} pageRight @param {number} pageLeft
 * @param {Set<Line>} [rowStarts] строки, каждый сегмент которых начинает новую ячейку (без склейки с ячейкой выше)
 */
function buildTable(lines, cols, pitch, pageRight, pageLeft, rowStarts) {
  const colOf = (s) => {
    let k = 0;
    for (let c = 0; c < cols.length; c++) if (s.x0 >= cols[c] - 0.5 * s.size) k = c;
    return k;
  };
  // правый край ячейки: начало следующей колонки минус поля (ошибка в сторону склейки безопаснее: разорванная
  // переносом сущность ушла бы в чат по частям)
  const maxX1 = cols.map(() => 0);
  for (const L of lines) for (const s of L.segs) maxX1[colOf(s)] = Math.max(maxX1[colOf(s)], s.x1);
  // поле ячейки — по отступу текста первой колонки от левого края текста страницы (в пределах 0.25…1.5 кегля)
  const size0 = lines[0].size;
  const pad = Math.min(1.5 * size0, Math.max(0.25 * size0, cols[0] - (pageLeft ?? cols[0])));
  // последняя колонка: ширина как у предыдущей (обычно колонки равны), но не меньше её самой длинной строки
  const colRight = (c) => {
    if (c + 1 < cols.length) return cols[c + 1] - 2 * pad;
    const est = Math.min((pageRight || Infinity) - pad, c > 0 ? cols[c] + (cols[c] - cols[c - 1]) - 2 * pad : Infinity);
    return Math.max(maxX1[c], est);
  };
  /** @type {{col: number, y: number, text: string, last: Seg, page: number}[][]} */
  const byCol = cols.map(() => []);
  for (const L of lines) {
    for (const s of L.segs) {
      const c = colOf(s);
      const list = byCol[c];
      const prev = list[list.length - 1];
      if (prev && !rowStarts?.has(L) && prev.last.page === s.page && continues(prev.last, s, colRight(c), pitch)) {
        prev.text = joinLineText(prev.text, s.text);
        prev.last = s;
      } else list.push({ col: c, y: s.y, text: s.text, last: s, page: s.page });
    }
  }
  // строки таблицы — по y начала ячеек
  const all = byCol.flat().sort((a, b) => a.y - b.y || a.col - b.col);
  /** @type {number[]} */
  const rowYs = [];
  for (const c of all) {
    const tolY = 0.5 * c.last.size;
    if (!rowYs.some((y) => Math.abs(y - c.y) <= tolY)) rowYs.push(c.y);
  }
  rowYs.sort((a, b) => a - b);
  const cells = [];
  for (const c of all) {
    const row = rowYs.findIndex((y) => Math.abs(y - c.y) <= 0.5 * c.last.size);
    const exist = cells.find((x) => x.row === row && x.col === c.col);
    if (exist) exist.text = joinLineText(exist.text, c.text);
    else cells.push({ row, col: c.col, text: c.text, page: c.page });
  }
  return { cells, rows: rowYs.length, cols: cols.length };
}

/**
 * Продолжает ли строка next абзац строки prev (перенос по ширине): предыдущая строка дошла до правого края колонки так,
 * что первое слово следующей на ней не поместилось бы, а шаг строк обычный.
 * @param {Seg} prev @param {Seg} next @param {number} colRight правый край колонки @param {number} pitch
 */
function continues(prev, next, colRight, pitch) {
  const step = next.y - prev.y;
  if (pitch && step > PARA_PITCH * pitch) return false;
  if (step <= 0) return false;
  // числа, выровненные вправо («15 000,00» над «120 500,50»): общий правый край при разных началах — новая строка
  // таблицы, а не перенос (перенесённая строка ячейки начинается у её левого края); суммы и количества не переносятся
  if (Math.abs(next.x1 - prev.x1) <= 0.5 * next.size && Math.abs(next.x0 - prev.x0) > 0.5 * next.size) return false;
  if (AMOUNT_RE.test(prev.text) && AMOUNT_RE.test(next.text)) return false;
  if (/[\p{L}\p{N}][-\u2010\u00AD]$/u.test(prev.text)) return true; // перенос после дефиса
  return !wouldFit(prev, next, colRight, 0.25);
}

/**
 * Поместилось бы первое слово next в конец строки prev (с запасом slack·size)? Да — значит, prev кончилась раньше края.
 * @param {Seg} prev @param {Seg} next @param {number} right @param {number} [slack]
 */
function wouldFit(prev, next, right, slack = 1) {
  const charW = next.chars ? (next.x1 - next.x0) / next.chars : 0.5 * next.size;
  const word = next.text.split(' ')[0] || '';
  const need = (word.length + 1) * charW;
  return prev.x1 + need < right - slack * next.size;
}

/* ---------------- абзацы ---------------- */

/** Строка выровнена по центру колонки: отступы слева и справа заметны и почти равны. */
function centered(seg, left, right) {
  const l = seg.x0 - left;
  const r = right - seg.x1;
  return l > seg.size && r > seg.size && Math.abs(l - r) < 1.5 * seg.size;
}

/**
 * Склейка строки абзаца с продолжением: перенос «слово-» + строчная → «словочасть» (дефис переноса удаляется),
 * «Санкт-» + «Петербург» → «Санкт-Петербург» (дефис остаётся); мягкий перенос U+00AD и знак переноса U+2010 в конце
 * строки удаляются всегда (так LibreOffice и Word рисуют мягкий перенос: «Ан‐» + «дреева» → «Андреева»); дефис после
 * двух букв слова с заглавной — тоже перенос («Ан-» + «дреева»), кроме «По-видимому», «Во-первых». Цифры: «7805-» +
 * «003215» → «7805003215», если по любую сторону дефиса группа ≥ 4 цифр (ИНН, счёт, разорванные мягким переносом:
 * иначе номер ушёл бы в чат двумя «безобидными» частями); группы по 2–3 цифры (телефон «123-» + «45-67») — дефис
 * остаётся. Дефис в почте, адресах сайтов и в коротких частях («пр-т», «из-за», «что-то») остаётся. Иначе — пробел.
 * @param {string} a @param {string} b
 */
export function dehyphenate(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (/[\u00AD\u2010]$/u.test(a)) return a.slice(0, -1) + b;
  // точка внутри почты или домена на конце строки: «info@vector-plus.» + «example» — без пробела (WP11-D)
  if (/\.$/.test(a) && technicalBreak(a, b)) return a + b;
  if (/[\p{L}\p{N}]-$/u.test(a)) {
    const leftTok = a.slice(a.lastIndexOf(' ') + 1, -1);
    const rightTok = b.split(' ')[0];
    const leftDigits = (leftTok.match(/\d+$/) || [''])[0];
    const rightDigits = (rightTok.match(/^\d+/) || [''])[0];
    if (leftDigits && rightDigits) return leftDigits.length >= 4 || rightDigits.length >= 4 ? a.slice(0, -1) + b : a + b;
    const rightWord = (rightTok.match(/^\p{L}+/u) || [''])[0];
    const leftWord = (leftTok.match(/\p{L}+$/u) || [''])[0];
    const technical = /[@/\\.\d_:]/.test(leftTok) || leftWord.length !== leftTok.length;
    const lower = rightWord.toLowerCase();
    const short2 = leftWord.length === 2 && /^\p{Lu}\p{Ll}$/u.test(leftWord) && !(/^(?:по|во)$/iu.test(leftWord) && KEEP_HYPHEN_PO.test(lower));
    if (!technical && /^\p{Ll}/u.test(b) && (leftWord.length >= 3 || short2) && !KEEP_HYPHEN_RIGHT.has(lower)) {
      return a.slice(0, -1) + b;
    }
    return a + b;
  }
  return `${a} ${b}`;
}

const joinLineText = dehyphenate;

/** Последнее слово строки — адрес почты, URL или домен («info@vector-», «https://vector-», «vector-plus.»). */
const TECH_TOKEN_RE = /@|:\/\/|^www\./iu;
/** Домен без почты и схемы, разорванный дефисом: «vector-plus.ex-» (точка внутри и дефис в конце). */
const DOMAIN_HYPHEN_RE = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+-$/iu;
/**
 * Строка кончается на «-» или «.» внутри почты, URL или домена, а следующая продолжает его без пробела (латинская
 * строчная или цифра): «info@vector-» + «plus.example», «info@vector-plus.» + «example» (WP11-D, корпус жанров:
 * центрированная шапка письма рвала почту на два абзаца, и «info@vector-» уходил в чат открытым).
 * @param {string} a @param {string} b
 */
export function technicalBreak(a, b) {
  // после точки — буквы домена («example»), не нумерация следующего пункта («1.3.»)
  if (!(/-$/.test(a) ? /^[a-z0-9]/ : /^[a-z]/).test(b) || !/[-.]$/.test(a)) return false;
  const tok = a.slice(a.lastIndexOf(' ') + 1);
  return tok.length > 1 && (TECH_TOKEN_RE.test(tok) || DOMAIN_HYPHEN_RE.test(tok));
}

/**
 * Склейка строк в абзацы. Новый абзац: другая страница (кроме продолжения — предыдущая строка дошла до края и не
 * кончилась точкой), шаг строк больше PARA_PITCH обычного, смена кегля, отступ первой строки > INDENT·size, маркер
 * списка, предыдущая строка явно короче колонки (следующее слово на ней помещалось).
 * @param {(Line & {col?: {left: number, right: number}})[]} lines строки по порядку чтения (одиночные сегменты)
 * @param {{pitch?: number, left?: (L: Line) => number, right?: (L: Line) => number, block?: (L: Line) => any}} [o]
 *   block — узкий блок строки (narrowBlocks): строки разных блоков в один абзац не склеиваются
 * @returns {{text: string, page: number, pageEnd: number, size: number, bold: number, lines: number, chars: number, contPage?: boolean}[]}
 */
export function mergeParagraphs(lines, o = {}) {
  const pitch = o.pitch || 0;
  const leftOf = o.left || ((L) => L.col?.left ?? L.segs[0].x0);
  const rightOf = o.right || ((L) => L.col?.right ?? L.segs[L.segs.length - 1].x1);
  const blockOf = o.block || (() => undefined);
  const paras = [];
  /** @type {any} */
  let cur = null;
  let prevL = null;
  for (const L of lines) {
    const text = lineText(L);
    const seg = { ...L.segs[0], text, x1: L.segs[L.segs.length - 1].x1, chars: L.segs.reduce((n, s) => n + s.chars, 0) };
    let newPara = !cur;
    if (cur && prevL) {
      const prevSeg = cur.lastSeg;
      const sameSize = Math.abs(L.size - prevL.size) <= 0.15 * Math.max(L.size, prevL.size);
      const left = leftOf(L);
      const right = rightOf(prevL);
      if (L.page !== prevL.page || (L.col && prevL.col && L.col.left !== prevL.col.left)) {
        // продолжение на следующей странице/колонке: предыдущая строка дошла до края и абзац не закончен;
        // «;» на границе — не конец, если дальше строчная буква без нумерации («…Федерации;» + «все уведомления»)
        const full = !wouldFit(prevSeg, seg, right);
        const ended = /[.!?:]$/.test(cur.text) || (/;$/.test(cur.text) && (!/^\p{Ll}/u.test(text) || NUMBERING_RE.test(text)));
        newPara = !(sameSize && full && !ended && !BULLET_RE.test(text));
        if (!newPara && L.page !== prevL.page) cur.contPage = true;
      } else {
        const step = L.y - prevL.y;
        const p = pitch || prevL.size * 1.2;
        if (step > PARA_PITCH * p || step <= 0) newPara = true;
        else if (!sameSize) newPara = true;
        else if (blockOf(L) !== blockOf(prevL))
          newPara = true; // граница узкого блока (надписи)
        else if (technicalBreak(cur.text, text)) {
          // перенос внутри адреса почты или домена («info@vector-» + «plus.example») — продолжение, даже в строке по центру
        } else if ((seg.bold >= 0.9 && prevSeg.bold <= 0.2) || (seg.bold <= 0.2 && prevSeg.bold >= 0.9))
          newPara = true; // жирный заголовок
        else if (centered(prevSeg, leftOf(prevL), right) && Math.abs(seg.x0 - prevSeg.x0) > L.size)
          newPara = true; // строка по центру
        else if (seg.x0 - left > INDENT * L.size && prevSeg.x0 - left <= INDENT * L.size) newPara = true;
        else if (BULLET_RE.test(text)) newPara = true;
        else if (/[.;:]$/.test(cur.text) && NUMBERING_RE.test(text))
          newPara = true; // «… товар.» + «1.3. …»
        else if (wouldFit(prevSeg, seg, right)) newPara = true;
      }
    }
    if (newPara) {
      if (cur) paras.push(cur);
      cur = { text, page: L.page, pageEnd: L.page, size: seg.size, boldChars: seg.bold * seg.chars, chars: seg.chars, lines: 1, lastSeg: seg };
    } else {
      cur.text = dehyphenate(cur.text, text);
      cur.pageEnd = L.page;
      cur.boldChars += seg.bold * seg.chars;
      cur.chars += seg.chars;
      cur.lines++;
      cur.lastSeg = seg;
    }
    prevL = L;
  }
  if (cur) paras.push(cur);
  return paras.map((p) => ({
    text: p.text,
    page: p.page,
    pageEnd: p.pageEnd,
    size: p.size,
    bold: p.chars ? p.boldChars / p.chars : 0,
    lines: p.lines,
    chars: p.chars,
    contPage: p.contPage,
  }));
}

/**
 * Заголовок по кеглю и жирности: ≥ 1.5 медианного кегля — h1, ≥ 1.2 — h2; целиком жирный абзац до 12 слов — h2.
 * Длинные абзацы (> 30 слов) заголовками не считаются.
 * @param {{text: string, size: number, bold: number}} p
 * @param {number} median
 * @returns {'h1'|'h2'|null}
 */
export function classifyHeading(p, median) {
  const words = p.text.split(/\s+/).filter(Boolean).length;
  if (!words || words > 30 || !/\p{L}/u.test(p.text)) return null;
  if (median > 0 && p.size >= 1.5 * median) return 'h1';
  if (median > 0 && p.size >= 1.2 * median) return 'h2';
  if (p.bold >= 0.9 && words <= 12 && !/[,;]$/.test(p.text)) return 'h2';
  return null;
}

/**
 * Пункт маркированного списка: маркер (•, –, —, ○, ▪, ■, ✓, -) и пробел в начале. Нумерация («1.», «1.1.») остаётся
 * обычным абзацем: база знаний сторон ищет начало условий по «1.» (kb.js).
 * @param {string} text
 * @returns {string|null} текст без маркера или null
 */
export function detectList(text) {
  const m = BULLET_RE.exec(text);
  return m ? text.slice(m[0].length) : null;
}

/* ---------------- сборка ---------------- */

function median(values) {
  if (!values.length) return 0;
  const v = values.slice().sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}

/**
 * Обычный шаг строк внутри абзаца: наименьший из частых шагов (кластеры шириной 1 pt, не меньше 2 и 10 % всех шагов).
 * Медиана не годится: в коротких договорах большинство шагов — между абзацами.
 * @param {number[]} steps
 */
export function linePitch(steps) {
  if (!steps.length) return 0;
  const v = steps.slice().sort((a, b) => a - b);
  const need = Math.max(2, Math.ceil(0.1 * v.length));
  for (let i = 0; i < v.length;) {
    let j = i;
    while (j < v.length && v[j] - v[i] <= 1) j++;
    if (j - i >= need) return median(v.slice(i, j));
    i = j;
  }
  return v[0]; // частых шагов нет (очень короткий документ) — наименьший
}

/**
 * Страницы pdf.js → блоки документа.
 * @param {PageItems[]} pages
 * @returns {Layout}
 */
export function buildLayout(pages) {
  const raw = pages.map(orientPage).map((p) => ({ page: p.page, height: p.height, lines: pageLines(p) }));
  // кегль основного текста — медиана по символам
  const sizes = [];
  for (const p of raw) for (const L of p.lines) for (const s of L.segs) for (let k = 0; k < Math.min(s.chars, 200); k++) sizes.push(s.size);
  const bodySize = median(sizes);
  /** Обычный шаг строк: наименьший частый шаг между соседними строками основного кегля (linePitch). */
  const pitchOf = (list) => {
    const steps = [];
    for (const p of list) {
      for (let k = 1; k < p.lines.length; k++) {
        const a = p.lines[k - 1];
        const b = p.lines[k];
        const d = b.y - a.y;
        if (Math.abs(a.size - bodySize) <= 0.15 * bodySize && Math.abs(b.size - bodySize) <= 0.15 * bodySize && d >= 0.9 * bodySize && d <= 2.5 * bodySize)
          steps.push(d);
      }
    }
    return linePitch(steps) || bodySize * 1.2;
  };
  const { pages: clean, headers } = stripRepeating(raw, bodySize, pitchOf(raw));
  const pitch = pitchOf(clean);

  /** @type {Block[]} */
  const blocks = [];
  for (const h of headers.filter((x) => x.kind === 'header')) blocks.push({ kind: 'header', text: h.text, page: h.page });

  let tableIndex = 0;
  /** @type {(Line & {col?: any})[]} */
  let pending = [];
  /** Правый и левый края текста страницы — для проверки «строка дошла до края». */
  const rightEdge = new Map();
  const leftEdge = new Map();
  for (const p of clean) {
    if (!p.lines.length) continue;
    rightEdge.set(p.page, Math.max(...p.lines.map((L) => L.segs[L.segs.length - 1].x1)));
    leftEdge.set(p.page, Math.min(...p.lines.map((L) => L.segs[0].x0)));
  }
  // разрыв страницы перед блоком с новой страницы (hr), абзац через границу страниц — разрыв после него
  let lastPage = 0;
  const pageBreak = (page) => {
    if (lastPage && page > lastPage) blocks.push({ kind: 'hr', text: '', page: lastPage });
    if (page > lastPage) lastPage = page;
  };
  const flush = () => {
    if (!pending.length) return;
    const boxes = narrowBlocks(pending, pitch, leftEdge, rightEdge);
    const paras = mergeParagraphs(pending, {
      pitch,
      left: (L) => L.col?.left ?? leftEdge.get(L.page) ?? L.segs[0].x0,
      right: (L) => L.col?.right ?? boxes.get(L)?.right ?? rightEdge.get(L.page) ?? L.segs[L.segs.length - 1].x1,
      block: (L) => boxes.get(L),
    });
    for (const para of paras) {
      pageBreak(para.page);
      const li = detectList(para.text);
      if (li !== null) blocks.push({ kind: 'li', text: li, page: para.page });
      else blocks.push({ kind: classifyHeading(para, bodySize) || 'p', text: para.text, page: para.page });
      pageBreak(para.pageEnd);
    }
    pending = [];
  };

  for (const p of clean) {
    if (!p.lines.length) continue;
    const units = detectTables(detectColumns(p.lines), pitch);
    for (const u of units) {
      if ('table' in u) {
        flush();
        pageBreak(p.page);
        const t = u.table;
        const index = tableIndex++;
        const sorted = t.cells.slice().sort((a, b) => a.row - b.row || a.col - b.col);
        // пустые ячейки — чтобы строки Markdown-таблицы были полными
        for (let row = 0; row < t.rows; row++) {
          for (let col = 0; col < t.cols; col++) {
            const c = sorted.find((x) => x.row === row && x.col === col);
            blocks.push({ kind: 'cell', text: c ? c.text : '', page: c ? c.page : p.page, table: { index, row, col, cols: t.cols } });
          }
        }
        continue;
      }
      const L = u.line;
      if (L.segs.length > 1) {
        // строка с далёкими сегментами вне таблицы («г. Москва        15 сентября 2026 г.») — одна строка
        const segs = L.segs;
        const merged = { ...segs[0], text: segs.map((x) => x.text).join(' '), x1: segs[segs.length - 1].x1, chars: segs.reduce((n, x) => n + x.chars, 0) };
        pending.push({ ...L, segs: [merged] });
      } else pending.push(L);
    }
  }
  flush();
  normalizeHr(blocks);
  for (const h of headers.filter((x) => x.kind === 'footer')) blocks.push({ kind: 'footer', text: h.text, page: h.page });
  return { blocks, pages: pages.length, warnings: [] };
}

/**
 * Узкие блоки (надпись LibreOffice «Согласовано: Зайцева / Ольга Петровна», врезка): ≥ 2 подряд идущих строк вне
 * колонок одной страницы с общим началом x0 (±0.3·size) с отступом > INDENT·size от левого края текста, одного кегля
 * и с обычным шагом, причём самая длинная из них заметно короче правого края страницы. Для них «строка дошла до края»
 * считается по локальному правому краю (max x1 участка), а не по краю страницы: иначе каждая строка надписи стала бы
 * отдельным абзацем и ФИО разорвалось бы на части. Строка, кончающаяся на «.!?:;», абзац не продолжает и здесь.
 * @param {Line[]} lines @param {number} pitch @param {Map<number, number>} leftEdge @param {Map<number, number>} rightEdge
 * @returns {Map<Line, {right: number}>} строка → её блок (один объект на блок) с локальным правым краем
 */
function narrowBlocks(lines, pitch, leftEdge, rightEdge) {
  /** @type {Map<Line, {right: number}>} */
  const out = new Map();
  let i = 0;
  while (i < lines.length) {
    const L = lines[i];
    const x0 = L.segs[0].x0;
    const indented = !L.col && x0 - (leftEdge.get(L.page) ?? x0) > INDENT * L.size;
    let j = i + 1;
    if (indented) {
      while (j < lines.length) {
        const N = lines[j];
        const P = lines[j - 1];
        const step = N.y - P.y;
        if (N.col || N.page !== L.page || Math.abs(N.segs[0].x0 - x0) > 0.3 * L.size) break;
        if (Math.abs(N.size - L.size) > 0.15 * L.size || step <= 0 || step > PARA_PITCH * (pitch || 1.2 * L.size)) break;
        if (/[.!?:;]$/.test(lineText(P))) break;
        j++;
      }
    }
    if (j - i >= 2) {
      const block = lines.slice(i, j);
      const right = Math.max(...block.map((x) => x.segs[x.segs.length - 1].x1));
      const box = { right };
      if (right < (rightEdge.get(L.page) ?? Infinity) - 2 * L.size) for (const x of block) out.set(x, box);
    }
    i = j;
  }
  return out;
}

/** Разрывы страниц: без повторов подряд, не в начале и не в конце основного текста. */
function normalizeHr(blocks) {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind !== 'hr') continue;
    const prev = blocks
      .slice(0, i)
      .reverse()
      .find((x) => x.kind !== 'header');
    const next = blocks[i + 1];
    if (!prev || prev.kind === 'hr' || !next || next.kind === 'hr' || next.kind === 'footer') blocks.splice(i, 1);
  }
}
