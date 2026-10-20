// Стоп-список модельных организаций (версия 0.4, концепция п. 4, К10; §5.2 NLP `docs/spec-full.md`): аббревиатуры
// деловых документов, названия программ и сервисов, которые модель NER (обученная на WikiANN) принимает за ORG.
// Дополняется из настроек (`settings.nerStoplist`). Сравнение — без учёта регистра, «ё» = «е», кириллица и латиница
// одного начертания совпадают (1С = 1C, ВЭД = BЭД), см. `stopKey`. Названия, которые пишутся по-разному
// (Яндекс/Yandex, Битрикс24/Bitrix24), перечислены обоими написаниями.
// Чистые данные: без chrome.* и DOM.
import { NEVER_MASK_ORGS, wordList } from '../detect/names/lexicon.js';

/** Аббревиатуры деловых и технических документов (не названия организаций). */
// Группы: документы и реквизиты; ИТ и маркетинг.
// prettier-ignore
export const STOP_ABBREVIATIONS = [
  ...wordList(`ЭДО|ВЭД|ТН ВЭД|УПД|УКД|ТЗ|ТКП|КП|ФИО|НДС|НДФЛ|ИНН|КПП|ОГРН|ОГРНИП|БИК|ОКПО|ОКВЭД|ОКТМО|ОКАТО
ТТН|ТН|ТОРГ-12|КС-2|КС-3|УСН|ОСНО|ПСН|ЕНС|ЕГРЮЛ|ЕГРИП|ЭЦП|ЭП|КЭП|УКЭП|НЭП|ПЭП|МЧД|СЧФ
р/с|к/с|ЛК|ПО|ИТ|ИИ|ГОСТ|СНиП|СанПиН|ПМИ|ПИР|СМР|ППР|ИД|ОТК|ТО|ЗИП|ГСМ|ДДУ|ЖКХ|ЦФО
РФ|РК|РБ|ЕАЭС|СНГ|ЕС|США|ЮЛ|ФЛ|ИП|НКО|СМИ|ЧаВо|FAQ|ПДн|ПД|СМС|NPS`),
  ...wordList(`MVP|API|CRM|ERP|SaaS|PaaS|IaaS|KPI|OKR|QR|PDF|DOCX|XLSX|PPTX|CSV|JSON|XML|HTML|CSS|SQL|URL
IT|AI|ML|LLM|BI|UX|UI|UX/UI|UI/UX|SEO|SMM|PR|HR|B2B|B2C|B2G|ROI|SLA|NDA|SDK|VPN|SSL
SMS|SMTP|HTTP|HTTPS|OCR|RPA|BPM|DevOps|QA|PM|CEO|CTO|CFO|ASAP|PS|TBD|N/A|Ltd|LLC|Inc|KYC|AML|MSc|MBA|BSc|PhD|Confidential Information`),
];

/** Программы, сервисы и платформы (продукты, а не стороны документа). */
// Группы: обращения и формулы вежливости в начале строки («Thank you», «Dear Ms. …»); бренд владельца не маскируется никогда (решение
// владельца 6, концепция 0.4) — общий список NEVER_MASK_ORGS (names/lexicon.js).
// prettier-ignore
export const STOP_PRODUCTS = [
  ...wordList(`Word|Excel|PowerPoint|Outlook|Teams|OneDrive|SharePoint|Office|Microsoft Office|MS Office|Microsoft 365|Office 365
MS Word|MS Excel|Microsoft Word|Microsoft Excel|Microsoft Teams|Microsoft|Windows|macOS|Linux|Android|iOS
Telegram|Телеграм|Телеграмм|WhatsApp|Ватсап|Вотсап|Viber|Вайбер|Zoom|Зум|Skype|Скайп|Slack|Discord
Google|Гугл|Google Docs|Google Drive|Google Sheets|Google Meet|Gmail|Chrome|Firefox|Safari|YouTube|Ютуб
Яндекс|Yandex|Яндекс.Диск|Яндекс Диск|Яндекс.Почта|Яндекс Почта|Яндекс.Телемост|Телемост|Яндекс 360|Яндекс.Директ
Яндекс.Метрика|Mail.ru|Почта Mail.ru|VK|ВК|ВКонтакте|VK Teams|VK WorkSpace|Одноклассники
1С|1С:Предприятие|1С:Бухгалтерия|1С:УНФ|1С:ERP|1С:Документооборот|1С:ЗУП|1С:УТ|1С:Фреш
Битрикс|Битрикс24|Bitrix|Bitrix24|amoCRM|АмоCRM|Мегаплан|Jira|Confluence|Notion|Trello|Miro|Figma|Фигма
Tilda|Тильда|WordPress|Photoshop|Illustrator|Acrobat|Adobe Acrobat|Adobe|Canva|ChatGPT|GPT|Claude|GigaChat
YandexGPT|Контур.Диадок|Диадок|Контур.Эльба|СБИС|Сбис|Госуслуги|Честный знак
Power BI|Tableau|Looker|Metabase|Grafana|Qlik|Excel-таблица|PDF-файл|Word-файл|GitHub|GitLab|Docker|Kubernetes|PostgreSQL|MySQL|Python|JavaScript|Postman`),
  ...wordList(`Thank|Thanks|Dear|Sincerely|Regards|Best regards|Kind regards|Hello|Hi|Здравствуйте|Добрый день|Спасибо
Уважаемый|Уважаемая|Уважаемые|Коллеги|С уважением`),
  ...NEVER_MASK_ORGS,
];

// Кириллические буквы, совпадающие по начертанию с латинскими: «1С» и «1C», «ВЭД» с латинской «B» — одно слово.
const HOMOGLYPHS = { а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x' };

/**
 * Ключ сравнения стоп-списка: нижний регистр, «ё» → «е», кириллица одного начертания с латиницей → латиница,
 * пробелы и точки между словами — одним пробелом, кавычки и знаки по краям отброшены.
 * @param {string} s
 */
export function stopKey(s) {
  return String(s)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[авекмнорстух]/g, (c) => HOMOGLYPHS[c])
    .replace(/[«»"“”„'‘’]/g, '')
    .replace(/[\s\u00a0.]+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}+]+$/gu, '')
    .trim();
}

/** Встроенный стоп-список (ключи `stopKey`). */
export const BUILTIN_STOPLIST = Object.freeze(new Set([...STOP_ABBREVIATIONS, ...STOP_PRODUCTS].map(stopKey)));

/**
 * Стоп-список документа: встроенный ∪ пользовательский (`settings.nerStoplist`).
 * @param {unknown} [extra]
 * @returns {Set<string>}
 */
export function buildStoplist(extra) {
  const set = new Set(BUILTIN_STOPLIST);
  if (Array.isArray(extra)) {
    for (const x of extra) {
      if (typeof x !== 'string') continue;
      const k = stopKey(x);
      if (k) set.add(k);
    }
  }
  return set;
}
