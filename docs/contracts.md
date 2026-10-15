# Контракты модулей (для параллельных рабочих пакетов)

Документ описывает, **что уже есть** в фундаменте и **как к этому подключаться**. Источник истины — код с JSDoc;
здесь — смысл и правила. Рамки — `docs/mvp-scope.md`, ТЗ — `docs/spec-full.md`.

```
popup / content / options / restore ──port "docx"──► background (router) ──runtime.sendMessage──► offscreen ──postMessage──► Web Worker
        (клиенты протокола §5.4)                    добавляет settings                          (мост)                 host.js → core/
```

Сборка: esbuild, бандлы — **IIFE** (content script и classic worker не умеют ESM), кроме `offscreen/worker.js`: с 0.2 (WP8) это
**ES-модуль** (отдельный вызов esbuild `format: 'esm'`, `new Worker('worker.js', {type: 'module'})`) — его требует `onnxruntime-web`. Точки входа — `scripts/build.mjs`.

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
| `src/core/deanon-morph.js` | склонение ФИО при восстановлении: `parsePersonValue`, `detectCase`, `declineInContext` (FR-37) | WP6 |
| `src/core/settings.js`, `sites.js` | схема настроек, дефолты, миграции; allowlist/blocklist | готово |
| `src/core/search.js`, `text-view.js` | поиск всех вхождений; данные для вкладки «Текст» | готово |
| `src/shared/protocol.js` | протокол §5.4 + транспорт (чанки base64, клиент) | готово |
| `src/shared/settings-store.js`, `port-client.js` | обёртки `chrome.storage` и порта | готово |
| `src/shared/permissions.js`, `src/background/site-access.js` | опциональный доступ к сайтам, динамическая регистрация content script (§4а) | 0.2, WP6 |
| `src/offscreen/host.js` | обработчик протокола в воркере (сессии, ANALYZE/APPLY/…) | готово |
| `src/background/` | роутер портов, жизненный цикл offscreen, миграция настроек | готово; `badge.js` — WP3 |
| `src/core/validators.js`, `detect/identifiers/` | валидаторы и детекторы идентификаторов | **WP1** (сейчас — временный EMAIL) |
| `src/core/detect/names/` | PERSON/COMPANY/ADDRESS + KB | **WP2** |
| `src/core/detect/names/person-dict.js`, `names/dict/` | словарный детектор ФИО третьих лиц, словари (генерирует `scripts/make-dicts.mjs`) | 0.2, WP7 |
| `src/core/hash.js` | `sha256Hex` (WebCrypto; `shared/protocol.js` реэкспортирует) | 0.2, WP8 |
| `src/core/ner/pack.js`, `known-packs.js`, `pending-provider.js` | формат пакета модели NER: `parsePackManifest`, `verifyPackFiles`, `packZipName`; список проверенных пакетов; временный провайдер (до WP9) | 0.2, WP8 (§6) |
| `src/shared/model-store.js` | хранилище пакетов модели в OPFS: импорт, проверка, чтение из воркера, удаление | 0.2, WP8 (§6) |
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

### 1.5. `deanonymize(text, mapping, {decline = false} = {}) → {text, unresolved[], replaced, declined[]}`

Понимает `[ФИО_1]`, `ФИО_1`, `ФИО 1`, `ФИО-1`, любой регистр, Markdown-обёртки; `ООО «[КОМПАНИЯ_1]»` → `ООО «Ромашка»`.
Записи режимов `mask`/`delete` не восстанавливаются. `unresolved` — оставшиеся `[X_n]` (позиции в результирующем тексте).
`decline: true` (FR-37, редакция 0.2) — PERSON в форме `[X_n]` склоняется по контексту (`core/deanon-morph.js`: приклеенное окончание → предлог → сочинение, иначе именительный);
`declined[] = {start, end, case: 'nom'|'gen'|'dat'|'acc'|'ins'|'prep', original, text}` — позиции в результирующем тексте, `original` — значение из карты.
При `decline: false` результат побайтно прежний, `declined` пуст. Карта замен не меняется: лемма и род выводятся из `value`/`variants`.

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
`dispose?()` (0.2, WP8) — освободить модель; хост зовёт при `MODEL_CHANGED` и смене `nerModel`. `init()` вызывается на каждый анализ и кэширует модель сам.
Провайдер создаёт фабрика хоста `env.createNerProvider(settings)` (§6.4); без модели (`nerModel: ''`), с `nerEnabled: false` или без фабрики провайдера нет и этапа `ner` нет.
Сбой провайдера → предупреждение `NER_FAILED {details: {reason}}`, анализ продолжается (NFR-13): `reason = 'MODEL_LOAD_FAILED'`, если `init()`/`detect()` бросили ошибку с `code === 'MODEL_LOAD_FAILED'` (`CoreError`), иначе `'INFERENCE_FAILED'`.
**`MODEL_LOAD_FAILED` никогда не уходит клиенту как `ERROR`** — только как `NER_FAILED.details.reason`. Панель показывает `warnNer` с причиной.

### Словарный детектор ФИО (0.2, WP7 — ступень 1 NER)
Работает внутри документного детектора `kb` (`names/kb.js`), не зависит от `nerEnabled` и модели; выключается настройкой `dictNames: false`.
- `findPersonsByDict(text, {toks?, skip?}) → PersonSpan[]` (`names/person-dict.js`): пары «Имя Фамилия»/«Фамилия Имя» (`parse.kind: 'pair'`), «Имя Отчество» (`'fm'`), латиница; `span.dict = true`, `parse.lemma = {surname?, first, patronymic?, gender}`. Спаны правил (`findPersons`) передаются в `skip` — словарь их не пересекает.
- Вхождения словаря выдаются с `confidence: 'kb'`, `source: 'kb'` (проигрывают `labeled`/`validated` других категорий по FR-20) и **не делают лицо стороной** (`party: false`).
- Записи базы лиц: `kind ∈ full | pair | initials | fm | other`. `fm` — «Имя Отчество» без фамилии: присоединяется к единственной записи с такими именем и отчеством (`full`), иначе своя запись с canonical `имя отчество`. `hits` — число присоединённых вхождений; записи (кроме `other`/`fm`) с `hits ≥ 2` ищутся по документу в двух- и трёхсловных формах, одиночная фамилия — только для сторон.
- Словари (`names/dict/index.js`, ленивое декодирование при первом вызове): `getDicts()`, `bigFirstNameInfo(word)`, `surnameLemmas(word)`, `surnameSuffixInfo(word)`, `isEnFirst`, `isEnSurname`. Модули словарей — генерируемые (`npm run dicts`), вручную не правятся; попадают только в `offscreen/worker.js` (К15).

---

## 3. Каталог и настройки

- `BUILTIN_CATEGORIES` — 21 запись: `id, label{ru,en}, placeholderPrefix{ru,en}, color, defaultOn, allowedLevels, labels{ru[],en[]}, validator, priority, builtin, normalize, numeric?`.
- `buildCatalog(settings) → {list, byId}` — встроенные + пользовательские. **UI берёт список категорий только отсюда** (FR-17).
- `isCategoryEnabled(cat, settings)` — `settings.categories[id] ?? defaultOn`.
- Настройки: `defaultSettings()`, `migrateSettings(stored) → {settings, changed}` (миграции — `MIGRATIONS[n]` + `SETTINGS_SCHEMA_VERSION`),
  `validateSettingsPatch(patch) → badKeys[]`, `VALIDATORS[key]`, `effectiveSettings(settings, profileId)`.
- `dictNames` (boolean, по умолчанию `true`, поле профиля) — словарный детектор ФИО (WP7); тумблер в настройках, раздел «Обработка».
- `nerModel` (string, по умолчанию `''`; иначе id пакета `/^[a-z0-9][a-z0-9-]{1,40}$/`) — установленный пакет модели NER (WP8). Не поле профиля, **не экспортируется** в файл настроек (`NOT_EXPORTED` в `options/config-io.js`): пакет живёт в OPFS этого браузера. Пишет только карточка «Модель NER».
- Хранилище — **только** через `src/shared/settings-store.js`: `loadSettings()`, `saveSettingsPatch(patch) → {settings, rejected}`, `onSettingsChanged(cb)`.
- Сайты: `matchOrigin`, `isOriginAllowed`, `isInterceptActive(settings, origin)` (FR-07, FR-35).

---

## 4. Протокол (`src/shared/protocol.js`)

- Порт: `chrome.runtime.connect({name: 'docx'})` → `connectClient()` из `src/shared/port-client.js` возвращает клиента.
- Все сообщения `{type, requestId, ...}`; типы — `MSG.*` (§5.4) + расширение `ACK` (ответ на `DISCARD`, `CANCEL`, `BATCH_BEGIN/END`, `CATALOG_CHANGED`, `MODEL_CHANGED`).
- `MODEL_CHANGED {modelId?}` (0.2, WP8): клиент (страница настроек) → bg → offscreen → worker; хост сбрасывает кэш NER-провайдера (`dispose()`), ответ `ACK`. Router не добавляет `settings`; если offscreen-документа нет — отвечает `ACK` сам, не поднимая его.
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
  await client.request(MSG.DEANON, { mappingRef: docId /* или объект маппинга */, text, decline /* необяз., FR-37 */ }); // → DEANON_RESULT {text, unresolved, replaced, declined}
  await client.request(MSG.LIST_SESSIONS);  // → SESSIONS {sessions[] без значений}
  await client.request(MSG.DISCARD, { docId }); // → ACK
  ```
  Ошибки — `ProtocolError {code, message}`; разрыв порта → `HOST_UNAVAILABLE` для всех ожидающих запросов.
- Сущность в `ENTITIES`: `{id, category, value, normalized, placeholder, replacement?, level, source, validated, enabled, occurrences[{id, part, pid, streamId, stream, start, end, text, context, variantOf?}]}`.
- Повторная загрузка того же файла (SHA-256) в одной сессии браузера → `restoredDecisions: true` и прежние решения (§3.6).
- Сквозная нумерация по нескольким файлам: `BATCH_BEGIN {batchId}` → `analyzeFile({..., batchId})` для каждого → `BATCH_END`.

---

## 4а. Доступ к сайтам (версия 0.2, К9)

В манифесте нет `host_permissions` и `content_scripts`: `permissions` = `storage, unlimitedStorage, offscreen, scripting, activeTab` (`unlimitedStorage` — для пакета модели в OPFS, §6), `optional_host_permissions: ["<all_urls>"]`.
Доступ к сайту выдаёт пользователь; **источник истины — `chrome.permissions`**, настройки (allowlist/blocklist) лишь решают, работать ли на сайте с доступом.

`src/shared/permissions.js` (чистые функции + обёртки с параметром `api = chrome` для тестов):
- `toMatchPattern('https://host')` → `'https://host/*'` (`*.` и порт сохраняются; `'<all_urls>'` как есть; мусор → `null`); `originFromPattern(match)` — обратно;
- `desiredPatterns(settings)` → `['<all_urls>']` в режиме `all`, иначе паттерны allowlist без дублей;
- `requestOrigins(patterns)` → `Promise<boolean>`, **вызывает `permissions.request` синхронно** — звать первым оператором обработчика клика, до любого `await` (нужен жест пользователя); не отклоняется;
- `removeOrigins(patterns)` → `Promise<boolean>` (ошибки, например снятие обязательного разрешения в e2e-сборке, глотаются);
- `hasOriginAccess(origin)` — `permissions.contains` для паттерна сайта (`activeTab` не учитывается).

`src/background/site-access.js`:
- `planRegistration(granted, registered)` → `{op: 'none'|'register'|'update'|'unregister', matches}` — чистая; `<all_urls>` поглощает остальные, не-http(s) паттерны отбрасываются;
- `createSiteAccess(api)` → `{sync(), inject(patterns), init()}`. Скрипт: `{id: 'intercept', js: ['content.js'], matches, allFrames: true, runAt: 'document_start', persistAcrossSessions: true}`.
  `sync()` сериализован (очередь промисов). `inject()` — `executeScript` во все кадры открытых вкладок, ошибки вкладок глотаются.
  `init()` — слушатели `runtime.onInstalled/onStartup` и `permissions.onRemoved` → `sync`, `permissions.onAdded` → `sync` + `inject(added.origins)`; вызывается синхронно из `background/index.js`.
- `content.js` может прийти дважды (регистрация + `executeScript`) — защита флагом `globalThis.__docxAnonymizerBooted`.

UI: popup — `siteState(settings, url, {granted})` даёт `needsAccess` (настройки разрешают, доступа нет; кнопка `site-grant`), `site-add` запрашивает доступ и сохраняет allowlist независимо от ответа. Настройки: добавление в allowlist → `requestOrigins`, удаление → `removeOrigins` (кроме режима `all`); `allowlist → all` сохраняется только при выданном `<all_urls>`, `all → allowlist` снимает `<all_urls>` и запрашивает сайты списка.
Бейдж (`background/badge.js`) не трогается: без доступа `tab.url` не виден, бейдж пуст.

Сборка `node scripts/build.mjs --e2e` → `dist-e2e/` с `host_permissions: ["<all_urls>"]` (нативный диалог Playwright не нажимает, опциональные разрешения заранее не выдать). e2e-фикстура грузит `dist-e2e/` и ждёт регистрации `intercept`. Релиз и `npm run pack` — без флага.

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
11. Сборка: новые точки входа добавляются в `entries` в `scripts/build.mjs`; HTML подключает бандлы обычным `<script src>`. Исключение — `offscreen/worker.js`: отдельный ESM-вызов esbuild (§6.5); в него не добавлять код, который рассчитывает на IIFE-обёртку.
12. Воркер ядра — модульный: в нём нет `importScripts`, а `import.meta.url` есть. `chrome.runtime.getURL` в воркере нет — пути к ресурсам расширения строятся от `import.meta.url`/`self.location`.

---

## 6. Пакет модели NER (версия 0.2, WP8)

Модель не входит в архив расширения: пользователь скачивает zip-пакет (GitHub Releases), импортирует на странице настроек, расширение проверяет
хеши и кладёт файлы в OPFS. Сетевых запросов из расширения нет (NFR-01, К6).

### 6.1. Формат пакета

Плоский zip `docx-anonymizer-ner-<id>-<version>.zip` (`packZipName(manifest)`): `pack.json` + файлы (`model.onnx`, `vocab.txt`, `config.json`, `LICENSE`, `NOTICE`).
Схема `pack.json` — `schemas/model-pack.schema.json` (draft 2020-12, `additionalProperties: false`); код проверки — `core/ner/pack.js` (зеркалит схему и добавляет связи между полями).

```jsonc
{
  "kind": "docx-anonymizer-model-pack", "schemaVersion": 1,
  "id": "rubert-tiny2-ner-ruen",          // /^[a-z0-9][a-z0-9-]{1,40}$/
  "version": "1.0.0",                      // semver
  "name": { "ru": "…", "en": "…" }, "languages": ["ru", "en"],
  "task": "token-classification",
  "labels": ["O", "B-PER", "I-PER", "B-ORG", "I-ORG", "B-LOC", "I-LOC"],   // labels[0] === 'O', далее O|B-X|I-X
  "tokenizer": { "type": "wordpiece", "vocab": "vocab.txt", "lowercase": false, "stripAccents": false,
                 "maxLen": 128 /* 64..512 */, "stride": 16 /* < maxLen/2 */, "cls": "[CLS]", "sep": "[SEP]", "pad": "[PAD]", "unk": "[UNK]" },
  "model": { "file": "model.onnx", "inputs": { "ids": "input_ids", "mask": "attention_mask", "types": "token_type_ids" /* необяз. */ },
             "output": "logits", "indexType": "int64" /* | int32 */ },
  "files": [{ "path": "model.onnx", "sha256": "<hex64>", "size": 31852495 }, …],  // ВСЕ записи zip, кроме pack.json
  "license": "MIT", "source": { "baseModel": "…", "data": ["…"] },  // source: строки/числа/логические/массивы строк
  "minExtensionVersion": "0.2.0",
  "recommendedThreshold": 0.7               // необязательно
}
```

Правила: имя файла — `/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/` (без `/`, `..`, скрытых файлов; `LICENSE`/`NOTICE` — заглавными), не `pack.json`, без повторов;
`model.file` и `tokenizer.vocab` ∈ `files`; каждая запись zip (кроме `pack.json`) есть в `files`, и наоборот; размер и sha256 совпадают.
`minExtensionVersion` больше версии расширения → пакет отклоняется (`INCOMPATIBLE`).
Исходник пакета — `models-src/<id>/pack.src.json` (тот же объект **без** `files`) + файлы; `npm run pack:model -- --id=<id>` (`scripts/pack-model.mjs`, `buildModelPack({srcDir, outDir, now})`)
считает `files`, проверяет `parsePackManifest`, пишет детерминированный zip (`FIXED_TIME`, `pack.json` первой записью, остальные по имени) в `release/` и печатает sha256.

API ядра (`core/ner/pack.js`, без побочных эффектов, не бросает):
- `parsePackManifest(jsonOrObjOrBytes, {extensionVersion?}) → {ok: true, manifest} | {ok: false, error}` — `error`: путь к первому неверному полю (`'tokenizer.stride'`, `'files[2].path'`, лишний ключ — его имя), `'json'` или `'minExtensionVersion'`;
- `verifyPackFiles(manifest, entries, {digest?}) → {ok: true} | {ok: false, error: 'EXTRA_FILE'|'MISSING_FILE'|'SIZE_MISMATCH'|'HASH_MISMATCH', path}`;
- `core/ner/known-packs.js`: `KNOWN_PACKS = [{id, version, sha256}]` (sha256 **всего zip**; пополняет WP9 при публикации), `findKnownPack(sha256)`. Пакет из списка — «проверен», иначе установка только после подтверждения.

### 6.2. Хранилище (`src/shared/model-store.js`)

OPFS (`navigator.storage.getDirectory()`), работает в окне и в dedicated worker. Раскладка: `models/<id>/{pack.json, <files>, installed.json}`;
во время установки в каталоге лежит `.installing` (время начала) — такой каталог не считается установленным, брошенный (> 10 мин) удаляется в `listInstalled()`.

| Функция | Что делает |
|---|---|
| `isAvailable()` | есть ли OPFS в контексте |
| `listInstalled()` | `[{id, version, name, languages, bytes, installedAt, verified, packSha256, manifest}]` |
| `inspectPack(bytes, {extensionVersion?})` | unzip (fflate, ≤ 512 МБ распакованного) + `parsePackManifest` + `verifyPackFiles`, без записи → `{manifest, packSha256, verified, bytes}` |
| `install(bytes, {verified?, extensionVersion?})` | повторная проверка; удаляет прежний `models/<id>/`, пишет `.installing` → `pack.json` → файлы (`createWritable`) → `installed.json` → снимает `.installing`. `verified` вычисляется по `KNOWN_PACKS`, параметр его не поднимает |
| `remove(id)` | удаляет каталог; отсутствующий — не ошибка |
| `getManifest(id)` | манифест или `null` |
| `readFile(id, path)` | `Uint8Array`; путь проверяется (`PACK_PATH_RE`, без `/` и `..`) |
| `openModelFiles(id)` | `{modelId, read(path)}` — синхронно, без обращения к хранилищу до первого `read` (для фабрики провайдера) |

Ошибки — `ModelStoreError {code}`; `MODEL_STORE_ERROR_CODES`: `UNAVAILABLE | BAD_ZIP | BAD_MANIFEST | INCOMPATIBLE | HASH_MISMATCH | QUOTA | IO | NOT_INSTALLED`
(`SIZE_MISMATCH`/`HASH_MISMATCH` файла → `HASH_MISMATCH`; лишний/отсутствующий файл → `BAD_MANIFEST`; `QuotaExceededError` → `QUOTA`). Тексты — `ner_err_<CODE>` в `ui/i18n/options.js`.

### 6.3. Страница настроек

Карточка `#ner` («Модель NER», после «Обработки»): тумблер `ner-enabled` (`nerEnabled`), число `ner-threshold` (`nerThreshold`, 0–1, шаг 0.05), статус `ner-status`,
`ner-import` + скрытый `ner-import-file` (`.zip`), `ner-remove`, сообщения `ner-msg` (role=status), ссылка `ner-releases-link` (обычный `<a target=_blank>`), подсказка о приватности.
Импорт: `inspectPack` → не проверен → `confirmDialog` → `install` → прочие пакеты удаляются (одна модель) → `save({nerModel: id})` → `MODEL_CHANGED`.
Удаление: подтверждение → `remove` всех установленных → `save({nerModel: ''})` → `MODEL_CHANGED`. Сбой установки, оставивший `nerModel` без файлов, сбрасывает `nerModel`.

### 6.4. Хост и воркер

`createHost({post, toolVersion, nerProvider?, createNerProvider?})`. `createNerProvider(settings)` — **синхронная** фабрика, модель не читает (загрузка — в `init()`).
Хост держит кэш `{modelId, provider}`: один провайдер на `nerModel`; смена `nerModel` или `MODEL_CHANGED` → `dispose?.()` и сброс. `env.nerProvider` (тесты) имеет приоритет.
`providerFor(settings)` используется в `ANALYZE` и `ADD_ENTITY`; при `!nerEnabled || !nerModel || !createNerProvider` → провайдера нет.
`worker.js` (ESM): `import * as ort from 'onnxruntime-web/wasm'`; `ort.env.wasm.numThreads = 1`, `proxy = false`, `wasmPaths = {wasm: new URL('../vendor/ort-wasm-simd-threaded.wasm', import.meta.url).href}`;
фабрика — `createPendingNerProvider({files: openModelFiles(s.nerModel), modelId: s.nerModel, ort})` (`core/ner/pending-provider.js`): `init()` читает и проверяет `pack.json` и бросает
`CoreError('MODEL_LOAD_FAILED')` → `NER_FAILED {reason: 'MODEL_LOAD_FAILED'}`. **WP9 заменяет тело провайдера** (ONNX + WordPiece) с тем же контрактом и той же фабрикой; `ort` уже передаётся.

### 6.5. Сборка и упаковка

- `scripts/build.mjs`: второй вызов esbuild для `offscreen/worker.js` (`format: 'esm'`, `platform: 'browser'`, `metafile`) — в лог пишется размер worker.js и доля ORT.
  В бандл попадает **`ort.wasm.bundle.min.mjs`** (glue встроен, без внешнего `.mjs`); в `dist/vendor/` — `ort-wasm-simd-threaded.wasm` (14 239 897 байт) и `onnxruntime-web.LICENSE`
  (в npm-пакете ORT файла лицензии нет — текст MIT лежит в `assets/licenses/`).
- Размеры `offscreen/worker.js`: до WP8 (IIFE) 225 443 байт; после WP8 329 403 байт, из них ORT ≈ 102 400 (+ словари WP7: 719 209 байт на момент сдачи WP8, без ORT ≈ 616 400).
  `tests/integration/pack.spec.js` проверяет «worker.js без ORT ≤ 700 КБ» (К15), считая ORT по секции бандла `// node_modules/onnxruntime-web/…`.
- Архив релиза (`npm run pack`) с wasm: ≈ 4,2 МБ (wasm сжимается до ≈ 3,5 МБ).

### 6.6. Спайки S1–S3 (Chromium из Playwright 1.63, headless new, `dist-e2e`)

| Спайк | Результат |
|---|---|
| **S1** OPFS в dedicated worker offscreen-документа | **Работает.** Страница настроек записала `models/_probe/x.bin` через `navigator.storage.getDirectory()` + `createWritable()`; модульный воркер offscreen прочитал тот же файл (130 байт) — общий origin `chrome-extension://<id>`. В воркере `self.isSecureContext === true`, `self.location` = `chrome-extension://<id>/offscreen/worker.js`. Fallback на IndexedDB не нужен. |
| **S2** квота | Запись 40 МБ одним файлом через `createWritable` прошла (даже без `unlimitedStorage`: `estimate().quota` ≈ 10,8 ГБ — квота считается от свободного места диска, `persisted() === false`). `unlimitedStorage` добавлен в манифест, чтобы квота не зависела от места на диске и вытеснения. `QuotaExceededError` → `ModelStoreError('QUOTA')` (код в `ioError`). |
| **S3** модульный worker под CSP + ORT | `new Worker('worker.js', {type: 'module'})` из классического offscreen-скрипта работает под CSP `extension_pages` (`script-src 'self' 'wasm-unsafe-eval'`); все существующие e2e зелёные. `onnxruntime-web/wasm` → `ort.wasm.bundle.min.mjs`; `InferenceSession.create` на 1-оп модели (`mul_1.onnx`, Mul, opset 7) — 146 мс холодно, `run` дал верный результат `[1..6]`. `ort.env.wasm.numThreads` = 1 до и после создания сессии; `SharedArrayBuffer` в воркере есть, но нити не создаются; ни одного запроса, кроме `chrome-extension:` (нет `blob:`-воркеров, нет http(s)). wasm грузится через `fetch` ORT с `chrome-extension://…/vendor/…` — разрешено `connect-src 'self'`. |
