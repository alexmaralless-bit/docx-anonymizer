// КОНТРАКТ: NER-провайдер (ТЗ §5.2 NLP). Провайдер создаёт фабрика хоста env.createNerProvider(settings) по пакету модели
// из хранилища (WP8); ONNX-реализация — WP9. Без модели — провайдера нет, этап NER пропускается.

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
 * @property {() => void} [dispose]                    освободить модель (хост зовёт при MODEL_CHANGED и смене модели)
 *
 * init() вызывается на каждый анализ и должен кэшировать загруженную модель. Ошибка загрузки — CoreError с кодом
 * MODEL_LOAD_FAILED: runner превращает её в предупреждение NER_FAILED {details: {reason: 'MODEL_LOAD_FAILED'}},
 * прочие исключения init/detect — в NER_FAILED {details: {reason: 'INFERENCE_FAILED'}}.
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
