// Разметка текста PDF (версия 0.3, К4): строки, слова, колонки, абзацы, переносы, заголовки, списки, таблицы,
// колонтитулы и разрывы страниц — на синтетических снимках текстовых элементов pdf.js.
import { describe, it, expect } from 'vitest';
import { buildLayout, groupLines, normalizeItems, joinWords, dehyphenate, classifyHeading, detectList, linePitch } from '../../../src/core/pdf/layout.js';

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
