// Строки PDF (версия 0.3) в словарях панели, общих строк и настроек: ru/en с одинаковыми ключами, коды ошибок протокола
// имеют тексты, подсказка про скан понятна.
import { describe, it, expect } from 'vitest';
import { panel } from '../../../src/ui/i18n/panel.js';
import { common } from '../../../src/ui/i18n/common.js';
import { OPTIONS_DICT as options } from '../../../src/ui/i18n/options.js';
import { ERROR_CODES, STAGES } from '../../../src/shared/protocol.js';
import { ERROR_CODES as CORE_CODES } from '../../../src/core/errors.js';
import { createT } from '../../../src/ui/i18n/index.js';
import { pdfPagesKey } from '../../../src/ui/panel/panel.js';

const keys = (d) => Object.keys(d).sort();

describe('i18n PDF', () => {
  it('ru и en совпадают по ключам: панель, общие строки, настройки', () => {
    for (const [name, d] of Object.entries({ panel, common, options })) expect(keys(d.en), name).toEqual(keys(d.ru));
  });
  it('новые строки есть и не пусты', () => {
    for (const lang of ['ru', 'en']) {
      for (const k of ['warnPdfPages', 'pdfNote', 'btnUpload']) expect(panel[lang][k], `${lang}.${k}`).toBeTruthy();
      // заметка подставляет расширение результата по pdfMode; лимит страниц — свой текст (ревью WP10-A, Д9, Д10)
      expect(panel[lang].pdfNote, `${lang}.pdfNote`).toContain('{ext}');
      expect(common[lang]['err.TOO_LARGE_PAGES'], `${lang}.err.TOO_LARGE_PAGES`).toMatch(/\{pages\}.*\{limit\}/);
      for (const k of ['pdf_mode', 'pdf_mode_markdown', 'pdf_mode_text', 'pdf_mode_off', 'pdf_mode_hint'])
        expect(options[lang][k], `${lang}.${k}`).toBeTruthy();
      for (const k of ['stage.pdf', 'err.PDF_INVALID', 'err.PDF_ENCRYPTED', 'err.PDF_EMPTY', 'err.PDF_NO_TEXT'])
        expect(common[lang][k], `${lang}.${k}`).toBeTruthy();
    }
    expect(common.ru['err.PDF_NO_TEXT']).toMatch(/скан/);
    expect(common.en['err.PDF_NO_TEXT']).toMatch(/scan/);
    expect(panel.ru.warnPdfPages).toContain('{pages}');
  });
  it('страницы без текста: одна — единственное число, несколько — множественное (ru и en)', () => {
    const say = (lang, pages) => createT(panel, lang)(pdfPagesKey(pages), { pages: pages.join(', ') });
    expect(pdfPagesKey([2])).toBe('warnPdfPage');
    expect(pdfPagesKey([2, 5])).toBe('warnPdfPages');
    expect(say('ru', [2])).toMatch(/^Страница 2 не содержит текста .*её содержимое/);
    expect(say('ru', [2, 5])).toMatch(/^Страницы 2, 5 не содержат текста .*их содержимое/);
    expect(say('en', [2])).toMatch(/^Page 2 contains no text .*its content/);
    expect(say('en', [2, 5])).toMatch(/^Pages 2, 5 contain no text .*their content/);
  });
  it('у каждого кода ошибки протокола и стадии есть текст; коды ядра и протокола совпадают', () => {
    for (const code of ERROR_CODES) expect(common.ru[`err.${code}`], code).toBeTruthy();
    for (const st of STAGES) expect(common.ru[`stage.${st}`], st).toBeTruthy();
    expect(Object.values(CORE_CODES).sort()).toEqual([...ERROR_CODES].sort());
  });
});
