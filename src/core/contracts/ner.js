// КОНТРАКТ: NER-провайдер (ТЗ §5.2 NLP). В MVP — только заглушка; ONNX — следующая версия.

/**
 * @typedef {object} NerSpan
 * @property {number} start
 * @property {number} end
 * @property {'PER'|'ORG'|'LOC'} label
 * @property {number} score   0–1
 */

/**
 * @typedef {object} NerProvider
 * @property {string} name
 * @property {() => Promise<void>} init                 загрузка модели (один раз на сессию offscreen)
 * @property {(text: string, opts: {language: 'ru'|'en'|'both'}) => Promise<NerSpan[]>} detect  по одному потоку
 */

/** Соответствие меток NER категориям каталога. */
export const NER_LABEL_TO_CATEGORY = Object.freeze({ PER: 'PERSON', ORG: 'COMPANY', LOC: 'ADDRESS' });

/** @implements {NerProvider} */
export class NoopNerProvider {
  constructor() {
    this.name = 'noop';
  }
  async init() {}
  /** @returns {Promise<NerSpan[]>} */
  async detect() {
    return [];
  }
}
