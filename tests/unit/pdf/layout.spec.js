// Разметка текста PDF (версия 0.3, К4): строки, слова, колонки, абзацы, переносы, заголовки, списки, таблицы,
// колонтитулы и разрывы страниц — на синтетических снимках текстовых элементов pdf.js.
import { describe, it, expect } from 'vitest';
import {
  buildLayout,
  groupLines,
  normalizeItems,
  joinWords,
  dehyphenate,
  classifyHeading,
  detectList,
  linePitch,
  findGutters,
  orientPage,
  orientationOf,
  isUpright,
  technicalBreak,
} from '../../../src/core/pdf/layout.js';

const H = 842;
const W = 595;
const CW = 6; // ширина символа при кегле 12 в этих снимках

/** Элемент pdf.js: y — базовая линия сверху страницы. */
function item(str, x, y, { size = 12, font = 'f1', eol = false, w } = {}) {
  return { str, transform: [size, 0, 0, size, x, H - y], width: w ?? str.length * (size / 2), height: size, fontName: font, hasEOL: eol };
}
const page = (n, items, fonts = {}) => ({ page: n, width: W, height: H, items, fonts });
const texts = (layout, kind) => layout.blocks.filter((b) => !kind || b.kind === kind).map((b) => b.text);

/** Абзац из строк шириной до 480 pt (по 80 символов), шаг 14.4 pt. */
function para(text, y0, { x = 50, width = 80, step = 14.4, size = 12, font = 'f1' } = {}) {
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > width) {
      lines.push(cur.trim());
      cur = w;
    } else cur = `${cur} ${w}`;
  }
  if (cur.trim()) lines.push(cur.trim());
  return { items: lines.map((l, i) => item(l, x, y0 + i * step, { size, font })), end: y0 + lines.length * step };
}

const LONG =
  'Стороны обязуются соблюдать порядок приёмки работ, сроки и требования к качеству, установленные техническим заданием, а также своевременно уведомлять друг друга об обстоятельствах, препятствующих исполнению обязательств.';

describe('строки и слова', () => {
  it('элементы с базовыми линиями в пределах 0.3·size — одна строка, слева направо', () => {
    const runs = normalizeItems(page(1, [item('мир', 100, 100.0 + 0.3 * 12), item('Привет', 50, 100)]));
    const lines = groupLines(runs);
    expect(lines).toHaveLength(1);
    expect(joinWords(lines[0]).map((s) => s.text)).toEqual(['Привет мир']);
  });

  it('зазор 0.1·size — без пробела, 0.4·size — пробел', () => {
    const a = item('Ива', 50, 100, { w: 3 * CW });
    const b = item('нов', 50 + 3 * CW + 0.1 * 12, 100, { w: 3 * CW });
    const c = item('Пётр', 50 + 6 * CW + 0.1 * 12 + 0.4 * 12, 100, { w: 4 * CW });
    const segs = joinWords(groupLines(normalizeItems(page(1, [a, b, c])))[0]);
    expect(segs.map((s) => s.text)).toEqual(['Иванов Пётр']);
  });

  it('явный пробельный элемент pdf.js даёт пробел даже при малом зазоре', () => {
    const segs = joinWords(
      groupLines(normalizeItems(page(1, [item('ИНН', 50, 100, { w: 18 }), item(' ', 68, 100, { w: 1 }), item('7736050003', 69, 100)])))[0],
    );
    expect(segs[0].text).toBe('ИНН 7736050003');
  });

  it('hasEOL у непустого элемента завершает сегмент', () => {
    const segs = joinWords(groupLines(normalizeItems(page(1, [item('Конец', 50, 100, { eol: true }), item('Начало', 90, 100)])))[0]);
    expect(segs.map((s) => s.text)).toEqual(['Конец', 'Начало']);
  });

  it('надстрочный знак сноски остаётся в своей строке', () => {
    const lines = groupLines(normalizeItems(page(1, [item('указано в сноске', 50, 100), item('1', 146, 96, { size: 7 })])));
    expect(lines).toHaveLength(1);
  });

  it('повёрнутый текст (водяной знак) отбрасывается', () => {
    const rot = { str: 'КОПИЯ', transform: [8, 8, -8, 8, 200, 400], width: 40, height: 12, fontName: 'f1', hasEOL: false };
    expect(normalizeItems(page(1, [rot]))).toEqual([]);
  });
});

describe('абзацы и переносы', () => {
  it('строки с шагом 1.2·size — один абзац, после промежутка 2·size — новый', () => {
    const p1 = para(LONG, 100, { step: 1.2 * 12 });
    const p2 = para('Второй абзац договора начинается после промежутка.', p1.end - 1.2 * 12 + 3.4 * 12);
    const L = buildLayout([page(1, [...p1.items, ...p2.items])]);
    expect(texts(L, 'p')).toEqual([LONG, 'Второй абзац договора начинается после промежутка.']);
  });

  it('«слово-» + строчная → слово без дефиса; «Санкт-» + «Петербург» — дефис остаётся', () => {
    expect(dehyphenate('стороны обязуются по сло-', 'вор и далее')).toBe('стороны обязуются по словор и далее');
    expect(dehyphenate('слово-', 'вор')).toBe('слововор');
    expect(dehyphenate('г. Санкт-', 'Петербург, ул. Ленина')).toBe('г. Санкт-Петербург, ул. Ленина');
    expect(dehyphenate('пишите на office@lunny-', 'svet.example')).toBe('пишите на office@lunny-svet.example');
    expect(dehyphenate('Невский пр-', 'т, д. 100')).toBe('Невский пр-т, д. 100');
    expect(dehyphenate('какой-', 'либо')).toBe('какой-либо');
    expect(dehyphenate('мягкий пере\u00AD', 'нос')).toBe('мягкий перенос');
    expect(dehyphenate('без переноса', 'дальше')).toBe('без переноса дальше');
  });

  it('перенос по ширине склеивает строки абзаца с удалением дефиса', () => {
    const items = [item('Исполнитель обязуется оказать услуги в соответствии с техническим зада-', 50, 100), item('нием и сдать результат.', 50, 114.4)];
    const L = buildLayout([page(1, items)]);
    expect(texts(L)).toEqual(['Исполнитель обязуется оказать услуги в соответствии с техническим заданием и сдать результат.']);
  });

  it('нумерованный пункт после точки — новый абзац, «1.» остаётся абзацем (не списком)', () => {
    const items = [
      item('1.1. Покупатель обязуется принять и оплатить товар в порядке и сроки по договору.', 50, 100),
      item('1.2. Поставщик обязуется передать товар.', 50, 114.4),
    ];
    const L = buildLayout([page(1, items)]);
    expect(L.blocks.map((b) => [b.kind, b.text.slice(0, 4)])).toEqual([
      ['p', '1.1.'],
      ['p', '1.2.'],
    ]);
  });
});

describe('заголовки и списки', () => {
  it('кегль 1.5× медианы — h1, жирный короткий абзац — h2', () => {
    const body = para(LONG, 160);
    const items = [item('ДОГОВОР ПОСТАВКИ', 150, 80, { size: 18 }), item('1. ПРЕДМЕТ ДОГОВОРА', 50, 120, { font: 'fb' }), ...body.items];
    const L = buildLayout([page(1, items, { f1: { name: 'LiberationSerif' }, fb: { name: 'AAAAAA+LiberationSerif-Bold' } })]);
    expect(L.blocks.slice(0, 3).map((b) => b.kind)).toEqual(['h1', 'h2', 'p']);
    expect(classifyHeading({ text: 'Обычный абзац', size: 12, bold: 0 }, 12)).toBe(null);
    expect(classifyHeading({ text: 'Подзаголовок', size: 14.5, bold: 0 }, 12)).toBe('h2');
  });

  it('маркеры списка → li без маркера; нумерация — не список', () => {
    expect(detectList('• первый пункт')).toBe('первый пункт');
    expect(detectList('– второй')).toBe('второй');
    expect(detectList('1. Предмет')).toBe(null);
    const items = [item('• Поставка товара в срок.', 50, 100), item('• Оплата в течение 5 дней.', 50, 124)];
    expect(buildLayout([page(1, items)]).blocks.map((b) => [b.kind, b.text])).toEqual([
      ['li', 'Поставка товара в срок.'],
      ['li', 'Оплата в течение 5 дней.'],
    ]);
  });
});

describe('колонки и таблицы', () => {
  it('две колонки по 6 строк читаются слева направо', () => {
    const left = Array.from({ length: 6 }, (_, i) => `Левая колонка строка ${i + 1} с текстом до правого края колонки текст`);
    const right = Array.from({ length: 6 }, (_, i) => `Правая колонка строка ${i + 1} с текстом до правого края колонки текст`);
    const items = [];
    left.forEach((t, i) => items.push(item(t.slice(0, 38), 50, 100 + i * 14.4, { w: 230 })));
    right.forEach((t, i) => items.push(item(t.slice(0, 38), 320, 100 + i * 14.4, { w: 230 })));
    const L = buildLayout([page(1, items)]);
    const all = texts(L).join(' ');
    expect(all.indexOf('Левая колонка строка 6')).toBeGreaterThan(-1);
    expect(all.indexOf('Левая колонка строка 6')).toBeLessThan(all.indexOf('Правая колонка строка 1'));
    expect(L.blocks.some((b) => b.kind === 'cell')).toBe(false);
  });

  it('таблица 3×3 → 9 ячеек с cols: 3 и координатами', () => {
    const items = [];
    const rows = [
      ['ИНН', 'КПП', 'ОГРН'],
      ['7736050003', '773601001', '1027700132195'],
      ['5004001234', '500401001', '1127746123450'],
    ];
    rows.forEach((r, i) => r.forEach((t, j) => items.push(item(t, 60 + j * 170, 200 + i * 20))));
    const L = buildLayout([page(1, [item('Реквизиты сторон договора', 50, 160), ...items])]);
    const cells = L.blocks.filter((b) => b.kind === 'cell');
    expect(cells).toHaveLength(9);
    expect(cells.every((c) => c.table.cols === 3 && c.table.index === 0)).toBe(true);
    expect(cells.map((c) => [c.table.row, c.table.col, c.text])[4]).toEqual([1, 1, '773601001']);
  });
});

describe('колонтитулы и страницы', () => {
  /** 4 страницы: верхняя полоса повторяется на 3 из 4, номер «Страница N из 4» внизу. */
  function pages4() {
    return [1, 2, 3, 4].map((n) => {
      const items = [item(`Страница ${n} из 4`, 270, 820, { size: 9 })];
      if (n !== 3) items.push(item('ООО «Ромашка» — Договор № 15', 200, 40, { size: 9 }));
      items.push(...para(`${n}. ${LONG}`, 100).items);
      return page(n, items);
    });
  }

  it('повтор верхней полосы на 3 из 4 страниц — header, номер страницы удалён, hr между страницами', () => {
    const L = buildLayout(pages4());
    expect(texts(L, 'header')).toEqual(['ООО «Ромашка» — Договор № 15']);
    expect(L.blocks.some((b) => /Страница \d из 4/.test(b.text))).toBe(false);
    expect(L.blocks.filter((b) => b.kind === 'hr')).toHaveLength(3);
    expect(texts(L, 'p').map((t) => t.slice(0, 2))).toEqual(['1.', '2.', '3.', '4.']);
  });

  // Финальная приёмка 0.3 (perf-50p): признак повтора — только у крайней строки полосы, не похожей на текст договора.
  /** Страница: текст до y ≈ 762 (последнее предложение кончается точкой), затем строка `tail` обычным шагом в нижней полосе. */
  function pageWithTail(n, tail, { font = 'f1', pageNum = true } = {}) {
    const items = [];
    for (let k = 0; k < 5; k++) items.push(item(`${n}.${k + 1}. Пункт договора номер ${k + 1}, изложенный в одной строке.`, 50, 704 + k * 14.4, { w: 300 }));
    items.push(item(tail, 50, 776, { font, w: 300 }));
    if (pageNum) items.push(item(`Страница ${n} из 4`, 270, 820, { size: 9 }));
    return page(n, items, { f2: { bold: true } });
  }

  it('повторяющаяся строка тела с ИНН внизу страницы — не колонтитул', () => {
    const L = buildLayout([1, 2, 3, 4].map((n) => pageWithTail(n, `ИНН 770100100${n}, телефон отдела договоров — в приложении`)));
    expect(texts(L, 'footer')).toEqual([]);
    expect(L.blocks.filter((b) => b.kind !== 'footer' && /ИНН 770100100\d/.test(b.text))).toHaveLength(4);
  });

  it('повторяющийся жирный заголовок раздела внизу страницы — не колонтитул', () => {
    const L = buildLayout([1, 2, 3, 4].map((n) => pageWithTail(n, `${n + 1}. ПОРЯДОК ВЫПОЛНЕНИЯ РАБОТ ЭТАПА ${n + 1}`, { font: 'f2' })));
    expect(texts(L, 'footer')).toEqual([]);
    expect(L.blocks.filter((b) => /ПОРЯДОК ВЫПОЛНЕНИЯ РАБОТ ЭТАПА/.test(b.text))).toHaveLength(4);
  });

  it('повторяющаяся строка, продолжающая абзац (строка выше без конца предложения), — не колонтитул', () => {
    const pages = [1, 2, 3, 4].map((n) => {
      const pg = pageWithTail(n, 'обязательств по настоящему договору.');
      pg.items[4] = item(`${n}.5. Стороны своевременно уведомляют друг друга об обстоятельствах, препятствующих исполнению`, 50, 761.6, { w: 495 });
      return pg;
    });
    const L = buildLayout(pages);
    expect(texts(L, 'footer')).toEqual([]);
    expect(L.blocks.filter((b) => /исполнению обязательств по настоящему договору\.$/.test(b.text))).toHaveLength(4);
  });

  it('настоящий колонтитул крайней строкой полосы (над номером страницы, обычным кеглем и шагом) — колонтитул', () => {
    const L = buildLayout([1, 2, 3, 4].map((n) => pageWithTail(n, 'ООО «Ромашка» — Договор № 15, редакция 2')));
    expect(texts(L, 'footer')).toEqual(['ООО «Ромашка» — Договор № 15, редакция 2']);
    expect(L.blocks.some((b) => b.kind !== 'footer' && /Ромашка/.test(b.text))).toBe(false);
    expect(L.blocks.some((b) => /Страница \d из 4/.test(b.text))).toBe(false);
  });

  it('верхняя повторяющаяся строка, продолжающая абзац с прошлой страницы обычным шагом, — не колонтитул', () => {
    const full = (t, y) => item(t, 50, y, { w: 495 });
    const body = (n, y0) => [0, 1, 2, 3].map((k) => full(`Пункт ${n}.${k + 1}: стороны соблюдают порядок приёмки работ, сроки и требования к`, y0 + k * 14.4));
    const pages = [1, 2, 3, 4].map((n) =>
      page(n, [
        n === 1
          ? item('ДОГОВОР ПОДРЯДА', 200, 50, { size: 16 })
          : full('качеству, установленные техническим заданием, и уведомляют друг друга о препятствиях', 50),
        ...body(n, 64.4),
      ]),
    );
    const L = buildLayout(pages);
    expect(texts(L, 'header')).toEqual([]);
    expect(
      texts(L)
        .join('\n')
        .match(/требования к качеству, установленные техническим заданием/g),
    ).toHaveLength(3);
  });

  it('абзац, продолжающийся на следующей странице, склеивается; разрыв — после него', () => {
    const lines1 = [
      item('Стороны обязуются соблюдать порядок приёмки работ, сроки и требования к качеству по', 50, 760, { w: 495 }),
      item('договору подряда, а также своевременно уведомлять друг друга о всех обстоятельствах', 50, 774.4, { w: 495 }),
    ];
    const lines2 = [item('препятствующих исполнению обязательств.', 50, 80), ...para('Новый абзац на второй странице.', 110).items];
    const L = buildLayout([page(1, lines1), page(2, lines2)]);
    expect(L.blocks.map((b) => b.kind)).toEqual(['p', 'hr', 'p']);
    expect(L.blocks[0].text).toMatch(/обстоятельствах препятствующих исполнению обязательств\.$/);
  });

  it('обычный шаг строк — наименьший частый шаг, а не медиана', () => {
    expect(linePitch([24, 24, 24, 15, 15, 24, 24])).toBe(15);
    expect(linePitch([14.4])).toBe(14.4);
  });
});

describe('ревью WP10-A: переносы, моноширинный шрифт, надписи, поворот, таблицы, колонки, колонтитулы', () => {
  it('Д1: «цифры-» + «цифры» — дефис мягкого переноса убирается при группе ≥ 4 цифр, телефон не ломается', () => {
    expect(dehyphenate('директор, ИНН 7805-', '003215.')).toBe('директор, ИНН 7805003215.');
    expect(dehyphenate('счёт 407-', '02810700000012345')).toBe('счёт 40702810700000012345');
    expect(dehyphenate('тел. +7 (495) 123-', '45-67')).toBe('тел. +7 (495) 123-45-67');
    expect(dehyphenate('тел. 8-900-', '123-45-67')).toBe('тел. 8-900-123-45-67');
    expect(dehyphenate('СНИЛС 112-233-', '445 95')).toBe('СНИЛС 112-233-445 95');
  });

  it('Д2: U+2010 и U+00AD в конце строки склеиваются всегда; «Ан-» + «дреева» — перенос, «По-» + «видимому» — нет', () => {
    expect(dehyphenate('директора Ан\u2010', 'дреева Петра')).toBe('директора Андреева Петра');
    expect(dehyphenate('стороны за\u2010', 'ключили договор')).toBe('стороны заключили договор');
    expect(dehyphenate('мягкий пере\u00AD', 'нос')).toBe('мягкий перенос');
    expect(dehyphenate('директора Ан-', 'дреева Петра')).toBe('директора Андреева Петра');
    expect(dehyphenate('По-', 'ставщик обязуется')).toBe('Поставщик обязуется');
    expect(dehyphenate('По-', 'видимому, нет')).toBe('По-видимому, нет');
    expect(dehyphenate('Во-', 'первых, стороны')).toBe('Во-первых, стороны');
    expect(dehyphenate('из-', 'за просрочки')).toBe('из-за просрочки');
    expect(dehyphenate('ул. Ле-', 'нина')).toBe('ул. Ленина');
  });

  it('Д3: моноширинный шрифт — пробел шириной в символ не режет «БИК 044525901» на ячейки', () => {
    const mono = (str, x, y) => item(str, x, y, { w: str.length * 7.2 });
    // три строки реквизитов: подпись и номер через один пробел (7.2 pt), вторая колонка — далеко
    const rows = [
      ['р/с', '40702810700000012345', 'E-mail: ivan@zvezda.example'],
      ['к/с', '30101810300000000901', 'Банк: ПАО «Банк»'],
      ['БИК', '044525901', 'Символ черты |'],
    ];
    // как в Chromium: каждое слово — отдельный элемент pdf.js, между словами — пробел шириной в символ
    const words = (t, x, y) => {
      let at = x;
      return t.split(' ').map((w) => {
        const it = mono(w, at, y);
        at += (w.length + 1) * 7.2;
        return it;
      });
    };
    const items = rows.flatMap(([a, b, c], i) => [mono(a, 61, 300 + i * 18), mono(b, 61 + a.length * 7.2 + 7.2, 300 + i * 18), ...words(c, 300, 300 + i * 18)]);
    const lines = groupLines(normalizeItems(page(1, items)));
    expect(findGutters(lines).map((x) => [...x])).toEqual([[2], [2], [2]]);
    const cells = buildLayout([page(1, items)]).blocks.filter((b) => b.kind === 'cell');
    expect(cells.map((c) => c.text)).toContain('БИК 044525901');
    expect(cells[0].table.cols).toBe(2);
    // шрифт по имени (Liberation Mono) — тот же результат и при двух прогонах в строке
    const named = rows.flatMap(([a, b], i) => [
      { ...mono(a, 61, 300 + i * 18), fontName: 'm' },
      { ...mono(b, 61 + a.length * 7.2 + 7.2, 300 + i * 18), fontName: 'm' },
    ]);
    const lines2 = groupLines(normalizeItems(page(1, named, { m: { name: 'BBBBBB+LiberationMono' } })));
    expect(findGutters(lines2).every((x) => x.size === 0)).toBe(true);
  });

  it('Д4: узкая надпись с общим x0 — один абзац по локальному правому краю, следующий абзац отдельно', () => {
    const body = para(LONG, 100);
    const items = [
      ...body.items,
      item('Согласовано: Зайцева', 140, body.end + 20),
      item('Ольга Петровна', 140, body.end + 20 + 14.4),
      item('Надпись:', 50, body.end + 20 + 28.8),
    ];
    expect(texts(buildLayout([page(1, items)]))).toEqual([LONG, 'Согласовано: Зайцева Ольга Петровна', 'Надпись:']);
  });

  it('Д5: ориентация элементов и поворот страницы к преобладающей ориентации текста', () => {
    expect(orientationOf([12, 0, 0, 12, 0, 0])).toBe(0);
    expect(orientationOf([0, 12, -12, 0, 0, 0])).toBe(90);
    expect(orientationOf([-12, 0, 0, -12, 0, 0])).toBe(180);
    expect(orientationOf([0, -12, 12, 0, 0, 0])).toBe(270);
    expect(orientationOf([8, 8, -8, 8, 0, 0])).toBe(null);
    expect(isUpright([12, 0, 0, 12, 5, 5])).toBe(true);
    expect(isUpright([-12, 0, 0, -12, 5, 5])).toBe(false); // вверх ногами
    expect(isUpright([8, 8, -8, 8, 5, 5])).toBe(false); // водяной знак
    const lines = ['Договор поставки между сторонами заключён в городе Москве.', 'Поставщик: ООО «Ромашка», ИНН 7736050003.'];
    // текст снизу вверх (90°) у левого края книжной страницы; x элемента — расстояние от левого края
    const rot90 = page(
      1,
      lines.map((t, i) => ({ str: t, transform: [0, 12, -12, 0, 100 + i * 14.4, 60], width: t.length * 6, height: 12, fontName: 'f1', hasEOL: false })),
    );
    const o = orientPage(rot90);
    expect([o.width, o.height]).toEqual([H, W]);
    expect(o.items.every((x) => isUpright(x.transform))).toBe(true);
    expect(texts(buildLayout([rot90])).join(' ')).toBe(lines.join(' '));
    // сверху вниз (270°) и вверх ногами (180°)
    const rot270 = page(
      1,
      lines.map((t, i) => ({ str: t, transform: [0, -12, 12, 0, 500 - i * 14.4, 780], width: t.length * 6, height: 12, fontName: 'f1', hasEOL: false })),
    );
    expect(texts(buildLayout([rot270])).join(' ')).toBe(lines.join(' '));
    const rot180 = page(
      1,
      lines.map((t, i) => ({ str: t, transform: [-12, 0, 0, -12, 545, 100 + i * 14.4], width: t.length * 6, height: 12, fontName: 'f1', hasEOL: false })),
    );
    expect(texts(buildLayout([rot180])).join(' ')).toBe(lines.join(' '));
    // обычная страница с диагональным водяным знаком — без изменений, знак отброшен
    const plain = page(1, [item(lines[0], 50, 100), { str: 'КОПИЯ КОПИЯ КОПИЯ', transform: [8, 8, -8, 8, 200, 400], width: 90, height: 12, fontName: 'f1' }]);
    expect(orientPage(plain)).toBe(plain);
    expect(texts(buildLayout([plain]))).toEqual([lines[0]]);
  });

  it('Д6: числа, выровненные вправо, — своя колонка таблицы («2 | Отчёт | 2 | 120 500,50»)', () => {
    const rows = [
      ['1', 'Консультация', '10', '15 000,00'],
      ['2', 'Отчёт', '2', '120 500,50'],
      ['3', 'Сопровождение', '1', '7 000,00'],
    ];
    const right = (t, x1, y) => item(t, x1 - t.length * 6, y);
    const items = rows.flatMap((r, i) => [
      item(r[0], 61, 300 + i * 16),
      item(r[1], 127, 300 + i * 16),
      right(r[2], 573, 300 + i * 16),
      right(r[3], 797, 300 + i * 16),
    ]);
    const L = buildLayout([{ ...page(1, items), width: 842, height: 595 }]);
    const cells = L.blocks.filter((b) => b.kind === 'cell');
    expect(cells[0].table.cols).toBe(4);
    expect(cells.filter((c) => c.table.row === 1).map((c) => c.text)).toEqual(['2', 'Отчёт', '2', '120 500,50']);
  });

  it('Д7: заголовок другого кегля после двух колонок — не хвост левой колонки', () => {
    const items = [];
    for (let i = 0; i < 4; i++) {
      items.push(item(`Левая колонка строка ${i + 1} с текстом до правого`, 50, 100 + i * 14.4, { w: 230 }));
      items.push(item(`Правая колонка строка ${i + 1} с текстом до правого`, 320, 100 + i * 14.4, { w: 230 }));
    }
    items.push(item('Левая колонка строка 5 последняя.', 50, 100 + 4 * 14.4, { w: 180 }));
    items.push(item('РЕКВИЗИТЫ И ПОДПИСИ СТОРОН', 50, 100 + 6 * 14.4, { size: 14, w: 200 }));
    const all = texts(buildLayout([page(1, items)]));
    expect(all[all.length - 1]).toBe('РЕКВИЗИТЫ И ПОДПИСИ СТОРОН');
    const joined = all.join(' ');
    expect(joined.indexOf('Левая колонка строка 5')).toBeLessThan(joined.indexOf('Правая колонка строка 1'));
  });

  it('Д8: крайняя строка полосы обычного кегля, отделённая от текста, — колонтитул и на одной странице', () => {
    const body = para(LONG, 80);
    const items = [item('ООО «Ромашка» — Договор поставки № 17/ПС-2026', 280, 47), ...body.items, item('Тел.: +7 (495) 123-45-67. Стр. 1', 85, 804)];
    const L = buildLayout([page(1, items)]);
    expect(texts(L, 'header')).toEqual(['ООО «Ромашка» — Договор поставки № 17/ПС-2026']);
    expect(texts(L, 'footer')).toEqual(['Тел.: +7 (495) 123-45-67. Стр. 1']);
    expect(texts(L, 'p')).toEqual([LONG]);
    // крупный (заголовок) в полосе — не колонтитул
    const title = buildLayout([page(1, [item('ДОГОВОР ПОСТАВКИ', 200, 47, { size: 16 }), ...body.items])]);
    expect(texts(title, 'header')).toEqual([]);
  });

  it('Д12: «;» на границе страницы — не конец абзаца, если дальше строчная; нумерация — новый абзац', () => {
    const full = (t, y) => item(t, 50, y, { w: 495 });
    const p1 = [
      full('Стороны руководствуются условиями договора и действующим законодательством', 760),
      full('Российской Федерации и иными обязательными нормативными актами страны;', 774.4),
    ];
    const L = buildLayout([page(1, p1), page(2, [item('все уведомления направляются в письменной форме.', 50, 80)])]);
    expect(texts(L, 'p')).toEqual([
      'Стороны руководствуются условиями договора и действующим законодательством Российской Федерации и иными обязательными нормативными актами страны; все уведомления направляются в письменной форме.',
    ]);
    const L2 = buildLayout([page(1, p1), page(2, [item('а) уведомления направляются в письменной форме.', 50, 80)])]);
    expect(texts(L2, 'p')).toHaveLength(2);
  });
});

describe('WP11-D: почта с переносом в строке по центру, таблица из двух строк', () => {
  it('technicalBreak: «-» или «.» внутри почты/домена + латинское продолжение — склейка; нумерация и слова — нет', () => {
    expect(technicalBreak('тел. +7 (812) 092-95-31 · info@vector-', 'plus.example')).toBe(true);
    expect(technicalBreak('почта info@vector-plus.', 'example')).toBe(true);
    expect(technicalBreak('сайт https://vector-', 'plus.example/help')).toBe(true);
    expect(technicalBreak('адрес p.ivanov@romashka.ru.', '1.3. Электронная почта')).toBe(false);
    expect(technicalBreak('г. Санкт-', 'Петербург')).toBe(false);
    expect(technicalBreak('поставка товара-', 'партнёра')).toBe(false);
    expect(dehyphenate('info@vector-plus.', 'example')).toBe('info@vector-plus.example');
    expect(dehyphenate('info@vector-', 'plus.example')).toBe('info@vector-plus.example');
  });

  it('центрированная шапка: «… info@vector-» + «plus.example» — один абзац, почта целиком', () => {
    const body = item('Текст письма во всю ширину страницы, чтобы задать левый и правый край текста страницы.', 50, 100, { w: 495 });
    const head = 'Невский пр-т, д. 90 · тел. +7 (812) 092-95-31 · info@vector-';
    const tail = 'plus.example';
    const items = [
      body,
      item(head, (595 - head.length * CW) / 2, 140),
      item(tail, (595 - tail.length * CW) / 2, 154.4),
      item('Исх. № 294 от 12.10.2026', 50, 190),
    ];
    const L = buildLayout([page(1, items)]);
    expect(texts(L, 'p')).toContain('Невский пр-т, д. 90 · тел. +7 (812) 092-95-31 · info@vector-plus.example');
    expect(texts(L).some((t) => t === 'plus.example')).toBe(false);
  });

  /** Подписи акта сверки: две строки по две ячейки, ячейка второй строки переносится на третью. */
  const signatures = (tailX = 60) => [
    item('Текст акта во всю ширину страницы задаёт левый край текста страницы и правый край.', 50, 100, { w: 495 }),
    item('От ООО «Северный Ветер»', 60, 140),
    item('От ООО «Синяя Птица»', 300, 140),
    item('Главный бухгалтер ________ (Фролова', 60, 163),
    item('Главный бухгалтер ________ (Белов И.С.)', 300, 163),
    item('А.М.)', tailX, 178),
  ];

  it('две строки с выровненными ячейками — таблица 2×2, перенос ячейки последней строки — в её ячейке', () => {
    const L = buildLayout([page(1, signatures())]);
    const cells = L.blocks.filter((b) => b.kind === 'cell').map((c) => [c.table.row, c.table.col, c.text]);
    expect(cells).toEqual([
      [0, 0, 'От ООО «Северный Ветер»'],
      [0, 1, 'От ООО «Синяя Птица»'],
      [1, 0, 'Главный бухгалтер ________ (Фролова А.М.)'],
      [1, 1, 'Главный бухгалтер ________ (Белов И.С.)'],
    ]);
  });

  it('строка у левого края текста под таблицей (не у края ячейки) — отдельный абзац, а не перенос ячейки', () => {
    const L = buildLayout([page(1, signatures(50))]);
    expect(L.blocks.filter((b) => b.kind === 'cell')).toHaveLength(4);
    expect(texts(L, 'p')).toContain('А.М.)');
  });

  it('вторая из двух выровненных строк — новая строка таблицы, даже если первое слово не поместилось бы выше', () => {
    const items = [
      item('Текст во всю ширину страницы задаёт левый край текста страницы и правый край текста.', 50, 100, { w: 495 }),
      item('ИНН 7805003215', 60, 140),
      item('Тел.: +7 (812) 555-77-88', 330, 140),
      item('ООО «Северный Ветер»', 60, 154),
      item('v.morozov@severny-veter.example', 330, 154),
    ];
    const cells = buildLayout([page(1, items)]).blocks.filter((b) => b.kind === 'cell');
    expect(cells.map((c) => c.text)).toEqual(['ИНН 7805003215', 'Тел.: +7 (812) 555-77-88', 'ООО «Северный Ветер»', 'v.morozov@severny-veter.example']);
  });

  it('две строки с разным числом ячеек или разными началами — не таблица', () => {
    const items = [
      item('Текст во всю ширину страницы задаёт левый край текста страницы и правый край текста.', 50, 100, { w: 495 }),
      item('г. Москва', 50, 140),
      item('15 сентября 2026 г.', 430, 140),
      item('Поставщик: ООО «Ромашка»', 50, 154),
      item('Покупатель', 250, 154),
      item('ООО «Вектор»', 430, 154),
    ];
    expect(buildLayout([page(1, items)]).blocks.some((b) => b.kind === 'cell')).toBe(false);
  });
});
