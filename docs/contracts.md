# Контракты модулей

Документ описывает, **что есть** в коде и **как к этому подключаться** (версия 0.2.0: MVP WP1–WP5 и пакеты WP6–WP9).
Источник истины — код с JSDoc; здесь — смысл и правила. Рамки MVP — `docs/mvp-scope.md`, цели 0.2 — `docs/concept-0.2.md`,
ТЗ — `docs/spec-full.md`, рабочие пакеты — `docs/tasks.md`.

```
popup / content / options / restore ──port "docx"──► background (router) ──runtime.sendMessage──► offscreen ──postMessage──► Web Worker
        (клиенты протокола §5.4)                    добавляет settings                          (мост)                 host.js → core/
```

Сборка: esbuild, бандлы — **IIFE** (content script и classic worker не умеют ESM), кроме `offscreen/worker.js`: с 0.2 (WP8) это
**ES-модуль** (отдельный вызов esbuild `format: 'esm'`, `new Worker('worker.js', {type: 'module'})`) — его требует `onnxruntime-web`. Точки входа — `scripts/build.mjs`.

---

## 0. Карта кода

| Путь | Что | Пакет |
|---|---|---|
| `src/core/docx/zip.js` | свой ZIP: чтение, детерминированная запись, байт-копия нетронутых записей | фундамент |
| `src/core/docx/xml.js` | линейный токенизатор XML, (un)escape, `applyRangeEdits` | фундамент |
| `src/core/docx/model.js` | `parseDocx` → `DocModel` (части, параграфы, потоки, virtualText, charMap) | фундамент |
| `src/core/docx/replace.js` | `serializeDocx(doc, edits, opts)` — замена через раны, метаданные, rels, ZIP | фундамент |
| `src/core/categories.js` | **единственный** каталог 21 категории + `buildCatalog`, `normalizeValue` | фундамент (данные — WP1/WP2) |
| `src/core/contracts/` | типы `Entity`/`EntityGroup`/`Decision`, реестр детекторов, `NerProvider` (+ `dispose`, `NER_LABEL_TO_CATEGORY`), `Session` | фундамент; `ner.js` — WP8 |
| `src/core/detect/runner.js` | `analyze()` — весь конвейер поиска, этап `ner`, порог `nerThreshold` | фундамент; WP8/WP9 |
| `src/core/detect/overlap.js` | `resolveOverlaps()` (FR-20) | фундамент |
| `src/core/apply.js`, `mapping.js`, `placeholders.js` | `applyDecisions()`, маппинг, плейсхолдеры, режимы | фундамент |
| `src/core/deanon.js` | `deanonymize()` (FR-36), опция `decline` (FR-37) | фундамент; WP6 |
| `src/core/deanon-morph.js` | склонение ФИО при восстановлении: `parsePersonValue`, `detectCase`, `declineInContext` (FR-37) | WP6 |
| `src/core/settings.js`, `sites.js` | схема настроек (`SETTINGS_SCHEMA_VERSION` 2), дефолты, миграции; allowlist/blocklist | фундамент; WP6–WP9 |
| `src/core/search.js`, `text-view.js` | поиск всех вхождений; данные для вкладки «Текст» | фундамент |
| `src/core/hash.js` | `sha256Hex` (WebCrypto; `shared/protocol.js` реэкспортирует) | WP8 |
| `src/core/validators.js`, `detect/identifiers/` | валидаторы и детекторы 18 категорий идентификаторов | WP1 |
| `src/core/detect/names/` | PERSON/COMPANY/ADDRESS, база знаний сторон (`kb.js`), морфология, транслитерация | WP2 |
| `src/core/detect/names/person-dict.js` | словарный детектор ФИО третьих лиц `findPersonsByDict` (§2) | WP7 |
| `src/core/detect/names/dict/` | `index.js` (ленивое декодирование, поиск), `codec.js` (front-coding), генерируемые `ru-surnames.js`, `ru-first.js`, `en-first.js`, `en-surnames.js`, `NOTICE.md` | WP7 |
| `src/core/detect/custom/` | документный детектор пользовательских категорий | WP4 |
| `src/core/ner/pack.js`, `known-packs.js` | формат пакета модели: `parsePackManifest`, `verifyPackFiles`, `packZipName`; список проверенных пакетов (§6.1) | WP8; sha256 — WP9 |
| `src/core/ner/pending-provider.js` | заглушка провайдера WP8 (только для `tests/unit/ner/pack.spec.js`) | WP8 |
| `src/core/ner/wordpiece.js`, `windows.js`, `bio.js`, `onnx-provider.js` | ONNX-провайдер NER: WordPiece с офсетами, окна, BIO и границы спанов, инференс через переданный `ort` (§6.7) | WP9 |
| `src/shared/protocol.js` | протокол §5.4 + транспорт (чанки base64, клиент), `MODEL_CHANGED` | фундамент; WP8 |
| `src/shared/settings-store.js`, `port-client.js` | обёртки `chrome.storage` и порта | фундамент |
| `src/shared/permissions.js` | опциональный доступ к сайтам: паттерны, `requestOrigins`, `removeOrigins`, `hasOriginAccess` (§4а) | WP6 |
| `src/shared/model-store.js` | хранилище пакетов модели в OPFS: проверка, установка в слоты, чтение из воркера, удаление (§6.2) | WP8 |
| `src/background/index.js`, `router.js`, `offscreen-manager.js` | роутер портов, жизненный цикл offscreen, миграция настроек | фундамент |
| `src/background/site-access.js` | динамическая регистрация content script по выданным origin (§4а) | WP6 |
| `src/background/badge.js` | бейдж `ON` (FR-43) | WP3 |
| `src/offscreen/` | `offscreen.js` (мост, модульный воркер), `host.js` (сессии, ANALYZE/APPLY/DEANON/…, кэш NER-провайдера), `worker.js` (ESM + ORT) | фундамент; WP6, WP8, WP9 |
| `src/content/`, `src/ui/panel/`, `src/ui/preview/`, `src/popup/` | перехват, панель, предпросмотр, popup | WP3 |
| `src/ui/components/site-state.js` | состояние сайта для popup (`needsAccess`) | WP6 |
| `src/options/`, `src/restore/`, `src/ui/deanon/` | настройки (в т.ч. «Модель NER»), свои категории, восстановление (склонение, подсветка) | WP4; WP6–WP8 |
| `src/help/`, `src/ui/brand.js` | справка, подпись «Сделано в Sitimlab» | 0.1 |
| `schemas/` | `mapping`, `protocol`, `model-pack` (JSON Schema draft 2020-12) | WP5; WP8 |
| `scripts/build.mjs`, `pack.mjs` | сборка `dist/` (`--e2e` → `dist-e2e/`), архив релиза | фундамент; WP6, WP8 |
| `scripts/make-dicts.mjs` | генератор словарей ФИО из закреплённых коммитов (`npm run dicts`, `--check`) | WP7 |
| `scripts/pack-model.mjs` | детерминированный zip пакета модели (`npm run pack:model -- --id=<id>`) | WP8 |
| `scripts/bench-ner.mjs` | бенчмарк и span-F1 провайдера в Node (`npm run bench-ner`), помощники для тестов | WP9 |
| `scripts/gen-ner-eval.mjs` | корпус оценки NER `tests/fixtures/ner/eval-{ru,en}.json` (`npm run gen-ner-eval`) | WP9 |
| `scripts/gen-fixtures.mjs`, `make-sample.mjs` | документы-фикстуры с gold, образец договора | WP5; WP7 (`third-persons`) |
| `tools/ner-train/` | обучение модели (Python, uv): WikiANN ru+en, дистилляция, ONNX int8, калибровка порога, `models-src/<id>/` | WP9 |

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
- Названия фирм (ревью WP-N1): латинская пара не берётся перед хвостом названия (`ORG_TAIL_WORDS_EN` в `lexicon.js`: `International`, `LLP`, `Inc.`, `Bank`, `Partners`…, а также `&` и `and <хвост>`), после `<Слово> of` («Bank of America Merrill Lynch») и если сама «фамилия» — хвост («Morris International»); устойчивые названия из двух «имён» («Clifford Chance», «Майкл Корс») — в `NON_PERSON_PAIRS`. Это же действует для латинских пар правил, найденных только по курируемому имени (`span.nameOnly`, без лейбла и обращения). В `kb.js` словарная пара (или `nameOnly`), совпадающая с названием компании документа без ОПФ или с его началом из ≥ 2 слов, выдаётся как `COMPANY` (`confidence: 'kb'`, canonical этой компании), а не `PERSON`.
- Пара правил «Имя Отчество» («Ольгой Петровной»: второе слово — отчество, согласованное с именем по роду и падежу) в `kb.js` разбирается как `fm`, поэтому падежные формы попадают в одну запись.
- Измерения: фикстура `PERSON-dict.json` — 47 позитивов (39 `dictOnly`), 68 негативов; К4 (2 400 абзацев) — отношение времени со словарём к времени без него 1.07–1.17.
- Словари (`names/dict/index.js`, ленивое декодирование при первом вызове): `getDicts()`, `bigFirstNameInfo(word)`, `surnameLemmas(word)`, `surnameSuffixInfo(word)`, `isEnFirst`, `isEnSurname`. Модули словарей — генерируемые (`npm run dicts`), вручную не правятся; попадают только в `offscreen/worker.js` (К15).

---

## 3. Каталог и настройки

- `BUILTIN_CATEGORIES` — 21 запись: `id, label{ru,en}, placeholderPrefix{ru,en}, color, defaultOn, allowedLevels, labels{ru[],en[]}, validator, priority, builtin, normalize, numeric?`.
- `buildCatalog(settings) → {list, byId}` — встроенные + пользовательские. **UI берёт список категорий только отсюда** (FR-17).
- `isCategoryEnabled(cat, settings)` — `settings.categories[id] ?? defaultOn`.
- Настройки: `defaultSettings()`, `migrateSettings(stored) → {settings, changed}` (миграции — `MIGRATIONS[n]` + `SETTINGS_SCHEMA_VERSION`),
  `validateSettingsPatch(patch) → badKeys[]`, `VALIDATORS[key]`, `effectiveSettings(settings, profileId)`.
- `SETTINGS_SCHEMA_VERSION` = 2 (0.2): миграция 1 → 2 меняет `nerThreshold` 0.6 (прежний дефолт) на 0.7, другие значения порога не трогает.
- `dictNames` (boolean, по умолчанию `true`, поле профиля) — словарный детектор ФИО (WP7); тумблер в настройках, раздел «Обработка».
- `nerEnabled` (boolean, `true`) и `nerThreshold` (0–1, по умолчанию **0.7** = `recommendedThreshold` пакета, поле профиля) — этап NER; без установленного пакета не действуют.
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
- `DEANON` (FR-36/37): `mappingRef` — `docId` сессии (берётся её последний маппинг; нет маппинга → ошибка «сначала примените замены») или объект маппинга.
  Хост склоняет ФИО **только при `decline === true`** (иначе результат прежний, `declined: []`). Страница восстановления шлёт `decline` из флажка (по умолчанию вкл.);
  маппинг из файла `.mapping.json` она восстанавливает сама, вызывая `deanonymize()` ядра, без хоста.
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
7. Детектор EMAIL — настоящий (WP1); `tests/integration/host.spec.js` и e2e рассчитывают на те же 4 адреса образца.
8. Блок «Проверка конвейера (dev)» в popup (`#dev-file`) остался для ручной отладки; e2e от него не зависят — `pipeline.spec.js` и `ner.spec.js` гоняют конвейер через клиент протокола (`tests/e2e/helpers/client.js`).
9. Образец — `scripts/make-sample.mjs` (`buildSampleDocx() → {bytes, gold}`); `gold` — все чувствительные значения для проверок утечек.
10. Snap-LibreOffice не видит скрытые каталоги и `/tmp`: интеграционный тест пишет в `test-output/` в репозитории; `SKIP_LIBREOFFICE=1` — пропустить.
11. Сборка: новые точки входа добавляются в `entries` в `scripts/build.mjs`; HTML подключает бандлы обычным `<script src>`. Исключение — `offscreen/worker.js`: отдельный ESM-вызов esbuild (§6.5); в него не добавлять код, который рассчитывает на IIFE-обёртку.
12. Воркер ядра — модульный: в нём нет `importScripts`, а `import.meta.url` есть. `chrome.runtime.getURL` в воркере нет — пути к ресурсам расширения строятся от `import.meta.url`/`self.location`.
13. Сеть в e2e (NFR-01, К6): `context.on('request')` Playwright не видит offscreen-документ и его воркер. `tests/e2e/helpers/network.js` (`captureAllRequests`,
    `externalRequests`, `offscreenRequests`) подключается к браузерной CDP-цели (фикстура запускает Chromium с `--remote-debugging-port=0`, порт — из
    `<профиль>/DevToolsActivePort`) и через `Target.setAutoAttach` пишет запросы всех целей: страниц, service worker, offscreen, worker. Работает в новом headless.
14. CI (`.github/workflows/ci.yml`, К12): push и pull request в `main`; задание `test` — `npm ci`, `lint`, `npm test` (`SKIP_LIBREOFFICE=1`, xmllint из `libxml2-utils`),
    `build`, `pack`, архив — артефакт; задание `e2e` — `npx playwright install --with-deps chromium`, `npm run e2e` (headless, без xvfb), `test-output/` — артефакт при сбое.
    Гейтовые тесты реальной модели (`NER_MODEL_DIR` — `tests/integration/ner-provider.spec.js`, `NER_PACK` — `tests/e2e/ner.spec.js`) в CI пропускаются: модели в git нет.
    Главный сценарий `tests/e2e/chat.spec.js` (12 тестов) с версии 0.2 идёт всегда; флаг `E2E_WP3` времён параллельной работы WP3/WP5 снят.

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

Правила: имя файла — `/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/` (без `/`, `..`, скрытых файлов; `LICENSE`/`NOTICE` — заглавными), без повторов,
не зарезервированное (`RESERVED_PACK_PATHS`, без учёта регистра: `pack.json`, `installed.json`, `.installing` — служебные файлы слота в хранилище, §6.2;
`__proto__`, `constructor`, `prototype` — имена свойств прототипа; проверяет код, схема только описывает);
`model.file` и `tokenizer.vocab` ∈ `files`; каждая запись zip, кроме `pack.json`, есть в `files`, и каждый файл из `files` есть в zip; размер и sha256 совпадают.
Записи zip с одинаковым именем и записи с зарезервированными именами отвергаются при распаковке (§6.2). Размер zip-файла и сумма распакованных размеров
записей по центральному каталогу — не больше 512 МБ (`MAX_PACK_BYTES`), иначе `TOO_LARGE`.
`minExtensionVersion` больше версии расширения → пакет отклоняется (`INCOMPATIBLE`).
Исходник пакета — `models-src/<id>/pack.src.json` (тот же объект **без** `files`) + файлы; `npm run pack:model -- --id=<id>` (`scripts/pack-model.mjs`, `buildModelPack({srcDir, outDir, now})`)
считает `files`, проверяет `parsePackManifest`, пишет детерминированный zip (`FIXED_TIME`, `pack.json` первой записью, остальные по имени) в `release/` и печатает sha256.

API ядра (`core/ner/pack.js`, без побочных эффектов; обе функции **не бросают** ни на каком входе — любой сбой возвращается как `{ok: false, error}`):
- `parsePackManifest(jsonOrObjOrBytes, {extensionVersion?}) → {ok: true, manifest} | {ok: false, error}` — `error`: путь к первому неверному полю (`'tokenizer.stride'`, `'files[2].path'`, лишний ключ — его имя), `'json'`, `'minExtensionVersion'` или `'manifest'` (непредвиденная ошибка разбора);
- `verifyPackFiles(manifest, entries, {digest?}) → {ok: true} | {ok: false, error: 'EXTRA_FILE'|'MISSING_FILE'|'SIZE_MISMATCH'|'HASH_MISMATCH'|'VERIFY_FAILED', path}` —
  `entries`: `Map<string, Uint8Array>` или объект; у объекта читаются только собственные ключи (`Object.hasOwn`), значение не `Uint8Array` → `MISSING_FILE`;
  `VERIFY_FAILED` — непредвиденный сбой (например, хеширования), `path` — файл, на котором он случился. Недоверенный zip передавайте как `Map` (в обычном объекте запись `__proto__` теряется);
- `RESERVED_PACK_PATHS`, `isReservedPackPath(name)` — зарезервированные имена;
- `core/ner/known-packs.js`: `KNOWN_PACKS = [{id, version, sha256}]` (sha256 **всего zip**; пополняет WP9 при публикации), `findKnownPack(sha256)`. Пакет из списка — «проверен», иначе установка только после подтверждения.

### 6.2. Хранилище (`src/shared/model-store.js`)

OPFS (`navigator.storage.getDirectory()`), работает в окне и в dedicated worker. Раскладка: у пакета два слота — `models/<id>/` и `models/<id>.1/`,
в каждом `{pack.json, <files>, installed.json}` (id без точки, поэтому слоты разных пакетов не пересекаются). Во время установки в слоте лежит `.installing`
(время начала) — такой слот не считается установленным; брошенный (> 10 мин) удаляется в `listInstalled()`. **Активный слот** — завершённый (есть `installed.json`,
нет `.installing`) с наибольшим `installedAt`; из него читают `readFile`/`getManifest`/`listInstalled`. Переустановка пишет в неактивный слот, переключение —
снятие `.installing` (одна операция; `installedAt` новой версии строго больше прежней), прежний слот удаляется только после этого. Сбой записи на любом шаге
оставляет прежнюю версию рабочей; не удалившийся устаревший слот дочищает `listInstalled()`. Переименовать каталог в OPFS нельзя, поэтому слоты, а не rename.

| Функция | Что делает |
|---|---|
| `isAvailable()` | есть ли OPFS в контексте |
| `listInstalled()` | `[{id, version, name, languages, bytes, installedAt, verified, packSha256, manifest}]` |
| `inspectPack(bytes, {extensionVersion?})` | zip ≤ `MAX_PACK_BYTES`; unzip (fflate) в `Map`, в `filter`: сумма распакованных размеров ≤ `MAX_PACK_BYTES` (`TOO_LARGE`), повтор имени → `BAD_MANIFEST {reason: 'DUPLICATE_ENTRY'}`, зарезервированное имя (кроме `pack.json`) → `BAD_MANIFEST {reason: 'EXTRA_FILE'}`; затем `parsePackManifest` + `verifyPackFiles`, без записи → `{manifest, packSha256, verified, bytes}` |
| `install(bytes, {verified?, extensionVersion?})` | повторная проверка; очищает неактивный слот и пишет в него `.installing` → `pack.json` → файлы (`createWritable`) → `installed.json` → снимает `.installing`; затем удаляет прежний слот. `verified` вычисляется по `KNOWN_PACKS`, параметр его не поднимает |
| `remove(id)` | удаляет оба слота; отсутствующий — не ошибка |
| `getManifest(id)` | манифест или `null` |
| `readFile(id, path)` | `Uint8Array` из активного слота; путь проверяется (`PACK_PATH_RE`, без `/` и `..`); активного нет → `NOT_INSTALLED` |
| `openModelFiles(id)` | `{modelId, read(path)}` — синхронно, без обращения к хранилищу до первого `read` (для фабрики провайдера) |

Ошибки — `ModelStoreError {code, details?}`; `MODEL_STORE_ERROR_CODES`: `UNAVAILABLE | BAD_ZIP | TOO_LARGE | BAD_MANIFEST | INCOMPATIBLE | HASH_MISMATCH | QUOTA | IO | NOT_INSTALLED`
(`SIZE_MISMATCH`/`HASH_MISMATCH` файла → `HASH_MISMATCH`; лишний/отсутствующий/повторяющийся файл → `BAD_MANIFEST` с `details: {path, reason}`; `VERIFY_FAILED` → `IO`;
больше `MAX_PACK_BYTES` → `TOO_LARGE`; `QuotaExceededError` → `QUOTA`). Тексты — `ner_err_<CODE>` в `ui/i18n/options.js`.

### 6.3. Страница настроек

Карточка `#ner` («Модель NER», после «Обработки»): тумблер `ner-enabled` (`nerEnabled`), число `ner-threshold` (`nerThreshold`, 0–1, шаг 0.05), статус `ner-status`,
`ner-import` + скрытый `ner-import-file` (`.zip`), `ner-remove`, сообщения `ner-msg` (role=status), ссылка `ner-releases-link` (обычный `<a target=_blank>`), подсказка о приватности.
Импорт: `f.size > MAX_PACK_BYTES` → `TOO_LARGE` без чтения файла → `inspectPack` → не проверен → `confirmDialog` → `install` → прочие пакеты удаляются (одна модель) → `save({nerModel: id})` → `MODEL_CHANGED`.
Удаление: подтверждение → `remove` всех установленных → `save({nerModel: ''})` → `MODEL_CHANGED`. Сбой установки, оставивший `nerModel` без файлов, сбрасывает `nerModel`.

### 6.4. Хост и воркер

`createHost({post, toolVersion, nerProvider?, createNerProvider?})`. `createNerProvider(settings)` — **синхронная** фабрика, модель не читает (загрузка — в `init()`).
Хост держит кэш `{modelId, provider}`: один провайдер на `nerModel`; смена `nerModel` или `MODEL_CHANGED` → `dispose?.()` и сброс. `env.nerProvider` (тесты) имеет приоритет.
`providerFor(settings)` используется в `ANALYZE` и `ADD_ENTITY`; при `!nerEnabled || !nerModel || !createNerProvider` → провайдера нет.
`worker.js` (ESM): `import * as ort from 'onnxruntime-web/wasm'`; `ort.env.wasm.numThreads = 1`, `proxy = false`, `wasmPaths = {wasm: new URL('../vendor/ort-wasm-simd-threaded.wasm', import.meta.url).href}`;
фабрика — `createOnnxNerProvider({files: openModelFiles(s.nerModel), modelId: s.nerModel, ort})` (`core/ner/onnx-provider.js`, WP9, §6.7). Любой сбой загрузки
(нет файла, битый `pack.json`, словарь без спецтокенов, ORT не принял модель, нет нужных входов/выхода) → `CoreError('MODEL_LOAD_FAILED')` → `NER_FAILED {reason: 'MODEL_LOAD_FAILED'}`;
так e2e `model-pack.spec.js` с фейковой моделью получает ту же причину. `core/ner/pending-provider.js` (заглушка WP8) воркером больше не используется — остаётся для `tests/unit/ner/pack.spec.js`.

### 6.5. Сборка и упаковка

- `scripts/build.mjs`: второй вызов esbuild для `offscreen/worker.js` (`format: 'esm'`, `platform: 'browser'`, `metafile`) — в лог пишется размер worker.js и доля ORT.
  В бандл попадает **`ort.wasm.bundle.min.mjs`** (glue встроен, без внешнего `.mjs`); в `dist/vendor/` — `ort-wasm-simd-threaded.wasm` (14 239 897 байт) и `onnxruntime-web.LICENSE`
  (в npm-пакете ORT файла лицензии нет — текст MIT лежит в `assets/licenses/`).
- Размеры `offscreen/worker.js`: до WP8 (IIFE) 225 443 байт; после WP8 329 403 байт, из них ORT ≈ 102 400 (+ словари WP7: 719 209 байт на момент сдачи WP8, без ORT ≈ 616 400).
  После WP9 (провайдер, токенизатор, BIO): 745 462 байт, из них ORT 102 795, без ORT 642 667 (≤ 700 КБ, К15).
  Финальное состояние 0.2.0 (`npm run build`, 15.10.2026): `worker.js` 747 708 байт, из них ORT 102 795, без ORT 644 913; `content.js` 110 048 байт (< 150 КБ, без словарей); `dist/` целиком 15 491 656 байт.
  `tests/integration/pack.spec.js` проверяет «worker.js без ORT ≤ 700 КБ» (К15), считая ORT по секции бандла `// node_modules/onnxruntime-web/…`.
- Архив релиза (`npm run pack`, 0.2.0): 4 240 994 байт (4,0 МБ), 27 файлов; wasm 14 239 897 байт (13,6 МБ) сжимается в архиве до 3 824 625 байт. Модели в архиве нет.

### 6.6. Спайки S1–S3 (Chromium из Playwright 1.63, headless new, `dist-e2e`)

| Спайк | Результат |
|---|---|
| **S1** OPFS в dedicated worker offscreen-документа | **Работает.** Страница настроек записала `models/_probe/x.bin` через `navigator.storage.getDirectory()` + `createWritable()`; модульный воркер offscreen прочитал тот же файл (130 байт) — общий origin `chrome-extension://<id>`. В воркере `self.isSecureContext === true`, `self.location` = `chrome-extension://<id>/offscreen/worker.js`. Fallback на IndexedDB не нужен. |
| **S2** квота | Запись 40 МБ одним файлом через `createWritable` прошла (даже без `unlimitedStorage`: `estimate().quota` ≈ 10,8 ГБ — квота считается от свободного места диска, `persisted() === false`). `unlimitedStorage` добавлен в манифест, чтобы квота не зависела от места на диске и вытеснения. `QuotaExceededError` → `ModelStoreError('QUOTA')` (код в `ioError`). |
| **S3** модульный worker под CSP + ORT | `new Worker('worker.js', {type: 'module'})` из классического offscreen-скрипта работает под CSP `extension_pages` (`script-src 'self' 'wasm-unsafe-eval'`); все существующие e2e зелёные. `onnxruntime-web/wasm` → `ort.wasm.bundle.min.mjs`; `InferenceSession.create` на 1-оп модели (`mul_1.onnx`, Mul, opset 7) — 146 мс холодно, `run` дал верный результат `[1..6]`. `ort.env.wasm.numThreads` = 1 до и после создания сессии; `SharedArrayBuffer` в воркере есть, но нити не создаются; ни одного запроса, кроме `chrome-extension:` (нет `blob:`-воркеров, нет http(s)). wasm грузится через `fetch` ORT с `chrome-extension://…/vendor/…` — разрешено `connect-src 'self'`. |

### 6.7. ONNX-провайдер NER (версия 0.2, WP9)

`createOnnxNerProvider({files, ort, modelId, batchSize = 8, skipLowercaseWindows = true, maxLen?, executionProviders = ['wasm'], onProgress?})` → `NerProvider` (+ `stats`).
Модуль `ort` передаётся снаружи (`{InferenceSession, Tensor}`): в воркере — `onnxruntime-web/wasm`, в Node-тестах — `onnxruntime-web` (сборка `ort.node.min.mjs`, тот же WASM).
Ядро не импортирует ORT и не делает сетевых запросов: модель и словарь читаются только через `files.read` (NFR-01).

**`init()`** — один общий промис (сбой не кэшируется: следующий анализ попробует снова): `pack.json` → `parsePackManifest` → `vocab.txt` → `createWordPiece`
(спецтокены из манифеста обязательны) → метки: `config.json` `id2label` (число меток должно совпасть с `manifest.labels`), иначе `manifest.labels` →
`ort.InferenceSession.create(bytes, {executionProviders: ['wasm'], graphOptimizationLevel: 'all'})` → проверка `session.inputNames` ⊇ `manifest.model.inputs`
и `outputNames` ∋ `model.output`. Любая ошибка → `CoreError('MODEL_LOAD_FAILED')` (сессия при этом освобождается). `dispose()` → `session.release()`.

**`detect(text)`** (конвейер):
1. `wordpiece.pretokenize` — BERT basic tokenizer как в `BertTokenizerFast`: пробелы Unicode (`\p{White_Space}`) разделяют; пунктуация (ASCII-не-буквы и `\p{P}`) и
   иероглифы CJK — отдельные слова; управляющие (`\p{C}`, кроме `\t\n\r`; NUL; U+FFFD) выбрасываются и слово не рвут (`и​нулевой` — одно слово); NFC/NFD
   не применяются при `stripAccents: false`. Офсеты — индексы исходной JS-строки (UTF-16). `tokenizeWord` — жадный longest-match с `##`, неразобранный
   остаток или слово длиннее `maxWordChars` (100) → один `[UNK]`; кэш слов (50 000). Эталон — `tests/fixtures/ner/wordpiece-cases.json` (40 случаев, 100 %).
2. `makeWindows(wordIds, {maxLen, stride, cls, sep})` — окна из целых слов `[CLS] … [SEP]` длиной ≤ `maxLen`; следующее окно начинается за `stride` слов
   до конца предыдущего (перекрытие ровно `stride` слов, если в окне их больше); слово длиннее `maxLen − 2` субтокенов усекается (метка — по первому).
3. **Пре-фильтр** `skipLowercaseWindows` (по умолчанию вкл.): окно без единого слова с заглавной буквой (`\p{Lu}`) в модель не подаётся — все слова O.
4. Батчи по `batchSize` окон, дополнение `[PAD]` до самого длинного в батче, `attention_mask`, `token_type_ids` = 0; тип индексов — `model.indexType` (int64/int32).
5. softmax по меткам **первого субтокена** слова. Слово в перекрытии берёт предсказание окна, чей центр (по словам) ближе.
6. `bio.decodeWord`: тип слова — argmax маргинальных вероятностей `P(X) = P(B-X) + P(I-X)` (метки вне PER/ORG/LOC, например MISC, считаются O); тег B/I — что больше;
   `prob` = `P(X)`. Так «Пятунину» с `I-PER 0.41, B-PER 0.20, O 0.39` — PER, а не O.
7. `bridgePunct`: знак между двумя словами одного типа становится частью сущности — дефис/апостроф без пробелов («Римский-Корсаков», «О'Коннор»), точка после
   однобуквенного инициала («И.С. Пятунину»).
8. `mergeBio` (B открывает, I продолжает спан того же типа, I без B начинает, O и смена типа закрывают; `score` — средняя `prob` слов) →
   `joinAdjacent` (соседние спаны одного типа через одни пробелы — один спан: модель ставит B на каждое слово ФИО).
9. `filterSpans` → `alignSpans` → `filterSpans`: подрезка пунктуации по краям (парные кавычки внутри и точка инициала/«Ltd.» остаются, объемлющие скобки снимаются);
   границы по соглашениям каталога (FR-18): ORG — с кавычками и ОПФ перед названием (`PREFIX_FORMS`, `FULL_FORMS_RE_SRC`) и латинской ОПФ после
   (`SUFFIX_FORMS_RE_SRC`), спан из одной ОПФ дотягивается до названия в кавычках (голая ОПФ выбрасывается); PER — без обращения (Mr., г-н). Выбрасываются спаны
   короче 2 символов, без букв, без заглавной буквы, PER/ORG из одних шаблонных слов договора (`isStopWord`, `ROLE_WORDS` WP2 + должности/названия реквизитов)
   и короткие сокращения с точкой, за которыми не начинается предложение («Стр. 1»).
   Структурный фильтр (`STRUCT_WORDS`, `structuralCut`): ORG/LOC, начинающийся со слова колонтитула/заголовка (стр, лист, раздел, статья, приложение, page, section… с падежами) и номера (`№`, арабский, римский), выбрасывается вместе с заголовком после номера («Стр. 1», «Лист 2», «Раздел 3. Порядок расчётов»), как и одно такое слово с номером сразу за спаном и нарицательное `COMMON_NOUNS` с номером («Ромашка 2»); ORG с ОПФ или кавычками после номера отрезается от заголовка («Таблица 1. Реквизиты ООО «Ромашка»» → «ООО «Ромашка»»), PER не трогается.

Порог: runner отбрасывает `score < settings.nerThreshold`. Дефолт **0.7** = `recommendedThreshold` пакета (было 0.6; миграция настроек 1 → 2 меняет только
прежний дефолт 0.6). `score` — средняя маргинальная вероятность типа, поэтому он выше, чем вероятность отдельной метки при калибровке. Замеры по порогу — ниже, под таблицей результатов.

**Корпус оценки** — `scripts/gen-ner-eval.mjs` (сид 20261015, вымышленные данные: ФИО из словарей WP7 со склонением `names/morph.js`, придуманные компании,
общеупотребительные топонимы) → `tests/fixtures/ner/eval-ru.json` (240 предложений договорного стиля: PER 169, ORG 94, LOC 88 спанов; 8 шаблонов без сущностей)
и `eval-en.json` (120: PER 80, ORG 42, LOC 58). Соглашение о gold: PER — ФИО как написано (с точкой последнего инициала), ORG — с ОПФ и кавычками, LOC — топоним
без родового слова («Ленина» в «ул. Ленина»). Метрика — span-F1 с точным совпадением границ и метки (`scoreSpans` в `scripts/bench-ner.mjs`).

**Результаты** (`rubert-tiny2-ner-ruen` 1.0.0, int8, `model.onnx` 31 852 495 байт (30,4 МБ), sha256 `0ab310c0…cd01` — финальная модель T1 (дистилляция XLM-R + 10 % синтетики);
опубликованный zip `docx-anonymizer-ner-rubert-tiny2-ner-ruen-1.0.0.zip`, 29 517 760 байт, sha256 `ca023f16799f08b1b1d6134fae242461bda6ab79dfe74e34eda1ec6c9a48318f` (= `KNOWN_PACKS`);
`maxLen` 128, `stride` 16, порог 0.7; `npm run bench-ner` и `tests/integration/ner-provider.spec.js`, 15.10.2026). При переэкспорте модели числа, zip и `KNOWN_PACKS` обновляются вместе:

| Корпус | PER P / R / F1 | ORG P / R / F1 | LOC P / R / F1 | Гейт |
|---|---|---|---|---|
| eval-ru (240) | 0.982 / 0.982 / **0.982** | 0.955 / 0.894 / **0.923** | 0.933 / 0.943 / 0.938 | PER ≥ 0.80 ✓, ORG ≥ 0.65 ✓ (К8) |
| eval-en (120) | 0.986 / 0.850 / **0.913** | 0.778 / 1.000 / 0.875 | 0.957 / 0.776 / 0.857 | PER ≥ 0.75 ✓ |

Тест WikiANN (`tools/ner-train/evaluate.py`, `verify_onnx.py`; токен-уровень seqeval, F1): ru — PER **0.915**, ORG **0.760**, LOC 0.861 (гейты К7 PER ≥ 0.85, ORG ≥ 0.75 ✓);
en — PER 0.809, ORG 0.652, LOC 0.772. Согласие argmax int8 ↔ PyTorch fp32 — 99,7 % (50 предложений; 99,65 % на 2 000), гейт ≥ 99 % ✓.
Числа на `eval-{ru,en}` оптимистичны: в обучение добавлена шаблонная синтетика того же договорного стиля (`synth.py`, свои словари и шаблоны), поэтому решающие для К7 — числа WikiANN.

Без постобработки шагов 6–9 (argmax метки, строгий BIO, только подрезка пунктуации по краям, порог 0.7) — замер WP9 на предыдущем экспорте той же архитектуры:
ru PER 0.711 / ORG 0.145 / LOC 0.877, en PER 0.671 / ORG 0.460 / LOC 0.796 — модель ставит B на каждое слово ФИО, делит массу между B и I, не включает ОПФ и кавычки в ORG.
Оставшиеся ошибки финальной модели (`npm run bench-ner -- --errors=10`): ORG без ОПФ или без ОПФ перед кавычками не находится («Севзапкабель», «Эталон-Логистик»»),
граница ORG захватывает соседние слова («силами ООО «Север-М»», «АНО "Вектор-Технологии" Коростелкина»), «Ростов-на-Дону» → «Ростов»;
в en — инициал перед фамилией («C. Bozeman»), голая фамилия после обращения («Mr. Stanfill», «Dr. Childers» → ORG), названия штатов и стран без контекста («California», «Bavaria»).

Порог: на `eval-ru` span-F1 почти не зависит от порога в диапазоне 0.4–0.8 (PER 0.982 везде, ORG 0.904 при 0.4, 0.929 при 0.6, 0.923 при 0.7, 0.917 при 0.75–0.8);
на `eval-en` выше порог — точнее ORG (0.840 при 0.4 → 0.923 при 0.8) ценой полноты PER/LOC. Калибровка на validation WikiANN (`calibrate.py`) даёт максимум micro-F1 при 0.70
(кривая плоская: 0.65–0.75 различаются < 0.001), поэтому дефолт 0.7 = `recommendedThreshold` пакета.

**Бенчмарк** (AMD Ryzen 9 7945HX, одна нить WASM SIMD; в Node — `npm run bench-ner`, в Chromium — e2e `ner.spec.js` и спайк S6). Финальная модель, 15.10.2026;
Chromium — e2e `ner.spec.js` с опубликованным zip (`NER_PACK`, headless). Строки с пометкой «WP9» измерены на предыдущем экспорте той же архитектуры и размера (скорость от весов не зависит):

| Замер | Node 22 (onnxruntime-web) | Chromium (расширение) |
|---|---|---|
| Холодная `init()` (чтение файлов + словарь 83 828 токенов + сессия) | **0,28–0,32 с** | холодный `analyzeFile` образца (чтение из OPFS + словарь + сессия + анализ) — 0,57 с (WP9: `create` 271 мс + чтение 103 мс) |
| Окно 128 токенов, батч 1 / батч 8 | **11,5 / 10,8 мс** на окно (≈ 12 мс) | WP9: 13,2 / 14,2 мс на окно |
| Окно 256 токенов, батч 1 / батч 8 (WP9) | — | 32,2 / 37,0 мс на окно |
| Токены/с (длинный поток, окна по 128) | **≈ 10 000** (10 900 / 11 700 при батче 1 / 8) | — |
| eval-ru, 240 предложений (по потоку на предложение) | 0,42 с, ≈ 12 000 токенов/с | — |
| «20 страниц», 9 016 слов, 286 абзацев | NER **1,4 с** (1 338 мс; пре-фильтр пропустил 0 окон: в каждом абзаце есть заглавные) | `analyzeFile` целиком (правила + NER) — 2,15 с |
| Тёплый `analyzeFile` образца | — | 0,10 с |
| «300 страниц» ≈ 150 000 слов, 4 764 абзаца (WP9) | NER 23,2 с (282 282 токена) | — |

Батч 8 не быстрее батча 1 в одной нити (≈ одинаковое время на окно), но и не медленнее; в документах батч собирается только внутри потока (абзаца), поэтому
короткие абзацы идут по одному окну. 20 страниц укладываются в 15 с с большим запасом — митигации (`maxLen` 128 уже в пакете, батч 8, пре-фильтр) включены по
умолчанию, до/после не потребовались. Холодная загрузка ≤ 5 с (К7, NFR-06) — с запасом более 10×.

**Спайки:**

| Спайк | Результат |
|---|---|
| **S4** окружение обучения (`tools/ner-train`) | **Работает** (запись по `tools/ner-train/README.md`; отдельного отчёта спайка в WP9 не было): Python 3.12 через `uv`, PyTorch с CUDA 12.8 (`pytorch-cu128`) на RTX 5070 Laptop (Blackwell, `sm_120`); WikiANN `unimelb-nlp/wikiann` (`ru`, `en`) загружается напрямую (parquet, `datasets` 5.x), зеркало не понадобилось. Без GPU конвейер работает на CPU, медленнее. |
| **S5** `onnxruntime-web` под vitest/Node | **Работает без `onnxruntime-node`.** `import 'onnxruntime-web'` в Node разрешается в `dist/ort.node.min.mjs` (WASM-бэкенд, wasm из пакета); `InferenceSession.create(Uint8Array)` на `model.onnx` (int8, 31,9 МБ) — 0,3–0,4 с, `inputNames` = `input_ids, attention_mask, token_type_ids`, выход `logits` float32 `[B, L, 7]`. ESM-импорт подпути `onnxruntime-web/wasm` (тот же, что в воркере) в Node тоже работает; CJS-вход (`require.resolve` → `ort.wasm.min.js`) при `import()` кладёт API в `default`. Тесты и бенчмарк берут основной ESM-вход (`loadOrt()` в `scripts/bench-ner.mjs`), `onnxruntime-node` не нужен. |
| **S6** int8-модель в ORT WASM (браузер и Node) | **Исполняется** в обоих: квантованные MatMul/Gather (в т.ч. построчно квантованная таблица эмбеддингов `Gather → Cast → Mul → Add`) поддерживает WASM EP; одна нить (`numThreads = 1`), без proxy. Числа — в таблице бенчмарка. Браузерный замер — отдельная страница в копии `dist-e2e` (ESM-бандл `ort.wasm.bundle.min.mjs`, модель с `chrome-extension://`), Chromium из Playwright 1.63, headless. |

**Поток из нескольких предложений, `splitSentences`, границы PER, дубликаты** (доработка после ревью WP9, 15.10.2026). В документе модель получает поток
абзаца, а обучена на отдельных предложениях: в склейке она тянет PER через точку («… Антонина. Груз …») и чаще ошибается в типе. Опция провайдера
`splitSentences` (**по умолчанию `true`**) режет поток на предложения до `makeWindows` (`windows.js` `sentenceRanges`: граница — `.`/`!`/`?`/`…` перед словом
с заглавной, в т.ч. после открывающей кавычки, и перенос строки/U+FFFC; не после однобуквенного инициала и сокращений «г.», «ул.», «Inc.»; обрывок короче
4 слов с буквами идёт со следующим предложением — иначе «Добрый день!» без контекста становится ORG); окна строятся по каждому предложению отдельно.
Дополнительно: `mergeBio` закрывает спан на переносе строки и U+FFFC между словами; `alignSpans` срезает у PER ведущие обращения, должности и роли
(`POSITION_RE_SRC`, `ROLE_WORDS`, «Уважаемый», «г-жа», «гражданка», «менеджер» …; спан из одних таких слов выбрасывается); `dedupeSpans` после последнего
`filterSpans` убирает дубликаты и вложенные спаны того же типа (остаётся объемлющий с большим score), а спан другого типа внутри кавычек названия ORG
(PER «Орион» в «ПАО "Орион-Логистик"») поглощается ORG; прочие пересечения — в пользу большего score. `dispose()` во время `detect`/`init` →
`CoreError('MODEL_LOAD_FAILED')` (сессия, созданная после dispose, освобождается), а не `TypeError`.

Склейка eval-ru по k подряд идущих предложений через пробел (gold сдвигается), порог 0.7, span-F1 PER / ORG / LOC:

| k | до доработки (ревью) | `splitSentences: false` | `splitSentences: true` (по умолчанию) |
|---|---|---|---|
| 1 | 0.982 / 0.923 / 0.938 | 0.982 / 0.923 / 0.938 | 0.982 / 0.923 / 0.938 |
| 3 | 0.893 / 0.891 / 0.894 | 0.893 / 0.891 / 0.894 | **0.959 / 0.917 / 0.938** |
| 5 | 0.877 / 0.930 / 0.903 | 0.886 / 0.930 / 0.903 | **0.959 / 0.923 / 0.938** |
| 10 | 0.856 / 0.885 / 0.880 | 0.859 / 0.891 / 0.880 | **0.964 / 0.917 / 0.938** |

eval-en при k = 5: PER 0.902 → 0.899, ORG 0.792 → 0.845, LOC 0.846 → 0.849 (без нарезки → с нарезкой). Гейт `tests/integration/ner-provider.spec.js` —
eval-ru абзацами по 5 предложений: PER ≥ 0.80, ORG ≥ 0.65 ✓. Собственный корпус ревьюера (30 предложений ru/en): PER 0.930 → **0.977**, ORG 0.933, LOC 1.000
(без изменений); трудный (15): PER 0.800, ORG 0.533, LOC 0.667 (без изменений). Цена нарезки: «20 страниц» — 813 окон вместо 286, NER в Node 1,35–1,42 → 1,72 с;
`analyzeFile` в Chromium (e2e `ner.spec.js`) 2,1 с — гейт 15 с с запасом.
