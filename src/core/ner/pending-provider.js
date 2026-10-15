// Временный NER-провайдер (WP8): проводка «настройки → хост → хранилище модели» готова, инференса ещё нет.
// init() читает и проверяет pack.json установленного пакета и сообщает MODEL_LOAD_FAILED — runner превращает это
// в предупреждение NER_FAILED {details: {reason: 'MODEL_LOAD_FAILED'}}, анализ правилами продолжается (NFR-13).
// WP9 заменяет тело на ONNX-провайдер (onnxruntime-web + WordPiece) с тем же контрактом core/contracts/ner.js.
import { CoreError } from '../errors.js';
import { PACK_MANIFEST, parsePackManifest } from './pack.js';

/**
 * @param {{files: {read: (path: string) => Promise<Uint8Array>}, modelId: string, ort?: any}} deps
 *   files — доступ к файлам пакета (src/shared/model-store.js openModelFiles), ort — модуль onnxruntime-web из worker
 * @returns {import('../contracts/ner.js').NerProvider}
 */
export function createPendingNerProvider({ files, modelId }) {
  return {
    name: `pending:${modelId}`,
    async init() {
      let manifest;
      try {
        const parsed = parsePackManifest(await files.read(PACK_MANIFEST));
        if (!parsed.ok) throw new Error(parsed.error);
        manifest = parsed.manifest;
      } catch (err) {
        throw new CoreError('MODEL_LOAD_FAILED', 'Пакет модели не читается', { modelId });
      }
      throw new CoreError('MODEL_LOAD_FAILED', 'Провайдер модели появится в WP9', { modelId, version: manifest.version });
    },
    async detect() {
      return [];
    },
    dispose() {},
  };
}
