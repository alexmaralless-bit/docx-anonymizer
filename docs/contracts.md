# Контракты модулей (для параллельных рабочих пакетов)

Документ описывает, **что уже есть** в фундаменте и **как к этому подключаться**. Источник истины — код с JSDoc;
здесь — смысл и правила. Рамки — `docs/mvp-scope.md`, ТЗ — `docs/spec-full.md`.

```
popup / content / options / restore ──port "docx"──► background (router) ──runtime.sendMessage──► offscreen ──postMessage──► Web Worker
        (клиенты протокола §5.4)                    добавляет settings                          (мост)                 host.js → core/
```

Сборка: esbuild, все бандлы — **IIFE** (content script и classic worker не умеют ESM). Точки входа — `scripts/build.mjs`.

---

## 0. Карта кода

| Путь | Что | Статус |
|---|---|---|
| `src/core/docx/zip.js` | свой ZIP: чтение, детерминированная запись, байт-копия нетронутых записей | готово |
| `src/core/docx/xml.js` | линейный токенизатор XML, (un)escape, `applyRangeEdits` | готово |
| `src/core/docx/model.js` | `parseDocx` → `DocModel` (части, параграфы, потоки, virtualText, charMap) | готово |
| `src/core/docx/replace.js` | `serializeDocx(doc, edits, opts)` — замена через раны, метаданные, rels, ZIP | готово |
| `src/core/categories.js` | **единственный** каталог 21 категории + `buildCatalog`, `normalizeValue` | готово (данные) |
| `src/core/contracts/` | типы `Entity`/`EntityGroup`/`Decision`, реестр детекторов, `NerProvider`, `Session` | готово |
| `src/core/detect/runner.js` | `analyze()` — весь конвейер поиска | готово |
| `src/core/detect/overlap.js` | `resolveOverlaps()` (FR-20) | готово |
| `src/core/apply.js`, `mapping.js`, `placeholders.js` | `applyDecisions()`, маппинг, плейсхолдеры, режимы | готово |
| `src/core/deanon.js` | `deanonymize()` (FR-36) | готово |
| `src/core/settings.js`, `sites.js` | схема настроек, дефолты, миграции; allowlist/blocklist | готово |
| `src/core/search.js`, `text-view.js` | поиск всех вхождений; данные для вкладки «Текст» | готово |
| `src/shared/protocol.js` | протокол §5.4 + транспорт (чанки base64, клиент) | готово |
| `src/shared/settings-store.js`, `port-client.js` | обёртки `chrome.storage` и порта | готово |
| `src/offscreen/host.js` | обработчик протокола в воркере (сессии, ANALYZE/APPLY/…) | готово |
| `src/background/` | роутер портов, жизненный цикл offscreen, миграция настроек | готово; `badge.js` — WP3 |
| `src/core/validators.js`, `detect/identifiers/` | валидаторы и детекторы идентификаторов | **WP1** (сейчас — временный EMAIL) |
| `src/core/detect/names/` | PERSON/COMPANY/ADDRESS + KB | **WP2** |
| `src/content/`, `src/ui/`, `src/popup/` | перехват, панель, popup | **WP3** |
| `src/options/`, `src/restore/`, `src/core/detect/custom/` | настройки, свои категории, восстановление | **WP4** |

`src/core/**` — чистый JS: без `chrome.*`, DOM и сети (ESLint это проверяет). Тесты ядра — Vitest в Node 22.

---

## 1. Модель документа и сущностей

### 1.1. `DocModel` (`core/docx/model.js`)

`parseDocx(bytes) → DocModel` или `CoreError` с `code` ∈ `NOT_DOCX | ENCRYPTED | PARSE_FAILED`.

- `doc.streams: Stream[]` — **всё, по чему ищут детекторы**, в порядке обхода FR-25
  (document → headers → footers → footnotes → endnotes → comments → glossary → people → rels → docProps).
- `Stream.type`:
  - `live` / `deleted` / `field` — потоки параграфа (`w:t` / `w:delText` / `w:instrText`); есть `segments`, `segIndex`, `segOffset` (charMap);
  - `attr` — значение атрибута; `attrKind` ∈ `author | initials | author-id | alt | field-instr | rel-target`;
  - `meta` — текст элемента `docProps/core.xml|app.xml`.
- `Stream.text` — **virtualText** (§6.2): XML уже раскрыт (`&amp;` → `&`); `w:tab`/`w:ptab` → `\t`; `w:br`/`w:cr` → `\n`;
  `w:sym`, ссылки на сноски/комментарии, `w:drawing`/`w:pict`/`w:object`/`mc:AlternateContent` → `U+FFFC`;
  `w:noBreakHyphen` → `U+2011`; `w:softHyphen` — **0 символов** (удаляется, если попал внутрь заменяемого диапазона).
- Вложенные `w:p` (текстовые поля, ячейки, `sdtContent`) — отдельные параграфы со своими потоками; `paragraph.depth` — вложенность.
- `doc.language` — авто-язык FR-19 (`ru|en|both`), `doc.warnings` — например `EMBEDDED_NOT_PROCESSED` (FR-15).

### 1.2. `Candidate` → `Entity` → `EntityGroup` (`core/contracts/entity.js`)

| Уровень | Кто создаёт | Ключевые поля |
|---|---|---|
| `Candidate` | детектор | `start`, `end` (в virtualText потока), `confidence` (уровень), `source?`, `validator?`, `keepPrefix?`, `keepSuffix?`, `canonical?` |
| `Entity` | ядро из кандидата | + `id`, `category`, `text`, `normalized`, `streamId`, `enabled` |
| `EntityGroup` | ядро (группировка) | одно значение = один плейсхолдер: `id` (`e1`…), `value`, `normalized`, `placeholder` (`[ФИО_1]`), `level`, `enabled`, `replacement?`, `excludedOccurrences?`, `occurrences[]` |

- **Уровни** (`confidence`): `validated > labeled > kb > ner > weak`. Кандидат с уровнем вне `category.allowedLevels` ядро **молча отбрасывает** (кроме `source: 'user'`).
- **Границы**: сущность не может содержать `\n` или `U+FFFC` — такие кандидаты отбрасываются. `\t` допустим (адреса, телефоны).
- **`keepPrefix`/`keepSuffix`** — сколько символов по краям остаётся вне плейсхолдера. COMPANY `ООО «Ромашка»` → `keepPrefix: 5, keepSuffix: 1` → `ООО «[КОМПАНИЯ_1]»`. Нормализация и `value` считаются по «ядру» без обёртки.
- **`canonical`** — для вариантов (KB: падежи, инициалы, транслитерация): нормализованное значение основной сущности. Все кандидаты с одним `(category, canonical|normalized)` получают один плейсхолдер. Ядро пропускает `canonical` через `normalizeValue`, так что `ё/е` и регистр не важны.
- **Нормализация** (`normalizeValue(cat, text)`): `lower` — PERSON/COMPANY/EMAIL/URL/ADDRESS (+`ё→е`); `alnum`/`alnumUpper` — числовые идентификаторы без разделителей.
- **Авторы правок/комментариев** (FR-11) ядро обрабатывает само: `w:author`, `w15:author` → PERSON `validated`; `w:initials` и `w15:userId` получают плейсхолдер своего автора. Детекторы для потоков `author|initials|author-id` **не вызываются**.

### 1.3. Решения и применение

- `Decision = {entityId, action: 'replace'|'skip', replacement?, excludedOccurrences?}`; `mergeDecisions(groups, decisions)` → новые группы.
- `applyDecisions(doc, groups, options) → {docxBytes, mapping, stats}`; `options`: `mode` (`placeholder|mask|delete`),
  `placeholderLanguage` (для `[удалено]/[redacted]`), `keepMetadata`, `stripEmbedded`, `document {name, sha256, resultName}`, `createdAt`.
  - ручная `replacement` побеждает режим (FR-26); `mask` — все буквы/цифры → `X`; `delete` → `[удалено]`/`[redacted]`;
  - внешняя ссылка `rel-target` + URL → `https://anonymized.invalid/<плейсхолдер>`, `mailto:` + EMAIL → `mailto:[EMAIL_1]` (FR-13);
  - `keepMetadata: false` — поля docProps очищаются (элементы остаются), `custom.xml` и миниатюра удаляются вместе с записями в `[Content_Types].xml` и `.rels` (FR-12);
  - `stripEmbedded: true` — удаляются `word/embeddings/*`, `word/charts/*`, их связи и раны с `w:object`/`c:chart` (FR-15).
- Модель `DocModel` **не мутируется** — применять можно многократно (другой режим, другие решения).
- Результат детерминирован (FR-40): порядок записей как в исходнике, дата 1980-01-01, DEFLATE 6, нетронутые части — исходные сжатые байты.

### 1.4. Маппинг (`core/mapping.js`)

Формат FR-28 плюс два поля: `token` — то, что реально стоит в тексте (`[КОМПАНИЯ_1]`), и `value` — значение без обёртки (`Ромашка`).
`placeholder` — полная форма (`ООО «[КОМПАНИЯ_1]»`), `original` — `ООО «Ромашка»`. Записи отсортированы по каталогу и номеру.
`mergeMappings([...])` — склейка маппингов файлов одной отправки. **Маппинг никогда не пишется в `chrome.storage`** (FR-29).

### 1.5. `deanonymize(text, mapping) → {text, unresolved[], replaced}`

Понимает `[ФИО_1]`, `ФИО_1`, `ФИО 1`, `ФИО-1`, любой регистр, Markdown-обёртки; `ООО «[КОМПАНИЯ_1]»` → `ООО «Ромашка»`.
Записи режимов `mask`/`delete` не восстанавливаются. `unresolved` — оставшиеся `[X_n]` (позиции в результирующем тексте).

---

## 2. Детекторы (`core/contracts/detector.js`)

```js
// Потоковый: вызывается для каждого потока (кроме авторов), только если категория включена.
registerDetector('INN', (virtualText, ctx) => [{ start, end, confidence: 'validated', validator: 'inn' }]);
// ctx: { stream: {id, part, pid, type, attrKind}, language: 'ru'|'en'|'both', category, catalog, settings }

// Документный: один раз после потоковых; видит весь документ и уже найденные сущности.
registerDocumentDetector('kb', (doc, entities, ctx) => [{ streamId, category: 'PERSON', start, end, confidence: 'kb', source: 'kb', canonical }]);
// ctx: { language, catalog, settings, isEnabled(categoryId) }
```

Правила:
- Регистрация — **только** в своём `register(api)`: WP1 → `detect/identifiers/index.js`, WP2 → `detect/names/index.js`,
  WP4 → `detect/custom/index.js`. Общий `detect/index.js` не трогать.
- Детектор — чистая функция; исключение внутри детектора не роняет анализ (предупреждение `DETECTOR_FAILED`), но так делать нельзя.
- Лейблы категорий — в каталоге (`category.labels.ru/en`); добавлять лейблы можно в `categories.js` (данные), структуру записей не менять.
- Документный детектор обязан задать `streamId` и `category`; категории, выключенные в настройках, ядро отбросит само.
- Пользовательские категории (FR-44) динамические → только документным детектором; их определения — `ctx.catalog.list.filter(c => !c.builtin)`, исходный объект — `cat.custom`.
- В тестах детекторов: `clearDetectors()` в `beforeEach`, затем `register(api)` своего модуля (реестр глобален в пределах файла теста).

Пересечения (FR-20) решает ядро после всех детекторов: user → уровень → приоритет категории (порядок в каталоге;
`aboveBuiltin` — выше всех) → раньше начался → длиннее. Проигравший отбрасывается целиком.

`analyze(doc, settings, {nerProvider?, allocator?, userEntities?, onProgress?}) → {language, placeholderLanguage, entities, groups, warnings, stats}`.
`stats.virtualTextLength`, `stats.entities` (групп), `stats.occurrences`.

### NER (`core/contracts/ner.js`)
`NerProvider = {name, init(): Promise, detect(text, {language}): Promise<{start,end,label:'PER'|'ORG'|'LOC',score}[]>}`.
В MVP — `NoopNerProvider`. Сбой провайдера → предупреждение `NER_FAILED`, анализ продолжается (NFR-13).

---

## 3. Каталог и настройки

- `BUILTIN_CATEGORIES` — 21 запись: `id, label{ru,en}, placeholderPrefix{ru,en}, color, defaultOn, allowedLevels, labels{ru[],en[]}, validator, priority, builtin, normalize, numeric?`.
- `buildCatalog(settings) → {list, byId}` — встроенные + пользовательские. **UI берёт список категорий только отсюда** (FR-17).
- `isCategoryEnabled(cat, settings)` — `settings.categories[id] ?? defaultOn`.
- Настройки: `defaultSettings()`, `migrateSettings(stored) → {settings, changed}` (миграции — `MIGRATIONS[n]` + `SETTINGS_SCHEMA_VERSION`),
  `validateSettingsPatch(patch) → badKeys[]`, `VALIDATORS[key]`, `effectiveSettings(settings, profileId)`.
- Хранилище — **только** через `src/shared/settings-store.js`: `loadSettings()`, `saveSettingsPatch(patch) → {settings, rejected}`, `onSettingsChanged(cb)`.
- Сайты: `matchOrigin`, `isOriginAllowed`, `isInterceptActive(settings, origin)` (FR-07, FR-35).

---

## 4. Протокол (`src/shared/protocol.js`)

- Порт: `chrome.runtime.connect({name: 'docx'})` → `connectClient()` из `src/shared/port-client.js` возвращает клиента.
- Все сообщения `{type, requestId, ...}`; типы — `MSG.*` (§5.4) + расширение `ACK` (ответ на `DISCARD`, `CANCEL`, `BATCH_BEGIN/END`, `CATALOG_CHANGED`).
- Файлы — чанками base64 по `CHUNK_CHARS` = 4 МиБ символов (кратно 4): `FILE_BEGIN {name, size, chunks, sha256?, origin?}` → `FILE_CHUNK {index, data}`… → `ANALYZE {settingsOverride?, batchId?}`.
  Ответ — `PROGRESS {stage, percent}`… и `ENTITIES`. Результат — `RESULT_BEGIN {name, size, chunks, docId}` → `RESULT_CHUNK`… → `RESULT_END {docId, mapping, stats}`.
- Клиент:
  ```js
  const client = connectClient();
  const ent = await client.analyzeFile({ name, bytes /* или base64 из readAsDataURL */, origin, onProgress });
  // ent: {docId, language, placeholderLanguage, entities[], warnings[], stats, restoredDecisions}
  const res = await client.apply({ docId: ent.docId, mode, decisions, options: {keepMetadata, stripEmbedded} });
  // res: {name: 'x.anon.docx', bytes: Uint8Array, mapping, stats}
  await client.request(MSG.GET_TEXT, { docId, part, from, count });          // → TEXT {paragraphs[{pid,text,spans[]}], total}
  await client.request(MSG.ADD_ENTITY, { docId, category, text, replaceAll }); // → ENTITIES (ПОЛНЫЙ список, не дельта; решения сохраняются)
  await client.request(MSG.DEANON, { mappingRef: docId /* или объект маппинга */, text }); // → DEANON_RESULT {text, unresolved, replaced}
  await client.request(MSG.LIST_SESSIONS);  // → SESSIONS {sessions[] без значений}
  await client.request(MSG.DISCARD, { docId }); // → ACK
  ```
  Ошибки — `ProtocolError {code, message}`; разрыв порта → `HOST_UNAVAILABLE` для всех ожидающих запросов.
- Сущность в `ENTITIES`: `{id, category, value, normalized, placeholder, replacement?, level, source, validated, enabled, occurrences[{id, part, pid, streamId, stream, start, end, text, context, variantOf?}]}`.
- Повторная загрузка того же файла (SHA-256) в одной сессии браузера → `restoredDecisions: true` и прежние решения (§3.6).
- Сквозная нумерация по нескольким файлам: `BATCH_BEGIN {batchId}` → `analyzeFile({..., batchId})` для каждого → `BATCH_END`.

---

## 5. Подводные камни (прочитать всем)

1. **Offscreen-документ не имеет `chrome.storage`.** Background сам добавляет поле `settings` к `FILE_BEGIN/ANALYZE/APPLY/ADD_ENTITY/BATCH_BEGIN`. Клиентам настройки слать не нужно (только `settingsOverride`).
2. **`runtime.sendMessage` слышат все страницы расширения** (popup, options, restore). Не вешайте там `chrome.runtime.onMessage` с `sendResponse` — используйте порт. Сообщения с полем `target` — служебные (bg ⇄ offscreen).
3. Префикс пространства имён WordprocessingML предполагается `w:` (так пишут Word, LibreOffice, Google Docs).
4. Плейсхолдеры назначаются в `analyze` (порядок обхода); тексты `mask`/`delete` — в `applyDecisions`.
5. Для `\n`/`U+FFFC` внутри сущности — кандидат отбрасывается без предупреждения: проверяйте детекторы на текстах с переносами строк.
6. Логи — без значений сущностей и текста документа (NFR-14): только id, категории, длины, тайминги.
7. Временный детектор EMAIL (`detect/identifiers/index.js`) нужен `tests/integration/host.spec.js` и e2e — WP1 заменяет его настоящим, тесты должны остаться зелёными (настоящий детектор находит те же 4 адреса образца).
8. Блок «Проверка конвейера (dev)» в popup используется `tests/e2e/pipeline.spec.js`: id `#dev-file`, `data-testid` `dev-status`, `vt-length`, `entity-count`, `result-size` сохраняются (можно спрятать в `<details>`), пока WP5 не заменит этот e2e.
9. Образец — `scripts/make-sample.mjs` (`buildSampleDocx() → {bytes, gold}`); `gold` — все чувствительные значения для проверок утечек.
10. Snap-LibreOffice не видит скрытые каталоги и `/tmp`: интеграционный тест пишет в `test-output/` в репозитории; `SKIP_LIBREOFFICE=1` — пропустить.
11. Сборка: новые точки входа добавляются в `entries` в `scripts/build.mjs`; HTML подключает бандлы обычным `<script src>`.
