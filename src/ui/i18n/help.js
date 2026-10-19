// Строки справки. Факты — из README: что делает, как пользоваться, что данные не покидают компьютер.
// Версия 0.2: доступ к сайтам по запросу (К9), словарный поиск ФИО (FR-23), пакет модели NER (§5.2), склонение при восстановлении (FR-37).
// Версия 0.3: PDF с текстовым слоем (FR-54–FR-57), файл от ИИ (FR-36а), два архива — полный с моделью и лёгкий (§5.2, К12).
export const HELP_DICT = {
  ru: {
    title: 'Справка',
    subtitle: 'DOCX Anonymizer: договор в ИИ-сервис без реквизитов и личных данных.',
    what_h: 'Что делает расширение',
    what_p1:
      'Перед тем как договор .docx или PDF попадёт в ChatGPT, Claude или другой ИИ-сервис, расширение перехватывает файл, локально находит в нём персональные и коммерческие данные и заменяет их плейсхолдерами.',
    what_p2:
      'В сервис уходит обезличенный документ: форматирование, таблицы, сноски и колонтитулы сохранены, метаданные файла очищены; из PDF — его текст с плейсхолдерами. Ответ ИИ — текстом или файлом — можно вернуть обратно с настоящими названиями и именами.',
    how_h: 'Как пользоваться',
    how_1:
      'Откройте меню расширения на сайте чата и включите «Перехват загрузки». Если сайта нет в списке, нажмите «Добавить …» и подтвердите запрос Chrome на доступ к сайту; для сайтов из списка по умолчанию нажмите «Разрешить доступ». По умолчанию перехват выключен, а доступа к сайтам у расширения нет.',
    how_2: 'Приложите .docx или PDF в чате: кнопкой, перетаскиванием или вставкой. Расширение остановит файл и покажет панель: что найдено и где.',
    how_3: 'Снимите лишние галочки и нажмите «Анонимизировать и загрузить» — в чат уйдёт файл имя.anon.docx, а для PDF — имя.anon.md.',
    how_4:
      'Ответ ИИ вставьте текстом или загрузите файлом от ИИ (.docx, .docm, .md, .txt) на странице «Восстановить текст»: расширение подставит настоящие значения из карты замен — ключа восстановления — и отдаст файл «имя.restored.*» с прежним форматированием; в файле заменяются только метки точно как в карте или в квадратных скобках. Ключ хранится только у вас, в памяти браузера до его перезапуска; сохранить его в файл можно на экране «готово» панели: «Ещё» → «Сохранить ключ восстановления». ФИО ставятся в нужный падеж по контексту, склонённые подстановки выделены зелёным — проверьте их.',
    privacy_h: 'Данные не покидают ваш компьютер',
    privacy_1: 'Расширение не делает ни одного сетевого запроса: это закреплено политикой безопасности расширения и проверяется тестами.',
    privacy_2: 'Документ обрабатывается в изолированном окне самого браузера и никуда не отправляется.',
    privacy_3: 'Содержимое документа и карта замен живут только в памяти и не записываются в хранилище браузера.',
    privacy_4:
      'Модель NER не скачивается из сети: в полном архиве расширения она уже есть и при первом запуске сама копируется из архива, для лёгкого архива пакет вы скачиваете и импортируете сами. Её файлы хранятся в хранилище браузера на этом компьютере; документы и результаты распознавания туда не записываются.',
    check_h: 'Что стоит знать',
    check_1: 'Перед отправкой всегда просматривайте результат — ответственность за содержимое остаётся за вами.',
    check_2:
      'Имена и названия находятся правилами: по меткам, шаблонам, базе знаний сторон из реквизитов и словарям имён и фамилий — так находятся и третьи лица без подписи «в лице». Для остального есть модель NER: в полном архиве расширения она уже есть и ставится сама при первом запуске, в лёгком — скачайте пакет с GitHub Releases и импортируйте в настройках («Модель NER» → «Импортировать пакет…»); модель работает офлайн, на этом компьютере. Одиночная фамилия или редкое имя всё равно могут остаться.',
    check_3: 'Встроенные объекты (OLE-вложения) не обезличиваются — расширение предупреждает об этом или удаляет их по настройке.',
    check_4:
      'Работает с файлами .docx, .docm и PDF с текстовым слоем. Из PDF в чат уходит текст с плейсхолдерами (имя.anon.md, по настройке — .txt), а не PDF: заголовки, списки и таблицы сохранены, колонтитулы и номера страниц убраны. Сканы, PDF с паролем и пустые PDF не обрабатываются — их можно загрузить как есть после подтверждения. Нужен Chrome или Edge версии 132 и новее.',
    open_options: 'Открыть настройки',
    open_restore: 'Восстановить текст',
  },
  en: {
    title: 'Help',
    subtitle: 'DOCX Anonymizer: send a contract to an AI service without requisites or personal data.',
    what_h: 'What the extension does',
    what_p1:
      'Before a .docx or PDF contract reaches ChatGPT, Claude or another AI service, the extension intercepts the file, finds personal and commercial data in it locally and replaces it with placeholders.',
    what_p2:
      'The service receives an anonymized document: formatting, tables, footnotes and headers are kept, file metadata is cleared; for a PDF it receives the PDF text with placeholders. The AI answer — text or a file — can be turned back into real names and titles.',
    how_h: 'How to use it',
    how_1:
      'Open the extension menu on the chat site and turn on "Upload interception". If the site is not listed, press "Add …" and accept Chrome\'s request for access to the site; for sites listed by default, press "Allow access". Interception is off by default and the extension has no access to sites until you allow it.',
    how_2:
      'Attach a .docx or PDF in the chat: with the button, by drag and drop or by pasting. The extension holds the file and shows a panel with what was found and where.',
    how_3: 'Clear the checkmarks you do not need and press "Anonymize and upload" — the chat receives name.anon.docx, or name.anon.md for a PDF.',
    how_4:
      'Paste the AI answer as text or load the file the AI produced (.docx, .docm, .md, .txt) on the "Restore text" page: the extension puts the real values back from the replacement map (the recovery key) and gives you a "name.restored.*" file with the original formatting; in a file only markers written exactly as in the map or in square brackets are replaced. The key stays only with you, in browser memory until the browser restarts; save it to a file on the panel\'s "done" screen: "More" → "Save the recovery key". Russian names are put in the right case by context; declined values are highlighted in green — check them.',
    privacy_h: 'Your data never leaves your computer',
    privacy_1: 'The extension makes no network requests at all: this is enforced by the extension security policy and checked by tests.',
    privacy_2: 'The document is processed in an isolated browser window and is not sent anywhere.',
    privacy_3: 'Document content and the replacement map live in memory only and are not written to browser storage.',
    privacy_4:
      'The NER model is never downloaded from the network: the full extension archive already contains it and copies it from the archive on first run; for the lite archive you download and import the pack yourself. Its files are kept in browser storage on this computer; documents and recognition results are never written there.',
    check_h: 'Good to know',
    check_1: 'Always review the result before sending — you remain responsible for the content.',
    check_2:
      'Names and titles are found by rules: labels, patterns, the knowledge base of the parties from the requisites and first-name and surname dictionaries — this also finds third persons without a “represented by” label. For the rest there is the NER model: the full extension archive already contains it and installs it on first run; with the lite archive, download the pack from GitHub Releases and import it in the settings (“NER model” → “Import pack…”); the model runs offline, on this computer. A lone surname or a rare name may still remain.',
    check_3: 'Embedded objects (OLE attachments) are not anonymized — the extension warns about them or removes them, depending on settings.',
    check_4:
      'Works with .docx, .docm and PDF files that have a text layer. For a PDF the chat receives the text with placeholders (name.anon.md, or .txt in the settings) instead of the PDF: headings, lists and tables are kept, headers, footers and page numbers are removed. Scans, password-protected and empty PDFs are not processed — you can upload them as is after confirming. Chrome or Edge 132 or later is required.',
    open_options: 'Open settings',
    open_restore: 'Restore text',
  },
};
