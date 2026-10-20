// Обращение одним именем (версия 0.4, WP11-D; FR-23 — имена третьих лиц без лейблов): «Елена, спасибо…»,
// «Наталья, добрый день!», «Максим, привет» в начале реплики или письма. Корпус жанров (переписка) показал утечку:
// словарный детектор ищет пары слов, а одиночное имя без фамилии не находилось.
//
// Правило: имя из словаря имён (именительный падеж — форма обращения) стоит в начале строки потока или сразу после
// метки реплики («Иван: », «[10:42] Иван Петров:», «10:42 Поддержка:»), за ним — запятая или «!»; либо после
// приветствия в начале строки («Здравствуйте, Елена!», «Добрый день, Максим.», «Hi Anna,»).
// Имя-омоним нарицательного («Вера», «Надежда», «Любовь», «Роза», «Слава»; по словарю — и «Лена», «Максим», «Роман»)
// в начале строки — только после метки реплики или приветствия, либо когда за запятой идёт слово обращения
// («Максим, привет», «Лена, спасибо»); перечисление («Вера, надежда, любовь») — не обращение.
// Уровень находки — kb (kb.js), canonical — запись о лице с этим именем, если она в документе одна
// («Елена Тихонова» и «Елена, спасибо» — одна метка).
// Чистый JS без chrome.* и DOM.
import { lowerE, isStopWord, COMMON_NOUNS, FIRST_NAMES_EN, STOP_EXACT } from './lexicon.js';
import { bigFirstNameInfo } from './dict/index.js';
import { TOPONYM_BEFORE_RE } from './person.js';

const SP = '[ \\t\\u00a0]';
/** Метка реплики: необязательное время в скобках или без, затем 1–3 слова с заглавной и двоеточие. */
const SPEAKER_RE = new RegExp(
  `^${SP}*(?:>+${SP}*)?(?:\\[[^\\]\\n]{1,40}\\]${SP}*|\\d{1,2}:\\d{2}(?::\\d{2})?${SP}+)?(?:(\\p{Lu}[\\p{L}.'’-]*(?:${SP}+\\p{Lu}[\\p{L}.'’-]*){0,2})${SP}*:${SP}+)?`,
  'u',
);
/** Приветствие перед именем: «Здравствуйте, », «Добрый день, », «Привет, », «Hi », «Hello, ». */
const GREETING_RE = new RegExp(
  `^(?:здравствуй(?:те)?|добр(?:ый|ое|ого)${SP}+(?:день|утро|вечер|дня|утра|вечера)|привет(?:ствую)?|доброго${SP}+времени${SP}+суток|hello|hi|hey|good${SP}+(?:morning|afternoon|evening))${SP}*,?${SP}*`,
  'iu',
);
/** Имя и запятая или «!» после него. */
const NAME_RE = new RegExp(`^(\\p{Lu}\\p{Ll}+)(?=${SP}*[,!])`, 'u');
/** Имя после приветствия: дальше запятая, «!», точка или конец строки. */
const NAME_AFTER_GREETING_RE = new RegExp(`^(\\p{Lu}\\p{Ll}+)(?=${SP}*(?:[,!.]|$))`, 'u');
/** Перечисление после имени: «Вера, надежда, любовь», «Роза, лилия и мак». */
// «и» — отдельным словом («подскажи пароль» — не «…и »)
const ENUM_RE = new RegExp(`^${SP}*,${SP}*\\p{Ll}+(?:${SP}*,|${SP}+и${SP})`, 'u');
/** Слово обращения после запятой: «Максим, привет», «Лена, спасибо», «Рома, подскажи». */
const ADDRESS_WORD_RE = new RegExp(
  `^${SP}*,${SP}*(?:привет\\p{L}*|здравствуй\\p{L}*|добр(?:ый|ое|ого)|спасибо|благодар\\p{L}*|пожалуйста|прошу|извин\\p{L}*|прост(?:и|ите)|подскаж\\p{L}*|посмотр\\p{L}*|глян\\p{L}*|пришл\\p{L}*|напомн\\p{L}*|уточн\\p{L}*|скин\\p{L}*|проверь\\p{L}*|напиш\\p{L}*|позвон\\p{L}*|ответь\\p{L}*|зайди\\p{L}*|сделай\\p{L}*|отправь\\p{L}*|можешь|можете|сможешь|сможете|ты|вы|у${SP}+(?:тебя|вас))(?![\\p{L}])`,
  'iu',
);

/**
 * Имя — обращение? `strong` — не омоним нарицательного.
 * @param {string} word
 * @returns {{script: 'cyr'|'lat', strong: boolean} | null}
 */
function nameInfo(word) {
  const w = lowerE(word);
  if (isStopWord(word) || STOP_EXACT.has(w)) return null;
  if (/^[a-z]+$/.test(w)) return FIRST_NAMES_EN.has(w) && !COMMON_NOUNS.has(w) ? { script: 'lat', strong: true } : null;
  if (!/^[а-я]+$/.test(w)) return null;
  // обращение — именительный падеж (падеж 0)
  const infos = bigFirstNameInfo(w).filter((x) => x.cases.includes(0));
  if (!infos.length) return null;
  return { script: 'cyr', strong: infos.some((x) => !x.ambiguous) && !COMMON_NOUNS.has(w) };
}

/**
 * Обращения одним именем в тексте потока: по одному на строку (начало потока и каждая строка после `\n`).
 * @param {string} text
 * @returns {{start: number, end: number, name: string, script: 'cyr'|'lat', speaker: boolean}[]}
 */
export function findVocativeNames(text) {
  const out = [];
  let lineStart = 0;
  for (;;) {
    const nl = text.indexOf('\n', lineStart);
    const line = text.slice(lineStart, nl < 0 ? text.length : nl);
    const pre = SPEAKER_RE.exec(line);
    let at = pre ? pre[0].length : 0;
    const speaker = !!pre?.[1];
    const greet = GREETING_RE.exec(line.slice(at));
    if (greet) at += greet[0].length;
    const m = (greet ? NAME_AFTER_GREETING_RE : NAME_RE).exec(line.slice(at));
    const info = m ? nameInfo(m[1]) : null;
    if (m && info) {
      const after = line.slice(at + m[1].length);
      // омоним нарицательного: нужна метка реплики, приветствие или слово обращения после запятой; не перечисление
      // повелительное наклонение или слово обращения после запятой («Вера, посмотри, пожалуйста») — не перечисление
      const address = ADDRESS_WORD_RE.test(after);
      const ok = info.strong || ((speaker || greet || address) && (address || !ENUM_RE.test(after)));
      if (ok) out.push({ start: lineStart + at, end: lineStart + at + m[1].length, name: m[1], script: info.script, speaker });
    }
    // WP11-E: подпись сообщения Telegram строкой целиком «Имя, [дата время]», «Имя Ф., [дата время]» — имя из словаря
    const tg = TG_SIGNATURE_RE.exec(line);
    if (tg && nameInfo(tg[1]) && !out.some((v) => v.start === lineStart + tg.index)) {
      const len = tg[1].length + (tg[2] ? tg[2].length : 0);
      out.push({ start: lineStart + tg.index, end: lineStart + tg.index + len, name: tg[1], script: nameInfo(tg[1])?.script || 'cyr', speaker: false });
    } else if (tg?.[2]) {
      // обращение по началу строки уже найдено — подпись «Имя Ф.» продлевает его до инициала
      const v = out.find((x) => x.start === lineStart + tg.index);
      if (v) v.end = v.start + tg[1].length + tg[2].length;
    }
    // WP11-E: подпись реплики одним именем («[09:01] Ринат: …») — имя не омоним
    if (pre?.[1] && !/\s/u.test(pre[1])) {
      const si = nameInfo(pre[1]);
      const off = line.indexOf(pre[1]);
      if (si?.strong && off >= 0) out.push({ start: lineStart + off, end: lineStart + off + pre[1].length, name: pre[1], script: si.script, speaker: false });
    }
    // WP11-E: внутри строки — «…. Тамара, а кто…» (после конца предложения, за именем запятая), «Спасибо, Ринат!»,
    // «потом Святослав.» (перед именем запятая или строчное слово, за ним конец предложения); только имена не омонимы
    for (const re of [INNER_COMMA_RE, INNER_END_RE])
      for (const mm of line.matchAll(re)) {
        const name = mm[1];
        const pos = /** @type {number} */ (mm.index) + mm[0].length - name.length;
        // «г. Владимир,», «ул. Мира.» — топоним после сокращения, не обращение
        if (TOPONYM_BEFORE_RE.test(line.slice(Math.max(0, pos - 14), pos))) continue;
        const si = pos > at || !m ? nameInfo(name) : null;
        if (!si?.strong || out.some((v) => v.start === lineStart + pos)) continue;
        out.push({ start: lineStart + pos, end: lineStart + pos + name.length, name, script: si.script, speaker: false });
      }
    if (nl < 0) break;
    lineStart = nl + 1;
  }
  return out;
}

/** Подпись Telegram: «Арсений, [14.10.2026 10:11]», «Валерия К., [14.10.2026 10:05]» — строка целиком. */
const TG_SIGNATURE_RE = new RegExp(`^${SP}*(\\p{Lu}\\p{Ll}+)( \\p{Lu}\\.)?,${SP}*\\[[^\\]\\n]{4,40}\\]${SP}*$`, 'u');
/** Имя внутри строки после конца предложения, за ним запятая: «…. Тамара, а кто…». */
const INNER_COMMA_RE = new RegExp(`[.!?…]${SP}+(\\p{Lu}\\p{Ll}+)(?=${SP}*,)`, 'gu');
/** Имя в конце фразы: перед ним запятая или строчное слово, за ним «!», «.», «?»: «Спасибо, Ринат!», «потом Святослав.». */
const INNER_END_RE = new RegExp(`(?:,${SP}*|(?<=\\p{Ll})${SP}+)(\\p{Lu}\\p{Ll}+)(?=${SP}*[!?.](?:${SP}|$))`, 'gu');
