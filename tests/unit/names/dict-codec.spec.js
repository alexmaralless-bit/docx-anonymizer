// WP7: кодек словарей (front-coding) и санитария сгенерированных словарей ФИО (scripts/make-dicts.mjs).
import { describe, it, expect } from 'vitest';
import { encodeList, decodeList } from '../../../src/core/detect/names/dict/codec.js';
import { getDicts, surnameLemmas, surnameSuffixInfo, bigFirstNameInfo } from '../../../src/core/detect/names/dict/index.js';
import RU_SURNAMES from '../../../src/core/detect/names/dict/ru-surnames.js';
import { isStopWord, COMMON_NOUNS } from '../../../src/core/detect/names/lexicon.js';

describe('кодек front-coding', () => {
  it('round-trip: кириллица (с дефисом) и латиница, порядок — сортировка', () => {
    const ru = ['иванов', 'иванова', 'ивановский', 'римский-корсаков', 'аа', 'ящук', 'ъыь'];
    const enc = encodeList(ru);
    expect(enc[0]).toBe('R');
    expect(enc).toMatch(/^[\x20-\x7e\n]+$/);
    expect(decodeList(enc)).toEqual([...ru].sort());
    const en = ['smith', 'smithson', 'smyth', 'o-neil', 'a'];
    expect(decodeList(encodeList(en))).toEqual([...en].sort());
    expect(decodeList(encodeList([]))).toEqual([]);
  });

  it('модуль словаря — ASCII без символов, ломающих template literal', () => {
    expect(RU_SURNAMES).toMatch(/^[0-9A-Za-z:;<=>?@\n]+$/);
  });

  it('длинный общий префикс (> 40) кодируется', () => {
    const a = 'а'.repeat(50);
    expect(decodeList(encodeList([a, a + 'б']))).toEqual([a, a + 'б']);
  });

  it('недопустимые слова отклоняются', () => {
    expect(() => encodeList(['Иванов'])).toThrow();
    expect(() => encodeList(['ёлкин'])).toThrow();
    expect(() => encodeList(['ivanov', 'иванов'])).toThrow();
  });
});

describe('санитария словарей', () => {
  const d = getDicts();

  it('размеры в ожидаемых диапазонах', () => {
    expect(d.ruSurnames.size).toBe(50000);
    expect(d.ruFirst.size).toBeGreaterThanOrEqual(5000);
    expect(d.ruFirst.size).toBeLessThanOrEqual(8000);
    expect(d.enFirst.size).toBeGreaterThanOrEqual(3000);
    expect(d.enSurnames.size).toBe(10000);
    expect(d.ruAmbiguous.size).toBeGreaterThan(50);
  });

  it('нижний регистр, без «ё», без стоп-слов и нарицательных', () => {
    for (const set of [d.ruSurnames, new Set(d.ruFirst.keys())]) {
      for (const w of set) {
        expect(w).toMatch(/^[а-я]+(?:-[а-я]+)*$/);
      }
    }
    for (const w of d.ruSurnames) {
      expect(isStopWord(w), w).toBe(false);
      expect(COMMON_NOUNS.has(w), w).toBe(false);
    }
    for (const w of d.enFirst) expect(w).toMatch(/^[a-z]+$/);
  });

  it('частые фамилии на месте, нарицательные — нет', () => {
    for (const w of ['иванов', 'смирнов', 'ткаченко', 'шевчук', 'чайковский', 'хасанов', 'павловский', 'римский', 'корсаков'])
      expect(d.ruSurnames.has(w), w).toBe(true);
    for (const w of ['ромашка', 'вектор', 'москва', 'директор', 'иван', 'анна']) expect(d.ruSurnames.has(w), w).toBe(false);
  });

  it('имена с родом; омонимы помечены', () => {
    expect(d.ruFirst.get('иван')).toBe('m');
    expect(d.ruFirst.get('анна')).toBe('f');
    expect(d.ruFirst.get('зульфия')).toBe('f');
    expect(d.ruAmbiguous.has('вера')).toBe(true);
    expect(bigFirstNameInfo('Вере').every((x) => x.ambiguous)).toBe(true);
    expect(bigFirstNameInfo('Зульфие')).toEqual([{ lemma: 'зульфия', gender: 'f', cases: [2, 5], ambiguous: false }]);
    expect(d.enFirst.has('brenda')).toBe(true);
    expect(d.enFirst.has('will')).toBe(false);
  });

  it('декодирование быстрое (< 500 мс)', () => {
    expect(d.decodeMs).toBeLessThan(500);
  });
});

describe('морфология фамилий по словарю', () => {
  it('падежные формы обоих родов и дефисные фамилии', () => {
    expect(surnameLemmas('Ивановой')).toEqual(expect.arrayContaining([{ lemma: 'иванова', gender: 'f', cases: [1, 2, 4, 5] }]));
    expect(surnameLemmas('Иванову').map((x) => [x.lemma, x.gender])).toEqual(
      expect.arrayContaining([
        ['иванов', 'm'],
        ['иванова', 'f'],
      ]),
    );
    expect(surnameLemmas('Павловской').map((x) => x.lemma)).toContain('павловская');
    expect(surnameLemmas('Шевчуку')).toEqual([{ lemma: 'шевчук', gender: 'm', cases: [2] }]);
    expect(surnameLemmas('Римского-Корсакова')).toEqual(expect.arrayContaining([{ lemma: 'римский-корсаков', gender: 'm', cases: [1, 3] }]));
    expect(surnameLemmas('Ромашкой')).toEqual([]);
  });

  it('фамилия по суффиксу', () => {
    expect(surnameSuffixInfo('Шмелькину')).toEqual(expect.arrayContaining([{ lemma: 'шмелькин', gender: 'm', cases: [2] }]));
    expect(surnameSuffixInfo('Портфель')).toBeNull();
  });
});
