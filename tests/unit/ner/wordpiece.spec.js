// WP9: WordPiece-токенизатор (core/ner/wordpiece.js) против эталона BertTokenizerFast базовой модели
// (tests/fixtures/ner/wordpiece-cases.json, tools/ner-train/make_tokenizer_fixture.py): 100 % id и офсетов.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createWordPiece } from '../../../src/core/ner/wordpiece.js';

const fx = JSON.parse(readFileSync(new URL('../../fixtures/ner/wordpiece-cases.json', import.meta.url), 'utf8'));

/** Словарь из vocabSample фикстуры: id сохраняются, остальные строки — заглушки, которые не совпадут ни с одним словом. */
function sampleVocab() {
  const lines = Array.from({ length: fx.vocabSize }, (_, i) => `\u0001${i}`);
  for (const [tok, id] of Object.entries(fx.vocabSample)) lines[id] = tok;
  return lines.join('\n') + '\n';
}

const wp = createWordPiece({
  vocab: sampleVocab(),
  lowercase: fx.tokenizer.lowercase,
  stripAccents: fx.tokenizer.stripAccents,
  maxWordChars: fx.tokenizer.maxInputCharsPerWord,
});

/** Маленький словарь для точечных проверок. */
const tiny = (tokens) => createWordPiece({ vocab: ['[PAD]', '[UNK]', '[CLS]', '[SEP]', ...tokens].join('\n') });

describe('wordpiece: эталон BertTokenizerFast', () => {
  it('спецтокены и размер словаря', () => {
    expect(wp.specials).toEqual({ cls: fx.cls, sep: fx.sep, pad: fx.pad, unk: fx.unk });
    expect(wp.size).toBe(fx.vocabSize);
  });

  it(`${fx.cases.length} случаев: слова, офсеты (UTF-16) и id субтокенов совпадают на 100 %`, () => {
    let words = 0;
    for (const c of fx.cases) {
      const got = wp.pretokenize(c.text);
      expect(got, JSON.stringify(c.text)).toEqual(c.words);
      expect(wp.encodeWords(got), JSON.stringify(c.text)).toEqual(c.ids);
      for (const w of got) expect(c.text.slice(w.start, w.end)).toBe(w.text);
      words += got.length;
    }
    expect(fx.cases.length).toBeGreaterThanOrEqual(40);
    expect(words).toBeGreaterThan(300);
  });
});

describe('wordpiece: правила претокенизатора и WordPiece', () => {
  const t = tiny(['Иван', '##ов', 'и', 'Smith', 'Sm', '##ith', 'O', "'", 'Neil', '.', ',', '-', '«', '»', 'café', 'ca', '##f', '##é']);

  it('пунктуация — отдельными словами, офсеты в исходной строке', () => {
    expect(t.pretokenize('«Иванов», Smith.')).toEqual([
      { start: 0, end: 1, text: '«' },
      { start: 1, end: 7, text: 'Иванов' },
      { start: 7, end: 8, text: '»' },
      { start: 8, end: 9, text: ',' },
      { start: 10, end: 15, text: 'Smith' },
      { start: 15, end: 16, text: '.' },
    ]);
    expect(t.pretokenize("O'Neil-Smith").map((w) => w.text)).toEqual(['O', "'", 'Neil', '-', 'Smith']);
  });

  it('кириллица и латиница: жадный longest-match с ##', () => {
    expect(t.tokenizeWord('Иванов')).toEqual([t.idOf('Иван'), t.idOf('##ов')]);
    expect(t.tokenizeWord('Smith')).toEqual([t.idOf('Smith')]); // целое слово длиннее «Sm» + «##ith»
    expect(t.tokenizeWord('café')).toEqual([t.idOf('café')]);
  });

  it('неразбираемое слово — целиком UNK; слово длиннее maxWordChars — UNK', () => {
    expect(t.tokenizeWord('Петров')).toEqual([t.specials.unk]);
    expect(t.tokenizeWord('Иванх')).toEqual([t.specials.unk]); // «Иван» + «х» без «##х» → всё слово UNK
    const long = 'Иван' + 'ов'.repeat(148); // 300 символов
    expect(long).toHaveLength(300);
    const [w] = t.pretokenize(long);
    expect(w).toEqual({ start: 0, end: 300, text: long });
    expect(t.tokenizeWord(long)).toEqual([t.specials.unk]);
    expect(t.tokenizeWord('Иван' + 'ов'.repeat(48))).toHaveLength(49); // 100 символов — ещё разбирается
  });

  it('пробелы Unicode разделяют, управляющие символы выбрасываются и слово не рвут', () => {
    expect(t.pretokenize('Иван и Smith').map((w) => w.text)).toEqual(['Иван', 'и', 'Smith']);
    const z = t.pretokenize('Ива​нов ​ и\u0000');
    expect(z).toEqual([
      { start: 0, end: 7, text: 'Ива​нов' },
      { start: 10, end: 11, text: 'и' },
    ]);
    expect(t.tokenizeWord(z[0].text)).toEqual([t.idOf('Иван'), t.idOf('##ов')]);
    expect(t.pretokenize('\t\r\n  ')).toEqual([]);
    expect(t.pretokenize('')).toEqual([]);
  });

  it('суррогатные пары и CJK: офсеты в UTF-16, иероглифы по одному', () => {
    expect(t.pretokenize('a😀b 京都')).toEqual([
      { start: 0, end: 4, text: 'a😀b' },
      { start: 5, end: 6, text: '京' },
      { start: 6, end: 7, text: '都' },
    ]);
  });

  it('lowercase и stripAccents (схема uncased-моделей)', () => {
    const u = createWordPiece({ vocab: ['[PAD]', '[UNK]', '[CLS]', '[SEP]', 'cafe', 'иван'].join('\n'), lowercase: true, stripAccents: true });
    expect(u.tokenizeWord('CAFÉ')).toEqual([u.idOf('cafe')]);
    expect(u.tokenizeWord('Иван')).toEqual([u.idOf('иван')]);
    // без stripAccents NFC/NFD не применяется: «é» и «é» — разные строки
    expect(t.tokenizeWord('café')).toEqual([t.specials.unk]);
  });

  it('словарь без спецтокенов отклоняется; \\r\\n в vocab.txt допустим', () => {
    expect(() => createWordPiece({ vocab: 'a\nb\n' })).toThrow(/\[(PAD|UNK|CLS|SEP)\]/);
    const crlf = createWordPiece({ vocab: '[PAD]\r\n[UNK]\r\n[CLS]\r\n[SEP]\r\nок\r\n' });
    expect(crlf.idOf('ок')).toBe(4);
    expect(crlf.specials).toEqual({ cls: 2, sep: 3, pad: 0, unk: 1 });
  });
});
