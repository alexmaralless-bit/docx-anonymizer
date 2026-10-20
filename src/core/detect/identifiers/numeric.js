// Детекторы цифровых/буквенно-цифровых идентификаторов: INN, KPP, OGRN, BIK, ACCOUNT, CARD, IBAN, SWIFT, SNILS, SSN, TAXID.
// Уровни: validated — контрольная сумма/структура пройдена; labeled — рядом лейбл (§4.3). Границы — NB/NA (labels.js).
import { inn, kpp, ogrn, bik, account, accountKeyOk, luhn, mod97, swift, snils, ssn, taxid, IBAN_LENGTHS } from '../../validators.js';
import { NB, NA, labelState, scan, goodsCodeContext } from './labels.js';

const cand = (start, end, confidence, validator) => (validator ? { start, end, confidence, validator } : { start, end, confidence });

/* ---------- ИНН ---------- */
const INN_RE = new RegExp(`${NB}(?:\\d{12}|\\d{10})${NA}`, 'gu');

export function detectInn(text, ctx) {
  const out = [];
  for (const c of scan(text, INN_RE)) {
    const valid = inn(c.text);
    const { mine, foreign } = labelState(text, c.start, ctx, 'INN');
    if (mine) out.push(cand(c.start, c.end, valid ? 'validated' : 'labeled', valid ? 'inn' : undefined));
    // код ТН ВЭД / ОКПД2 / артикул в окне слева или в заголовке столбца — не ИНН (WP11-D)
    else if (valid && !foreign && !goodsCodeContext(text, c.start, c.end, ctx)) out.push(cand(c.start, c.end, 'validated', 'inn'));
  }
  return out;
}

/* ---------- КПП ---------- */
const KPP_RE = new RegExp(`${NB}\\d{4}[0-9A-Z]{2}\\d{3}${NA}`, 'gu');
// «ИНН/КПП 7736050003/773601001» — второй номер без собственного лейбла; между меткой и номерами — до двух слов
// («ИНН/КПП покупателя: X/Y», «ИНН/КПП продавца»), вокруг «/» — пробелы («ИНН / КПП: X / Y») (WP11-D, корпус жанров)
const INN_KPP_RE =
  /(?<![\p{L}\p{N}])(?:ИНН|INN)[ \t\u00a0]*\/[ \t\u00a0]*(?:КПП|KPP)(?:[ \t\u00a0]+[\p{L}.()-]+){0,2}[ \t\u00a0:№#]*(?:\d{12}|\d{10})[ \t\u00a0]*\/[ \t\u00a0]*(\d{4}[0-9A-Z]{2}\d{3})(?![\p{L}\p{N}])/giu;

export function detectKpp(text, ctx) {
  const out = [];
  const seen = new Set();
  for (const c of scan(text, KPP_RE)) {
    const { mine } = labelState(text, c.start, ctx, 'KPP');
    if (mine) {
      out.push(cand(c.start, c.end, 'labeled', kpp(c.text) ? 'kpp' : undefined));
      seen.add(c.start);
    }
  }
  for (const c of scan(text, INN_KPP_RE)) {
    const g = c.m[1];
    const start = c.end - g.length;
    if (!seen.has(start)) out.push(cand(start, c.end, 'labeled', kpp(g) ? 'kpp' : undefined));
  }
  return out;
}

/* ---------- ОГРН / ОГРНИП ---------- */
const OGRN_RE = new RegExp(`${NB}(?:\\d{15}|\\d{13})${NA}`, 'gu');

export function detectOgrn(text, ctx) {
  const out = [];
  for (const c of scan(text, OGRN_RE)) {
    const valid = ogrn(c.text);
    const { mine, foreign } = labelState(text, c.start, ctx, 'OGRN');
    if (mine) out.push(cand(c.start, c.end, valid ? 'validated' : 'labeled', valid ? 'ogrn' : undefined));
    // штрихкод EAN-13 и код товара проходят контрольную сумму ОГРН — без лейбла не берутся (WP11-D)
    else if (valid && !foreign && !goodsCodeContext(text, c.start, c.end, ctx)) out.push(cand(c.start, c.end, 'validated', 'ogrn'));
  }
  return out;
}

/* ---------- БИК ---------- */
const BIK_RE = new RegExp(`${NB}04\\d{7}${NA}`, 'gu');
const BANK_CONTEXT = /(?<![\p{L}])(?:р\/с|к\/с|р\/сч|расч[её]тн\p{L}*\s+сч[её]т|корр\p{L}*|банк\p{L}*|bank|account|сч[её]т)(?![\p{L}])|\d{20}/iu;

export function detectBik(text, ctx) {
  const out = [];
  for (const c of scan(text, BIK_RE)) {
    if (!bik(c.text)) continue;
    const { mine, foreign } = labelState(text, c.start, ctx, 'BIK');
    if (mine) out.push(cand(c.start, c.end, 'validated', 'bik'));
    else if (!foreign && BANK_CONTEXT.test(text.slice(Math.max(0, c.start - 150), c.end + 150))) out.push(cand(c.start, c.end, 'validated', 'bik'));
  }
  return out;
}

/* ---------- счёт ---------- */
const ACCOUNT_RE = new RegExp(`${NB}(?:\\d{20}|\\d{5}[ \\u00a0]\\d{3}[ \\u00a0]\\d[ \\u00a0]\\d{4}[ \\u00a0]\\d{7})${NA}`, 'gu');
const BIK_NEAR_RE = /(?<!\d)04\d{7}(?!\d)/g;
export const BIK_RADIUS = 500;

/** Найден ли в радиусе 500 символов БИК, подходящий к ключу счёта (в пределах одного потока). */
function keyMatchesNearby(text, start, end, acc) {
  const around = text.slice(Math.max(0, start - BIK_RADIUS), end + BIK_RADIUS);
  for (const m of around.matchAll(BIK_NEAR_RE)) if (accountKeyOk(acc, m[0])) return true;
  return false;
}

export function detectAccount(text, ctx) {
  const out = [];
  for (const c of scan(text, ACCOUNT_RE)) {
    if (!account(c.text)) continue;
    const { mine, foreign } = labelState(text, c.start, ctx, 'ACCOUNT');
    const keyOk = keyMatchesNearby(text, c.start, c.end, c.text);
    if (keyOk && !foreign) out.push(cand(c.start, c.end, 'validated', 'account'));
    else if (mine) out.push(cand(c.start, c.end, 'labeled'));
  }
  return out;
}

/**
 * Документный детектор: счёт без лейбла, у которого БИК стоит в соседнем потоке (ячейка таблицы, соседний абзац) —
 * в радиусе 500 символов по порядку обхода в пределах части.
 * @type {import('../../contracts/detector.js').DocumentDetectFn}
 */
export function detectAccountByBikInDocument(doc, entities, ctx) {
  const out = [];
  const streams = doc.streams;
  for (let i = 0; i < streams.length; i++) {
    const s = streams[i];
    if (s.type === 'attr' || s.type === 'deleted') continue;
    for (const c of scan(s.text, ACCOUNT_RE)) {
      if (!account(c.text)) continue;
      if (labelState(s.text, c.start, ctx, 'ACCOUNT').foreign) continue;
      let ok = false;
      // назад: расстояние = символы между концом БИК и началом счёта
      let gap = 0;
      let j = i;
      let seg = s.text.slice(0, c.start);
      for (;;) {
        for (const m of seg.matchAll(BIK_NEAR_RE)) if (seg.length - (m.index + 9) + gap <= BIK_RADIUS && accountKeyOk(c.text, m[0])) ok = true;
        gap += seg.length;
        if (ok || gap > BIK_RADIUS || --j < 0 || streams[j].part !== s.part) break;
        seg = streams[j].text;
      }
      // вперёд: расстояние = символы между концом счёта и началом БИК
      if (!ok) {
        gap = 0;
        j = i;
        seg = s.text.slice(c.end);
        for (;;) {
          for (const m of seg.matchAll(BIK_NEAR_RE)) if (m.index + gap <= BIK_RADIUS && accountKeyOk(c.text, m[0])) ok = true;
          gap += seg.length;
          if (ok || gap > BIK_RADIUS || ++j >= streams.length || streams[j].part !== s.part) break;
          seg = streams[j].text;
        }
      }
      if (ok) out.push({ streamId: s.id, category: 'ACCOUNT', start: c.start, end: c.end, confidence: 'validated', source: 'rule', validator: 'account' });
    }
  }
  return out;
}

/* ---------- банковская карта ---------- */
const CARD_RE = new RegExp(
  `${NB}(?:` +
    `\\d{4}([ \\u00a0-])\\d{6}\\1\\d{5}` + // 4-6-5 (Amex)
    `|\\d{4}([ \\u00a0-])\\d{4}\\2\\d{4}(?:\\2\\d{1,4})?(?:\\2\\d{1,3})?` + // 4-4-4[-4[-3]]
    `|\\d{13,19}` +
    `)${NA}`,
  'gu',
);

export function detectCard(text, ctx) {
  const out = [];
  for (const c of scan(text, CARD_RE)) {
    const digits = c.text.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    const valid = luhn(digits);
    const { mine, foreign } = labelState(text, c.start, ctx, 'CARD');
    if (mine) out.push(cand(c.start, c.end, valid ? 'validated' : 'labeled', valid ? 'luhn' : undefined));
    else if (valid && !foreign) {
      // без лейбла: PAN начинается с 2–6; сплошные 13–15 цифр — скорее ОГРН/ОГРНИП, берём только Amex
      const grouped = /\D/.test(c.text);
      if (!/^[2-6]/.test(digits)) continue;
      if (!grouped && digits.length < 16 && !(digits.length === 15 && /^3[47]/.test(digits))) continue;
      out.push(cand(c.start, c.end, 'validated', 'luhn'));
    }
  }
  return out;
}

/* ---------- IBAN ---------- */
const IBAN_START_RE = /(?<![\p{L}\p{N}])[A-Z]{2}\d{2}(?=[ \u00a0-]?[A-Z0-9])/gu;

export function detectIban(text, ctx) {
  const out = [];
  for (const c of scan(text, IBAN_START_RE)) {
    const len = IBAN_LENGTHS[c.text.slice(0, 2)];
    if (!len) continue;
    let i = c.start;
    let count = 0;
    while (i < text.length && count < len) {
      const ch = text[i];
      if (/[A-Z0-9]/.test(ch)) {
        count++;
        i++;
      } else if ((ch === ' ' || ch === '\u00a0' || ch === '-') && count > 0 && /[A-Z0-9]/.test(text[i + 1] || '')) i++;
      else break;
    }
    if (count !== len || /[\p{L}\p{N}]/u.test(text[i] || '')) continue;
    const valid = mod97(text.slice(c.start, i));
    const { mine, foreign } = labelState(text, c.start, ctx, 'IBAN');
    if (valid && (mine || !foreign)) out.push(cand(c.start, i, 'validated', 'iban'));
    else if (mine) out.push(cand(c.start, i, 'labeled'));
  }
  return out;
}

/* ---------- SWIFT ---------- */
const SWIFT_RE = new RegExp(`${NB}[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?(?![\\p{L}\\p{N}])`, 'gu');

export function detectSwift(text, ctx) {
  const out = [];
  for (const c of scan(text, SWIFT_RE)) {
    if (!swift(c.text)) continue;
    if (labelState(text, c.start, ctx, 'SWIFT').mine) out.push(cand(c.start, c.end, 'labeled', 'swift'));
  }
  return out;
}

/* ---------- СНИЛС ---------- */
const SNILS_RE = new RegExp(`${NB}(?:\\d{3}[- ]\\d{3}[- ]\\d{3}[ -]\\d{2}|\\d{11})${NA}`, 'gu');

export function detectSnils(text, ctx) {
  const out = [];
  for (const c of scan(text, SNILS_RE)) {
    const valid = snils(c.text);
    const { mine, foreign } = labelState(text, c.start, ctx, 'SNILS');
    if (mine) out.push(cand(c.start, c.end, valid ? 'validated' : 'labeled', valid ? 'snils' : undefined));
    else if (valid && !foreign) out.push(cand(c.start, c.end, 'validated', 'snils'));
  }
  return out;
}

/* ---------- SSN ---------- */
const SSN_RE = new RegExp(`${NB}(?:\\d{3}-\\d{2}-\\d{4}|\\d{3} \\d{2} \\d{4}|\\d{9})${NA}`, 'gu');

export function detectSsn(text, ctx) {
  const out = [];
  for (const c of scan(text, SSN_RE)) {
    if (!labelState(text, c.start, ctx, 'SSN').mine) continue;
    const valid = ssn(c.text);
    out.push(cand(c.start, c.end, valid ? 'validated' : 'labeled', valid ? 'ssn' : undefined));
  }
  return out;
}

/* ---------- налоговый ID (EIN / UTR / VAT) ---------- */
const TAXID_RE = new RegExp(`${NB}(?:\\d{2}-\\d{7}|[A-Z]{2}[ ]?[0-9A-Z]{8,12}|\\d{10})(?![\\p{L}\\p{N}])`, 'gu');

// UK VAT с пробелами внутри: «GB 318 4471 26», «GB318 4471 26 001» (WP11-E, финальная проверка)
const UK_VAT_RE = new RegExp(`${NB}GB[ ]?\\d{3}[ ]?\\d{4}[ ]?\\d{2}(?:[ ]?\\d{3})?(?![\\p{L}\\p{N}])`, 'gu');
/** UK VAT без метки: «GB» и 9 цифр группами 3-4-2 через пробел — формат, который не спутать с другими номерами. */
const UK_VAT_SPACED_RE = /^GB ?\d{3} \d{4} \d{2}$/;

export function detectTaxId(text, ctx) {
  const out = [];
  const seen = new Set();
  for (const c of scan(text, TAXID_RE)) {
    if (!taxid(c.text)) continue;
    if (labelState(text, c.start, ctx, 'TAXID').mine) {
      out.push(cand(c.start, c.end, 'labeled', 'taxid'));
      seen.add(c.start);
    }
  }
  for (const c of scan(text, UK_VAT_RE)) {
    if (seen.has(c.start) || !taxid(c.text)) continue;
    if (labelState(text, c.start, ctx, 'TAXID').mine || UK_VAT_SPACED_RE.test(c.text)) out.push(cand(c.start, c.end, 'labeled', 'taxid'));
  }
  return out;
}
