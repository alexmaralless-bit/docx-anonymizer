// Строки интерфейса пакета модели NER (WP8): паритет ru/en, тексты ошибок для всех кодов хранилища, справка.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { OPTIONS_DICT } from '../../../src/ui/i18n/options.js';
import { panel } from '../../../src/ui/i18n/panel.js';
import { HELP_DICT } from '../../../src/ui/i18n/help.js';
import { MAX_PACK_BYTES, MODEL_STORE_ERROR_CODES as STORE_CODES } from '../../../src/shared/model-store.js';

describe('i18n: модель NER', () => {
  it('словари настроек и панели: ключи ru и en совпадают, строки не пусты', () => {
    for (const dict of [OPTIONS_DICT, panel]) {
      expect(Object.keys(dict.en).sort()).toEqual(Object.keys(dict.ru).sort());
      for (const lang of ['ru', 'en']) for (const [k, v] of Object.entries(dict[lang])) expect(String(v).trim(), `${lang}.${k}`).not.toBe('');
    }
  });

  it('у каждого кода ModelStoreError есть текст ошибки; коды совпадают с model-store.js', () => {
    const src = readFileSync(new URL('../../../src/shared/model-store.js', import.meta.url), 'utf8');
    // все коды, которые бросает хранилище (литералы), объявлены в MODEL_STORE_ERROR_CODES
    for (const m of src.matchAll(/ModelStoreError\('([A-Z_]+)'/g)) expect(STORE_CODES).toContain(m[1]);
    for (const c of STORE_CODES) {
      expect(OPTIONS_DICT.ru[`ner_err_${c}`], c).toBeTruthy();
      expect(OPTIONS_DICT.en[`ner_err_${c}`], c).toBeTruthy();
    }
  });

  it('TOO_LARGE: код объявлен, тексты ru/en есть и называют тот же предел, что MAX_PACK_BYTES', () => {
    expect(STORE_CODES).toContain('TOO_LARGE');
    const mb = String(MAX_PACK_BYTES / (1024 * 1024));
    const unit = { ru: 'МБ', en: 'MB' };
    for (const lang of ['ru', 'en']) expect(OPTIONS_DICT[lang].ner_err_TOO_LARGE, lang).toContain(`${mb} ${unit[lang]}`);
    // страница настроек проверяет размер файла до чтения в память
    const opts = readFileSync(new URL('../../../src/options/options.js', import.meta.url), 'utf8');
    expect(opts).toMatch(/f\.size > MAX_PACK_BYTES[\s\S]{0,200}f\.arrayBuffer\(\)/);
  });

  it('статус «не проверен», подсказка о приватности, предупреждение панели с причиной', () => {
    expect(OPTIONS_DICT.ru.ner_unverified).toBe('не проверен');
    expect(OPTIONS_DICT.ru.ner_privacy).toMatch(/локально/);
    expect(panel.ru.warnNer).toContain('{reason}');
    expect(panel.ru.nerReason_MODEL_LOAD_FAILED).toBeTruthy();
    expect(panel.ru.nerReason_INFERENCE_FAILED).toBeTruthy();
  });

  it('справка больше не утверждает, что нейросетевого распознавания нет', () => {
    expect(HELP_DICT.ru.check_2).not.toMatch(/Нейросетевого распознавания нет/);
    expect(HELP_DICT.ru.check_2).toMatch(/офлайн/);
    expect(HELP_DICT.ru.privacy_4).toMatch(/хранилище браузера/);
    const helpJs = readFileSync(new URL('../../../src/help/help.js', import.meta.url), 'utf8');
    expect(helpJs).toContain("list('ul', t, 'privacy', 4)");
  });

  it('встроенная модель (WP10-C): тексты говорят про полный и лёгкий архив, «ничего не скачивает» и «локально» сохранены', () => {
    for (const k of ['ner_hint', 'ner_privacy']) expect(OPTIONS_DICT.ru[k], k).toMatch(/архив/);
    expect(OPTIONS_DICT.ru.ner_hint).toMatch(/полном архиве/);
    expect(OPTIONS_DICT.ru.ner_hint).toMatch(/лёгкого архива/);
    expect(OPTIONS_DICT.ru.ner_privacy).toMatch(/ничего не скачивает/);
    expect(HELP_DICT.ru.check_2).toMatch(/полном архиве/);
    expect(HELP_DICT.ru.check_2).toMatch(/GitHub Releases/);
    expect(HELP_DICT.ru.privacy_4).toMatch(/не скачивается из сети/);
    expect(HELP_DICT.en.check_2).toMatch(/full extension archive/);
    expect(HELP_DICT.en.privacy_4).toMatch(/browser storage/);
  });
});
