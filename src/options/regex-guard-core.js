// Ядро проверки regex (FR-45, R-8): общий код для Worker'а и для тестов. Без DOM и chrome.*.
import { checkRegexSource } from '../core/detect/custom/rules.js';

export const SAMPLE_LENGTH = 20000;
export const GUARD_TIMEOUT_MS = 500;

/** Текст-образец ≈ 20 000 символов: строки вида `aaaa…a!` (лат., кириллица, цифры, пробелы) + обычный текст договора. */
export function buildStressSample() {
  const lines = ['a'.repeat(45) + '!', 'а'.repeat(45) + '!', '1'.repeat(45) + '!', ' '.repeat(45) + '!', 'ab'.repeat(24) + '!', 'x-'.repeat(24) + '!'];
  const filler = 'Договор № ЗК-2024/01 между ООО «Ромашка» и Ивановым И. И.; contract no. 12345, tel +7 495 123-45-67, e-mail a.b@example.com. ';
  let s = '';
  while (s.length < SAMPLE_LENGTH) s += lines.join('\n') + '\n' + filler.repeat(3) + '\n';
  return s.slice(0, SAMPLE_LENGTH);
}

/**
 * Синхронная проверка (в Worker'е; зависание = бэктрекинг, вызывающий завершает Worker по таймеру).
 * @param {{regex: string, flags?: string, sample?: string}} req
 * @returns {{ok: boolean, code?: string, message?: string, matches?: number}}
 */
export function evaluateRegex(req) {
  const rules = checkRegexSource(req.regex, req.flags || '');
  if (!rules.ok) return { ok: false, code: rules.code, message: rules.message };
  const re = new RegExp(req.regex, (req.flags || '') + 'g');
  const sample = req.sample || buildStressSample();
  let matches = 0;
  for (const m of sample.matchAll(re)) {
    matches++;
    if (!m[0] && matches > 100000) break;
  }
  return { ok: true, matches };
}
