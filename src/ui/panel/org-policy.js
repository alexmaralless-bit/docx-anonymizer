// Политика маскирования 0.4 в панели (docs/concept-0.4.md, решения владельца 3–4; Ц3, К3): чистые функции без DOM.

/**
 * Показать подсказку «названия организаций — по желанию»: только если миграция 2 → 3 поставила флаг
 * (существующий профиль 0.3), и только один раз — флаг снимается при показе.
 * @param {{orgPolicyHintPending?: boolean}} [settings]
 */
export function shouldShowOrgPolicyHint(settings = {}) {
  return settings?.orgPolicyHintPending === true;
}

/**
 * Новая версия списка компаний для маскирования с добавленным названием («Маскировать всегда», «запомнить»)
 * или null, если добавлять нечего: пустое название или такое уже есть (без учёта регистра, «ё» и пробелов по краям).
 * @param {{name: string, aliases?: string[]}[] | undefined} list
 * @param {string} value
 * @returns {{name: string, aliases: string[]}[] | null}
 */
export function withMaskedCompany(list, value) {
  const name = String(value ?? '')
    .replace(/[\s\u00A0]+/g, ' ')
    .trim();
  if (!name) return null;
  const key = (s) => s.trim().toLowerCase().replace(/ё/g, 'е');
  const cur = Array.isArray(list) ? list : [];
  if (cur.some((c) => key(c.name) === key(name) || (c.aliases || []).some((a) => key(a) === key(name)))) return null;
  return [...cur.map((c) => ({ name: c.name, aliases: [...(c.aliases || [])] })), { name, aliases: [] }];
}
