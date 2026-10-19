// Вид абзаца (версия 0.4, К10): DOCX — по w:pStyle/w:numPr, PDF/текстовая модель — по виду блока разметки.
// Нужен фильтрам модельных организаций (src/core/ner/filters.js): заголовок, пункт списка, ячейка.
import { describe, it, expect } from 'vitest';
import { parseDocx } from '../../src/core/docx/model.js';
import { fromText } from '../../src/core/text/model.js';
import { makeDocx } from '../helpers/docx.js';

const p = (inner, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}<w:r><w:t>${inner}</w:t></w:r></w:p>`;

describe('paragraph.kind', () => {
  it('DOCX: Heading1/Title/«1» → heading, w:numPr → li, остальное → p', () => {
    const xml =
      p('ВХОДИТ В ПАКЕТ', '<w:pStyle w:val="Heading1"/>') +
      p('Название', '<w:pStyle w:val="Title"/>') +
      p('Русский заголовок', '<w:pStyle w:val="1"/>') +
      p('Пункт', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>') +
      p('Обычный абзац', '<w:pStyle w:val="Normal"/>') +
      p('Без свойств');
    const doc = parseDocx(makeDocx(xml));
    const kinds = doc.paragraphs.filter((x) => x.part === 'word/document.xml').map((x) => x.kind);
    expect(kinds).toEqual(['heading', 'heading', 'heading', 'li', 'p', 'p']);
    // заголовок со списком остаётся заголовком
    const both = parseDocx(makeDocx(p('1. Раздел', '<w:pStyle w:val="Heading2"/><w:numPr><w:numId w:val="1"/></w:numPr>')));
    expect(both.paragraphs[0].kind).toBe('heading');
  });
  it('текстовая модель: kind блока копируется в абзац', () => {
    const doc = fromText([
      { kind: 'h1', text: 'ЗАГОЛОВОК', page: 1 },
      { kind: 'li', text: 'пункт', page: 1 },
      { kind: 'cell', text: 'ячейка', page: 1, table: { index: 0, row: 0, col: 0, cols: 1 } },
      { kind: 'hr', text: '', page: 1 },
      { kind: 'p', text: 'абзац', page: 2 },
    ]);
    expect(doc.paragraphs.map((x) => x.kind)).toEqual(['h1', 'li', 'cell', 'p']);
  });
});
