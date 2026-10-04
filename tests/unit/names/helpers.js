// Помощники тестов WP2: документ из параграфов, анализ только с детекторами WP2.
import { makeDocx, run, para } from '../../helpers/docx.js';
import { parseDocx } from '../../../src/core/docx/model.js';
import { analyze } from '../../../src/core/detect/runner.js';
import { clearDetectors, registerDetector, registerDocumentDetector } from '../../../src/core/contracts/index.js';
import { defaultSettings } from '../../../src/core/settings.js';
import { register } from '../../../src/core/detect/names/index.js';

export const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** .docx из параграфов (строки — обычный текст). */
export function docFromParagraphs(paras) {
  return parseDocx(makeDocx(paras.map((t) => para(run(esc(t)))).join('')));
}

/** Сбросить реестр и зарегистрировать детекторы WP2 (+ дополнительные). */
export function registerNames({ withNames = true, extra } = {}) {
  clearDetectors();
  if (withNames) register({ registerDetector, registerDocumentDetector });
  if (extra) extra({ registerDetector, registerDocumentDetector });
}

/** Настройки: все встроенные категории включены. */
export function allOnSettings(patch = {}) {
  const s = defaultSettings();
  for (const k of Object.keys(s.categories)) s.categories[k] = true;
  return { ...s, ...patch };
}

export async function analyzeParagraphs(paras, settings = defaultSettings()) {
  const doc = docFromParagraphs(paras);
  const res = await analyze(doc, settings);
  return { doc, ...res };
}
