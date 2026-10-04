// Общий помощник тестов идентификаторов: прогоняет зарегистрированные детекторы по тексту так же, как analyze():
// фильтр по allowedLevels, границы сущности, разрешение пересечений FR-20.
import { buildCatalog } from '../../../src/core/categories.js';
import { clearDetectors, registerDetector, registerDocumentDetector, getDetectors } from '../../../src/core/contracts/detector.js';
import { register } from '../../../src/core/detect/identifiers/index.js';
import { resolveOverlaps } from '../../../src/core/detect/overlap.js';

export const catalog = buildCatalog({});

clearDetectors();
register({ registerDetector, registerDocumentDetector });

/**
 * @param {string} text
 * @param {{language?: 'ru'|'en'|'both', categories?: string[]}} [opts]
 * @returns {{category: string, text: string, start: number, end: number, level: string, validator?: string}[]}
 */
export function detect(text, opts = {}) {
  const raw = [];
  const stream = { id: 's1', part: 'word/document.xml', pid: 'p1', type: 'live' };
  for (const [categoryId, list] of getDetectors()) {
    if (opts.categories && !opts.categories.includes(categoryId)) continue;
    const category = catalog.byId.get(categoryId);
    for (const d of list) {
      for (const c of d.fn(text, { stream, language: opts.language || 'ru', category, catalog, settings: {} })) {
        if (!category.allowedLevels.includes(c.confidence)) continue;
        if (!(c.start >= 0 && c.end <= text.length && c.end > c.start)) throw new Error(`плохой диапазон ${categoryId} ${c.start}-${c.end}`);
        const t = text.slice(c.start, c.end);
        if (/[\n￼]/.test(t)) continue;
        raw.push({
          ...c,
          id: `c${raw.length}`,
          category: categoryId,
          source: c.source || 'rule',
          streamId: 's1',
          keepPrefix: c.keepPrefix || 0,
          keepSuffix: c.keepSuffix || 0,
          text: t,
        });
      }
    }
  }
  return resolveOverlaps(raw, catalog).map((e) => ({
    category: e.category,
    text: e.text,
    start: e.start,
    end: e.end,
    level: e.confidence,
    validator: e.validator,
    canonical: e.canonical,
  }));
}
