// Подсказка о ключе восстановления на экране «готово» (WP10-D, FR-28, FR-29): показывается один раз —
// если карта замен есть, пользователь её не сохранил и подсказку ещё не видел (флаг hintMappingShown в настройках).

/**
 * @param {{hintMappingShown?: boolean, mappingAvailable?: boolean, mappingSaved?: boolean}} s
 * @returns {boolean}
 */
export function shouldShowMappingHint({ hintMappingShown, mappingAvailable, mappingSaved } = {}) {
  return Boolean(mappingAvailable) && !mappingSaved && hintMappingShown !== true;
}
