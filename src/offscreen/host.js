// Хост ядра: обработчик протокола §5.4 внутри Web Worker offscreen-документа.
// Без chrome.* — тестируется в Node (tests/integration/host.spec.js).
// Настройки приходят ВНУТРИ сообщения (поле `settings`, его добавляет background):
// offscreen-документ не имеет доступа к chrome.storage.
import {
  parseDocx,
  analyze,
  applyDecisions,
  mergeDecisions,
  deanonymize,
  findOccurrences,
  getParagraphs,
  occurrenceContext,
  migrateSettings,
  PlaceholderAllocator,
  resolvePlaceholderLanguage,
  registerBuiltinDetectors,
  NoopNerProvider,
  CoreError,
  summarizeSession,
} from '../core/index.js';
import { MSG, ChunkAssembler, postChunked, errorMessage, sha256Hex } from '../shared/protocol.js';

/**
 * @param {{post: (clientId: string, msg: object) => void, nerProvider?: any, toolVersion?: string}} env
 */
export function createHost(env) {
  registerBuiltinDetectors();
  const nerProvider = env.nerProvider || new NoopNerProvider();
  /** @type {Map<string, {begin: any, assembler: ChunkAssembler}>} */
  const uploads = new Map();
  /** @type {Map<string, any>} docId → Session */
  const sessions = new Map();
  /** @type {Map<string, PlaceholderAllocator>} */
  const batches = new Map();
  let docSeq = 0;

  /**
   * @param {string} clientId
   * @param {any} msg
   */
  async function handle(clientId, msg) {
    const post = (m) => env.post(clientId, m);
    const { requestId } = msg;
    const progress = (stage, percent) => post({ type: MSG.PROGRESS, requestId, stage, percent });
    try {
      switch (msg.type) {
        case MSG.FILE_BEGIN: {
          const settings = migrateSettings(msg.settings).settings;
          if (msg.size > settings.maxFileSizeMB * 1024 * 1024) {
            throw new CoreError('TOO_LARGE', `Файл больше ${settings.maxFileSizeMB} МБ`, { limitMB: settings.maxFileSizeMB });
          }
          uploads.set(requestId, { begin: msg, assembler: new ChunkAssembler(msg) });
          progress('receiving', 0);
          return;
        }
        case MSG.FILE_CHUNK: {
          const u = uploads.get(requestId);
          if (!u) throw new CoreError('INTERNAL', 'Чанк без FILE_BEGIN');
          u.assembler.add(msg.index, msg.data);
          progress('receiving', Math.round((u.assembler.received / u.assembler.expected) * 100));
          return;
        }
        case MSG.ANALYZE:
          return await onAnalyze(msg, post, progress);
        case MSG.APPLY:
          return await onApply(msg, post, progress);
        case MSG.GET_TEXT: {
          const s = getSession(msg.docId);
          const r = getParagraphs(s.doc, s.groups, { part: msg.part, from: msg.from, count: msg.count });
          post({ type: MSG.TEXT, requestId, docId: msg.docId, ...r });
          return;
        }
        case MSG.ADD_ENTITY:
          return await onAddEntity(msg, post, progress);
        case MSG.DEANON: {
          const ref = msg.mappingRef;
          const mapping = typeof ref === 'string' ? getSession(ref).lastMapping : ref;
          if (!mapping) throw new CoreError('INTERNAL', 'Маппинг не найден: сначала примените замены');
          // FR-37: склонение ФИО по контексту — только по явной просьбе клиента
          const r = deanonymize(msg.text || '', mapping, { decline: msg.decline === true });
          post({ type: MSG.DEANON_RESULT, requestId, text: r.text, unresolved: r.unresolved, replaced: r.replaced, declined: r.declined });
          return;
        }
        case MSG.DISCARD:
          sessions.delete(msg.docId);
          post({ type: MSG.ACK, requestId });
          return;
        case MSG.LIST_SESSIONS:
          post({ type: MSG.SESSIONS, requestId, sessions: [...sessions.values()].map(summarizeSession) });
          return;
        case MSG.BATCH_BEGIN: {
          const settings = migrateSettings(msg.settings).settings;
          const lang = resolvePlaceholderLanguage(settings.placeholderLanguage, 'ru');
          batches.set(msg.batchId, new PlaceholderAllocator(lang));
          post({ type: MSG.ACK, requestId, batchId: msg.batchId });
          return;
        }
        case MSG.BATCH_END:
          batches.delete(msg.batchId);
          post({ type: MSG.ACK, requestId });
          return;
        case MSG.CANCEL:
          uploads.delete(requestId);
          post({ type: MSG.ACK, requestId });
          return;
        case MSG.CATALOG_CHANGED:
          post({ type: MSG.ACK, requestId });
          return;
        default:
          throw new CoreError('INTERNAL', `Неизвестный тип сообщения ${msg.type}`);
      }
    } catch (err) {
      uploads.delete(requestId);
      post(errorMessage(requestId, err));
    }
  }

  async function onAnalyze(msg, post, progress) {
    const { requestId } = msg;
    const u = uploads.get(requestId);
    if (!u) throw new CoreError('INTERNAL', 'ANALYZE без файла');
    uploads.delete(requestId);
    const bytes = u.assembler.result();
    const settings = migrateSettings({ ...(msg.settings || {}), ...(msg.settingsOverride || {}) }).settings;
    const sha256 = u.begin.sha256 || (await sha256Hex(bytes));

    // §3.6: тот же файл в этой сессии браузера → прежние решения
    for (const s of sessions.values()) {
      if (s.sha256 === sha256) {
        post(entitiesMessage(requestId, s, true));
        return;
      }
    }
    progress('unzip', 0);
    const doc = parseDocx(bytes);
    progress('parse', 100);
    const allocator = msg.batchId ? batches.get(msg.batchId) : undefined;
    const analysis = await analyze(doc, settings, { nerProvider, allocator, onProgress: progress });
    const docId = `d${++docSeq}`;
    const session = {
      docId,
      name: u.begin.name,
      sha256,
      size: bytes.length,
      origin: u.begin.origin || undefined,
      batchId: msg.batchId,
      doc,
      analysis,
      groups: analysis.groups,
      settings,
      userEntities: [],
      createdAt: Date.now(),
      lastMapping: null,
    };
    sessions.set(docId, session);
    post(entitiesMessage(requestId, session, false));
  }

  async function onAddEntity(msg, post, progress) {
    const s = getSession(msg.docId);
    const found = msg.replaceAll === false ? [] : findOccurrences(s.doc, msg.text, { wholeWord: true });
    const explicit = msg.streamId != null ? [{ streamId: msg.streamId, start: msg.start, end: msg.end }] : [];
    for (const f of [...explicit, ...found]) {
      s.userEntities.push({ streamId: f.streamId, start: f.start, end: f.end, category: msg.category, confidence: 'labeled', source: 'user' });
    }
    // Переанализ с сохранением решений по ключу (категория + нормализованное значение)
    const prev = new Map(s.groups.map((g) => [`${g.category}\u0000${g.normalized}`, g]));
    const allocator = s.batchId ? batches.get(s.batchId) : undefined;
    const analysis = await analyze(s.doc, s.settings, { nerProvider, allocator, userEntities: s.userEntities, onProgress: progress });
    s.analysis = analysis;
    s.groups = analysis.groups.map((g) => {
      const p = prev.get(`${g.category}\u0000${g.normalized}`);
      return p ? { ...g, enabled: p.enabled, replacement: p.replacement } : g;
    });
    post(entitiesMessage(msg.requestId, s, false));
  }

  async function onApply(msg, post, progress) {
    const { requestId } = msg;
    const s = getSession(msg.docId);
    const settings = migrateSettings({ ...(msg.settings || {}), ...(s.settings || {}) }).settings;
    s.groups = mergeDecisions(s.groups, msg.decisions || []);
    progress('apply', 0);
    const opts = msg.options || {};
    const resultName = makeResultName(s.name, settings.outputSuffix);
    const r = applyDecisions(s.doc, s.groups, {
      mode: msg.mode || settings.mode,
      placeholderLanguage: s.analysis.placeholderLanguage,
      language: s.analysis.language,
      keepMetadata: opts.keepMetadata ?? settings.keepMetadata,
      stripEmbedded: opts.stripEmbedded ?? settings.stripEmbedded,
      document: { name: s.name, sha256: s.sha256, resultName },
      toolVersion: env.toolVersion,
    });
    s.lastMapping = r.mapping;
    progress('zip', 100);
    postChunked(post, { requestId, kind: 'RESULT', bytes: r.docxBytes, meta: { name: resultName, docId: s.docId } });
    post({ type: MSG.RESULT_END, requestId, docId: s.docId, mapping: r.mapping, stats: r.stats });
  }

  function getSession(docId) {
    const s = sessions.get(docId);
    if (!s) throw new CoreError('INTERNAL', 'Сессия документа не найдена — загрузите файл заново');
    return s;
  }

  function entitiesMessage(requestId, s, restored) {
    return {
      type: MSG.ENTITIES,
      requestId,
      docId: s.docId,
      name: s.name,
      language: s.analysis.language,
      placeholderLanguage: s.analysis.placeholderLanguage,
      entities: s.groups.map((g) => toProtocolEntity(s.doc, g)),
      warnings: s.analysis.warnings,
      stats: s.analysis.stats,
      restoredDecisions: restored,
    };
  }

  return { handle, sessions };
}

/** EntityGroup → сущность сообщения ENTITIES (§5.4). */
export function toProtocolEntity(doc, g) {
  return {
    id: g.id,
    category: g.category,
    value: g.value,
    normalized: g.normalized,
    placeholder: g.placeholder,
    replacement: g.replacement,
    level: g.level,
    source: g.source,
    validated: g.validated,
    enabled: g.enabled,
    occurrences: g.occurrences.map((o) => ({
      id: o.id,
      part: o.part,
      pid: o.pid,
      streamId: o.streamId,
      stream: o.stream,
      start: o.start,
      end: o.end,
      text: o.text,
      context: occurrenceContext(doc, o),
      variantOf: o.variantOf,
    })),
  };
}

/** 'договор.docx' → 'договор.anon.docx' */
export function makeResultName(name, suffix = '.anon') {
  const m = /^(.*?)(\.(docx|docm))?$/i.exec(name || 'document.docx');
  const base = m?.[1] || 'document';
  const ext = m?.[2] || '.docx';
  return `${base}${suffix}${ext}`;
}
