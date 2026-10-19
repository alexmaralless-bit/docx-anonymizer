// Встроенная модель NER (версия 0.3, WP10-C, Ц7/К15): решения «ставить ли пакет из архива расширения» без chrome.* и DOM.
// Полная сборка (`build.mjs --with-model=<zip>`) запекает описание пакета в define __BUNDLED_MODEL__
// ({file, id, version, sha256, size}) и кладёт сам zip в models/<file>; лёгкая — null. Background по этому плану поднимает
// offscreen и шлёт MODEL_INSTALL, ответ MODEL_INSTALLED превращается в патч настроек (settingsPatchFor).
// Сеть не используется (NFR-01): пакет читается из собственного пакета расширения (chrome-extension://, offscreen/package-fetch.js).

/** clientId сообщений background ⇄ offscreen об установке встроенной модели (не порт клиента: router их не трогает). */
export const BOOTSTRAP_CLIENT = 'bootstrap';

/**
 * @typedef {{file: string, id: string, version: string, sha256: string, size: number}} BundledModel
 * @typedef {'none'|'skip'|'foreign'|'install'} BootstrapPlan
 */

/**
 * Что делать при установке/обновлении/старте профиля (docs/contracts.md §6.8):
 * - `none`    — лёгкая сборка, встроенной модели нет: offscreen не поднимается;
 * - `skip`    — этот sha встроенного пакета профиль уже обработал (поставил или пользователь потом удалил модель — не возвращаем);
 * - `foreign` — пользователь выбрал свой пакет (nerModel не пуст и не встроенный) — не трогаем;
 * - `install` — иначе, в том числе nerModel === id без bundledModelSha (ручной импорт того же пакета: хост ответит `present`).
 * @param {{bundled: BundledModel|null, settings: {nerModel?: string, bundledModelSha?: string}}} p
 * @returns {BootstrapPlan}
 */
export function planBootstrap({ bundled, settings }) {
  if (!bundled) return 'none';
  if (settings.bundledModelSha === bundled.sha256) return 'skip';
  if (settings.nerModel && settings.nerModel !== bundled.id) return 'foreign';
  return 'install';
}

/** Код ошибки для настройки bundledModelError: как в schemas/protocol.schema.json (A-Z и _), иначе INTERNAL. */
export function errorCode(code) {
  return typeof code === 'string' && /^[A-Z_]{1,40}$/.test(code) ? code : 'INTERNAL';
}

/**
 * Патч настроек по ответу хоста MODEL_INSTALLED. installed|present: sha отмечается всегда (профиль обработал этот пакет),
 * nerModel — только если за время установки пользователь не выбрал другой пакет (гонка с ручным импортом), прежняя ошибка
 * стирается. failed: только код ошибки в bundledModelError (sha не отмечается — следующий запуск попробует снова; карточка
 * «Модель NER» показывает «не удалось / повторить», docs/contracts.md §6.3).
 * @param {{status: 'installed'|'present'|'failed', code?: string}} result
 * @param {BundledModel} bundled
 * @param {{nerModel?: string}} cur  текущие настройки
 * @returns {{nerModel?: string, bundledModelSha?: string, bundledModelError: string} | null}
 */
export function settingsPatchFor(result, bundled, cur) {
  if (!bundled || !result) return null;
  if (result.status === 'failed') return { bundledModelError: errorCode(result.code) };
  if (result.status !== 'installed' && result.status !== 'present') return null;
  const done = { bundledModelSha: bundled.sha256, bundledModelError: '' };
  return cur.nerModel && cur.nerModel !== bundled.id ? done : { nerModel: bundled.id, ...done };
}
