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

// eslint-disable-next-line no-control-regex -- управляющие символы из текстового слоя PDF удаляются
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F\uFFFE\uFFFF]/g;
const BULLET_RE = /^[•‒–—○▪■✓\-·◦●►]\s+/u;
const NUMBERING_RE = /^(?:\d{1,3}(?:\.\d{1,3})*\.|\d{1,3}\)|[а-яa-z]\))\s/iu;
const PAGE_NUM_RE = /^(?:-\s*\d+\s*-|\d+|(?:страница|стр\.?|page|p\.)\s*\d+(?:\s*(?:из|of|\/)\s*\d+)?|\d+\s*(?:из|of|\/)\s*\d+)$/iu;
const BOLD_FONT_RE = /bold|black|heavy|semibold|demi|[-,]bd\b|w[6-9]00/i;
/** Слова-частицы и короткие приставки, дефис перед которыми — часть слова, а не перенос («что-то», «из-за», «пр-т»). */
const KEEP_HYPHEN_RIGHT = new Set(['то', 'либо', 'нибудь', 'таки', 'ка', 'де', 'с', 'за', 'под', 'над', 'т']);

/* ---------------- элементы → строки → сегменты ---------------- */

/**
 * Элементы страницы → «прогоны» с геометрией сверху вниз. Пробельные элементы pdf.js не выдаются, а помечают
 * соседей (spAfter/spBefore); повёрнутый текст (водяные знаки, вертикальные подписи) отбрасывается.
 * @param {PageItems} page
 */
export function normalizeItems(page) {
  const fonts = page.fonts || {};
  /** @type {{text: string, x: number, x1: number, y: number, size: number, bold: boolean, eol: boolean, spBefore: boolean, spAfter: boolean}[]} */
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
    const [a, b, c, d] = t;
    if (Math.abs(b) > 0.05 * Math.abs(a) + 1e-6 || Math.abs(c) > 0.05 * Math.abs(d) + 1e-6) continue; // поворот
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
 * Разрывы строк по «просветам» колонок (ячейки таблиц, колонки текста): зазор > SEGMENT_GAP·size — разрыв всегда;
 * зазор > GUTTER_GAP·size — разрыв, если в непрерывном участке соседних строк, которые не пересекают этот x текстом,
 * ещё ≥ 2 строки начинают элемент у того же x (±0.3·size). Растянутые пробелы выровненного по ширине абзаца так не
 * проходят: соседние строки перекрывают их словами.
 * @param {{y: number, size: number, runs: any[]}[]} lines строки страницы
 * @returns {Set<number>[]} для каждой строки — индексы прогонов, перед которыми разрыв
 */
export function findGutters(lines) {
  const splits = lines.map(() => new Set());
  const starts = (L, x, tol) => L.runs.some((r) => Math.abs(r.x - x) <= tol);
  const crosses = (L, x, tol) => L.runs.some((r) => r.x < x - tol && r.x1 > x + tol);
  lines.forEach((L, i) => {
    let right = -Infinity;
    L.runs.forEach((r, k) => {
      if (k > 0) {
        const gap = r.x - right;
        const size = Math.max(L.size, r.size);
        if (gap > SEGMENT_GAP * size) splits[i].add(k);
        else if (gap > GUTTER_GAP * size) {
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

/**
 * Колонтитулы и номера страниц (FR колонтитулов концепции 0.3): строки верхней и нижней полос (BAND высоты), текст
 * которых (цифры → #) повторяется на ≥ 3 страницах или на ≥ 50 % страниц (не меньше двух), — колонтитулы; одиночная
 * крайняя строка полосы мелким кеглем (≤ 0.85 основного) — тоже; номера страниц («3», «- 3 -», «Страница 2 из 4»,
 * «Page 2 of 4») удаляются. Возвращает строки без колонтитулов и сами колонтитулы (по одному на уникальный текст).
 * @param {{page: number, height: number, lines: Line[]}[]} pages
 * @param {number} bodySize медианный кегль документа
 * @returns {{pages: {page: number, height: number, lines: Line[]}[], headers: {kind: 'header'|'footer', text: string, page: number}[]}}
 */
export function stripRepeating(pages, bodySize = 0) {
  const n = pages.length;
  /** @type {Map<string, Set<number>>} */
  const seen = new Map();
  const bandOf = (L, h) => (L.y < BAND * h ? 'top' : L.y > (1 - BAND) * h ? 'bottom' : null);
  for (const p of pages) {
    for (const L of p.lines) {
      const band = bandOf(L, p.height);
      if (!band) continue;
      const key = `${band}\u0000${repeatKey(lineText(L))}`;
      let set = seen.get(key);
      if (!set) seen.set(key, (set = new Set()));
      set.add(p.page);
    }
  }
  const repeated = (key) => {
    const c = seen.get(key)?.size || 0;
    return c >= 2 && (c >= 3 || c >= 0.5 * n);
  };
  const headers = [];
  const known = new Set();
  const out = pages.map((p) => {
    const lines = [];
    p.lines.forEach((L, i) => {
      const band = bandOf(L, p.height);
      const text = lineText(L);
      if (band) {
        if (PAGE_NUM_RE.test(text.trim())) return;
        const extreme = band === 'top' ? i === 0 : i === p.lines.length - 1;
        const small = bodySize > 0 && L.size <= 0.85 * bodySize && extreme;
        if (repeated(`${band}\u0000${repeatKey(text)}`) || small) {
          const kind = band === 'top' ? 'header' : 'footer';
          const k = `${kind}\u0000${repeatKey(text)}`;
          if (!known.has(k)) {
            known.add(k);
            headers.push({ kind, text, page: p.page });
          }
          return;
        }
      }
      lines.push(L);
    });
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
    // одиночные строки после последней многосегментной — не таблица
    const lastMulti = run.map((r) => r.segs.length >= 2).lastIndexOf(true);
    const tableLines = run.slice(0, lastMulti + 1);
    const multi = tableLines.filter((r) => r.segs.length >= 2).length;
    const cols = clusterStarts(tableLines);
    if (multi >= 3 && cols.length >= 2) {
      units.push({ table: buildTable(tableLines, cols, pitch, pageRight, pageLeft) });
      i += tableLines.length;
    } else {
      units.push({ line: L });
      i++;
    }
  }
  return units;
}

/** x-начала колонок таблицы: кластеры начал сегментов многосегментных строк (±0.5·size), поддержанные ≥ 2 строками. */
function clusterStarts(lines) {
  /** @type {{x: number, n: number, size: number}[]} */
  const cl = [];
  for (const L of lines) {
    if (L.segs.length < 2) continue;
    for (const s of L.segs) {
      const c = cl.find((k) => Math.abs(k.x - s.x0) <= 0.5 * s.size);
      if (c) {
        c.n++;
        c.x = Math.min(c.x, s.x0);
      } else cl.push({ x: s.x0, n: 1, size: s.size });
    }
  }
  return cl
    .filter((c) => c.n >= 2)
    .map((c) => c.x)
    .sort((a, b) => a - b);
}

function buildTable(lines, cols, pitch, pageRight, pageLeft) {
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
      if (prev && prev.last.page === s.page && continues(prev.last, s, colRight(c), pitch)) {
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
 * «Санкт-» + «Петербург» → «Санкт-Петербург» (дефис остаётся); мягкий перенос U+00AD удаляется всегда;
 * дефис в почте, адресах сайтов, числах и в коротких частях («пр-т», «из-за», «что-то») остаётся. Иначе — пробел.
 * @param {string} a @param {string} b
 */
export function dehyphenate(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.endsWith('\u00AD')) return a.slice(0, -1) + b;
  if (/[\p{L}\p{N}][-\u2010]$/u.test(a)) {
    const leftTok = a.slice(a.lastIndexOf(' ') + 1, -1);
    const rightTok = b.split(' ')[0];
    const rightWord = (rightTok.match(/^\p{L}+/u) || [''])[0];
    const leftWord = (leftTok.match(/\p{L}+$/u) || [''])[0];
    const technical = /[@/\\.\d_:]/.test(leftTok) || leftWord.length !== leftTok.length;
    if (!technical && /^\p{Ll}/u.test(b) && leftWord.length >= 3 && !KEEP_HYPHEN_RIGHT.has(rightWord.toLowerCase())) {
      return a.slice(0, -1) + b;
    }
    return a + b;
  }
  return `${a} ${b}`;
}

const joinLineText = dehyphenate;

/**
 * Склейка строк в абзацы. Новый абзац: другая страница (кроме продолжения — предыдущая строка дошла до края и не
 * кончилась точкой), шаг строк больше PARA_PITCH обычного, смена кегля, отступ первой строки > INDENT·size, маркер
 * списка, предыдущая строка явно короче колонки (следующее слово на ней помещалось).
 * @param {(Line & {col?: {left: number, right: number}})[]} lines строки по порядку чтения (одиночные сегменты)
 * @param {{pitch?: number, left?: (L: Line) => number, right?: (L: Line) => number}} [o]
 * @returns {{text: string, page: number, pageEnd: number, size: number, bold: number, lines: number, chars: number, contPage?: boolean}[]}
 */
export function mergeParagraphs(lines, o = {}) {
  const pitch = o.pitch || 0;
  const leftOf = o.left || ((L) => L.col?.left ?? L.segs[0].x0);
  const rightOf = o.right || ((L) => L.col?.right ?? L.segs[L.segs.length - 1].x1);
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
        // продолжение на следующей странице/колонке: предыдущая строка дошла до края и абзац не закончен
        const full = !wouldFit(prevSeg, seg, right);
        newPara = !(sameSize && full && !/[.!?:;]$/.test(cur.text) && !BULLET_RE.test(text));
        if (!newPara && L.page !== prevL.page) cur.contPage = true;
      } else {
        const step = L.y - prevL.y;
        const p = pitch || prevL.size * 1.2;
        if (step > PARA_PITCH * p || step <= 0) newPara = true;
        else if (!sameSize) newPara = true;
        else if ((seg.bold >= 0.9 && prevSeg.bold <= 0.2) || (seg.bold <= 0.2 && prevSeg.bold >= 0.9))
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
  const raw = pages.map((p) => ({ page: p.page, height: p.height, lines: pageLines(p) }));
  // кегль основного текста — медиана по символам
  const sizes = [];
  for (const p of raw) for (const L of p.lines) for (const s of L.segs) for (let k = 0; k < Math.min(s.chars, 200); k++) sizes.push(s.size);
  const bodySize = median(sizes);
  const { pages: clean, headers } = stripRepeating(raw, bodySize);

  // обычный шаг строк: медиана расстояний между соседними строками основного кегля
  const steps = [];
  for (const p of clean) {
    for (let k = 1; k < p.lines.length; k++) {
      const a = p.lines[k - 1];
      const b = p.lines[k];
      const d = b.y - a.y;
      if (Math.abs(a.size - bodySize) <= 0.15 * bodySize && Math.abs(b.size - bodySize) <= 0.15 * bodySize && d >= 0.9 * bodySize && d <= 2.5 * bodySize)
        steps.push(d);
    }
  }
  const pitch = linePitch(steps) || bodySize * 1.2;

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
    const paras = mergeParagraphs(pending, {
      pitch,
      left: (L) => L.col?.left ?? leftEdge.get(L.page) ?? L.segs[0].x0,
      right: (L) => L.col?.right ?? rightEdge.get(L.page) ?? L.segs[L.segs.length - 1].x1,
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
