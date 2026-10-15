# Рабочие пакеты

Пакеты WP1–WP5 — MVP (версия 0.1). Пакеты WP6–WP9 — версия 0.2, цели и критерии в `docs/concept-0.2.md`.

Фундамент готов: каркас MV3, ядро DOCX, контракты, протокол, конвейер popup → offscreen → worker (см. `docs/contracts.md`).
Оставшаяся работа MVP (`docs/mvp-scope.md`) разбита на 5 независимых пакетов. Пакеты работают параллельно:
**каждый правит только свои файлы**. Нужна правка в чужом или в замороженном файле — сначала согласовать с координатором
(минимальное аддитивное изменение, с тестом).

## Общие правила

- Ветка на пакет: `wp1-identifiers`, `wp2-names`, `wp3-intercept`, `wp4-options`, `wp5-e2e`.
- Перед сдачей: `npm test`, `npm run lint`, `npm run build`, `npm run e2e` — зелёные.
- Тексты для пользователя — на русском (EN — вторым языком в словарях `src/ui/i18n/<модуль>.js`).
- Никаких сетевых запросов; никаких значений из документа в логах.
- Тестовые данные — только вымышленные (образец: `scripts/make-sample.mjs`).

### Замороженные файлы фундамента (менять только через координатора)

`manifest.json`, `scripts/build.mjs`, `src/core/contracts/**`, `src/core/docx/**`, `src/core/detect/{index,runner,overlap}.js`,
`src/core/{apply,mapping,placeholders,settings,sites,search,text-view,errors,index}.js`, `src/shared/**`,
`src/offscreen/**`, `src/background/{index,router,offscreen-manager}.js`.
Исключение: `src/core/categories.js` — WP1/WP2 могут дополнять **данные** (лейблы) своих категорий, не меняя структуру.

После MVP (версия 0.2) заморозка снята для файлов, которые меняли пакеты WP6–WP9: `manifest.json`, `scripts/build.mjs`,
`src/core/contracts/ner.js`, `src/core/detect/runner.js`, `src/core/{settings,deanon}.js`, `src/shared/**` (в т.ч. новые `permissions.js`, `model-store.js`),
`src/offscreen/**`, `src/background/{index,router,offscreen-manager}.js`. Правило прежнее: минимальное аддитивное изменение, с тестом, в рамках своего WP.
Версия 0.2.0 завершена (WP6–WP9 выполнены); остальные файлы фундамента по-прежнему меняются только через координатора, с записью в `docs/contracts.md`.

---

## WP1 — детекторы идентификаторов

**Файлы:** `src/core/validators.js`, `src/core/detect/identifiers/**`, `tests/unit/identifiers/**`, `tests/fixtures/categories/{INN,KPP,OGRN,BIK,ACCOUNT,CARD,IBAN,SWIFT,SNILS,PASSPORT,SSN,TAXID,EMAIL,PHONE,URL,BIRTHDATE,CONTRACT,AMOUNT}.json`.

**Сделать:**
- Валидаторы (§9.1 `validators.spec`): ИНН-10/12, ОГРН/ОГРНИП, СНИЛС, Луна, IBAN mod-97 (+ длины по странам), SSN, БИК, КПП, ключ счёта по БИК, SWIFT (ISO-3166), EIN/VAT, дата рождения. ≥ 20 валидных и ≥ 20 невалидных примеров на каждый.
- Детекторы 18 категорий по таблице §4.3: регулярки + лейблы (≤ 40 символов перед кандидатом, `:`/`№`/`#`/пробелы/табуляция), уровни `validated/labeled/weak` строго по `allowedLevels`, границы (цифровой идентификатор не часть более длинной цифровой последовательности), счёт: ключ по БИК в радиусе 500 символов (документный детектор или контекст потока), PASSPORT: серия/номер, орган выдачи, код подразделения — три вхождения одной сущности (через `canonical`).
- Учитывать лейблы ближайшей категории (ИНН рядом с «тел.» не PHONE и наоборот — решается уровнями и пересечениями FR-20).
- Удалить временный детектор EMAIL, заменив настоящим.
- Повторяющиеся подстроки: «ИНН 7736050003 7736050003» → два вхождения с верными смещениями (дефект 5).

**Приёмка:**
- фикстуры `tests/fixtures/categories/<ID>.json` (≥ 10 позитивных и ≥ 10 негативных, включая примеры из таблицы §4.3) — 100 % совпадение (FR-18);
- на образце (`buildSampleDocx().gold`) все ИНН, КПП, ОГРН, БИК, р/с, к/с, СНИЛС, паспорт, телефоны, e-mail, URL найдены с верной категорией;
- `tests/integration/host.spec.js` и e2e остаются зелёными.

## WP2 — PERSON / COMPANY / ADDRESS и база знаний сторон

**Файлы:** `src/core/detect/names/**`, `tests/unit/names/**`, `tests/fixtures/categories/{PERSON,COMPANY,ADDRESS}.json`, `tests/fixtures/kb-forms.json`, `tests/fixtures/overlap.json`.

**Сделать:**
- PERSON: ФИО 2–3 слова с заглавной, «Фамилия И.О.», «И.О. Фамилия», латиница; лейблы «в лице», «генеральный директор», «ФИО», «represented by» и т.д.; негативы — «Общество с Ограниченной Ответственностью», «Российская Федерация», месяцы/дни.
- COMPANY: ОПФ (ООО, АО, ПАО, ЗАО, ИП, НКО, ГУП, LLC, Ltd, Inc, GmbH, …) + название в кавычках любого типа; **ОПФ и кавычки — в `keepPrefix/keepSuffix`**; `ИП Иванов И.И.` → COMPANY целиком, ФИО → KB-вариант (FR-21); `govEntities` — список госорганов/банков, которые не трогаем.
- ADDRESS: индекс + компоненты (г., ул., д., кв., обл., пр-т, корп., стр., офис), EN-адреса; ≥ 2 компонента; `weak` только при ≥ 3 компонентах и индексе.
- KB (FR-22–23): документный детектор `registerDocumentDetector('kb', …)` — блок реквизитов и преамбула; варианты: падежи ФИО (-ов/-ев/-ин/-ский/-ая/-ич/-на…), инициалы во всех формах, «Имя Фамилия», одиночная фамилия (≥ 4 букв, не нарицательное), название без ОПФ, транслитерация ГОСТ 7.79-2000 Б и ИКАО, аббревиатура ≥ 3 букв. Варианты связываются с основной сущностью через `canonical`.

**Приёмка:**
- фикстуры категорий — 100 %; `kb-forms.json` по FR-23 («Иванов Пётр Сергеевич» → «Иванова П.С.», «П.С. Иванов», «Иванову», «Пётр Иванов»; «ООО «Ромашка-Трейд»» → «Ромашка-Трейд», «Romashka-Trade LLC»; «РТ» — не находится);
- `overlap.json` — 20 случаев FR-20 (с детекторами WP1 подключать не обязательно — достаточно кандидатов из фикстуры);
- на образце: обе стороны, оба директора во всех падежах и сокращениях, оба адреса — одна группа на лицо/компанию.

## WP3 — перехват на сайте, панель, popup

**Файлы:** `src/content/**`, `src/ui/panel/**`, `src/ui/preview/**`, `src/ui/components/**`, `src/ui/i18n/{panel,preview,popup,common}.js`, `src/popup/**`, `src/background/badge.js`, `tests/e2e/intercept.spec.js` (+ при необходимости `tests/e2e/pages/intercept-*.html`), `tests/unit/ui/**`.

**Сделать (§3.2, §3.4–3.7, §4.1, FR-30/31/33 в объёме MVP):**
- Content script: при `isInterceptActive(settings, location.origin) === false` — ничего (FR-07), реакция на `onSettingsChanged` без перезагрузки; перехват `change` у `input[type=file]` (включая динамические, open shadow root, iframe того же origin), `drop` и `paste` в фазе capture на `document`; `.docx/.docm` или MIME (FR-04); `multiple` с сохранением порядка (FR-06); подстановка `<name>.anon.docx` через `DataTransfer` + `input`/`change` с защитой от повторного перехвата (FR-05); инвалидация контекста (FR-09); ошибки §3.5.
- Панель: custom element с closed Shadow DOM, стили строкой в JS, `z-index` 2147483647, Esc с подтверждением, перетаскивание и запоминание позиции (FR-08); прогресс по стадиям; таблица сущностей (чекбокс, категория, значение, вхождения, плейсхолдер редактируемый), фильтр категорий, счётчик «Найдено N, включено M», предупреждения; кнопки «Анонимизировать и загрузить», «Загрузить оригинал», «Отмена», «Скачать результат», «Скачать маппинг»; «Больше не предлагать» → `exclusions` (FR-32); вкладки по файлам, `BATCH_BEGIN` для сквозной нумерации.
- Вкладка «Текст» — по `GET_TEXT`, выделение → `ADD_ENTITY` (FR-31, базово).
- Popup: тумблер перехвата с состоянием для текущего сайта, «Восстановить текст», «Настройки», недавние сессии (`LIST_SESSIONS`). Блок dev-конвейера оставить (можно в `<details>`), см. contracts §5 п.8.
- Бейдж `ON` и тултип (FR-43) в `src/background/badge.js`.

**Приёмка:** на тестовой странице (от WP5 или своей `tests/e2e/pages/intercept-*.html`) e2e: выбор файла/drop/paste → панель → «Анонимизировать» → обработчик страницы получает `*.anon.docx` с заменёнными значениями; «Загрузить оригинал» → оригинал; при выключенном тумблере `document.querySelector('docx-anonymizer-root') === null`; `[a.docx, b.pdf, c.docx]` → `[a.anon.docx, b.pdf, c.anon.docx]`.

## WP4 — настройки, свои категории, обратная замена

**Файлы:** `src/options/**`, `src/restore/**`, `src/core/detect/custom/**`, `src/ui/deanon/**`, `src/ui/i18n/{options,restore}.js`, `tests/unit/custom/**`, `tests/e2e/{options,restore}.spec.js`, `tests/fixtures/{custom-categories,deanon}.json`.

**Сделать (§4.8, §4.9, §4.11, §4.12 — базово):**
- `options.html`: разделы «Перехват» (тумблер, `siteMode` с подтверждением для `all`, allowlist/blocklist с валидацией origin), «Категории» (из `buildCatalog`, переключатели), «Обработка» (режим, язык, язык плейсхолдеров, метаданные, `stripEmbedded`, лимит размера), «Исключения», «Данные» (экспорт/импорт конфигурации JSON, очистка). Каждое изменение сохраняется сразу через `saveSettingsPatch`; невалидное — подсвечивается и не сохраняется (FR-42).
- Свои категории (FR-44/45/47): форма (имя, префиксы RU/EN, цвет, тип: словарь / лейбл+форма / шаблон, приоритет), «Проверить на тексте» с подсветкой; regex-guard в `src/options/regex-guard.worker.js` (лимит 500 символов, флаги `iu`, без lookbehind, 500 мс на образце 20 000 символов — `(a+)+$` отклоняется); экспорт/импорт `*.categories.json`; предупреждение о хранении словаря.
- Ядро своих категорий: документный детектор `custom` в `src/core/detect/custom/index.js` (уровни по FR-44, `validator` из `core/validators.js`).
- `restore.html` (С3, FR-36/37): поле «Текст с плейсхолдерами» → результат; маппинг из сессии (`LIST_SESSIONS` → `DEANON {mappingRef: docId}`) или из файла `.mapping.json`; подсветка нераспознанных; «Копировать»; подсказка про падежи.

**Приёмка:** `deanon.json` — 30 случаев, 100 %; `custom-categories.json` — по 3 категории каждого типа, `aboveBuiltin` выигрывает у PERSON; e2e: изменение настройки отражается в `storage.local` ≤ 200 мс; восстановление текста по маппингу из файла.

## WP5 — e2e, генератор образцов, «файл → файл»

**Файлы:** `scripts/make-sample.mjs` (расширение), `scripts/gen-fixtures.mjs`, `tests/integration/**` (новые файлы; существующие — не ломать), `tests/fixtures/docs/**`, `tests/e2e/pages/**`, `tests/e2e/fixtures.js`, `tests/e2e/pipeline.spec.js`, `tests/e2e/{chat,nfr}.spec.js`, `schemas/**`.

**Сделать:**
- Генератор: несколько документов (EN-договор, договор с правками трёх авторов, таблица в таблице, `sdtContent`, `mc:AlternateContent`-надпись, OLE-вложение для FR-15, soft hyphen, посимвольно разбитые раны, 30+ страниц для производительности) + `*.gold.json`.
- «Файл → файл» (§9.2): для каждого документа — анализ полным набором детекторов → применение → `xmllint` (если есть) + проверка корректности XML → список частей и `[Content_Types].xml` → LibreOffice (если есть) → поиск gold-значений в результате = 0. До готовности WP1/WP2 тесты, зависящие от детекторов, помечать `it.todo`/`skipIf`, а «конвейерные» части (утечки при пользовательских сущностях) — делать сразу.
- Локальная тестовая страница, имитирующая чат LLM (`tests/e2e/pages/chat.html`): кнопка «Прикрепить» со скрытым `input[type=file]`, динамический инпут, инпут в open shadow root, iframe того же origin, React-подобная drop-зона, paste-зона, `multiple`; страница выводит в DOM имена и SHA-256 полученных файлов. Отдаётся локальным статическим сервером из Playwright (`webServer` или `page.route`), **без внешней сети**.
- e2e: NFR-01 (ни одного запроса с инициатором `chrome-extension://` наружу), сквозной сценарий на тестовой странице (совместно с WP3 — WP5 даёт страницу и хелперы, WP3 пишет `intercept.spec.js`).
- JSON-схемы `schemas/mapping.schema.json`, `schemas/protocol.schema.json` и тест валидации маппинга и сообщений хоста.

**Приёмка:** `npm test` и `npm run e2e` зелёные без дисплея (headless); каждое gold-значение проверено на утечку; результат детерминирован (SHA-256 двух прогонов совпадает).

---

## WP6 — разрешения по сайтам, версия, склонение при восстановлении (версия 0.2)

**Файлы:** `manifest.json`, `scripts/build.mjs` (флаг `--e2e`), `scripts/pack.mjs`, `src/shared/permissions.js`, `src/background/{site-access,index}.js`,
`src/content/content.js`, `src/popup/popup.js`, `src/ui/components/site-state.js`, `src/options/options.js` (раздел «Перехват»),
`src/core/{deanon,deanon-morph}.js`, `src/restore/**`, `src/ui/deanon/index.js`, `src/offscreen/host.js` (DEANON), `schemas/protocol.schema.json`,
`src/ui/i18n/{popup,options,help,restore}.js`, `tests/unit/{site-access,deanon-morph}.spec.js`, `tests/unit/ui/site-state.spec.js`,
`tests/unit/custom/deanon-decline-fixture.spec.js`, `tests/fixtures/deanon-decline.json`, `tests/integration/manifest.spec.js`, `tests/e2e/{site-access,restore}.spec.js`, `tests/e2e/fixtures.js`.

**Сделать:**
- Разрешения: `optional_host_permissions: ["<all_urls>"]`, `permissions` += `scripting`, `activeTab`; удалить `host_permissions` и статический `content_scripts`. Content script регистрируется через `chrome.scripting.registerContentScripts` для выданных origin (источник истины — `chrome.permissions.getAll().origins`), синхронизация на `onInstalled`/`onStartup`/`permissions.onAdded|onRemoved`; по `onAdded` — `executeScript` в открытые вкладки. Popup и настройки запрашивают доступ синхронно в обработчике клика; состояние `needsAccess` в popup. Сборка `--e2e` → `dist-e2e/` с `host_permissions` для Playwright (нативный диалог не автоматизируется — ручной чек-лист в README).
- Версия: `manifest.json` репозитория = package.json (тест); комментарий о DOS-времени в `pack.mjs`, тест на независимость от TZ.
- Склонение (FR-37 в новой редакции): `deanonymize(text, mapping, {decline})` подбирает падеж ФИО по приклеенному окончанию (`[ФИО_1]у`), предлогу или управляющему сочетанию перед меткой (`от`, `в лице`, `в адрес`…) или по предыдущей метке при сочинении (`от [ФИО_1] и [ФИО_2]`); `в/на/за/под`, незнакомые окончания и латиница — именительный; лемма и род выводятся из `value`/`variants`, карта замен не меняется; склонённые подстановки подсвечиваются и считаются; флажок «Склонять ФИО по контексту» на странице восстановления (по умолчанию вкл.), `DEANON {decline}` в протоколе.

**Приёмка:** К9, К10, К11 из `docs/concept-0.2.md`; `deanon.json` (30 случаев) не тронута; `npm run e2e` зелёный на `dist-e2e`.
Факт: `deanon-decline.json` — 51 случай, 100 %; разрешения проверяют `manifest.spec.js`, `pack.spec.js`, `site-access.spec.js` (unit и e2e); ручной чек-лист нативного диалога — README, «Разработка».

**Статус:** выполнено, коммиты `a51e841` (склонение ФИО при восстановлении), `7c94d12` (доступ к сайтам по запросу, версия в манифесте, сборка `dist-e2e`).

## WP7 — словарный детектор ФИО (NER, ступень 1)

**Файлы:** `scripts/make-dicts.mjs`, `src/core/detect/names/dict/**` (генерируемые модули + `NOTICE.md`), `src/core/detect/names/{person-dict,kb,person,lexicon,morph}.js`,
`src/core/settings.js` (`dictNames`), `src/options/options.js` (тумблер), `src/ui/i18n/options.js`, `scripts/gen-fixtures.mjs` (документ `third-persons`),
`tests/unit/names/{person-dict,person-dict-morph,dict-codec,person-dict.perf}.spec.js`, `tests/fixtures/categories/PERSON-dict.json`, `tests/fixtures/docs/third-persons.*`, `tests/integration/{fixtures-docs,pack}.spec.js`.

**Сделать:**
- Словари: datacoon/russiannames (BSD-3) — RU фамилии (50 000 лемм) и имена (≈ 6 800, с родом); natasha (MIT) — неоднозначные имена (омонимы нарицательных); US Census (public domain) — EN имена (≈ 4 900) и фамилии (10 000). Генератор `npm run dicts` (`--check`), front-coding, `NOTICE.md`; ≈ 360 КБ данных только в `offscreen/worker.js`.
- Детектор `findPersonsByDict`: пары `[Имя][Фамилия]`/`[Фамилия][Имя]`, `[Имя][Отчество]` (вид `fm`), латиница; правило «два признака из трёх» с согласованием падежа и рода; guards (топонимы, стоп-слова, нарицательные, госорганы, кавычки, начало предложения, заголовки, `NON_PERSON_PAIRS`). Вхождения — уровень `kb`, `party:false`; поиск вариантов по документу для записей с ≥ 2 попаданиями (одиночная фамилия — только для сторон).
- Настройка `dictNames` (по умолчанию вкл., поле профиля), тумблер в «Обработка».
- Ревью (WP-N1): названия фирм латиницей не считаются людьми — хвосты `Inc`/`LLP`/`Group`/`International`…, «Bank of …», сверка с названиями компаний документа (такая пара выдаётся как COMPANY); «Имя Отчество» из правил («Ольгой Петровной») склеивается в одну запись с полным ФИО.

**Приёмка:** К1, К2, К3, К4, К15. Факт: `PERSON-dict.json` — 47 позитивов (39 только словарных), 68 негативов, 100 %; К4 — отношение времени 1.07–1.17; `content.js` 110 048 байт, словарей в нём нет.

**Статус:** выполнено, коммиты `402923f` (словари и детектор), `a7cdce1` (названия фирм латиницей, «Имя Отчество»).

## WP8 — модельный пакет NER (ступень 2)

**Файлы:** `schemas/model-pack.schema.json`, `src/core/hash.js`, `src/core/ner/{pack,known-packs}.js`, `src/shared/model-store.js`, `src/core/settings.js` (`nerModel`), `src/options/{options,config-io}.js` (карточка «NER»),
`src/ui/i18n/{options,help,panel}.js`, `src/help/help.js`, `src/shared/protocol.js` (`MODEL_CHANGED`), `schemas/protocol.schema.json`, `src/offscreen/{host,worker,offscreen}.js`, `src/core/contracts/ner.js` (`dispose`), `src/core/detect/runner.js` (`NER_FAILED.details`),
`scripts/{build,pack-model}.mjs`, `manifest.json` (`unlimitedStorage`), `tests/unit/ner/pack.spec.js`, `tests/integration/{pack-model,host,schemas,pack}.spec.js`, `tests/e2e/model-pack.spec.js`, `tests/fixtures/ner/pack.valid.json`.

**Сделать:**
- Формат пакета `docx-anonymizer-ner-<id>-<ver>.zip` с `pack.json` (манифест, хеши файлов), `model.onnx`, `vocab.txt`, `config.json`, `LICENSE`, `NOTICE`; валидация и проверка хешей в ядре; список известных пакетов для пометки «проверен».
- Хранилище OPFS: два слота `models/<id>/` и `models/<id>.1/` с маркером `.installing` — переустановка не ломает прежнюю версию (запись из настроек, чтение из worker); `unlimitedStorage`; импорт/удаление/статус в настройках; `MODEL_CHANGED` сбрасывает кэш провайдера в хосте; фабрика провайдера `env.createNerProvider(settings)`.
- Проверка пакета без исключений (`{ok: false, error}` на любом входе), зарезервированные имена файлов (`pack.json`, `installed.json`, `.installing`, имена свойств прототипа), лимит 512 МБ (`TOO_LARGE`) на zip и распакованное содержимое.
- e2e видит сеть offscreen-документа и его воркера через CDP браузера (`tests/e2e/helpers/network.js`, К6).
- Сборка: worker как ES-модуль (отдельный вызов esbuild `format:'esm'`), `onnxruntime-web` wasm в `dist/vendor/`.
- `npm run pack:model -- --id=<id>`: детерминированный zip из `models-src/<id>/` в `release/`.

**Приёмка:** К5, К6, К3; спайки S1–S3 (OPFS в worker offscreen, квота, модульный worker под CSP) зафиксированы в `docs/contracts.md` §6.6.

**Статус:** выполнено, коммиты `7872a8d` (формат, хранилище, импорт, `MODEL_CHANGED`, модульный worker с ORT, `dictNames`, версия 0.2.0), `ef1ca45` (проверка без исключений, зарезервированные имена, `TOO_LARGE`, слоты, сеть offscreen/worker в e2e).

## WP9 — ONNX-провайдер и обучение модели (ступень 3)

**Файлы:** `src/core/ner/{wordpiece,windows,bio,onnx-provider}.js`, `src/offscreen/worker.js`, `scripts/{bench-ner,gen-ner-eval}.mjs`, `tools/ner-train/**`,
`tests/unit/ner/{wordpiece,windows,bio}.spec.js`, `tests/integration/ner-provider.spec.js`, `tests/e2e/ner.spec.js`, `tests/fixtures/ner/{wordpiece-cases,eval-ru,eval-en}.json`, `src/core/ner/known-packs.js` (sha256 пакета).

**Сделать:**
- Провайдер: `onnxruntime-web` (WASM SIMD, одна нить) + собственный WordPiece с офсетами; окна `maxLen`/`stride` по словам; батчи; пре-фильтр окон без заглавных; метка первого субтокена; тип слова по маргинальной вероятности `P(B-X) + P(I-X)`, слияние BIO, склейка соседних спанов и пунктуации внутри имён, границы ORG/PER по соглашениям каталога; `score` — средняя вероятность; ошибки загрузки → `MODEL_LOAD_FAILED` → предупреждение `NER_FAILED` (NFR-13).
- Корпус оценки `npm run gen-ner-eval` (`eval-ru` 240 предложений, `eval-en` 120), бенчмарк `npm run bench-ner`; порог `nerThreshold` 0.7 с миграцией настроек 1 → 2 (прежний дефолт 0.6).
- Обучение (`tools/ner-train`, uv, GPU): `cointegrated/rubert-tiny2` на WikiANN ru+en с дистилляцией от учителя `xlm-roberta-base` и 10 % шаблонной синтетики → ONNX opset 17 → int8 (MatMul — `quantize_dynamic` per-channel; эмбеддинги — построчная uint8-квантизация из `Gather → Cast → Mul → Add`, потому что `quantize_dynamic` с `Gather` давал согласие 98,1 %) → проверка argmax ≥ 99 % → калибровка `nerThreshold` → `models-src/<id>/` → `npm run pack:model`.
- Модель в git не попадает; zip выкладывается в GitHub Releases, sha256 — в `known-packs.js` и README.

**Приёмка:** К6, К7, К8; результаты бенчмарка (мс/окно, холодная загрузка) — в `docs/contracts.md` §6.7.
Факт (финальная модель, int8, порог 0.7): WikiANN ru test F1 PER 0.915 / ORG 0.760 / LOC 0.861, en PER 0.809 / ORG 0.652 / LOC 0.772; `eval-ru` PER 0.982 / ORG 0.923 / LOC 0.938,
`eval-en` PER 0.913 / ORG 0.875 / LOC 0.857; `model.onnx` 30,4 МБ; согласие с PyTorch 99,7 %; холодная загрузка 0,28 с; ≈ 12 мс на окно 128 токенов; 20 страниц (9 016 слов) — 1,4 с.
Пакет `docx-anonymizer-ner-rubert-tiny2-ner-ruen-1.0.0.zip` (29 517 760 байт), sha256 `ca023f16…318f` — в `KNOWN_PACKS` и README.

**Статус:** выполнено, коммиты `a50a725` (провайдер, корпус оценки, бенчмарк, порог 0.7, известный пакет), `be5519b` (конвейер обучения `tools/ner-train`), `1f5ee52` (пакет пересобран из финальной модели, sha256).
