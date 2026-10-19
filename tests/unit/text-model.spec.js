// Текстовая модель документа (версия 0.3, Ц3): fromText → DocModel, analyze() на ней, serializeText в Markdown/текст.
import { describe, it, expect, beforeAll } from 'vitest';
import { fromText } from '../../src/core/text/model.js';
import { serializeText, escapeLineStart, escapeCell } from '../../src/core/text/serialize.js';
import { analyze, defaultSettings, registerBuiltinDetectors, clearDetectors } from '../../src/core/index.js';

/** @type {import('../../src/core/pdf/layout.js').Block[]} */
const BLOCKS = [
  { kind: 'header', text: 'ООО «Ромашка» — Договор № 15', page: 1 },
  { kind: 'h1', text: 'ДОГОВОР ПОСТАВКИ № 15', page: 1 },
  { kind: 'p', text: 'ООО «Ромашка», ИНН 7736050003, в лице директора Иванова Петра Сергеевича, e-mail info@romashka.example.', page: 1 },
  { kind: 'h2', text: '1. Предмет договора', page: 1 },
  { kind: 'p', text: '1. Поставщик передаёт товар.', page: 1 },
  { kind: 'li', text: 'первый пункт', page: 1 },
  { kind: 'hr', text: '', page: 1 },
  { kind: 'cell', text: 'Поставщик', page: 2, table: { index: 0, row: 0, col: 0, cols: 2 } },
  { kind: 'cell', text: 'Покупатель', page: 2, table: { index: 0, row: 0, col: 1, cols: 2 } },
  { kind: 'cell', text: 'ИНН 7736050003', page: 2, table: { index: 0, row: 1, col: 0, cols: 2 } },
  { kind: 'cell', text: 'a | b', page: 2, table: { index: 0, row: 1, col: 1, cols: 2 } },
  { kind: 'footer', text: 'Тел.: +7 (495) 123-45-67', page: 2 },
];

const SNAPSHOT = [
  '# ДОГОВОР ПОСТАВКИ № 15',
  '',
  'ООО «Ромашка», ИНН 7736050003, в лице директора Иванова Петра Сергеевича, e-mail info@romashka.example.',
  '',
  '## 1. Предмет договора',
  '',
  '1\\. Поставщик передаёт товар.',
  '',
  '- первый пункт',
  '',
  '---',
  '',
  '| Поставщик | Покупатель |',
  '| --- | --- |',
  '| ИНН 7736050003 | a \\| b |',
  '',
].join('\n');

beforeAll(() => {
  clearDetectors();
  registerBuiltinDetectors();
});

describe('fromText', () => {
  it('потоки, части, абзацы, таблицы и язык', () => {
    const doc = fromText(BLOCKS, { name: 'a.pdf', size: 1234 });
    expect(doc.kind).toBe('text');
    expect(doc.format).toBe('pdf');
    expect(doc.entries).toEqual([]);
    expect(doc.parts.size).toBe(0);
    expect(doc.streams).toHaveLength(11); // все блоки, кроме hr
    expect(doc.streams.every((s) => s.type === 'live' && s.id === `${s.pid}:live`)).toBe(true);
    // порядок FR-25: основной текст → колонтитулы
    expect(doc.streams.map((s) => s.part).slice(-2)).toEqual(['word/header1.xml', 'word/footer1.xml']);
    expect(doc.streams.map((s) => s.order)).toEqual(doc.streams.map((_, i) => i));
    expect(doc.paragraphs.filter((p) => p.part === 'word/document.xml')).toHaveLength(9);
    expect(doc.paragraphs.find((p) => p.pid === doc.tables[0].pids[0]).depth).toBe(1);
    expect(doc.tables).toEqual([{ index: 0, cols: 2, pids: ['p6', 'p7', 'p8', 'p9'] }]);
    expect(doc.language).toBe('ru');
    expect(doc.size).toBe(1234);
    expect(doc.blocks.find((b) => b.kind === 'hr').pid).toBeUndefined();
  });

  it('analyze() находит ИНН и e-mail, в том числе в ячейке и колонтитуле', async () => {
    const doc = fromText(BLOCKS);
    const a = await analyze(doc, defaultSettings());
    const cats = new Set(a.groups.map((g) => g.category));
    expect(cats.has('INN')).toBe(true);
    expect(cats.has('EMAIL')).toBe(true);
    const inn = a.groups.find((g) => g.category === 'INN');
    expect(inn.occurrences.map((o) => o.part)).toEqual(['word/document.xml', 'word/document.xml']);
    expect(a.groups.some((g) => g.category === 'PHONE' && g.occurrences[0].part === 'word/footer1.xml')).toBe(true);
  });
});

describe('serializeText', () => {
  it('без правок — снимок Markdown (колонтитулы не попадают)', () => {
    const r = serializeText(fromText(BLOCKS), [], { format: 'md' });
    expect(r.text).toBe(SNAPSHOT);
    expect(new TextDecoder().decode(r.bytes)).toBe(SNAPSHOT);
    expect(r.bytes[0]).not.toBe(0xef); // без BOM
    expect(r.changedParts).toEqual([]);
    expect(r.removedParts).toEqual([]);
  });

  it('plain text: блоки через пустую строку, ячейки через табуляцию', () => {
    const r = serializeText(fromText(BLOCKS), [], { format: 'txt' });
    expect(r.text).toContain('ДОГОВОР ПОСТАВКИ № 15\n\nООО «Ромашка»');
    expect(r.text).toContain('Поставщик\tПокупатель\nИНН 7736050003\ta | b\n');
    expect(r.text).not.toContain('#');
  });

  it('правка в ячейке — с экранированием «|», плейсхолдер как есть', () => {
    const doc = fromText(BLOCKS);
    const cell = doc.streams.find((s) => s.text === 'ИНН 7736050003');
    const body = doc.streams.find((s) => s.text.startsWith('ООО «Ромашка», ИНН'));
    const r = serializeText(doc, [
      { streamId: cell.id, start: 4, end: 14, newText: '[ИНН|1]' },
      { streamId: body.id, start: 5, end: 12, newText: '[КОМПАНИЯ_1]' },
    ]);
    expect(r.text).toContain('| ИНН [ИНН\\|1] | a \\| b |');
    expect(r.text).toContain('ООО «[КОМПАНИЯ_1]», ИНН 7736050003');
    expect(r.changedParts).toEqual(['word/document.xml']);
  });

  it('пересекающиеся правки и правки вне потока отклоняются', () => {
    const doc = fromText(BLOCKS);
    const s = doc.streams[1];
    expect(() =>
      serializeText(doc, [
        { streamId: s.id, start: 0, end: 5, newText: 'x' },
        { streamId: s.id, start: 3, end: 8, newText: 'y' },
      ]),
    ).toThrow(/Пересекающиеся/);
    expect(() => serializeText(doc, [{ streamId: s.id, start: 0, end: 10_000, newText: 'x' }])).toThrow(/вне потока/);
    expect(() => serializeText(doc, [{ streamId: 'nope', start: 0, end: 1, newText: 'x' }])).toThrow(/Неизвестный поток/);
  });

  it('экранирование минимальное и обратимое', () => {
    expect(escapeLineStart('# не заголовок')).toBe('\\# не заголовок');
    expect(escapeLineStart('> не цитата')).toBe('\\> не цитата');
    expect(escapeLineStart('- не список')).toBe('\\- не список');
    expect(escapeLineStart('+ и * тоже')).toBe('\\+ и * тоже');
    expect(escapeLineStart('12. Пункт')).toBe('12\\. Пункт');
    expect(escapeLineStart('1.1. Подпункт')).toBe('1.1. Подпункт');
    expect(escapeLineStart('[ФИО_1] и *звёздочки* _подчёркивания_')).toBe('[ФИО_1] и *звёздочки* _подчёркивания_');
    expect(escapeCell('a|b')).toBe('a\\|b');
  });
});
