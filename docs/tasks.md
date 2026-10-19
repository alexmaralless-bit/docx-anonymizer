# Рабочие пакеты

Пакеты WP1–WP5 — MVP (версия 0.1). Пакеты WP6–WP9 — версия 0.2 (`docs/concept-0.2.md`). Пакеты WP10-A…D — версия 0.3 (`docs/concept-0.3.md`). Пакеты WP11-A…C — версия 0.4 (`docs/concept-0.4.md`).

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
В 0.4 (волна 0, координатор) изменены `src/core/{categories,settings}.js` (группы категорий, схема 3), `src/core/contracts/entity.js` и `schemas/protocol.schema.json`
(источник `list`), `src/core/detect/runner.js` (гейт `user`/`list`, порог ORG, вызов `core/ner/filters.js`), `src/core/docx/model.js` и `src/core/text/model.js`
(`paragraph.kind`), `src/options/config-io.js` — см. `docs/contracts.md` §8. Пакетам WP11 эти файлы менять не нужно; нужна правка — через координатора.

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

**Статус:** закоммичено `64bdb9f`. pdf.js 6.4 — **legacy-сборка** в `vendor/pdfjs/` (современная требует API новее Chrome 132), вложенный воркер через `PDFWorker({port})`; `core/pdf/{layout,extract}.js`, `core/text/{model,serialize}.js`, `planEdits` + сериализатор по `doc.kind`, хук `doc.tables` в `kb.js`, `pdfMode`, стадия `pdf`, коды `PDF_*`, `RESULT_BEGIN.mime`, `ENTITIES.kind`; 13 PDF-фикстур (10 текстовых со снимками и gold). Факт: К2 — 0 утечек детекторами на 10 фикстурах; К3 — паритет с DOCX (перемер на финальной приёмке 0.3, 12 фикстур с DOCX-исходником): все категории 1.0, кроме EMAIL 21/22 (пропуск — `sample-contract.lo`, 28/29), «дикие» без DOCX — gold 17/17; К4 — порядок абзацев 100 % на 10 фикстурах с проверкой порядка (`structures.lo` и `sample-contract.lo` вне проверки: исправления и сноски LibreOffice в теле), `perf-50p` — 446/446 блоков в порядке исходного текста генератора, строк `pdftotext` 2046/2046 (до финальной приёмки 2023/2046: эвристика колонтитулов удаляла строки тела), колонтитулы вынесены, таблица реквизитов `ip-contract` 8 × 2 и в Chromium, и в LibreOffice; К6 — `perf-50p` (48 стр.) ≈ 0,45 с в Node, 0,36 с в Chromium, холодный PDF с загрузкой pdf.js 0,2 с; К8 — `vendor/pdfjs/` 3,6 МБ, лёгкий архив 6,1 МБ; `worker.js` без ORT 706 952 байт (≤ 700 КБ). Архивы на `64bdb9f`: лёгкий 6 425 902 байт (sha256 `c1980132…a6411`), полный 35 944 673 байт. Спайки S1–S4 — `docs/contracts.md` §7.6. Тест восстановления по карте PDF-сессии (К10) — в `tests/e2e/pdf.spec.js` (файл `restore.spec.js` — зона WP10-B).

Доработка по ревью (19.10.2026) — коммит `68d9c73`: мягкий перенос в номерах («ИНН 7805-» + «003215» → без дефиса при группе ≥ 4 цифр, телефоны
не трогаются) и знак переноса U+2010/U+00AD всегда, «Ан-» + «дреева» (Д1, Д2); моноширинный шрифт — пробел не режет ячейку «БИК 044525901» (Д3); узкая
надпись LibreOffice — один абзац по локальному правому краю (Д4); повёрнутое содержимое (`/Rotate` + `cm`) — через матрицу viewport и `orientPage`,
страница из одних водяных знаков → `PDF_NO_TEXT`/`PDF_PAGES_NO_TEXT` (Д5); колонки таблицы по правому краю для чисел (Д6); заголовок после двух колонок —
граница участка (Д7); отделённая крайняя строка полосы обычного кегля — колонтитул и на одной странице (Д8); заметка панели с расширением `{ext}` по `pdfMode`
(Д9); `TOO_LARGE` с `details.pages` → `err.TOO_LARGE_PAGES` (Д10); «;» на границе страницы/колонки перед строчной — не конец абзаца (Д12); кнопка
«Загрузить» (`btnUpload`), когда все файлы «как есть». Фикстуры: `wild-mono`, `wild-landscape`, `wild-2col`, `rotated`, `structures.lo`,
`sample-contract.lo` (16 текстовых); К2 — 0 утечек целиком и частично (фамилии gold-ФИО, номера с дефисом/пробелом внутри), К3 ≥ 95 % на каждой.
Бюджет `worker.js` разделён (§6.5 `docs/contracts.md`): код без ORT и словарей ≈ 351 КБ (≤ 400 КБ), словари ФИО ≈ 365 КБ (≤ 400 КБ); точные значения печатает сборка.
Это разрешённое изменение ожидания теста 0.2 (`pack.spec.js`: прежде «без ORT ≤ 700 КБ», NFR-10) — К11 `docs/concept-0.3.md`, п. (б).
Доработка по финальной приёмке 0.3: колонтитул по повтору — только крайние строки полосы, не заголовок, не пункт с нумерацией, без реквизита с номером
(«ИНН 7701…») и не продолжение абзаца (`stripRepeating`); на `perf-50p` вернулись 13 строк «обязательств по настоящему договору.», строки «(ИНН …), который
согласует…» и заголовки разделов 13, 26, 39 (снимок `perf-50p.txt`; остальные снимки не изменились); К4-проверки `perf-50p` в `pdf-pipeline.spec.js`.

Бэклог — в разделе «Бэклог после 0.3» в конце файла.

## WP10-B — восстановление файла от ИИ

**Файлы:** `src/core/{deanon,deanon-morph,restore-doc,index}.js`, `src/shared/protocol.js` (`GET_MAPPING`/`MAPPING`), `schemas/protocol.schema.json`, `src/offscreen/host.js`, `src/restore/{restore.js,restore.css}`, `src/ui/deanon/{index,dom}.js`, `src/ui/i18n/{restore,help}.js`, `tests/unit/{deanon-spans,deanon-morph,restore-doc}.spec.js`, `tests/unit/ui/restore-model.spec.js`, `tests/integration/{host,schemas}.spec.js`, `tests/unit/protocol.spec.js`, `tests/e2e/restore.spec.js`.

**Сделать:** `deanonymizeSpans` (координаты входа) и `deanonymize` поверх него (фикстуры 30 + 51 без изменений); `restoreDocx` — обратная замена во всех потоках DOCX с сохранением форматирования (`keepMetadata:true`), склонение в live/deleted, обратное отображение `rel-target`; страница восстановления: режим «Файл от ИИ» (`.docx/.docm/.md/.txt`), карта из файла или по `GET_MAPPING`, скачивание `имя.restored.*`; `?docId=` предвыбирает сессию.

**Приёмка:** К10, К14, К13.

**Статус:** выполнено, коммиты `d691fff` (восстановление файла, `GET_MAPPING`, `?docId=`; протокол и схема — в общем коммите `64bdb9f`) и `e76285a` (доработка по ревью). `deanonymizeSpans`/`findUnresolved` (фикстуры 30 + 51 без изменений), `restoreDocx`/`restoreText`, `GET_MAPPING`/`MAPPING`, режим «Файл от ИИ» и `?docId=` на странице восстановления; тесты `deanon-spans`, `restore-doc` (в т.ч. круговой прогон образца), `restore-model`, `host`/`schemas`/`protocol`, e2e `restore.spec.js` (+3).
Доработка по ревью: склонение «в лице генерального директора [ФИО_n]» → родительный (FR-37: окно до 6 слов / 64 символов — разрешённое изменение ожидания теста 0.2 `deanon-morph.spec.js` (было 3 слова), К11 `docs/concept-0.3.md`, п. (а); мостики — обращения и основы должностей из `POSITION_RE_SRC`; «по доверенности» и «в отношении» — по-прежнему именительный); строгое распознавание меток в файлах (`strict`, FR-36а: «Счет 1», «Договор 1» из текста документа не заменяются), текст — либерально; предупреждение о метке с несколькими значениями (`mixedValueWarnings`); сброс результата для скачивания при смене файла, карты, источника, обработки или флажка склонения; `ERROR.reason` (`NO_MAPPING`/`NO_SESSION`) и сообщения `session_missing`/`session_gone`; имя результата снимает пользовательский суффикс, `.anon` и хвост ` (n)`.
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
Доработка по финальной приёмке 0.3: снимок после автоустановки в 2 из 5 прогонов не содержал чтения zip (запись подключалась после старта расширения) —
опция фикстуры `earlyCapture`: запись подключается к CDP до загрузки расширения (`Extensions.loadUnpacked`), жёсткая проверка `models/<zip>` и
`offscreen/*` в снимке сохранена; `--repeat-each=5` — 5/5 (`docs/contracts.md` §6.8).

## WP10-D — меню «Ещё» и подсказка о ключе восстановления

**Файлы:** `src/ui/panel/{panel,done-hint,styles}.js`, `src/ui/i18n/panel.js`, `src/content/flow.js`, `src/core/settings.js` (`hintMappingShown`), `src/options/config-io.js`, `tests/unit/ui/done-hint.spec.js`, `tests/e2e/intercept.spec.js`, `tests/e2e/helpers/chat.js`.

**Сделать:** кнопка «Скачать маппинг» переезжает в меню «Ещё ▾» как «Сохранить ключ восстановления» (testid сохранён); при закрытии done-экрана без сохранения — одноразовая подсказка с кнопками «Сохранить»/«Понятно», флаг `hintMappingShown` в настройках (не экспортируется).

**Приёмка:** К16 (меню и подсказка), К13.

**Статус:** выполнено, коммит `d691fff` (`hintMappingShown` и `content/flow.js` — в общем коммите `64bdb9f`); доработка «×»/Esc по ревью — `e76285a`. `hintMappingShown` (не экспортируется), `done-hint.js`, меню «Ещё ▾» с `btn-download-mapping`, подсказка `mapping-hint`, флаг из `content/flow.js`; тесты `done-hint`, `settings`, e2e `intercept.spec.js` (+2), контракт DOM в `tests/e2e/helpers/chat.js`. Доработка по ревью: «×» и Esc на экране «готово» идут через `closeDone()` (подсказка не обходится), Esc в открытом меню возвращает фокус на «Ещё ▾»; e2e `intercept.spec.js` (+2).

---

## WP11-A — политика маскирования, список компаний, панель и настройки (версия 0.4)

**Файлы.** Новые: `src/core/detect/names/company-list.js`, `tests/unit/names/company-list.spec.js`, `tests/unit/ui/org-policy-hint.spec.js`.
Изменяемые: `src/core/detect/names/{index,kb,company,lexicon}.js`, `src/ui/preview/{preview,model}.js`, `src/ui/panel/{panel,styles}.js`, `src/content/flow.js`,
`src/options/options.js`, `src/ui/i18n/{options,panel,preview,help}.js`, `src/help/help.js`, `tests/unit/{settings,help-dict}.spec.js`,
`tests/unit/names/{kb,sample,person-dict,categories}.spec.js`, `tests/integration/{fixtures-detectors,sample,fixtures-docs,host,pdf-pipeline}.spec.js`,
`tests/e2e/{options,intercept,pdf}.spec.js`, `tests/e2e/helpers/chat.js`, gold `ip-contract` (`scripts/gen-fixtures.mjs`, `tests/fixtures/docs/*`), этот раздел.
Не трогать: файлы волны 0 (см. выше), `src/core/ner/**`, `scripts/gen-genre-fixtures.mjs`, `scripts/eval-genres.mjs` (WP11-B).

**Сделать** (`docs/contracts.md` §8, план D3, D5, D6, D10, D11):
1. **ИП — человек** (решение владельца 1): «ИП Фамилия И.О.» и «Индивидуальный предприниматель Фамилия Имя Отчество» всегда дают PERSON с `keepPrefix` на форму
   («ИП », «Индивидуальный предприниматель »); `canonical` — запись персоны, чтобы «Иванов И.И.» дальше по тексту получил ту же метку. COMPANY для ИП не порождается
   ни в одном режиме. В коммерческом режиме при выключенной COMPANY (`commercial: false`) `kb.js` не порождает компании и **не занимает** их спаны (персоны рядом не теряются).
2. **Правило «Студия/Агентство/Бюро/Компания/Группа компаний/Холдинг + Название»** (1–3 слова с заглавной) → COMPANY `labeled`, `keepPrefix` = родовое слово; только при включённой COMPANY.
3. **Детектор списка** `company-list.js` (§8.2): регистрируется в `names/index.js` после `kb`; ядро названия без ОПФ/кавычек (regex-ы `lexicon.js`); поиск во всех потоках
   (кроме container-сегментов): точное слово без учёта регистра; русская морфология (кириллическое слово ≥ 5 букв → основа без последней гласной группы + хвост `[а-яё]{0,3}`;
   слова ≤ 4 букв и латиница — точно); границы слова как `glued()` в `person-dict.js`; кросс-скрипт через `crossScriptMatch` при `skeletonWeight ≥ 3`; ОПФ-префикс и кавычки
   в `keepPrefix`/`keepSuffix` как в `company.js`; `aliases` — как ещё одно название. Выход `category: 'COMPANY', source: 'list', confidence: 'labeled', canonical: name`.
   Работает при `commercial: false`. `exclusions` применяются после (в `ignoreForever` для `source: 'list'` кладётся canonical).
4. **Панель и превью**: подпись источника `list` («из списка»); в строке COMPANY (коммерческий режим, `source ≠ list`) кнопка «Маскировать всегда» (`pv-mask-always`)
   → `api.maskAlways(item)` → `saveSettingsPatch({maskedCompanies: [...cur, {name: item.value, aliases: []}]})` + тост; вкладка «Текст», «Анонимизировать как»:
   при выборе COMPANY флажок «запомнить» (`pv-sel-remember`) — то же сохранение перед `ADD_ENTITY`. Одноразовая подсказка `org-policy-hint` в `setReady`
   (как `ner-hint`: «×» `org-policy-hint-close`, ссылка на `options.html#categories`), показывается при `settings.orgPolicyHintPending`; при показе
   `onOrgPolicyHintShown` → `saveSettingsPatch({orgPolicyHintPending: false})`.
5. **Настройки**: раздел «Что маскируется» (`#categories`): блоки «Персональные данные — всегда» и «Идентификаторы — всегда» (чипы без переключателей, состав из
   `CATEGORY_GROUPS`), «Коммерческая информация» — переключатель `commercial` (testid `commercial`) + прежние `cat-COMPANY|CONTRACT|AMOUNT` внутри (активны всегда,
   действуют при включённой группе). Новый раздел «Компании для маскирования» (`#companies`, после categories, в nav): `company-name`, `company-add`, список `.chips`
   с «×», поле псевдонимов `company-aliases-<i>`, предупреждение `company-short` (название < 4 символов или из `COMMON_NOUNS`), `companies-export`/`companies-import`
   (JSON `{kind: 'docx-anonymizer-companies', version: 1, companies: […]}`). Раздел NER: поле `ner-threshold-org`, textarea `ner-stoplist` (строки → массив).
   Справка ru/en: раздел о политике (сохранить слова, которые пинят `help-dict.spec`/`ner-i18n.spec`).
6. **Тесты 0.3 с изменёнными ожиданиями** — перечислить здесь (К11): какие, почему (COMPANY по умолчанию не ищется; ИП → PERSON).

**Приёмка** (К1, К2 часть правил, К3, К11, К13 часть):

| Проверка | Как |
|---|---|
| pii/ids нельзя выключить; миграция 2 → 3 чинит профили; `commercial` по умолчанию `false`; экспорт/импорт сохраняет `commercial` и `maskedCompanies` | `tests/unit/{settings,categories}.spec.js` (есть с волны 0, дополнить экспортом/импортом) |
| «Ромашка» → «Ромашки», «Ромашке», «Ромашкой»; «ООО «Ромашка»», без ОПФ, «Romashka», «Ромашка-Трейд», alias; одна метка; `exclusions` снимает; 3-буквенное название — точное слово; «Ромашкаус» не совпадает; DOCX и PDF (`fromText`) | `tests/unit/names/company-list.spec.js` |
| «ИП Иванов И.И.» → PERSON (`keepPrefix 3`), «Иванов И.И.» далее — та же метка; при `commercial: false` «ООО «Ромашка»» не находится, «Петров П.П.» рядом — находится | `tests/unit/names/kb.spec.js` |
| Обычный режим на всех фикстурах договоров: ноль утечек pii/ids, ноль COMPANY кроме списка; коммерческий — все gold-организации 0.3 найдены | `tests/integration/{fixtures-detectors,pdf-pipeline}.spec.js` в двух режимах |
| Настройки: блоки «всегда» без переключателей; `commercial` показывает `cat-*`; добавление/удаление компании; экспорт/импорт списка | e2e `options.spec.js` |
| Документ с «ООО «Ромашка»» при `maskedCompanies: [{name: 'Ромашка'}]`, `commercial: false` → строка COMPANY `list`; при `commercial: true` «Маскировать всегда» пишет запись в storage; подсказка по политике показана один раз | e2e `intercept.spec.js` |
| gold PDF-фикстур с `commercial: true` | e2e `pdf.spec.js` |
| `npm run lint`, `npm test`, `npm run e2e` зелёные | запуск |

**Статус:** выполнено (ждёт ревью и коммита координатора). Новое: `names/company-list.js` (детектор списка, регистрация после `kb`),
правило «родовое слово + название» и `companyCore` в `company.js`, `GENERIC_ORG_RE_SRC` в `lexicon.js`; `kb.js` — ИП как PERSON, без компаний
и их спанов при выключенной COMPANY, название правил из списка — `source: 'list'`; панель/превью — «из списка», `pv-mask-always`, `pv-sel-remember`,
`org-policy-hint`; настройки — «Что маскируется» (`group-pii|ids|commercial`, `commercial`), «Компании для маскирования» (`#companies`),
`ner-threshold-org`, `ner-stoplist`; справка — раздел `policy_1…4`. Вспомогательные модули: `src/options/companies-io.js` (файл списка,
слияние, `company-short`), `src/ui/panel/org-policy.js` (подсказка, пополнение списка).

Уточнения к §8.2 (приняты при реализации):
- хвост после основы — не произвольные `[а-яё]{0,3}`, а падежные окончания существительных и прилагательных до 3 букв (иначе «Ромашкаус» = «Ромашк» + «аус»);
  у слова на согласную основа — всё слово («Вектор» → «Вектора», но не «Вектра»); в названии из нескольких слов короткое (3–4 буквы) кириллическое слово
  тоже склоняется («Цветочного дома», «Лунного света»), одиночное короткое название — только точно;
- `canonical` — ядро названия записи (без ОПФ и кавычек), а не `name` как введено: «ООО «Ромашка»» в списке и «Ромашка» из правил коммерческого режима
  дают одну метку; ⊘ у строки из списка кладёт в `exclusions` нормализованный canonical;
- название из списка с заглавной не ищется в строчном написании («ромашка» в тексте); составное через дефис («Ромашка-Трейд») — не «Ромашка».
- ~~одиночное название из `COMMON_NOUNS` в начале предложения не ищется~~ — отменено координатором по повторному ревью: давало частичную утечку компании из
  списка («Поставщик: Ромашка», «1. Ромашка …», ячейка «Ромашка»). Название из списка маскируется везде; риск общих слов закрывает предупреждение `company-short`.

Доработка по ревью (20.10.2026):
- правило «родовое слово + название»: строчное родовое слово — только перед кавычками («агентство «Вектор»»), без кавычек — только с заглавной
  («Студия Ромашка»); ядро с инициалом или с инициалами сразу после — не название («Бюро Иванова И.И.»); название по родовому слову не отбирает
  спан у лица, найденного правилами или словарём (`kb.js`); латинское ядро не обрывается на «&»/«and» («Агентство Smith & Co»). Лица в
  «В компании Петрова П.П.», «директор компании Сидоров Иван Петрович», «студия Артемия Лебедева» — как в 0.3 (`kb.spec.js`);
- бренд владельца (решение 6): `NEVER_MASK_ORGS` / `isNeverMaskOrg` в `lexicon.js` (Sitimlab, Ситимлаб в любом падеже) — правила `company.js`,
  варианты `kb.js`, детектор списка (запись с брендом не ищется; в настройках предупреждение `company-brand`) и стоп-список NER
  (`core/ner/stoplist.js` импортирует общий список — правка в зоне WP11-B с разрешения координатора);
- ссылка «Открыть настройки» (`org-policy-hint-open`) в подсказке: новое сообщение `MSG.OPEN_OPTIONS {section}` (`src/shared/protocol.js`,
  `OPTIONS_SECTIONS`, `schemas/protocol.schema.json`, `src/background/router.js` → `chrome.tabs.create(options.html#<section>)` + `ACK`;
  `docs/contracts.md` §4) — с разрешения координатора;
- кнопка «Маскировать всегда» есть и у строки COMPANY с `source: 'user'` в обычном режиме (компания, добавленная вручную на вкладке «Текст»,
  может быть запомнена) — осознанное расширение п. 4, принято координатором.

Тесты 0.3 с изменёнными ожиданиями (К11):

| Тест / фикстура | Было | Стало | Почему |
|---|---|---|---|
| `tests/unit/names/kb.spec.js` «ИП Иванов И.И.» | COMPANY «ИП Иванов И.И.», `keepPrefix 3` (коммерческий режим) | PERSON с `keepPrefix 3` в обоих режимах; «Иванов И.И.» в другом абзаце — та же группа | решение владельца 1: ИП — имя человека |
| `tests/fixtures/categories/COMPANY.json` | позитивы «ИП Иванов И.И.», «Индивидуальный предприниматель Петров Пётр Петрович» | перенесены в `PERSON.json` с теми же `expect`/`cores` (COMPANY: 14 позитивов) | то же |
| `tests/fixtures/overlap.json` «ФИО внутри «ИП Иванов Иван Иванович»» | COMPANY целиком | PERSON целиком (форма «ИП » в keepPrefix) | то же |
| gold `ip-contract` (`scripts/gen-fixtures.mjs`, `tests/fixtures/docs/*`, `tests/fixtures/pdf/ip-contract*.gold.json`) | — | без изменений: ИП в gold и раньше был PERSON (`ipPerson`, `ipShort`), COMPANY в gold — только «Лунный свет»; фикстуры не перегенерировались | — |

Остальные тесты 0.3 проходят без изменения ожиданий; новые проверки обычного режима и списка — в `fixtures-detectors.spec.js`, `pdf-pipeline.spec.js`,
`company-list.spec.js`, `kb.spec.js`, `person-dict.spec.js`, `settings.spec.js`, `help-dict.spec.js`, `ui/org-policy-hint.spec.js`, e2e `options.spec.js` (+3)
и `intercept.spec.js` (+4).

---

## WP11-B — корпус жанров, отчёт, фильтры модельных организаций (версия 0.4)

**Файлы.** Новые: `scripts/gen-genre-fixtures.mjs`, `scripts/eval-genres.mjs`, `tests/fixtures/genres/**`, `tests/integration/genres.spec.js`,
`src/core/ner/stoplist.js`, `tests/unit/ner/filters.spec.js`. Изменяемые: `src/core/ner/filters.js` (наполнение заглушки волны 0), `scripts/gen-pdf-fixtures.mjs`
(экспорт `htmlToPdf`/`htmlPage`), `package.json` (скрипты `gen-genre-fixtures`, `eval-genres`), `tests/integration/ner-provider.spec.js`, этот раздел.
Не трогать: `src/options/**`, `src/ui/**`, `src/content/**`, `src/core/detect/**` (WP11-A); `src/core/detect/runner.js` — только через координатора.

**Сделать** (`docs/contracts.md` §8.3–8.4, план D7, D8):
1. `filters.js`: `createOrgFilterContext(doc, settings)` (частоты слов, множество капс-строк, стоп-список = `stoplist.js` ∪ `settings.nerStoplist`),
   `filterOrgSpans(spans, {text, blockKind, …ctx})`: отбросить ORG, если (1) спан = весь поток, поток ≤ 3 слов, без ОПФ/кавычек, и `blockKind ∈ {h1, h2, li, cell, heading}`
   или текст капсом / оканчивается на «:»; (2) спан целиком в стоп-списке; (3) одно слово без ОПФ, встречающееся в документе только в капс-строках. Сохранять: ОПФ + кавычки,
   названия внутри предложения («Ромашка-Трейд»), «Студия Ромашка». `stoplist.js`: аббревиатуры (ЭДО, ВЭД, УПД, ТЗ, ФИО, КП, НДС, MVP, API, CRM, ERP, SaaS, KPI, QR, PDF, DOCX…),
   продукты (Word, Excel, PowerPoint, Outlook, Teams, Telegram, WhatsApp, Zoom, Google, Яндекс, 1С, Bitrix24…).
2. `gen-genre-fixtures.mjs` → `tests/fixtures/genres/<genre>/<name>.{docx,pdf,gold.json}` + `<name>.pdf.txt` (снимок разметки, как `tests/fixtures/pdf`). Жанры:
   `proposal` (КП), `letter`, `invoice` (счёт + УПД), `reconciliation` (акт сверки), `manual` (регламент), `deck` (презентация, только PDF), `resume`, `chat` (переписка);
   `letter` и `resume` дополнительно en. ≥ 3 документа на жанр; PRNG mulberry32 с фиксированным сидом (как `gen-ner-eval.mjs`); вымышленные словари; переиспользовать
   `make-sample.mjs`, `gen-fixtures.mjs` (`pack/tbl/cell/title`), `gen-pdf-fixtures.mjs` (`documentToHtml`, Chromium). Gold `{entities: [{key, category, value}], negatives: [{value, category}]}`:
   `negatives` — заголовки капсом, аббревиатуры, продукты, бренд «Студия <Бренд>», которые не должны стать COMPANY/PERSON. Синтетический аналог КП Sitimlab в `proposal/`
   (обложка капсом, нумерованные разделы «05 Цены», таблица цен, ЭДО/ВЭД/УПД/MVP, Word/Excel, реквизиты с ИНН/КПП/счётом).
3. `eval-genres.mjs` (`npm run eval-genres [--model=<dir>] [--json] [--private]`): по жанру × категории × режиму (`normal`/`commercial`) — точность, полнота, число ложных;
   с моделью при `NER_MODEL_DIR` (загрузчик из `bench-ner.mjs`); использует `tests/integration/support/pipeline.js`. `tests/fixtures/private/` (gitignored) — гейт `PRIVATE_FIXTURES=1`,
   файлы `*.pdf|*.docx` + необязательный `*.gold.json`; в выводе — только счётчики по категориям, без значений.

**Приёмка** (К2 часть, К4 синтетика, К5, К7 часть правил, К10, К12 часть):

| Проверка | Как |
|---|---|
| К10: капс-заголовок, строка списка 1–3 слов, аббревиатура из стоп-списка, ячейка без ОПФ — отброшены; «ООО «Ромашка»», «Ромашка-Трейд» в предложении, «Студия Ромашка» — сохранены; `nerStoplist` работает; `blockKind` из PDF `h1` и DOCX `Heading1` достигает фильтра | `tests/unit/ner/filters.spec.js` (+ интеграционно через `fromText`/`parseDocx` и стаб-провайдер в `analyze`) |
| К5: 8 жанров × ≥ 3 документа, ru + en для `letter`/`resume`, DOCX и PDF; детерминизм (двойная генерация → те же DOCX-байты и `.pdf.txt`) | `tests/integration/genres.spec.js` |
| Обычный режим: ноль утечек pii/ids, ноль COMPANY, `negatives` не найдены ни в одной категории; коммерческий без модели: полнота организаций с ОПФ ≥ 0,95, ложных COMPANY на `proposal` ≤ 2; при `NER_MODEL_DIR` — числа в отчёт (гейт К6/К7 для 1.1.0 включает WP11-C3) | `genres.spec.js`, `npm run eval-genres` |
| `PRIVATE_FIXTURES=1` прогоняет `private/` без падения, печатает счётчики без значений | `genres.spec.js` |
| `npm run lint`, `npm test`, `npm run e2e` (регрессия, под flock) зелёные | запуск |

**Статус:** выполнено (19.10.2026), доработка по ревью — 20.10.2026; не закоммичено — коммит координатора.

- **Фильтры** (`src/core/ner/{filters,stoplist}.js`, сигнатуры волны 0 сохранены). `createOrgFilterContext(doc, settings)` → `{stoplist, properStems, cellTexts}`:
  стоп-список (`stoplist.js` ∪ `settings.nerStoplist`; ключ `stopKey` — регистр, «ё», кириллица/латиница одного начертания: 1С = 1C; бренд владельца —
  `NEVER_MASK_ORGS` из `names/lexicon.js`, WP11-A), `properStems` — основы слов, написанных в обычном тексте (не капс, не заголовок) с заглавной не в начале
  предложения, `cellTexts` — тексты ячеек таблиц DOCX (у DOCX `kind` ячейки — `'p'`, раннер не передаёт pid). **Порядок проверки** `filterOrgSpans`
  (первое сработавшее решает):
  1. ОПФ в спане или вплотную к нему — **сохранить**;
  2. **(2)** стоп-список: спан целиком, каждым словом («Word и Excel»), слово целиком вокруг спана («Диск» из «Яндекс.Диск»); падежное окончание до 2 букв —
     только у кириллических слов («Яндексе»; «Canvas», «Zoomer», «Wordex» — не «Canva», «Zoom», «Word») — **отбросить**;
  3. кавычки или «Студия/Агентство/Бюро/Компания/Группа компаний/Холдинг + Название» — **сохранить**;
  4. **(2б)** часть спана из стоп-списка, остальные слова — не имена собственные документа («Настройка CRM») — отбросить;
  5. **(1)** спан — вся строка ≤ 3 слов (номер раздела и знаки допускаются: «05 Цены») в `h1|h2|li|cell|heading`, ячейке DOCX, капсом или с «:» в конце —
     отбросить, кроме названия, все слова которого в тексте документа — имена собственные («ВЕКТОР ПЛЮС» в шапке при «компания Вектор Плюс» в тексте);
  6. **(3)** капс-строка/заголовок, спан ≤ 8 слов, ни одно слово не имя собственное в тексте («ВХОДИТ», «АКТ СВЕРКИ ВЗАИМНЫХ РАСЧЁТОВ») — отбросить;
  7. **(4)** фраза: тире с пробелами в спане; слово со строчной буквы (кроме частиц «и», «of», «de»…), если спан — весь абзац, строка ≤ 5 слов без точки,
     заголовок, пункт или ячейка; в предложении — только спан, начинающийся со строчного слова («субъектов ПДн») или кончающийся служебным («Новый документ
     или») — отбросить. «Северная транспортная компания», «Уральский завод точных приборов», «Агентство недвижимости Ромашка» в предложении сохраняются;
  8. **(5)** обрывок кода: спан из ≤ 4 заглавных букв с цифрой внутри или вплотную («ПС» из «17/ПС-2026», «АБ-12»); «Ромашка» из «Ромашка-2000» и «Вектор»
     из «Исполнитель/Вектор» — не обрывки — отбросить;
  9. **(6)** адрес («45 King Street», «ул.», британский индекс) или должность в конце спана, если за ним не продолжается название с заглавной
     («Senior Data Analyst»; «Asset Manager Group» — нет) — отбросить;
  10. иначе — сохранить.

  Правила 2б, 4–6, исключение в (1) и до 8 слов в (3) — расширение §8.3 по прогону корпуса с моделью 1.0.0 и ревью. Тесты: `tests/unit/ner/filters.spec.js` (23).
- **Корпус** `npm run gen-genre-fixtures` → `tests/fixtures/genres/<жанр>/` (1,3 МБ): 26 документов — proposal 3 (`kp-lunopark` — аналог КП Sitimlab),
  letter 3 + en, invoice 3 (2 счёта + УПД от ИП), reconciliation 3, manual 3, deck 3 (только PDF, слайды 16:9), resume 3 + en, chat 3; 23 DOCX, 26 PDF
  со снимками `.pdf.txt`; gold `{entities: [{key, category, value, opf?, surname?, meta?}], negatives: [{value, category, mode?}]}`; `meta` — значение только
  в docProps (в PDF не ожидается), `surname` — для частичных утечек, `opf` — организация с ОПФ (`false` — «Студия Лунопарк», «Северная транспортная компания»,
  «Уральский завод точных приборов», «Агентство недвижимости Тихий Двор»). ИП — PERSON без «ИП». Корпус не подстраивается под недочёты: «ИНН/КПП
  покупателя: X/Y» в УПД, шапка письма одной строкой, таблица подписей акта сверки из двух строк, обращения одним именем в двух чатах.
  Телефоны — из невыдаваемых диапазонов (`+7 (999) 00x-xx-xx`, городские с «0» в начале местного номера; британские — диапазоны Ofcom для вымысла),
  карта — тестовый BIN 400000. Сид на документ (mulberry32 от имени). Экспорт для переиспользования: `pack/cell/tbl/title` (`gen-fixtures.mjs`),
  `htmlPage/htmlToPdf/documentXml` (`gen-pdf-fixtures.mjs`).
- **Отчёт** `npm run eval-genres [-- --model=<dir>] [--json] [--private] [--verbose] [--format=docx|pdf]` (`scripts/eval-genres.mjs`). Сравнение по
  (категория, нормализованное ядро); у COMPANY родовое слово отбрасывается («СТУДИЯ ЛУНОПАРК» ≡ «Лунопарк»). Утечки: значение целиком и частью — фамилия,
  номер ≥ 9 цифр, у адреса индекс или «д./кв./офис/оф./стр./корп. N» из gold, у почты «имя@начало домена». **CONTRACT и AMOUNT** в коммерческом режиме
  не измеряются (по умолчанию выключены внутри группы, в gold их нет). **Гейты К7** (точность ORG по жанрам, ложных на КП, полнота с ОПФ) перенесены из
  `ner-provider.spec.js` в `genres.spec.js`: пороги — константы, жёсткая проверка при `GENRES_MODEL_GATES=1` (WP11-C3), иначе печать чисел; так же гейт
  «ноль утечек в обычном режиме с моделью».
- **`KNOWN_GAPS`** (`tests/integration/genres.spec.js`; основные гейты исключают ровно эти ключи, `it.fails` проверяет, что недочёт ещё есть; WP11-D удаляет
  запись и снимает `it.fails`):

  | Документ | Формат | gold | Вид | Причина |
  |---|---|---|---|---|
  | `invoice/upd-ip` | DOCX, PDF | `e4` KPP | утечка | КПП в «ИНН/КПП покупателя: X/Y» не находится |
  | `chat/chat-sales` | DOCX, PDF | `e5` PERSON | утечка | обращение одним именем («Елена, спасибо…») |
  | `chat/chat-team` | DOCX, PDF | `e4` PERSON | утечка | обращение одним именем («Наталья, добрый день!») |
  | `letter/letter-schedule` | PDF | `e4` EMAIL | утечка | центрированная строка с переносом рвёт почту на два абзаца |
  | `reconciliation/reconciliation-ooo` | PDF | `e4`, `e6` PERSON | утечка | таблица подписей из двух строк не распознаётся, фамилия отделена от инициалов |
  | `letter/letter-schedule` | DOCX, PDF | `e7` PERSON | пропуск | «Уважаемый Павел Николаевич» — PERSON вместе с «Уважаемый» |
  | `letter/letter-reply` | DOCX, PDF | `e6` PERSON | пропуск | «Уважаемая Марина Павловна» — то же |
  | `invoice/upd-ip` | DOCX, PDF | INN `8471300000` | ложная | код ТН ВЭД проходит контрольную сумму ИНН |

- **Числа** (P/R/ложные, DOCX + PDF, 49 файлов; ≈ 1,3 с без модели, ≈ 4,7 с с моделью; «утечки» — все, включая `KNOWN_GAPS`):

  | Режим | Модель | PERSON | COMPANY | ADDRESS | утечки | из них частичных адресов | отриц. примеры | COMPANY в обычном |
  |---|---|---|---|---|---|---|---|---|
  | normal | нет | 0,97 / 0,93 / 4 | — | 1,00 / 1,00 / 0 | 9 (все из `KNOWN_GAPS`) | 0 | 0 | 0 |
  | commercial | нет | 0,97 / 0,93 / 4 | 1,00 / 0,93 / 0 (ОПФ R 1,00) | 1,00 / 1,00 / 0 | 9 | 0 | 0 | — |
  | normal | 1.0.0 | 0,87 / 0,96 / 19 | — | 0,37 / 1,00 / 66 | 3 (все из `KNOWN_GAPS`) | 0 | 55 | 0 |
  | commercial | 1.0.0 | 0,87 / 0,96 / 19 | 1,00 / 0,98 / 0 (ОПФ R 1,00; на КП 0 ложных) | 0,37 / 1,00 / 66 | 3 | 0 | 55 | — |

  Строки с моделью — после исправления пересечений координатором (`80bb49d`); до него: ADDRESS 0,21 / 0,63 / 90, утечек 17, из них частичных адресов 14.

  С моделью 1.0.0 (коммерческий): PERSON P по жанрам — proposal 1,00, letter 0,82, invoice 1,00, reconciliation 0,96, manual 0,71, deck 1,00, resume 0,80,
  chat 0,80 — К6 не пройден в 4 жанрах; COMPANY P 1,00 во всех жанрах. Модель находит обращения одним именем (утечки чатов с моделью — 0) и таблицу подписей
  акта сверки; ложные ADDRESS (66) — LOC модели на городах и словах («Москва», «Этап», «Оптимальный»).
- **Найдено прогоном** (вне зоны WP11-B): (а) LOC → ADDRESS дробил адрес правил — исправлено координатором (`80bb49d`); (б) модель даёт PER/LOC на продуктах и словах («Jira», «Логин»,
  «Здравствуйте», «Оптимальный») — 55 отрицательных примеров; фильтр — только ORG; (в)–(е) — в `KNOWN_GAPS`.

---

## Координатор: пересечения «модель внутри правила» (версия 0.4)

**Файлы:** `src/core/detect/overlap.js`, `tests/unit/overlap.spec.js`, `tests/fixtures/overlap.json`.
Корпус жанров с моделью 1.0.0 показал утечку: адрес без метки (уровень `weak`) проигрывал обрывку модели (`ner`) — «Новосибирск», «Ленина» —
и отбрасывался целиком, индекс и номер дома оставались открытыми (полнота ADDRESS 0,63). Теперь находка модели, целиком лежащая внутри более длинной
находки правил/KB/пользователя, отбрасывается до ранжирования. Полнота ADDRESS с моделью — 1,00, частичных утечек адресов 0.
**Изменённое ожидание (К11):** `tests/fixtures/overlap.json` случай «ner побеждает weak» (0.1) — было PERSON «Ленина», стало ADDRESS целиком: прежнее
ожидание фиксировало утечку индекса и дома.

---

## WP11-D — недочёты детекторов по корпусу жанров (версия 0.4)

**Файлы.** Новые: `src/core/detect/tables.js` (заголовки столбцов), `src/core/detect/names/vocative.js` (обращение одним именем),
`src/core/ner/filters-pl.js` (фильтры модельных PER/LOC), `tests/unit/ner/filters-pl.spec.js`, `tests/unit/names/vocative.spec.js`.
Изменяемые: `src/core/detect/identifiers/{numeric,labels}.js`, `src/core/detect/names/{kb,lexicon}.js`, `src/core/pdf/layout.js`, `src/core/ner/filters.js`
(экспорт `isStoplisted`, `wholeWordAround`, `inStoplist`), `src/core/detect/runner.js` (с разрешения координатора: `columnHeader` потока, фильтр PER/LOC),
`tests/integration/{genres,ner-provider}.spec.js`, `tests/unit/{identifiers/context,pdf/layout}.spec.js`, снимки `tests/fixtures/pdf/structures.lo.txt` и
`tests/fixtures/genres/**/*.pdf.txt` (4), этот раздел. Не трогать: `tools/ner-train/**`, `models-src/**` (WP11-C), `docs/contracts.md` (текст §8 — координатору).

**Сделать** (`KNOWN_GAPS` WP11-B, ложные PER/LOC модели 1.0.0, ревью WP11-B):
1. Девять записей `KNOWN_GAPS`: КПП в «ИНН/КПП покупателя: X/Y» и вариантах; код ТН ВЭД (ОКПД2, ОКВЭД, артикул, штрихкод) — не ИНН/ОГРН по окну слева и по
   заголовку столбца; «Уважаемый/Уважаемая/Уважаемые» вне PERSON, восстановление «Уважаемый [ФИО_1]» не ломается; обращение одним именем («Елена, спасибо…»)
   без ложных срабатываний на омонимах («Вера, надежда, любовь», «Роза ветров», «Любовь к делу», «Слава богу»); PDF — почта, разорванная переносом
   в центрированной строке; PDF — таблица подписей из двух строк.
2. Фильтр модельных PER и LOC в раннере после порога (`filterPersonLocSpans(spans, ctx)`, контекст — `createOrgFilterContext`): стоп-список, служебные слова
   и формулы вежливости, одно слово со строчной, PER без слова-имени в заголовке/ячейке/капсом; LOC → ADDRESS только рядом с признаками адреса.
3. Ревью WP11-B: утечки с моделью — безусловно; имя документа в `KNOWN_GAPS` — вне `it.fails`; DOCX и PDF — отдельными `it.fails`.

**Приёмка** (Ц1, Ц2, Ц5, К2, К6, К11):

| Проверка | Как |
|---|---|
| Все 9 записей `KNOWN_GAPS` исправлены, `it.fails` сняты; основные гейты корпуса без исключений | `tests/integration/genres.spec.js` |
| КПП во всех вариантах «ИНН/КПП»; код товара — не ИНН/ОГРН (окно, заголовок столбца DOCX с `gridSpan` и вложенной таблицей, PDF); настоящие ИНН `INN.json` на месте | `tests/unit/identifiers/{categories,context}.spec.js` |
| Обращение одним именем — PERSON `kb`, метка общая с полным ФИО; омонимы — нет; «Уважаемый [ФИО_1]» → «Уважаемый Павел Николаевич» (и с `decline`) | `tests/unit/names/vocative.spec.js` |
| PDF: почта в центрированной строке целиком; таблица 2×2 подписей; строка у края текста под таблицей — не перенос ячейки; две строки с разными началами — не таблица | `tests/unit/pdf/layout.spec.js`, снимки |
| Фильтр PER/LOC: стаб-провайдер на всех отрицательных примерах корпуса (PER и LOC, оба режима) — 0 прошло, люди и адреса gold — 0 потеряно | `tests/unit/ner/filters-pl.spec.js`, `genres.spec.js` |
| С моделью 1.0.0: отрицательных примеров, ставших сущностью, ≤ 5; ADDRESS P ≥ 0,9 при R = 1,00; PERSON P ≥ 0,90 и R ≥ 0,85 по жанрам; утечек 0 | `NER_MODEL_DIR=… npm run eval-genres`, `genres.spec.js` |
| Договоры с моделью — без регрессии | `ner-provider.spec.js` (гейт `NER_MODEL_DIR`) |
| `npm run lint`, `npm test`, `npm run e2e` (под flock) зелёные | запуск |

**Статус:** выполнено (20.10.2026), доработка по ревью — 20.10.2026 (ниже); не закоммичено — коммит координатора.

- **КПП** (`identifiers/numeric.js`, `INN_KPP_RE`): между «ИНН/КПП» и номерами — до двух слов («покупателя:», «продавца»), пробелы вокруг «/» в метке и между номерами.
- **Код товара** (`identifiers/labels.js` `GOODS_CODE_RE`/`goodsCodeContext`): ТН ВЭД (ЕАЭС), ОКПД2, ОКВЭД, ОКП, артикул, «арт.», штрихкод, «код товара/продукции»,
  HS code, SKU, EAN, GTIN, part number — в окне 40 символов слева (та же строка) или в заголовке столбца → ИНН и ОГРН **без своего лейбла** не берутся
  (EAN-13 проходит контрольную сумму ОГРН). С лейблом «ИНН»/«ОГРН» — как прежде. Заголовок столбца — `detect/tables.js` `columnHeaders(doc)`: DOCX — по
  `w:tbl/w:tr/w:tc` части с учётом `w:gridSpan`, вложенная таблица — своя; PDF — по `doc.blocks[].table`; раннер кладёт его в `ctx.stream.columnHeader`.
- **«Уважаемый»** (`names/lexicon.js` `STOP_EXACT`): уважаемый/-ая/-ые (все падежи), глубоко-/многоуважаемый — стоп-слова, ФИО по отчеству начинается после
  обращения («Уважаемый [ФИО_1]!»). «Дорогой/Дорогая» не добавлены: «Дорогая» — фамилия словаря (`dict-codec.spec.js`). Восстановление проверено с `decline`.
- **Обращение одним именем** (`names/vocative.js`, шаг 4в `kb.js`, при `dictNames`): имя из словаря в именительном падеже в начале строки потока, после метки
  реплики («Иван: », «[12.10.2026 10:20] Максим Савельев: », «10:42 Поддержка: ») или после приветствия («Здравствуйте, Елена!», «Hi Anna,»), за ним «,» или «!».
  Омоним нарицательного (`AMBIGUOUS` словаря и `AMBIGUOUS_NAMES_RU`: Вера, Любовь, Роза, Слава, а также Лена, Максим, Роман…) — только после метки реплики,
  приветствия или со словом обращения после запятой («Максим, привет», «Лена, спасибо»), и не в перечислении. Уровень `kb`, `canonical` — единственная запись
  о лице с этим именем (иначе своя метка).
- **PDF, почта** (`pdf/layout.js` `technicalBreak`): строка кончается на «-» или «.» внутри почты, URL или домена (`@`, `://`, `www.`, домен с точкой и дефисом
  на конце), следующая начинается латинской строчной (после «-» — и цифрой) → продолжение абзаца даже в строке по центру; `dehyphenate` склеивает «…plus.» +
  «example» без пробела. После «.» цифра не продолжает («…@romashka.ru.» + «1.3. …» — новый пункт).
- **PDF, таблица из двух строк** (`detectTables`): две многосегментные строки — таблица, если у них одинаковое число сегментов (≥ 2) и начала попарно
  совпадают (±0.5·size); вторая из них — новая строка таблицы (без склейки с ячейками первой). Перенос ячейки **последней** строки (одиночная строка
  сразу под ней, начинается у края колонки ±0.2·size, `continues` — строка выше дошла до правого края колонки; не в последней колонке) входит в ячейку —
  так же и в таблицах ≥ 3 строк («CRM, API, обучение,» + «поддержка 3 месяца» в КП).
- **Фильтр PER/LOC** (`ner/filters-pl.js`, оба режима, после порога `nerThreshold`): (1) стоп-список целиком/каждым словом/словом вокруг — отбросить;
  (2) служебные слова по краям (`SERVICE_WORDS`: вежливость, учётные данные, заголовки таблиц и учёта, тарифы, языки, должности), у PER — и слова со строчной
  или с цифрами по краям — отрезать; ничего не осталось, остаток со строчной, римская цифра — отбросить; (3) одно слово со строчной — отбросить; (4) LOC — только
  если в спане или в окне ±40 символов есть индекс, «ул./д./кв./оф./пер./пр-т/наб.», «дом/офис/улица/проспект/шоссе», street/road/avenue/suite, британский
  индекс, ZIP, номер дома после запятой (не дата «, 15 сентября»); **«г.» сама по себе — не признак** (отклонение от ТЗ: «г. Нижний Новгород» в строке банка —
  город, а не адрес; без этого ADDRESS P ≈ 0,9 не достигался); (5) PER со строчным словом внутри (кроме частиц «ван», «де», «оглы»…) или цифрой — отбросить;
  PER без слова-имени (словари имён и фамилий, `morph.js`, инициал с точкой; для капса — без фамилии по суффиксу, в капсе из нескольких слов нужно имя/отчество/
  инициал) — отбросить, если это остаток фразы после отрезания, капс или одно слово в заголовке/пункте/ячейке.
- **`genres.spec.js`**: `KNOWN_GAPS = []` (механизм сохранён); проверка записей (документ, формат, ключ) — обычным `it`; `it.fails` — по формату; утечки с моделью —
  безусловно; новый гейт с моделью — отрицательных примеров ≤ 5 в каждом режиме; новый тест — стаб PER и LOC на всех отрицательных примерах и gold-людях/адресах.
- **Изменённые ожидания (К11)**: `ner-provider.spec.js` «документ: модель находит лицо…» — настройки `commercial: true`: с политикой 0.4 (WP11-A) правила
  по умолчанию не ищут ООО «Ромашка» и ООО «Вектор-М», и гейт «правила нашли ≥ 8» падал ещё до WP11-D (тест под `NER_MODEL_DIR`, в CI не идёт); ожидания те же.
  Снимки: `genres/letter/letter-schedule.pdf.txt` (почта целиком), `genres/reconciliation/reconciliation-ooo.pdf.txt` (таблица подписей 2×2),
  `genres/proposal/kp-polden.pdf.txt`, `genres/proposal/kp-svetlyachok.pdf.txt` (перенос «поддержка 3 месяца» — в ячейке строки «Максимум»),
  `pdf/structures.lo.txt` (вложенная таблица 2×2 «ИНН | Тел.» / «ООО «Северный Ветер» | почта» — таблицей; «Пусто» — отдельным абзацем, раньше
  склеивался с почтой). Снимки обновлены из закоммиченных PDF (PDF не пересоздавались); регенерация в Chromium даёт те же снимки. Ложных таблиц в
  остальных фикстурах нет (снимки не изменились), К4 `pdf-pipeline.spec.js` зелёный.
- **Числа** (`npm run eval-genres`, 49 файлов; P/R/ложные; «отриц.» — отрицательные примеры, ставшие сущностью):

  | Режим | Модель | | PERSON | ADDRESS | INN | KPP | EMAIL | COMPANY | утечки | отриц. |
  |---|---|---|---|---|---|---|---|---|---|---|
  | normal | нет | до | 0,97 / 0,93 / 4 | 1,00 / 1,00 / 0 | 0,94 / 1,00 / 2 | 1,00 / 0,88 / 0 | 1,00 / 0,97 / 0 | — | 9 | 0 |
  | normal | нет | после | 1,00 / 1,00 / 0 | 1,00 / 1,00 / 0 | 1,00 / 1,00 / 0 | 1,00 / 1,00 / 0 | 1,00 / 1,00 / 0 | — | 0 | 0 |
  | commercial | нет | до | 0,97 / 0,93 / 4 | 1,00 / 1,00 / 0 | 0,94 / 1,00 / 2 | 1,00 / 0,88 / 0 | 1,00 / 0,97 / 0 | 1,00 / 0,93 / 0 | 9 | 0 |
  | commercial | нет | после | 1,00 / 1,00 / 0 | 1,00 / 1,00 / 0 | 1,00 / 1,00 / 0 | 1,00 / 1,00 / 0 | 1,00 / 1,00 / 0 | 1,00 / 0,93 / 0 | 0 | 0 |
  | normal | 1.0.0 | до | 0,87 / 0,96 / 19 | 0,37 / 1,00 / 66 | 0,94 / 1,00 / 2 | 1,00 / 0,88 / 0 | 1,00 / 0,97 / 0 | — | 3 | 55 |
  | normal | 1.0.0 | после | 1,00 / 1,00 / 0 | 1,00 / 1,00 / 0 | 1,00 / 1,00 / 0 | 1,00 / 1,00 / 0 | 1,00 / 1,00 / 0 | — | 0 | 0 |
  | commercial | 1.0.0 | до | 0,87 / 0,96 / 19 | 0,37 / 1,00 / 66 | 0,94 / 1,00 / 2 | 1,00 / 0,88 / 0 | 1,00 / 0,97 / 0 | 1,00 / 0,98 / 0 | 3 | 55 |
  | commercial | 1.0.0 | после | 1,00 / 1,00 / 0 | 1,00 / 1,00 / 0 | 1,00 / 1,00 / 0 | 1,00 / 1,00 / 0 | 1,00 / 1,00 / 0 | 1,00 / 0,98 / 0 | 0 | 0 |

  PERSON P с моделью по жанрам: было proposal 1,00, letter 0,82, invoice 1,00, reconciliation 0,96, manual 0,71, deck 1,00, resume 0,80, chat 0,80 — стало 1,00
  во всех (R 1,00): К6 на корпусе с 1.0.0 и фильтрами проходит. COMPANY R в коммерческом режиме не менялась (пропуски — организации без ОПФ: «Уральский завод
  точных приборов», слайды deck/letter без модели). На договорах (`tests/fixtures/{docs,pdf}`, модель 1.0.0, коммерческий режим) фильтр убрал только ложные
  LOC («г. Москва» в шапке, «Российской Федерации», «Пусто», «Ок», «Реквизиты сторон»), находки PER модели не изменились; `ner-provider.spec.js` зелёный.
  Оговорка: корпус синтетический, `SERVICE_WORDS` составлен по ошибкам модели на нём — слова общие (служебные, должности, языки), но на настоящих документах
  числа будут ниже; проверка — `PRIVATE_FIXTURES=1` и модель 1.1.0 (WP11-C).

**Доработка по ревью (20.10.2026, вердикт «Доработать»).** Ревьюер проверил WP11-D на 12 новых документах вне корпуса (договор услуг,
претензия, доверенность, служебная записка, протокол, письмо и резюме на английском, чат, счёт-оферта, инструкция, омонимы имён, реестр
с ИНН и кодами ТН ВЭД): с моделью 1.0.0 — 2 новые утечки против `8dee668` (адрес «Тольятти, Революционная 52-14» — LOC отброшен фильтром,
ИНН после «Артикул … .» — подавлен окном кода товара) и пробелы, бывшие и на базе. Решение владельца 1: лишнее маскирование допустимо, утечка — нет.
Дополнительные файлы: `src/core/detect/names/{address,person,person-dict,text,lexicon}.js`, `src/core/detect/names/dict/index.js`,
`src/core/detect/overlap.js` (разрешение координатора), `scripts/gen-heldout-fixtures.mjs` (новый), `scripts/eval-genres.mjs` (`--dir`, `parts`),
`tests/fixtures/heldout/**` (новые), `tests/integration/heldout.spec.js` (новый), `tests/unit/names/{address-label,heldout-names}.spec.js` (новые),
`tests/unit/{overlap,names/kb,names/vocative,ner/filters-pl,identifiers/context}.spec.js`, `src/core/ner/{bio,stoplist}.js`, `src/core/detect/names/{company,company-list}.js`
(только списки слов — бюджет `worker.js`), `package.json` (`gen-heldout-fixtures`).

- **Адреса.** `address.js`: значение после адресной метки в любой форме («адрес», «по адресу», «проживающую», «зарегистрированный», «место
  жительства/регистрации», «доставка», «address», «lives at», «located at», «resides at»; слова до «:» не длиннее 40 символов) — до конца строки
  или предложения, до слова со строчной не из типов адреса («…кв. 88, представлять…»), с цифрой и словом с заглавной (не дата, не почта) —
  `labeled`, шире цепочки — заменяет её; «Город, Улица 12-5» без «ул./д.» — `weak` (город — не шаблонное слово, номер до 3 цифр); «Flat N» — тип
  английского адреса. Второй адрес доверенности «проживающую по адресу: г. Казань, ул. Чистопольская, д. 61, кв. 88» больше не теряет дом
  (метки были только «проживающий/проживающая»). `filters-pl.js`: LOC → ADDRESS и рядом с адресной меткой («адрес*», «проживающ*»,
  «зарегистрирован*», «место жительства/регистрации», «доставк*», «курьер», «address», «lives at», «located at», «resides»), и перед номером
  дома («Тверская 12-5», «Лесную 14», не дата/«1С»/сумма); номер дома и «, квартира 3» входят в спан LOC.
- **ИНН и коды товаров.** `goodsCodeContext(text, start, end, ctx)`: подавляется только число **сразу после** ключевого слова (между ними
  «:», «№», «#», тире и предыдущие коды списка) и только длины кода: ТН ВЭД/HS — 10 цифр, штрихкод/EAN/GTIN — 8/13/14 (12 цифр — ИНН физлица),
  артикул/SKU/«код товара» — любая; ОКПД2 и ОКВЭД ничего не подавляют; заголовок столбца — только если в нём нет других слов, кроме кода
  («Код ТН ВЭД», «Артикул»; не «ИНН / ОКВЭД», «Реквизиты (ИНН, ОКПД2)», «Артикул/Получатель»). Все случаи `inn.mjs` ревьюера находятся,
  ТН ВЭД УПД — не ИНН.
- **Обращения.** `ENUM_RE`: «и» — отдельным словом («подскажи пароль» — не перечисление); повелительное наклонение и слово обращения после
  запятой («Вера, посмотри, пожалуйста») — не перечисление.
- **Люди.** Профессия перед именем — не фамилия (`isRoleNoun`: «Сотрудник Кирилл Ахмедов» → «Кирилл Ахмедов»); одиночная фамилия после
  профессии со строчной («курьер Абдуллаев») — PERSON `kb`; латиница с диакритикой и «McAllister/MacDonald/DeLuca» — одно слово, словари EN —
  без диакритики («Wiśniewski» = «wisniewski»); строка целиком «Имя Фамилия» капсом или в заголовке («OLIVER BRANNIGAN») — PERSON;
  одиночная фамилия и «Фамилия И.» — варианты любого лица с именем и фамилией (не только сторон), латиница так же; люди, найденные моделью, —
  записи базы лиц (их варианты ищутся правилами, сами спаны модели не дублируются); PER модели, оборванный перед словарной фамилией
  («Tomasz» → «Tomasz Wiśniewski»), продолжается.
- **Пересечения** (`overlap.js`, `mergePersons`): PERSON правил и PERSON модели, где модель выходит за правило («Ван Тхань» ⊂ «Нгуен Ван Тхань»,
  «Сотрудник Кирилл» ∩ «Кирилл Ахмедов»), — одно лицо: объединённый спан с уровнем, источником и canonical правила, профессия в начале —
  в `keepPrefix`; модель на двух лицах правил не объединяется.
- **Омонимы (п. 6).** Пробная модель 1.1.0 давала PER «Вера/Роман/Любовь» в «Вера в продукт…»: фильтр снимает PER-омоним в начале предложения
  перед предлогом («в», «о», «к», «на», «за», «для», «без», «и») или в перечислении, если в документе нет человека с этим именем (слово рядом
  с другим словом с заглавной: `pairedWords` контекста). Обращения и «Вера в отпуске» при «Вера Лукина» в документе не теряются (тесты).
  «Надежда только на пятничный релиз» в чате остаётся ложным PER — лишнее маскирование.
- **Набор ревью — в репозитории** (`tests/fixtures/heldout/`, `npm run gen-heldout-fixtures`, детерминирован; ИНН заменены вымышленными с
  контрольной суммой). Он больше **не отложенный**: правила WP11-D доработаны по нему; финальная проверка версии — на новом наборе ревьюера.
  `npm run eval-genres -- --dir=tests/fixtures/heldout`; `tests/integration/heldout.spec.js`: без модели — ни одной утечки, кроме лиц
  `modelOnly`, покрытие людей и адресов ≥ 0,95; с `NER_MODEL_DIR` — ни одной утечки, покрытие ≥ 0,95.
- **Бюджет `worker.js`** (К12, `pack.spec.js`: код ≤ 400 КБ): доработка выводила код до 416,6 КБ. Списки слов (`lexicon.js`, `stoplist.js`,
  `filters-pl.js`, `bio.js`, `person.js`, `company*.js`, `address.js`) переведены в `wordList('a|b|c')` (esbuild без minify печатал каждый элемент
  отдельной строкой), комментарии из массивов вынесены над объявлениями: код 406,8 КБ, запас ≈ 2,8 КБ — для WP11-C почти не осталось,
  следующий шаг — словари в `vendor/dict` (бэклог).
- **Изменённые ожидания (К11):** `tests/unit/names/kb.spec.js` «сторона вне зон: варианты в теле не ищутся» → «одиночная фамилия в теле —
  вариант того же лица» (было одно вхождение «Иванов Пётр Сергеевич», стало + «Иванову» той же меткой: решение владельца 1, фамилия лица
  из документа — ПДн); `ner-provider.spec.js` «модель находит лицо, которого нет у правил» — в документ добавлена строка с именами вне словарей
  («Олжас Нурланов», «Юки Танака»): прежнее лицо модели «экспедитор Кравчук» теперь находят правила. Свои тесты первой итерации
  (`filters-pl.spec.js`: «Доставку по Казани…» → «Филиал в Казани…», `context.spec.js`: «ОКПД2 8471300000» теперь ИНН) — по новым правилам.
- **Числа после доработки.** Корпус жанров: без модели — все категории 1,00/1,00, утечек 0; модель 1.0.0 — ADDRESS 0,95/1,00/2 («Доставку по
  Казани» — адресная метка), остальное 1,00, отрицательных 0, утечек 0; пробная 1.1.0 (`tools/ner-train/runs/x-genre-probe/pack-src`) —
  PERSON 0,99/1,00/2, ADDRESS 0,95/1,00/2, отрицательных 0, утечек 0, COMPANY в коммерческом 0,91/0,93/9 (К7 не пройден в letter 0,73 и
  manual 0,75 — модель, WP11-C). Набор ревью (`run.mjs` ревьюера, обычный режим; «утечки» — целиком/частью):

  | Модель | Дерево | PERSON | ADDRESS | INN | утечки | ложные PER / ADR | отриц. |
  |---|---|---|---|---|---|---|---|
  | нет | база `8dee668` | 38/57 | 6/9 | 5/5 | 20 / 4 | 0 / 0 | 1 |
  | нет | WP11-D (1-я итерация) | 42/57 | 6/9 | 4/5 | 17 / 4 | 0 / 0 | 0 |
  | нет | текущее | 52/57 | 9/9 | 5/5 | 5 / 0 (все `modelOnly`) | 0 / 0 | 0 |
  | 1.0.0 | база | 53/57 | 6/9 | 5/5 | 2 / 5 | 4 / 15 | 12 |
  | 1.0.0 | WP11-D (1-я итерация) | 53/57 | 6/9 | 4/5 | 4 / 4 | 2 / 1 | 3 |
  | 1.0.0 | текущее | 57/57 | 9/9 | 5/5 | 0 / 0 | 2 / 1 | 3 |
  | 1.1.0 (проба) | база | 54/57 | 6/9 | 5/5 | 1 / 5 | 6 / 14 | 15 |
  | 1.1.0 (проба) | WP11-D (1-я итерация) | 54/57 | 6/9 | 4/5 | 3 / 4 | 4 / 1 | 6 |
  | 1.1.0 (проба) | текущее | 57/57 | 9/9 | 5/5 | 0 / 0 | 1 / 1 | 2 |

**Третья итерация (20.10.2026, повторное ревью «Доработать»).** Ревьюер проверил на новом отложенном наборе (heldout2, 12 документов,
у ревьюера — в репозиторий не переносится, финальная проверка — на нём); в релиз идёт модель 1.1.0 (`tools/ner-train/runs/rubert-tiny2-ner-ruen-1.1.0`).

- **Имя или фамилия после профессии** (`person-dict.js`): после профессии с заглавной или со строчной («09:03 Оператор Алина:», «Сотрудник Кирилл
  подготовил», «Водитель Рашид», «Бухгалтер Петрова», «Инженер Захарченко», «курьер Абдуллаев») одно имя или фамилия из словаря (фамилия — и по
  суффиксу) — PERSON `kb`, профессия вне спана; в `isRoleNoun` добавлены директор, руководитель, начальник, заместитель, председатель, водитель.
  Первая итерация исключила профессию из ФИО, и «Оператор Алина» перестала находиться совсем — новая утечка против базы, закрыта.
- **Дом после запятой** (`address.js` `addressTailEnd`, `filters-pl.js`): ADDRESS правил и LOC модели продлевается через «, N», «, кв./корп./
  корпус/стр./строение/офис/пом./подъезд/этаж N» (не дата, не год, не сумма); метки «расположенн*», «находящ*» — адресные; «Город, Улица, N» —
  `weak`; в значении после метки число перед датой не берётся.
- **Британский адрес без типа улицы**: компонент «N Name,» (только перед запятой) — «Suite 5, 88 Deansgate, Manchester M3 2ER». **Улица-ORG**
  (`orgStreetsAsLoc`, раннер — до порога): ORG модели перед номером дома («на Профсоюзную 104, корпус 2») — LOC в обоих режимах (не в кавычках,
  не капсом), дальше — правило LOC → ADDRESS с хвостом дома.
- **LOC модели на фамилии вне адреса** (модель 1.1.0: «представитель подрядчика Лисицын» — LOC 0,96; первая итерация отбрасывала LOC вне адреса,
  и фамилия уходила в чат открытой): одно слово-фамилия по суффиксу, не имя, не «г. N» — PER. Лишнее: «Садовой» (улица) — PER.
- **К7 с 1.1.0** (`filters.js` `extendGenericTail`): ORG, кончающийся родовым словом (завод, комбинат, компания, группа, фабрика, агентство, бюро,
  холдинг, институт, университет, банк, фонд), продолжается строчными словами в родительном падеже (до знака, глагола, предлога, ≤ 5 слов):
  «Уральский завод» → «Уральский завод точных приборов»; «компания точно в срок» — нет. `GENRES_MODEL_GATES=1` с 1.1.0 — зелёный.
- **Бюджет `worker.js`**: код 408 977 байт при лимите 409 600 (запас 623 байта ≈ 0,6 КиБ); сжатие — `'a|b'.split('|')` в `windows.js`, `filters.js`,
  комментарии вне массивов, общие источники регэкспов (`VALUE_LABEL_SRC`, `NOT_HOUSE_SRC` из `address.js`). Следующая правка ядра потребует
  выноса словарей в `vendor/dict` или пересмотра лимита (решение координатора).
- heldout2 (`run2.mjs` ревьюера, обычный режим; утечки целиком / частью; база — `8dee668`):

  | Модель | Дерево | PERSON | ADDRESS | утечки | ложные PER / ADR | отриц. |
  |---|---|---|---|---|---|---|
  | нет | база | 27/44 | 0/6 | 21 / 0 | 0 / 0 | 3 |
  | нет | 2-я итерация | 29/44 | 1/6 | 17 / 1 | 0 / 0 | 0 |
  | нет | 3-я итерация | 30/44 | 5/6 | 13 / 0 | 0 / 0 | 0 |
  | 1.1.0 | база | 42/44 | 0/6 | 2 / 2 | 5 / 8 | 12 |
  | 1.1.0 | 2-я итерация | 43/44 | 1/6 | 3 / 2 | 3 / 1 | 3 |
  | 1.1.0 | 3-я итерация | 44/44 | 6/6 | 0 / 0 | 3 / 2 | 4 |

  Без модели остаются утечки вне пунктов ревью (не подгонялось): иностранные ФИО без словаря («Гиоргадзе Нино», «Абдрахманова Айгерим», «Сейтказиев Д.»,
  «Katarzyna Thorne»), «Р. Хабибуллин» строкой подписи, обращение «Алина,» после метки реплики из четырёх слов со строчным («Старший смены Евгений
  Кудрявцев:»), омонимы «Злата», «Павел» в обычном тексте, «на Профсоюзную 104, корпус 2» (без модели улица без типа не находится), фамилии только модели.

---

## WP11-C — переобучение модели и пакет 1.1.0 (версия 0.4)

Исполнитель C1/C2 — `ner-trainer` (Python, без JS-тестов), C3 — `wp-implementer`.

**C1 (спайк и подготовка, параллельно с A и B).** Файлы: `tools/ner-train/**`. Спайк лицензий Nerus, factRuEval-2016, RuREBus (файл лицензии/условия в источнике;
совместимость с распространением обученных весов под MIT и упоминанием в NOTICE) → `tools/ner-train/README.md` «Источники 1.1.0» (включён/отклонён, почему);
при отклонении всех — путь «учитель + синтетика жанров ≥ 50 %». Код: `synth.py` — шаблоны жанров (≥ 6 жанров ru, 2 en: КП, письма, счета, регламенты, резюме, переписка;
заголовки капсом, нумерованные заголовки «05 Цены», аббревиатуры, продукты — как O; ≥ 30 % синтетики — отрицательные предложения без сущностей); `prepare.py` — источники
с весами (`config.yaml data.sources[]`, конвертация меток в `PER/ORG/LOC`), снятие `assert ≤ 20 %` (параметр `synth.max_ratio`), отложенный набор `synth_genre_test`;
`evaluate.py` — гейты `ru_per_f1 ≥ 0.91`, `ru_org_f1 ≥ 0.78`, новый `synth_genre_org_precision ≥ 0.85`; `make_pack_src.py` — источники/лицензии из конфига, `version: 1.1.0`
(`minExtensionVersion` остаётся `0.2.0`). Пробный прогон `--set run_id=x-genre-probe` с числами в отчёте.

**C2 (обучение, после корпуса B).** Финальный прогон `rubert-tiny2-ner-ruen` 1.1.0: `prepare → teacher → train → evaluate → export_onnx → quantize → verify_onnx →
calibrate → bench_ort → make_tokenizer_fixture → make_pack_src`; `npm run pack:model -- --id=rubert-tiny2-ner-ruen` → `release/docx-anonymizer-ner-rubert-tiny2-ner-ruen-1.1.0.zip`
+ sha256. Координатор прогоняет `NER_MODEL_DIR=models-src/rubert-tiny2-ner-ruen npm run eval-genres` и `ner-provider.spec`; при провале К6/К7 — до 2 итераций весов
смешивания, затем честная фиксация результата.

**C3 (интеграция пакета).** Файлы: `src/core/ner/known-packs.js` (+ запись 1.1.0, 1.0.0 остаётся), `scripts/pack.mjs` (`findModelZip` — zip с наибольшей версией из
`KNOWN_PACKS` или `--model=`), `tests/integration/{pack,manifest}.spec.js` (имя zip из `KNOWN_PACKS`, гейт полного архива ≤ 45 МБ), `tests/unit/background/bundled-model.spec.js`
и `tests/integration/host.spec.js` (установленный `{id, sha_old}` + bundled `sha_new` → `install`, старый слот удалён), `tests/e2e/bundled-model.spec.js` (сценарий «поверх 1.0.0»,
гейт `NER_PACK_PREV`: импорт 1.0.0 через настройки → `MODEL_BOOTSTRAP` → 1.1.0), `tests/integration/{genres,ner-provider}.spec.js` (гейты К6/К7 для 1.1.0), `README.md`
(таблица метрик 1.1.0: WikiANN + жанры), `docs/contracts.md` §6.7, `tests/fixtures/ner/*` при переэкспорте токенизатора.

**Приёмка** (К5–К9, К12): гейты `evaluate.py` PASS; int8 ≤ 40 МБ; `bench-ner` холодный старт ≤ 0,5 с, 20 страниц ≤ 3 с; `eval-genres` с 1.1.0: люди P ≥ 0,90 / R ≥ 0,85
по жанрам, организации в коммерческом режиме P ≥ 0,80, ложных на `proposal` ≤ 2; договоры без регрессии (пороги `ner-provider.spec` 0.3); полный архив ≤ 45 МБ, лёгкий ≤ 12 МБ;
`bundled-model.spec` зелёный с `--with-model=…1.1.0.zip`.

**Статус:** C1, C2 — выполнены (пакет 1.1.0: 29 541 797 байт, sha256 `5616d089…a0b8`). C3 — интеграция выполнена 20.10.2026: запись 1.1.0 в `KNOWN_PACKS`
(1.0.0 остаётся), `findModelZip` — zip из `KNOWN_PACKS` с наибольшей версией (неизвестные — предупреждение), `pack`/`manifest.spec` берут имя zip из `KNOWN_PACKS`,
гейт полного архива ≤ 45 МБ; обновление 1.0.0 → 1.1.0 — unit (план), host (настоящий model-store, слоты), e2e «поверх 1.0.0» (`NER_PACK_PREV`) зелёные;
`npm run pack`: полный 36 017 278 байт, лёгкий 6 474 276 байт; `bench-ner` 1.1.0: холодный старт 0,25–0,31 с, 20 страниц 1,72 с; README и §6.7/§6.8 contracts —
числа 1.1.0. Не в этой итерации C3: жёсткие гейты К6/К7 для 1.1.0 в `genres.spec.js` (`GENRES_MODEL_GATES`, зона WP11-D) и таблица по жанрам в README (документация).

---

## Бэклог после 0.3

Версия 0.3.0 завершена (WP10-A…D выполнены, критерии К1–К17 `docs/concept-0.3.md`). Отложено:

- **Словари ФИО — в `vendor/dict/*.txt`** с ленивой загрузкой через `offscreen/package-fetch.js`: освободит ≈ 360 КБ `worker.js` (бюджет словарей — §6.5 `docs/contracts.md`) и время старта воркера.
- **Отдельные метки для частей паспорта** (серия и номер, орган выдачи, код подразделения) в детекторе и `core/mapping.js`: сейчас все три места под одной `[ПАСПОРТ_n]`
  и при восстановлении получают серию и номер (страница восстановления предупреждает, WP10-B).
- **Таблица, разорванная границей страницы** (по 1–2 строки на странице) в PDF собирается в одну; сейчас такая часть может уйти абзацем (WP10-A).
- **Ответ ИИ в `.xlsx`/`.pptx`** — восстановление файлов этих форматов (`docs/concept-0.3.md`, «Что не делаем в 0.3»).
- ~~Склонение после «индивидуального предпринимателя»~~ — закрыто в 0.3.0: мостики `BRIDGE` дополнены ролями сторон («индивидуальный предприниматель», «ИП», «учредитель», «участник», «адвокат», «доверитель», «арендатор», «заказчик», «исполнитель», «поставщик», «покупатель», «подрядчик»…).
- Сканы и OCR, «PDF → PDF», формы PDF — по `docs/concept-0.3.md`; публикация в Chrome Web Store — решение владельца.
