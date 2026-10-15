// WP9: окна NER (core/ner/windows.js) — целые слова, [CLS] … [SEP], перекрытие ровно stride слов, усечение длинного слова.
import { describe, it, expect } from 'vitest';
import { makeWindows, sentenceRanges } from '../../../src/core/ner/windows.js';
import { createWordPiece } from '../../../src/core/ner/wordpiece.js';

const CLS = 2;
const SEP = 3;
/** Слово i из k субтокенов с id 1000·i + j — по id видно, какому слову принадлежит субтокен. */
const words = (lens) => lens.map((k, i) => Array.from({ length: k }, (_, j) => 1000 * (i + 1) + j));
const opts = (maxLen, stride) => ({ maxLen, stride, cls: CLS, sep: SEP });

describe('makeWindows', () => {
  it('короткий текст — одно окно: [CLS] субтокены [SEP], индексы первых субтокенов', () => {
    const w = makeWindows(words([1, 2, 1]), opts(16, 2));
    expect(w).toEqual([{ wordFrom: 0, wordTo: 3, ids: [CLS, 1000, 2000, 2001, 3000, SEP], wordStartIndex: [1, 2, 4] }]);
  });

  it('пустой текст — нет окон', () => {
    expect(makeWindows([], opts(16, 2))).toEqual([]);
  });

  it('слова не режутся, окна не длиннее maxLen, перекрытие ровно stride слов, покрыты все слова', () => {
    const lens = Array.from({ length: 200 }, (_, i) => 1 + ((i * 7) % 4)); // 1–4 субтокена
    const wi = words(lens);
    const maxLen = 32;
    const stride = 4;
    const ws = makeWindows(wi, opts(maxLen, stride));
    expect(ws.length).toBeGreaterThan(5);
    const covered = new Set();
    ws.forEach((w, n) => {
      expect(w.ids.length).toBeLessThanOrEqual(maxLen);
      expect(w.ids[0]).toBe(CLS);
      expect(w.ids.at(-1)).toBe(SEP);
      // окно = конкатенация целых слов wordFrom..wordTo
      expect(w.ids.slice(1, -1)).toEqual(wi.slice(w.wordFrom, w.wordTo).flat());
      w.wordStartIndex.forEach((t, k) => expect(w.ids[t]).toBe(1000 * (w.wordFrom + k + 1)));
      // следующее слово уже не влезло бы
      if (w.wordTo < wi.length) expect(w.ids.length + lens[w.wordTo]).toBeGreaterThan(maxLen);
      if (n > 0) expect(ws[n - 1].wordTo - w.wordFrom).toBe(stride);
      for (let k = w.wordFrom; k < w.wordTo; k++) covered.add(k);
    });
    expect(ws[0].wordFrom).toBe(0);
    expect(ws.at(-1).wordTo).toBe(wi.length);
    expect(covered.size).toBe(wi.length);
  });

  it('слово длиннее maxLen − 2 субтокенов усекается и занимает окно целиком; окна всё равно продвигаются', () => {
    const wi = words([1, 40, 1, 1]);
    const ws = makeWindows(wi, opts(10, 3));
    for (const w of ws) expect(w.ids.length).toBeLessThanOrEqual(10);
    const big = ws.find((w) => w.wordFrom === 1);
    expect(big).toEqual({ wordFrom: 1, wordTo: 2, ids: [CLS, ...wi[1].slice(0, 8), SEP], wordStartIndex: [1] });
    expect(ws.at(-1).wordTo).toBe(4);
    // каждое следующее окно начинается правее предыдущего
    for (let n = 1; n < ws.length; n++) expect(ws[n].wordFrom).toBeGreaterThan(ws[n - 1].wordFrom);
  });

  it('слово без субтокенов (пустое после нормализации) — wordStartIndex −1', () => {
    const ws = makeWindows([[10], [], [11]], opts(8, 1));
    expect(ws).toEqual([{ wordFrom: 0, wordTo: 3, ids: [CLS, 10, 11, SEP], wordStartIndex: [1, -1, 2] }]);
  });

  it('maxLen < 3 — ошибка', () => {
    expect(() => makeWindows(words([1]), opts(2, 0))).toThrow();
  });
});

describe('sentenceRanges', () => {
  const wp = createWordPiece({
    vocab: '[PAD]\n[UNK]\n[CLS]\n[SEP]\n',
    lowercase: false,
    stripAccents: false,
    cls: '[CLS]',
    sep: '[SEP]',
    pad: '[PAD]',
    unk: '[UNK]',
  });
  const split = (text) => {
    const words = wp.pretokenize(text);
    return sentenceRanges(words, text).map(([a, b]) => text.slice(words[a].start, words[b - 1].end));
  };
  it('граница — «.», «!», «?» перед словом с заглавной; инициалы и сокращения — не граница', () => {
    expect(split('Груз принят водителем Аммосовой Антониной. Груз сопровождает Т.Е. Ходенков из г. Омск. Ключи передаются «Арендатору» сразу!')).toEqual([
      'Груз принят водителем Аммосовой Антониной.',
      'Груз сопровождает Т.Е. Ходенков из г. Омск.',
      'Ключи передаются «Арендатору» сразу!',
    ]);
    expect(split('Сумма 1.5 млн руб. включает НДС. «Ромашка» платит в срок.')).toEqual(['Сумма 1.5 млн руб. включает НДС.', '«Ромашка» платит в срок.']);
  });
  it('короткий обрывок идёт со следующим предложением; перенос строки — граница всегда', () => {
    expect(split('Добрый день! По поручению Тарасова сообщаю о переносе.')).toEqual(['Добрый день! По поручению Тарасова сообщаю о переносе.']);
    expect(split('Директор\nИванов Пётр Сергеевич')).toEqual(['Директор', 'Иванов Пётр Сергеевич']);
    expect(sentenceRanges([], '')).toEqual([]);
  });
});
