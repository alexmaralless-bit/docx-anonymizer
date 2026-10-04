// Конвейер анализа: потоковые детекторы → авторы → NER → документные детекторы (KB)
// → фильтр уровней → пересечения → группировка и плейсхолдеры.
import { buildCatalog, isCategoryEnabled, normalizeValue } from '../categories.js';
import { getDetectors, getDocumentDetectors } from '../contracts/detector.js';
import { NER_LABEL_TO_CATEGORY } from '../contracts/ner.js';
import { resolveOverlaps } from './overlap.js';
import { PlaceholderAllocator, resolvePlaceholderLanguage } from '../placeholders.js';

const BOUNDARY_RE = /[\n\uFFFC]/;
const AUTHOR_KINDS = new Set(['author', 'initials', 'author-id']);

/**
 * @typedef {object} AnalyzeOptions
 * @property {import('../contracts/ner.js').NerProvider} [nerProvider]
 * @property {PlaceholderAllocator} [allocator]  общий для партии файлов
 * @property {(stage: string, percent: number) => void} [onProgress]
 * @property {import('../contracts/entity.js').Entity[]} [userEntities]  сущности source='user' (ADD_ENTITY)
 */

/**
 * @typedef {object} AnalyzeResult
 * @property {'ru'|'en'|'both'} language
 * @property {'ru'|'en'} placeholderLanguage
 * @property {import('../contracts/entity.js').Entity[]} entities      после разрешения пересечений
 * @property {import('../contracts/entity.js').EntityGroup[]} groups
 * @property {{code: string, count?: number, details?: object}[]} warnings
 * @property {{streams: number, virtualTextLength: number, entities: number, occurrences: number}} stats
 */

/**
 * @param {import('../docx/model.js').DocModel} doc
 * @param {object} settings эффективные настройки (migrateSettings уже применён)
 * @param {AnalyzeOptions} [opts]
 * @returns {Promise<AnalyzeResult>}
 */
export async function analyze(doc, settings, opts = {}) {
  const progress = opts.onProgress || (() => {});
  const catalog = buildCatalog(settings);
  const language = settings.language && settings.language !== 'auto' ? settings.language : doc.language;
  const isEnabled = (id) => {
    const c = catalog.byId.get(id);
    return !!c && isCategoryEnabled(c, settings);
  };
  const warnings = [...doc.warnings];
  /** @type {import('../contracts/entity.js').Entity[]} */
  const raw = [];
  let seq = 0;

  const accept = (cand, category, stream, defaultSource) => {
    const cat = catalog.byId.get(category);
    if (!cat || !isEnabled(category)) return;
    const source = cand.source || defaultSource;
    if (source !== 'user' && !cat.allowedLevels.includes(cand.confidence)) return;
    if (!Number.isInteger(cand.start) || !Number.isInteger(cand.end) || cand.start < 0 || cand.end > stream.text.length || cand.end <= cand.start) return;
    const text = stream.text.slice(cand.start, cand.end);
    if (BOUNDARY_RE.test(text)) return;
    const keepPrefix = cand.keepPrefix || 0;
    const keepSuffix = cand.keepSuffix || 0;
    if (keepPrefix + keepSuffix >= text.length) return;
    const core = text.slice(keepPrefix, text.length - keepSuffix);
    raw.push({
      id: `c${seq++}`,
      category,
      text,
      normalized: cand.canonical ? normalizeValue(cat, cand.canonical) : normalizeValue(cat, core),
      start: cand.start,
      end: cand.end,
      streamId: stream.id,
      source,
      confidence: cand.confidence,
      validator: cand.validator,
      enabled: true,
      keepPrefix,
      keepSuffix,
      canonical: cand.canonical,
      subtype: cand.subtype,
      score: cand.score,
    });
  };

  // 1. Потоковые детекторы
  progress('detect', 0);
  const detectors = getDetectors();
  const total = doc.streams.length || 1;
  doc.streams.forEach((stream, i) => {
    if (stream.type === 'attr' && AUTHOR_KINDS.has(stream.attrKind || '')) return;
    const info = { id: stream.id, part: stream.part, pid: stream.pid, type: stream.type, attrKind: stream.attrKind };
    for (const [categoryId, list] of detectors) {
      if (!isEnabled(categoryId)) continue;
      const category = /** @type {any} */ (catalog.byId.get(categoryId));
      for (const d of list) {
        let cands;
        try {
          cands = d.fn(stream.text, { stream: info, language, category, catalog, settings }) || [];
        } catch (err) {
          warnings.push({ code: 'DETECTOR_FAILED', details: { detector: d.name } });
          continue;
        }
        for (const c of cands) accept(c, categoryId, stream, 'rule');
      }
    }
    if (i % 200 === 0) progress('detect', Math.round((i / total) * 100));
  });

  // 2. Авторы правок и комментариев (FR-11)
  if (isEnabled('PERSON')) {
    const personCat = /** @type {any} */ (catalog.byId.get('PERSON'));
    for (const s of doc.streams) {
      if (s.type !== 'attr' || !AUTHOR_KINDS.has(s.attrKind || '')) continue;
      if (s.attrKind === 'author') {
        accept({ start: 0, end: s.text.length, confidence: 'validated', subtype: 'author' }, 'PERSON', s, 'rule');
      } else if (s.linkedTo) {
        const author = doc.streamById.get(s.linkedTo);
        if (author) {
          accept(
            { start: 0, end: s.text.length, confidence: 'validated', subtype: s.attrKind, canonical: normalizeValue(personCat, author.text) },
            'PERSON',
            s,
            'rule',
          );
        }
      }
    }
  }

  // 3. NER (в MVP — заглушка); сбой не прерывает анализ (NFR-13)
  if (settings.nerEnabled && opts.nerProvider) {
    progress('ner', 0);
    try {
      await opts.nerProvider.init();
      for (const s of doc.streams) {
        if (s.type !== 'live') continue;
        const spans = await opts.nerProvider.detect(s.text, { language });
        for (const sp of spans) {
          if (sp.score < (settings.nerThreshold ?? 0.6)) continue;
          const cat = NER_LABEL_TO_CATEGORY[sp.label];
          if (cat) accept({ start: sp.start, end: sp.end, confidence: 'ner', source: 'ner', score: sp.score }, cat, s, 'ner');
        }
      }
    } catch (err) {
      warnings.push({ code: 'NER_FAILED' });
    }
    progress('ner', 100);
  }

  // 4. Документные детекторы (KB сторон, FR-22–23)
  progress('kb', 0);
  for (const d of getDocumentDetectors()) {
    let cands;
    try {
      cands = d.fn(doc, raw.slice(), { language, catalog, settings, isEnabled }) || [];
    } catch (err) {
      warnings.push({ code: 'DETECTOR_FAILED', details: { detector: d.name } });
      continue;
    }
    for (const c of cands) {
      const s = c.streamId ? doc.streamById.get(c.streamId) : null;
      if (s && c.category) accept(c, c.category, s, 'kb');
    }
  }
  // 5. Пользовательские сущности
  for (const u of opts.userEntities || []) {
    const s = doc.streamById.get(u.streamId);
    if (s) accept({ ...u, source: 'user' }, u.category, s, 'user');
  }
  progress('kb', 100);

  // 6. Пересечения
  const entities = resolveOverlaps(raw, catalog);

  // 7. Исключения пользователя (FR-32)
  const excluded = new Set((settings.exclusions || []).map((x) => `${x.category}\u0000${normalizeValue(catalog.byId.get(x.category), x.value || '')}`));
  const kept = entities.filter((e) => !excluded.has(`${e.category}\u0000${e.normalized}`));

  // 8. Группировка
  const phLang = resolvePlaceholderLanguage(settings.placeholderLanguage, language === 'both' ? 'ru' : language);
  const allocator = opts.allocator || new PlaceholderAllocator(phLang);
  const groups = groupEntities(doc, kept, catalog, allocator);

  let vlen = 0;
  for (const s of doc.streams) vlen += s.text.length;
  return {
    language,
    placeholderLanguage: allocator.lang,
    entities: kept,
    groups,
    warnings,
    stats: { streams: doc.streams.length, virtualTextLength: vlen, entities: groups.length, occurrences: kept.length },
  };
}

/**
 * Группирует сущности по (категория, canonical|normalized) в порядке обхода FR-25 и назначает плейсхолдеры.
 * @param {import('../docx/model.js').DocModel} doc
 * @param {import('../contracts/entity.js').Entity[]} entities
 * @param {{byId: Map<string, any>}} catalog
 * @param {PlaceholderAllocator} allocator
 * @returns {import('../contracts/entity.js').EntityGroup[]}
 */
export function groupEntities(doc, entities, catalog, allocator) {
  const ordered = [...entities].sort((a, b) => {
    const sa = /** @type {any} */ (doc.streamById.get(a.streamId)).order;
    const sb = /** @type {any} */ (doc.streamById.get(b.streamId)).order;
    return sa - sb || a.start - b.start;
  });
  /** @type {Map<string, import('../contracts/entity.js').EntityGroup & {_base?: boolean}>} */
  const groups = new Map();
  let occSeq = 0;
  for (const e of ordered) {
    const key = `${e.category}\u0000${e.normalized}`;
    let g = groups.get(key);
    const s = /** @type {any} */ (doc.streamById.get(e.streamId));
    const core = e.text.slice(e.keepPrefix, e.text.length - e.keepSuffix);
    if (!g) {
      const cat = catalog.byId.get(e.category);
      g = {
        id: `e${groups.size + 1}`,
        category: e.category,
        value: core,
        normalized: e.normalized,
        placeholder: allocator.get(cat, e.normalized),
        level: e.confidence,
        source: e.source,
        validated: e.validator || null,
        enabled: true,
        occurrences: [],
        _base: !e.canonical,
      };
      groups.set(key, g);
    } else {
      if (rank(e.confidence) < rank(g.level)) g.level = e.confidence;
      if (!g.validated && e.validator) g.validated = e.validator;
      if (!g._base && !e.canonical) {
        // основная форма — первое вхождение, которое не является вариантом
        g.value = core;
        g.source = e.source;
        g._base = true;
      }
    }
    g.occurrences.push({
      id: `o${++occSeq}`,
      streamId: e.streamId,
      part: s.part,
      pid: s.pid,
      stream: s.type,
      start: e.start,
      end: e.end,
      text: e.text,
      keepPrefix: e.keepPrefix,
      keepSuffix: e.keepSuffix,
      source: e.source,
      confidence: e.confidence,
    });
  }
  const out = [...groups.values()];
  for (const g of out) {
    delete g._base;
    for (const o of g.occurrences) {
      const core = o.text.slice(o.keepPrefix, o.text.length - o.keepSuffix);
      if (core !== g.value) o.variantOf = g.value;
    }
  }
  return out;
}

const RANKS = { validated: 0, labeled: 1, kb: 2, ner: 3, weak: 4 };
function rank(l) {
  return RANKS[l] ?? 9;
}
