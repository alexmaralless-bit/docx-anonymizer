# Рабочие пакеты

Пакеты WP1–WP5 — MVP (версия 0.1). Пакеты WP6–WP9 — версия 0.2 (`docs/concept-0.2.md`). Пакеты WP10-A…D — версия 0.3 (`docs/concept-0.3.md`).

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
В 0.3 (WP10-A…D) через координатора изменены `src/core/{apply,errors,index}.js` (сериализатор по `doc.kind`, коды `PDF_*`, реэкспорт) и уже размороженные
`manifest.json`, `scripts/build.mjs`, `src/core/{settings,deanon}.js`, `src/shared/protocol.js`, `src/offscreen/{host,worker}.js`, `src/background/{index,router}.js`;
добавлены `src/shared/bundled-model.js`, `src/offscreen/{package-fetch,pdf-loader}.js`. Остальной фундамент (`src/core/contracts/**`, `src/core/docx/**`,
`src/core/detect/{index,runner,overlap}.js`, `src/core/{mapping,placeholders,sites,search,text-view}.js`, `src/background/offscreen-manager.js`) в 0.3 не менялся
и по-прежнему меняется только через координатора.

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

**Приёмка:** К1, К2, К3, К4, К15. Факт: `PERSON-dict.json` — 47 позитивов (39 только словарных), 68 негативов, 100 %; К4 — отношение времени 1.07–1.17; `content.js` ≈ 110 КБ, словарей в нём нет.

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
Факт (финальная модель, int8; WikiANN — argmax без порога, синтетика — порог 0.7): WikiANN ru test F1 PER 0.916 / ORG 0.762 / LOC 0.861 (fp32 — 0.915 / 0.760), en PER 0.809 / ORG 0.652 / LOC 0.772; `eval-ru` PER 0.982 / ORG 0.923 / LOC 0.938,
`eval-en` PER 0.913 / ORG 0.875 / LOC 0.857; `model.onnx` 30,4 МБ; согласие с PyTorch 99,7 %; холодная загрузка 0,28 с; ≈ 12 мс на окно 128 токенов; 20 страниц (9 016 слов) — 1,4 с.
Пакет `docx-anonymizer-ner-rubert-tiny2-ner-ruen-1.0.0.zip` (29 517 760 байт), sha256 `ca023f16…318f` — в `KNOWN_PACKS` и README.

**Статус:** выполнено, коммиты `a50a725` (провайдер, корпус оценки, бенчмарк, порог 0.7, известный пакет), `be5519b` (конвейер обучения `tools/ner-train`), `1f5ee52` (пакет пересобран из финальной модели, sha256).

---

## WP10-A — PDF с текстовым слоем (версия 0.3)

**Файлы:** `src/core/pdf/{layout,extract}.js`, `src/core/text/{model,serialize}.js`, `src/core/apply.js` (`planEdits` + сериализатор по `doc.kind`), `src/core/detect/names/kb.js` (хук `doc.tables`), `src/core/{errors,settings,index}.js`, `src/shared/protocol.js`, `schemas/protocol.schema.json`, `src/offscreen/{host,worker,pdf-loader}.js`, `src/content/{files,interceptor,content,flow}.js`, `src/ui/panel/panel.js`, `src/ui/i18n/{panel,common,options,help}.js`, `src/options/options.js`, `scripts/{build,gen-pdf-fixtures}.mjs`, `manifest.json` (`minimum_chrome_version` 132), `tests/fixtures/pdf/**`, `tests/unit/pdf/**`, `tests/unit/{text-model,apply-text}.spec.js`, `tests/integration/{pdf-pipeline,pdf-fixtures,pack,host,schemas}.spec.js`, `tests/integration/support/pdf.js`, `tests/e2e/{pdf,chat,intercept,nfr,restore}.spec.js`.

**Сделать:** pdf.js 6.4 вендорится в `vendor/pdfjs/` и грузится лениво во вложенном Worker; текст страниц → разметка (строки, слова, колонки, абзацы, заголовки, списки, таблицы, колонтитулы, переносы) → текстовая `DocModel` (`kind:'text'`) → те же детекторы → `serializeText` в Markdown/txt; хост ветвится по сигнатуре `%PDF-`/имени; коды `PDF_INVALID|PDF_ENCRYPTED|PDF_EMPTY|PDF_NO_TEXT`, предупреждение `PDF_PAGES_NO_TEXT`; RESULT с `mime`; настройка `pdfMode` (`markdown|text|off`); отказы через существующий экран ошибки с «Загрузить как есть»; фикстуры PDF из синтетических договоров (Chromium + LibreOffice) со снимками разметки.

**Приёмка:** К1–К9, К11–К13, К17 (PDF) из `docs/concept-0.3.md`.

**Статус:** закоммичено `64bdb9f`. pdf.js 6.4 — **legacy-сборка** в `vendor/pdfjs/` (современная требует API новее Chrome 132), вложенный воркер через `PDFWorker({port})`; `core/pdf/{layout,extract}.js`, `core/text/{model,serialize}.js`, `planEdits` + сериализатор по `doc.kind`, хук `doc.tables` в `kb.js`, `pdfMode`, стадия `pdf`, коды `PDF_*`, `RESULT_BEGIN.mime`, `ENTITIES.kind`; 13 PDF-фикстур (10 текстовых со снимками и gold). Факт: К2 — 0 утечек детекторами на 10 фикстурах; К3 — паритет 100 % по всем категориям; К4 — порядок абзацев 100 %, колонтитулы вынесены, таблица реквизитов `ip-contract` 8 × 2 и в Chromium, и в LibreOffice; К6 — `perf-50p` (48 стр.) ≈ 0,45 с в Node, 0,36 с в Chromium, холодный PDF с загрузкой pdf.js 0,2 с; К8 — `vendor/pdfjs/` 3,6 МБ, лёгкий архив 6,1 МБ; `worker.js` без ORT 706 952 байт (≤ 700 КБ). Архивы на `64bdb9f`: лёгкий 6 425 902 байт (sha256 `c1980132…a6411`), полный 35 944 673 байт. Спайки S1–S4 — `docs/contracts.md` §7.6. Тест восстановления по карте PDF-сессии (К10) — в `tests/e2e/pdf.spec.js` (файл `restore.spec.js` — зона WP10-B).

Доработка по ревью (19.10.2026) — коммит `68d9c73`: мягкий перенос в номерах («ИНН 7805-» + «003215» → без дефиса при группе ≥ 4 цифр, телефоны
не трогаются) и знак переноса U+2010/U+00AD всегда, «Ан-» + «дреева» (Д1, Д2); моноширинный шрифт — пробел не режет ячейку «БИК 044525901» (Д3); узкая
надпись LibreOffice — один абзац по локальному правому краю (Д4); повёрнутое содержимое (`/Rotate` + `cm`) — через матрицу viewport и `orientPage`,
страница из одних водяных знаков → `PDF_NO_TEXT`/`PDF_PAGES_NO_TEXT` (Д5); колонки таблицы по правому краю для чисел (Д6); заголовок после двух колонок —
граница участка (Д7); отделённая крайняя строка полосы обычного кегля — колонтитул и на одной странице (Д8); заметка панели с расширением `{ext}` по `pdfMode`
(Д9); `TOO_LARGE` с `details.pages` → `err.TOO_LARGE_PAGES` (Д10); «;» на границе страницы/колонки перед строчной — не конец абзаца (Д12); кнопка
«Загрузить» (`btnUpload`), когда все файлы «как есть». Фикстуры: `wild-mono`, `wild-landscape`, `wild-2col`, `rotated`, `structures.lo`,
`sample-contract.lo` (16 текстовых); К2 — 0 утечек целиком и частично (фамилии gold-ФИО, номера с дефисом/пробелом внутри), К3 ≥ 95 % на каждой.
Бюджет `worker.js` разделён (§6.5 `docs/contracts.md`): код без ORT и словарей 350 775 байт (≤ 400 КБ), словари ФИО 365 494 байт (≤ 400 КБ).

Бэклог — в разделе «Бэклог после 0.3» в конце файла.

## WP10-B — восстановление файла от ИИ

**Файлы:** `src/core/{deanon,deanon-morph,restore-doc,index}.js`, `src/shared/protocol.js` (`GET_MAPPING`/`MAPPING`), `schemas/protocol.schema.json`, `src/offscreen/host.js`, `src/restore/{restore.js,restore.css}`, `src/ui/deanon/{index,dom}.js`, `src/ui/i18n/{restore,help}.js`, `tests/unit/{deanon-spans,deanon-morph,restore-doc}.spec.js`, `tests/unit/ui/restore-model.spec.js`, `tests/integration/{host,schemas}.spec.js`, `tests/unit/protocol.spec.js`, `tests/e2e/restore.spec.js`.

**Сделать:** `deanonymizeSpans` (координаты входа) и `deanonymize` поверх него (фикстуры 30 + 51 без изменений); `restoreDocx` — обратная замена во всех потоках DOCX с сохранением форматирования (`keepMetadata:true`), склонение в live/deleted, обратное отображение `rel-target`; страница восстановления: режим «Файл от ИИ» (`.docx/.docm/.md/.txt`), карта из файла или по `GET_MAPPING`, скачивание `имя.restored.*`; `?docId=` предвыбирает сессию.

**Приёмка:** К10, К14, К13.

**Статус:** выполнено, коммиты `d691fff` (восстановление файла, `GET_MAPPING`, `?docId=`; протокол и схема — в общем коммите `64bdb9f`) и `e76285a` (доработка по ревью). `deanonymizeSpans`/`findUnresolved` (фикстуры 30 + 51 без изменений), `restoreDocx`/`restoreText`, `GET_MAPPING`/`MAPPING`, режим «Файл от ИИ» и `?docId=` на странице восстановления; тесты `deanon-spans`, `restore-doc` (в т.ч. круговой прогон образца), `restore-model`, `host`/`schemas`/`protocol`, e2e `restore.spec.js` (+3).
Доработка по ревью: склонение «в лице генерального директора [ФИО_n]» → родительный (FR-37: окно до 6 слов / 64 символов, мостики — обращения и основы должностей из `POSITION_RE_SRC`; «по доверенности» и «в отношении» — по-прежнему именительный); строгое распознавание меток в файлах (`strict`, FR-36а: «Счет 1», «Договор 1» из текста документа не заменяются), текст — либерально; предупреждение о метке с несколькими значениями (`mixedValueWarnings`); сброс результата для скачивания при смене файла, карты, источника, обработки или флажка склонения; `ERROR.reason` (`NO_MAPPING`/`NO_SESSION`) и сообщения `session_missing`/`session_gone`; имя результата снимает пользовательский суффикс, `.anon` и хвост ` (n)`.
**Известное ограничение (отложено, бэклог):** паспорт с 0.2 хранит под одной меткой `[ПАСПОРТ_n]` серию/номер, а орган выдачи и код подразделения — в `variants`; при восстановлении все три места получают серию и номер (сейчас — только предупреждение в сводке). Правильное решение — отдельные метки для частей паспорта в анонимизаторе (детектор и `core/mapping.js`), следующая версия.

## WP10-C — модель в полном архиве, автоустановка, онбординг

**Файлы:** `scripts/{build,pack}.mjs`, `src/shared/bundled-model.js`, `src/background/{bundled-model,index,router}.js`, `src/offscreen/{package-fetch,host,worker}.js`, `eslint.config.js` (override для `package-fetch.js`), `src/core/settings.js` (`bundledModelSha`), `src/options/{options,config-io}.js`, `src/popup/**`, `src/content/flow.js`, `src/ui/panel/panel.js`, `src/ui/i18n/{options,popup,panel,help}.js`, `src/shared/protocol.js`, `schemas/protocol.schema.json`, `tests/unit/{bundled-model,router,settings}.spec.js`, `tests/unit/background/bundled-model.spec.js`, `tests/integration/{host,schemas,pack,manifest}.spec.js`, `tests/e2e/{fixtures.js,helpers/network.js,bundled-model,options,chat,model-pack,ner}.spec.js`.

**Сделать:** `build.mjs --with-model=<zip>` (define `__BUNDLED_MODEL__`, `models/index.json`, только пакеты из `KNOWN_PACKS`); `pack.mjs` → лёгкий и полный архивы; при `onInstalled`/`onStartup` background по `planBootstrap` поднимает offscreen и шлёт `MODEL_INSTALL`, worker читает zip из собственного пакета (`chrome-extension://`) и ставит в OPFS, ответ `MODEL_INSTALLED` пишет `nerModel`/`bundledModelSha`; `MODEL_BOOTSTRAP` для кнопки «Восстановить встроенную модель»; онбординг в настройках/popup/панели для лёгкой сборки.

**Приёмка:** К15, К16, К17 (модель), К13.

**Статус:** выполнено, коммиты `f75399f` (сборка с моделью, два архива, автоустановка, онбординг; общие файлы `build.mjs`, `host.js`, `worker.js`, `settings.js`, `protocol.js`, `options.js`, `flow.js`, `panel.js` — в `64bdb9f`) и `53b59ba` (доработка по ревью). `build.mjs --with-model`, `pack.mjs` → лёгкий (побайтно прежний) и `-full.zip`; `bundledModelSha`
(не экспортируется); `shared/bundled-model.js` (`planBootstrap`, `settingsPatchFor`), `background/bundled-model.js` (onInstalled + миграция, onStartup,
ответ хоста), `MODEL_BOOTSTRAP`/`MODEL_INSTALL`/`MODEL_INSTALLED`, `offscreen/package-fetch.js` (единственный `fetch`, override ESLint); онбординг в настройках,
popup и панели. Тесты: `tests/unit/{bundled-model,background/bundled-model,router,settings,protocol}.spec.js`, `tests/integration/{host,schemas,pack,manifest}.spec.js`,
e2e `bundled-model.spec.js` (полная сборка, гейт), `options.spec.js`, `intercept.spec.js`. Замер e2e: автоустановка `MODEL_INSTALLED.ms` 804 мс, `nerModel` ≈ 1,2 с
после старта. Архивы: лёгкий ≈ 6,1 МБ, полный ≈ 34 МБ (точные значения печатает `npm run pack`; `docs/contracts.md` §6.8).
Доработка по ревью: `bundledModelError` (код неудачной автоустановки, не экспортируется) → карточка «Не удалось установить встроенную модель ({код})» с
`ner-retry` «Повторить» и включённым импортом, тайм-аут ожидания 60 с (`TIMEOUT`), popup — ссылка вместо «устанавливается»; «Сбросить настройки» сохраняет
`nerModel`/`bundledModelSha`/`bundledModelError`; `readPackageFile` — только `/models/<имя>.zip` (обход пути, учётные данные, `blob:` — отказ); `force`
не теряется при объединении прогонов; router отвечает `ERROR` на клиентские `MODEL_INSTALL`/`MODEL_INSTALLED`; подсказка в панели — только лёгкая сборка;
e2e: снимок записи сети после автоустановки, сброс настроек, сценарий с испорченным zip; `pdfjs-dist` — точная версия.

## WP10-D — меню «Ещё» и подсказка о ключе восстановления

**Файлы:** `src/ui/panel/{panel,done-hint,styles}.js`, `src/ui/i18n/panel.js`, `src/content/flow.js`, `src/core/settings.js` (`hintMappingShown`), `src/options/config-io.js`, `tests/unit/ui/done-hint.spec.js`, `tests/e2e/intercept.spec.js`, `tests/e2e/helpers/chat.js`.

**Сделать:** кнопка «Скачать маппинг» переезжает в меню «Ещё ▾» как «Сохранить ключ восстановления» (testid сохранён); при закрытии done-экрана без сохранения — одноразовая подсказка с кнопками «Сохранить»/«Понятно», флаг `hintMappingShown` в настройках (не экспортируется).

**Приёмка:** К16 (меню и подсказка), К13.

**Статус:** выполнено, коммит `d691fff` (`hintMappingShown` и `content/flow.js` — в общем коммите `64bdb9f`); доработка «×»/Esc по ревью — `e76285a`. `hintMappingShown` (не экспортируется), `done-hint.js`, меню «Ещё ▾» с `btn-download-mapping`, подсказка `mapping-hint`, флаг из `content/flow.js`; тесты `done-hint`, `settings`, e2e `intercept.spec.js` (+2), контракт DOM в `tests/e2e/helpers/chat.js`. Доработка по ревью: «×» и Esc на экране «готово» идут через `closeDone()` (подсказка не обходится), Esc в открытом меню возвращает фокус на «Ещё ▾»; e2e `intercept.spec.js` (+2).

---

## Бэклог после 0.3

Версия 0.3.0 завершена (WP10-A…D выполнены, критерии К1–К17 `docs/concept-0.3.md`). Отложено:

- **Словари ФИО — в `vendor/dict/*.txt`** с ленивой загрузкой через `offscreen/package-fetch.js`: освободит ≈ 360 КБ `worker.js` (бюджет словарей — §6.5 `docs/contracts.md`) и время старта воркера.
- **Отдельные метки для частей паспорта** (серия и номер, орган выдачи, код подразделения) в детекторе и `core/mapping.js`: сейчас все три места под одной `[ПАСПОРТ_n]`
  и при восстановлении получают серию и номер (страница восстановления предупреждает, WP10-B).
- **Таблица, разорванная границей страницы** (по 1–2 строки на странице) в PDF собирается в одну; сейчас такая часть может уйти абзацем (WP10-A).
- **Ответ ИИ в `.xlsx`/`.pptx`** — восстановление файлов этих форматов (`docs/concept-0.3.md`, «Что не делаем в 0.3»).
- **Склонение после «индивидуального предпринимателя»** при восстановлении: мостики `BRIDGE` в `core/deanon-morph.js` повторяют основы `POSITION_RE_SRC` вручную,
  но без «индивидуальн…/предпринимател…» — «в лице индивидуального предпринимателя [ФИО_1]» сейчас даёт именительный (FR-37). Найдено при сверке документации.
- Сканы и OCR, «PDF → PDF», формы PDF — по `docs/concept-0.3.md`; публикация в Chrome Web Store — решение владельца.
