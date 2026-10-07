import { describe, it, expect } from 'vitest';
import { HELP_DICT } from '../../src/ui/i18n/help.js';
import { common } from '../../src/ui/i18n/common.js';
import { popup } from '../../src/ui/i18n/popup.js';

describe('строки справки и подписи', () => {
  it('русский и английский словари справки совпадают по ключам и не пусты', () => {
    expect(Object.keys(HELP_DICT.en).sort()).toEqual(Object.keys(HELP_DICT.ru).sort());
    for (const lang of ['ru', 'en']) for (const [k, v] of Object.entries(HELP_DICT[lang])) expect(v.trim(), `${lang}.${k}`).not.toBe('');
  });

  it('справка говорит главное: что делает, как пользоваться, данные остаются на компьютере', () => {
    const ru = HELP_DICT.ru;
    expect(ru.what_p1).toMatch(/локально/);
    expect(ru.privacy_h).toBe('Данные не покидают ваш компьютер');
    expect(ru.privacy_1).toMatch(/ни одного сетевого запроса/);
    expect([ru.how_1, ru.how_2, ru.how_3, ru.how_4].every(Boolean)).toBe(true);
  });

  it('«Сделано в Sitimlab» и «Справка» есть в общих строках на обоих языках, меню их наследует', () => {
    expect(common.ru.madeBy).toBe('Сделано в');
    expect(common.en.madeBy).toBe('Made at');
    expect(common.ru.help).toBe('Справка');
    expect(common.en.help).toBe('Help');
    expect(popup.ru.help).toBeUndefined(); // берётся из common, дубля нет
  });
});
