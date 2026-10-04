import { describe, it, expect } from 'vitest';
import { deanonymize } from '../../src/core/deanon.js';
import { mergeMappings } from '../../src/core/mapping.js';

const mapping = {
  schemaVersion: 1,
  entries: [
    {
      token: '[ФИО_1]',
      placeholder: '[ФИО_1]',
      category: 'PERSON',
      original: 'Иванов Пётр Сергеевич',
      value: 'Иванов Пётр Сергеевич',
      variants: [],
      occurrences: 3,
      source: 'kb',
      parts: [],
    },
    {
      token: '[КОМПАНИЯ_1]',
      placeholder: 'ООО «[КОМПАНИЯ_1]»',
      category: 'COMPANY',
      original: 'ООО «Ромашка-Трейд»',
      value: 'Ромашка-Трейд',
      variants: [],
      occurrences: 2,
      source: 'rule',
      parts: [],
    },
    {
      token: '[ДАТА_РОЖД_1]',
      placeholder: '[ДАТА_РОЖД_1]',
      category: 'BIRTHDATE',
      original: '12.03.1985',
      value: '12.03.1985',
      variants: [],
      occurrences: 1,
      source: 'rule',
      parts: [],
    },
    {
      token: 'XXXXXXXXXX',
      placeholder: 'XXXXXXXXXX',
      category: 'INN',
      original: '7736050003',
      value: '7736050003',
      variants: [],
      occurrences: 1,
      source: 'rule',
      parts: [],
    },
  ],
};

describe('deanonymize (FR-36)', () => {
  const cases = [
    ['[ФИО_1] подписал', 'Иванов Пётр Сергеевич подписал'],
    ['ФИО_1 подписал', 'Иванов Пётр Сергеевич подписал'],
    ['ФИО 1 и ФИО-1', 'Иванов Пётр Сергеевич и Иванов Пётр Сергеевич'],
    ['**[ФИО_1]**', '**Иванов Пётр Сергеевич**'],
    ['`[ФИО_1]`', '`Иванов Пётр Сергеевич`'],
    ['_[ФИО_1]_', '_Иванов Пётр Сергеевич_'],
    ['[фио_1]', 'Иванов Пётр Сергеевич'],
    ['ООО «[КОМПАНИЯ_1]»', 'ООО «Ромашка-Трейд»'],
    ['родился [ДАТА_РОЖД_1]', 'родился 12.03.1985'],
    ['[ФИО_10] не путать', '[ФИО_10] не путать'],
    ['ИНН XXXXXXXXXX', 'ИНН XXXXXXXXXX'],
  ];
  it.each(cases)('%s', (input, expected) => {
    expect(deanonymize(input, mapping).text).toBe(expected);
  });
  it('нераспознанные [X_n] перечисляются', () => {
    const r = deanonymize('[ФИО_2] и [АДРЕС_1] и [ФИО_1]', mapping);
    expect(r.unresolved.map((u) => u.text)).toEqual(['[ФИО_2]', '[АДРЕС_1]']);
    expect(r.replaced).toBe(1);
  });
  it('mergeMappings объединяет записи по токену', () => {
    const m = mergeMappings([
      { ...mapping, documents: [{ name: 'a.docx' }] },
      { ...mapping, documents: [{ name: 'b.docx' }] },
    ]);
    expect(m.documents).toHaveLength(2);
    expect(m.entries[0].occurrences).toBe(6);
  });
});
