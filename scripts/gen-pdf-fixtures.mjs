#!/usr/bin/env node
// Генератор PDF-фикстур (версия 0.3, К1): синтетические договоры из scripts/gen-fixtures.mjs и образец make-sample.mjs →
// HTML (обход WordprocessingML: абзацы, жирный, таблицы, вложенные таблицы, списки, надписи) → PDF через Chromium Playwright
// (A4, колонтитулы шаблонами page.pdf). Плюс LibreOffice-версии (ip-contract.lo, two-companies.lo, зашифрованный PDF),
// «скан» (страница-картинка), смешанный документ, пустой PDF (/Count 0) и perf-50p (50 страниц ≈ 20 000 слов, К6).
// По ревью WP10-A: «дикие» wild-mono / wild-landscape / wild-2col (другие шрифт, кегль, альбом, колонки), rotated
// (/Rotate 270 с повёрнутым содержимым), structures.lo и sample-contract.lo.
// Все данные ВЫМЫШЛЕННЫЕ. Сети не требует.
//
// Для каждого текстового PDF пишутся `<имя>.gold.json` (значения для проверки утечек, К2) и `<имя>.txt` — снимок
// Markdown после разметки (core/pdf/layout.js). Байты PDF недетерминированы (дата создания, шрифты), поэтому
// tests/integration/pdf-fixtures.spec.js сверяет со снимком извлечение, а не байты. Снимки перезаписываются только
// с флагом --update-snapshots (или если снимка ещё нет).
//
// Использование: npm run gen-pdf-fixtures [-- --update-snapshots] [--out=<каталог>] [--only=<имя,имя>]
//   --snapshots-only — пересчитать только снимки .txt из записанных PDF (после правки разметки)
// Из кода: import { buildPdfFixtures } from './scripts/gen-pdf-fixtures.mjs' → [{name, bytes, gold, kind}]
import { chromium } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFixtures } from './gen-fixtures.mjs';
import { buildSampleDocx, inn10, r, p, B } from './make-sample.mjs';
import { readZip, inflateEntry } from '../src/core/docx/zip.js';
import { tokenize, parseAttrs, unescapeXml } from '../src/core/docx/xml.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PDF_FIXTURES_DIR = join(root, 'tests/fixtures/pdf');

/* ---------- WordprocessingML → дерево ---------- */

/** Минимальное дерево XML на линейном токенизаторе ядра: {name, attrs, children} | {text}. */
function parseTree(xml) {
  const rootNode = { name: '#root', attrs: {}, children: [] };
  const stack = [rootNode];
  tokenize(xml, (t) => {
    const top = stack[stack.length - 1];
    if (t.type === 'open' || t.type === 'selfclose') {
      const attrs = Object.fromEntries(parseAttrs(xml, t.attrStart, t.attrEnd).map((a) => [a.name, unescapeXml(a.raw)]));
      const node = { name: t.name, attrs, children: [] };
      top.children.push(node);
      if (t.type === 'open') stack.push(node);
    } else if (t.type === 'close') {
      if (stack.length > 1) stack.pop();
    } else if (t.type === 'text') {
      top.children.push({ text: unescapeXml(xml.slice(t.start, t.end)) });
    }
  });
  return rootNode;
}

const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const child = (n, name) => n.children?.find((c) => c.name === name);
const on = (n) => !!n && n.attrs?.['w:val'] !== '0' && n.attrs?.['w:val'] !== 'false';

/**
 * document.xml → HTML тела. Живой текст (w:t), без удалённого (w:del), полей (w:instrText), комментариев и сносок;
 * надписи (wps:txbx / v:textbox) — отдельными абзацами после абзаца, в котором стоят; из mc:AlternateContent — только Choice.
 * @param {string} xml
 * @param {{columns?: [number, number], list?: [number, number]}} [opts] columns — диапазон верхнеуровневых абзацев [от, до)
 *   в две колонки, list — диапазон абзацев, которые выводятся пунктами маркированного списка
 */
export function documentToHtml(xml, opts = {}) {
  const tree = parseTree(xml);
  const body = findDeep(tree, 'w:body');
  if (!body) throw new Error('нет w:body');
  const out = [];
  let topIndex = 0;
  let inCols = false;
  for (const n of body.children) {
    if (!n.name) continue;
    if (n.name === 'w:p' || n.name === 'w:tbl' || n.name === 'w:sdt') {
      if (opts.columns) {
        if (topIndex === opts.columns[0] && !inCols) {
          out.push('<div class="cols">');
          inCols = true;
        }
        if (topIndex === opts.columns[1] && inCols) {
          out.push('</div>');
          inCols = false;
        }
      }
      topIndex++;
    }
    const asList = opts.list && n.name === 'w:p' && topIndex - 1 >= opts.list[0] && topIndex - 1 < opts.list[1];
    out.push(asList ? renderParagraph(n, true) : renderBlock(n));
  }
  if (inCols) out.push('</div>');
  return out.join('\n');
}

function findDeep(n, name) {
  if (n.name === name) return n;
  for (const c of n.children || []) {
    const f = findDeep(c, name);
    if (f) return f;
  }
  return null;
}

function renderBlock(n) {
  if (n.name === 'w:p') return renderParagraph(n);
  if (n.name === 'w:tbl') return renderTable(n);
  if (n.name === 'w:sdt') return (child(n, 'w:sdtContent')?.children || []).map(renderBlock).join('\n');
  return '';
}

function renderTable(tbl) {
  const rows = tbl.children.filter((c) => c.name === 'w:tr');
  return `<table>${rows
    .map(
      (tr) =>
        `<tr>${tr.children
          .filter((c) => c.name === 'w:tc')
          .map((tc) => `<td>${tc.children.map(renderBlock).join('')}</td>`)
          .join('')}</tr>`,
    )
    .join('')}</table>`;
}

function renderParagraph(pNode, forceList = false) {
  const pPr = child(pNode, 'w:pPr');
  const style = child(pPr || {}, 'w:pStyle')?.attrs['w:val'] || '';
  const jc = child(pPr || {}, 'w:jc')?.attrs['w:val'];
  const list = forceList || !!child(pPr || {}, 'w:numPr');
  const deferred = [];
  const inner = renderInline(pNode.children, {}, deferred);
  const align = jc === 'center' ? 'center' : jc === 'both' ? 'justify' : jc === 'right' ? 'right' : '';
  const st = align ? ` style="text-align:${align}"` : '';
  let html;
  if (/^heading/i.test(style)) html = `<h2${st}>${inner}</h2>`;
  else if (list) html = `<ul><li${st}>• ${inner}</li></ul>`;
  else html = `<p${st}>${inner || '&nbsp;'}</p>`;
  if (!inner.trim() && !deferred.length) html = '<p class="empty">&nbsp;</p>';
  return [html, ...deferred.map((d) => `<div class="box">${d}</div>`)].join('\n');
}

function renderInline(nodes, fmt, deferred) {
  let s = '';
  for (const n of nodes || []) {
    if (!n.name) continue;
    switch (n.name) {
      case 'w:pPr':
      case 'w:del':
      case 'w:moveFrom':
      case 'w:instrText':
      case 'w:delText':
      case 'w:fldChar':
      case 'w:commentRangeStart':
      case 'w:commentRangeEnd':
      case 'w:bookmarkStart':
      case 'w:bookmarkEnd':
        break;
      case 'w:r': {
        const rPr = child(n, 'w:rPr');
        const f = {
          b: on(child(rPr || {}, 'w:b')),
          i: on(child(rPr || {}, 'w:i')),
          sup: child(rPr || {}, 'w:vertAlign')?.attrs['w:val'] === 'superscript',
        };
        let t = '';
        for (const c of n.children) {
          if (c.name === 'w:t') t += escHtml(c.children.map((x) => x.text || '').join(''));
          else if (c.name === 'w:tab') t += '&emsp;&emsp;';
          else if (c.name === 'w:br') t += c.attrs['w:type'] === 'page' ? '<span class="pb"></span>' : '<br>';
          else if (c.name === 'w:noBreakHyphen') t += '\u2011';
          else if (c.name === 'mc:AlternateContent') {
            const choice = child(c, 'mc:Choice');
            collectBoxes(choice, deferred);
          } else if (c.name === 'w:pict' || c.name === 'w:drawing') collectBoxes(c, deferred);
        }
        if (!t) break;
        if (f.sup) break; // сноски и примечания в PDF-фикстуры не попадают
        if (f.b) t = `<b>${t}</b>`;
        if (f.i) t = `<i>${t}</i>`;
        s += t;
        break;
      }
      default:
        // w:ins, w:hyperlink, w:fldSimple, w:smartTag, w:sdt/w:sdtContent внутри абзаца — содержимое как есть
        s += renderInline(n.name === 'w:sdt' ? child(n, 'w:sdtContent')?.children : n.children, fmt, deferred);
    }
  }
  return s;
}

function collectBoxes(n, deferred) {
  if (!n) return;
  const box = findDeep(n, 'w:txbxContent');
  if (box) deferred.push(box.children.map(renderBlock).join('\n'));
}

const CSS = `
  body { font-family: 'Times New Roman', 'Liberation Serif', serif; font-size: 12pt; line-height: 1.25; margin: 0; color: #000; }
  p { margin: 0 0 9pt; }
  p.empty { margin: 0; line-height: 0.5; }
  h2 { font-size: 15pt; margin: 6pt 0 9pt; }
  td p { margin: 0; }
  table { border-collapse: collapse; width: 100%; margin: 6pt 0 14pt; table-layout: fixed; }
  td { border: 0.5pt solid #000; padding: 4pt 12pt; vertical-align: top; }
  td table { margin: 4pt 0; }
  ul { list-style: none; padding: 0; margin: 0 0 6pt; }
  li { margin: 0; }
  .cols { column-count: 2; column-gap: 14mm; text-align: justify; margin: 0 0 9pt; }
  .box { border: 0.5pt solid #000; padding: 4pt; margin: 0 0 9pt; }
  .pb { display: block; break-before: page; }
`;

/** HTML документа A4. */
export function htmlPage(bodyHtml) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>${CSS}</style></head><body>${bodyHtml}</body></html>`;
}

const FOOTER =
  '<div style="font-size:9px;width:100%;text-align:center;font-family:serif">Страница <span class="pageNumber"></span> из <span class="totalPages"></span></div>';
const headerTpl = (text) => `<div style="font-size:9px;width:100%;text-align:center;font-family:serif">${escHtml(text)}</div>`;

export async function htmlToPdf(browser, html, header) {
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    return new Uint8Array(
      await page.pdf({
        format: 'A4',
        displayHeaderFooter: true,
        headerTemplate: header ? headerTpl(header) : '<div></div>',
        footerTemplate: FOOTER,
        margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
        printBackground: false,
      }),
    );
  } finally {
    await page.close();
  }
}

export function documentXml(docxBytes) {
  const e = readZip(docxBytes).find((x) => x.name === 'word/document.xml');
  return new TextDecoder().decode(inflateEntry(/** @type {any} */ (e)));
}

/* ---------- perf-50p ---------- */

// prettier-ignore
const PERF_PEOPLE = [
  ['Корнилов', 'Степан', 'Аркадьевич'], ['Ветрова', 'Лидия', 'Олеговна'], ['Шубин', 'Матвей', 'Ильич'], ['Галкина', 'Ульяна', 'Романовна'],
  ['Лаптев', 'Игнат', 'Семёнович'], ['Широкова', 'Таисия', 'Глебовна'], ['Дроздов', 'Ростислав', 'Юрьевич'], ['Абрамова', 'Нелли', 'Вадимовна'],
  ['Колосов', 'Тимур', 'Эдуардович'], ['Рябинина', 'Злата', 'Артёмовна'],
];

/** 50 страниц ≈ 20 000 слов: пункты договора с ФИО и ИНН (К6). */
export function perfDocument() {
  const gold = [];
  const parts = [p(r('ДОГОВОР ПОДРЯДА № 50/П-2026 (сводный)', B), '<w:jc w:val="center"/>')];
  const inns = PERF_PEOPLE.map((_, i) => inn10(String(770100100 + i * 1013)));
  PERF_PEOPLE.forEach(([s, f, m], i) => {
    gold.push({ key: `person${i}`, category: 'PERSON', value: `${s} ${f} ${m}` });
    gold.push({ key: `inn${i}`, category: 'INN', value: inns[i] });
  });
  const filler =
    'Стороны обязуются соблюдать порядок приёмки работ, сроки и требования к качеству, установленные техническим заданием, ' +
    'а также своевременно уведомлять друг друга об обстоятельствах, препятствующих исполнению обязательств по настоящему договору.';
  let n = 0;
  for (let sec = 1; n < 400; sec++) {
    parts.push(p(r(`${sec}. ПОРЯДОК ВЫПОЛНЕНИЯ РАБОТ ЭТАПА ${sec}`, B)));
    for (let k = 1; k <= 9 && n < 400; k++, n++) {
      const [s, f, m] = PERF_PEOPLE[n % PERF_PEOPLE.length];
      const inn = inns[n % PERF_PEOPLE.length];
      parts.push(
        p(
          r(
            `${sec}.${k}. Ответственным за этап назначен представитель Подрядчика ${s} ${f} ${m} (ИНН ${inn}), который согласует график работ с Заказчиком. ` +
              filler,
          ),
          '<w:jc w:val="both"/>',
        ),
      );
    }
  }
  const xml = `<w:document xmlns:w="w"><w:body>${parts.join('')}</w:body></w:document>`;
  return { xml, gold };
}

/* ---------- картинка без текста ---------- */

async function scanPng(browser) {
  const page = await browser.newPage({ viewport: { width: 600, height: 400 } });
  try {
    await page.setContent(
      '<body style="margin:0;background:#fff;font:20px serif"><div style="padding:30px">ДОГОВОР № 7<br>Страница отсканирована: текст есть только на картинке.<br>Подпись: __________</div></body>',
    );
    return await page.screenshot({ type: 'png' });
  } finally {
    await page.close();
  }
}

/** PDF без страниц: каталог с /Pages /Count 0 и корректной таблицей xref. */
export function emptyPdf() {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [] /Count 0 >>'];
  let s = '%PDF-1.4\n';
  const off = [];
  objs.forEach((o, i) => {
    off.push(s.length);
    s += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const x = s.length;
  s +=
    `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    off.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return new TextEncoder().encode(s);
}

/* ---------- «дикие» PDF: другой шрифт и кегль, альбом, две колонки, моноширинный ---------- */

// Реквизиты «диких» договоров (ВЫМЫШЛЕННЫЕ, как и всё в фикстурах).
const WILD = {
  co1: 'Звёздный путь',
  inn1: '7736050003',
  kpp1: '773601001',
  ogrn1: '1025004012340',
  co2: 'Вектор-М',
  inn2: '500400123402',
  dir1: 'Петров Иван Сергеевич',
  dir1g: 'Петрова Ивана Сергеевича',
  dir2g: 'Смирновой Елены Александровны',
  dir2: 'Смирнова Елена Александровна',
  tel: '+7 (495) 765-43-21',
  mail: 'ivan.petrov@zvezda.example',
  rs: '40702810700000012345',
  ks: '30101810300000000901',
  bik: '044525901',
  pass: '45 05 123456',
  snils: '112-233-445 95',
  addr: '123456, г. Москва, ул. Ленина, д. 1, офис 5',
};
// prettier-ignore
export const WILD_GOLD = [
  ['COMPANY', WILD.co1], ['INN', WILD.inn1], ['KPP', WILD.kpp1], ['OGRN', WILD.ogrn1], ['COMPANY', WILD.co2], ['INN', WILD.inn2],
  ['PERSON', WILD.dir1], ['PERSON', WILD.dir1g], ['PERSON', WILD.dir2g], ['PERSON', WILD.dir2], ['PHONE', WILD.tel], ['EMAIL', WILD.mail],
  ['ACCOUNT', WILD.rs], ['ACCOUNT', WILD.ks], ['BIK', WILD.bik], ['PASSPORT', WILD.pass], ['SNILS', WILD.snils],
].map(([category, value], i) => ({ key: `w${i}`, category, value }));

/** HTML «дикого» договора: вступление, пункты-заполнители, таблица позиций (числа вправо), реквизиты. */
function wildHtml({ font, size, extra = '', filler = 4, cols = false, items = false }) {
  const P = WILD;
  const fill = Array.from(
    { length: filler },
    (_, i) =>
      `<p>${i + 2}.1. Стороны руководствуются условиями настоящего договора и действующим законодательством Российской Федерации; ` +
      'все уведомления направляются уполномоченным представителям сторон в письменной форме не позднее пяти рабочих дней с даты ' +
      'наступления соответствующего обстоятельства, включая изменение банковских реквизитов и адресов.</p>',
  ).join('\n');
  const intro = `<h1>ДОГОВОР ОКАЗАНИЯ УСЛУГ № 42/ЗП-2026</h1>
<p class="row"><span>г. Москва</span><span>1 октября 2026 г.</span></p>
<p>ООО «${P.co1}», ИНН ${P.inn1}, КПП ${P.kpp1}, ОГРН ${P.ogrn1}, именуемое в дальнейшем «Исполнитель», в лице генерального директора ${P.dir1g}, действующего на основании Устава, с одной стороны, и АО «${P.co2}», ИНН ${P.inn2}, в лице генерального директора ${P.dir2g}, действующей на основании Устава, с другой стороны, заключили настоящий договор.</p>
<p>1.1. Контактное лицо Исполнителя — ${P.dir1}, тел. ${P.tel}, e-mail ${P.mail}; паспорт ${P.pass}, СНИЛС ${P.snils}.</p>
<p>1.2. Оплата производится на расчётный счёт ${P.rs} в банке с БИК ${P.bik}, корреспондентский счёт ${P.ks}.</p>
<ul><li>оказание консультационных услуг;</li><li>подготовка отчётов;</li></ul>
<p># Хештег в начале абзаца и вертикальная черта | внутри текста.</p>`;
  const table = `<table class="items"><tr><th>№</th><th>Наименование</th><th>Кол-во</th><th>Цена, руб.</th></tr>
<tr><td>1</td><td>Консультация</td><td class="r">10</td><td class="r">15 000,00</td></tr>
<tr><td>2</td><td>Отчёт</td><td class="r">2</td><td class="r">120 500,50</td></tr>
<tr><td>3</td><td>Сопровождение</td><td class="r">1</td><td class="r">7 000,00</td></tr></table>`;
  const req = `<h2>РЕКВИЗИТЫ И ПОДПИСИ СТОРОН</h2>
<table><tr><td>Исполнитель:</td><td>Заказчик:</td></tr>
<tr><td>ООО «${P.co1}»</td><td>АО «${P.co2}»</td></tr>
<tr><td>ИНН/КПП ${P.inn1}/${P.kpp1}</td><td>ИНН ${P.inn2}</td></tr>
<tr><td>ОГРН ${P.ogrn1}</td><td>Адрес: 141000, Московская обл., г. Мытищи, пр-т Мира, д. 10</td></tr>
<tr><td>Адрес: ${P.addr}</td><td>Тел.: ${P.tel}</td></tr>
<tr><td>р/с ${P.rs}</td><td>E-mail: ${P.mail}</td></tr>
<tr><td>к/с ${P.ks}</td><td>Банк: ПАО «Банк»</td></tr>
<tr><td>БИК ${P.bik}</td><td>| символ черты</td></tr>
<tr><td>_____________ / ${P.dir1} /</td><td>_____________ / ${P.dir2} /</td></tr></table>`;
  const css = `body{font-family:'${font}';font-size:${size}pt;margin:0} h1{font-size:${size * 1.4}pt;text-align:center} h2{font-size:${size * 1.15}pt}
 .row{display:flex;justify-content:space-between} table{border-collapse:collapse;width:100%} td,th{border:1px solid #000;padding:2pt 4pt;vertical-align:top;text-align:left}
 .r{text-align:right} .cols{column-count:2;column-gap:24pt} .cols p{text-align:justify} ${extra}`;
  const body = intro + (cols ? `<div class="cols">${fill}</div>` : fill) + (items ? table : '') + req;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`;
}

// Варианты: моноширинный 12 pt (пробел шириной в символ), альбомный 10 pt с таблицей чисел вправо, две колонки
// с колонтитулом обычного кегля и заголовком на всю ширину после колонок.
const WILD_VARIANTS = {
  'wild-mono': { html: { font: 'Liberation Mono', size: 12, filler: 4, items: true }, header: 0 },
  'wild-landscape': { html: { font: 'DejaVu Sans', size: 10, filler: 25, items: true }, header: 10, landscape: true },
  'wild-2col': { html: { font: 'Liberation Sans', size: 11, filler: 20, cols: true }, header: 11 },
};

async function wildPdf(browser, name) {
  const v = WILD_VARIANTS[name];
  const page = await browser.newPage();
  try {
    await page.setContent(wildHtml(v.html), { waitUntil: 'load' });
    const hdr = v.header;
    const tpl = (align, inner) =>
      `<div style="font-family:'Liberation Sans';font-size:${hdr}pt;width:100%;text-align:${align};padding-right:15mm">${inner}</div>`;
    return new Uint8Array(
      await page.pdf({
        format: 'A4',
        landscape: !!v.landscape,
        margin: { top: '25mm', bottom: '25mm', left: '20mm', right: '15mm' },
        displayHeaderFooter: hdr > 0,
        headerTemplate: hdr ? tpl('center', `ООО «${WILD.co1}» — Договор № 42/ЗП-2026`) : '<span></span>',
        footerTemplate: hdr ? tpl('right', 'Страница <span class="pageNumber"></span> из <span class="totalPages"></span>') : '<span></span>',
      }),
    );
  } finally {
    await page.close();
  }
}

/* ---------- повёрнутая страница ---------- */

/**
 * Страницы PDF «по-принтерному» (Д5 ревью WP10-A): MediaBox альбомный (ширина и высота меняются местами), /Rotate 270,
 * содержимое повёрнуто матрицей cm так, что на экране страница выглядит как исходная книжная. Без учёта поворота текст
 * страницы идёт сверху вниз и разметка отбросила бы его целиком. Инкрементальное обновление PDF Chromium (классическая
 * таблица xref, объекты страниц без сжатия): новые объекты страниц, потоки «q cm» / «Q» и xref с /Prev.
 * @param {Uint8Array} bytes
 */
export function rotatePdf(bytes) {
  const src = Buffer.from(bytes).toString('latin1');
  const prev = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(src)?.[1]);
  const trailer = src.slice(src.lastIndexOf('trailer'));
  const size = Number(/\/Size (\d+)/.exec(trailer)?.[1]);
  const rootRef = /\/Root (\d+ \d+ R)/.exec(trailer)?.[1];
  const infoRef = /\/Info (\d+ \d+ R)/.exec(trailer)?.[1];
  if (!prev || !size || !rootRef) throw new Error('rotatePdf: не классическая таблица xref');
  const pages = [...src.matchAll(/(\d+) 0 obj\s*(<<\s*\/Type \/Page\b[\s\S]*?)endobj/g)];
  if (!pages.length) throw new Error('rotatePdf: нет объектов страниц');
  let out = '';
  let next = size;
  const offsets = [];
  const add = (num, body) => {
    offsets.push([num, src.length + Buffer.byteLength(out, 'latin1')]);
    out += `${num} 0 obj\n${body}\nendobj\n`;
  };
  for (const [, num, dict] of pages) {
    const box = /\/MediaBox \[\s*([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)\s*\]/.exec(dict);
    const contents = /\/Contents (\d+ \d+ R|\[[^\]]*\])/.exec(dict);
    if (!box || !contents || /\/Rotate/.test(dict)) throw new Error('rotatePdf: неожиданный объект страницы');
    const [w, h] = [Number(box[3]) - Number(box[1]), Number(box[4]) - Number(box[2])];
    const pre = `q 0 -1 1 0 0 ${w} cm\n`;
    const post = '\nQ\n';
    const preNum = next++;
    const postNum = next++;
    add(preNum, `<< /Length ${pre.length} >>\nstream\n${pre}\nendstream`);
    add(postNum, `<< /Length ${post.length} >>\nstream\n${post}\nendstream`);
    const inner = contents[1].startsWith('[') ? contents[1].slice(1, -1).trim() : contents[1];
    const page = dict
      .replace(box[0], `/MediaBox [0 0 ${h} ${w}]`)
      .replace(/\/CropBox \[[^\]]*\]\s*/, '')
      .replace(contents[0], `/Contents [${preNum} 0 R ${inner} ${postNum} 0 R] /Rotate 270`);
    add(Number(num), page.trimEnd());
  }
  const xrefAt = src.length + Buffer.byteLength(out, 'latin1');
  out += 'xref\n0 1\n0000000000 65535 f \n';
  for (const [num, off] of offsets.sort((a, b) => a[0] - b[0])) out += `${num} 1\n${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${next} /Root ${rootRef}${infoRef ? ` /Info ${infoRef}` : ''} /Prev ${prev} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new Uint8Array(Buffer.concat([Buffer.from(bytes), Buffer.from(out, 'latin1')]));
}

/* ---------- LibreOffice ---------- */

export const SOFFICE = process.env.SOFFICE || (existsSync('/snap/bin/libreoffice') ? '/snap/bin/libreoffice' : 'soffice');
let loAvailable;
/** Есть ли LibreOffice (проверяется лениво: импорт модуля тестами не должен запускать soffice). */
export function libreOfficeAvailable() {
  loAvailable ??= !process.env.SKIP_LIBREOFFICE && spawnSync(SOFFICE, ['--version'], { stdio: 'ignore', timeout: 60000 }).status === 0;
  return loAvailable;
}

/** .docx → .pdf через LibreOffice (snap не видит /tmp — рабочий каталог в test-output/). */
function libreOfficePdf(name, docxBytes, filter = 'pdf') {
  const dir = join(root, 'test-output', 'pdf-fixtures-lo');
  mkdirSync(dir, { recursive: true });
  const src = join(dir, `${name}.docx`);
  writeFileSync(src, docxBytes);
  const out = join(dir, `${name}.pdf`);
  rmSync(out, { force: true });
  const res = spawnSync(SOFFICE, ['--headless', '--convert-to', filter, '--outdir', dir, src], { encoding: 'utf8', timeout: 180000 });
  if (res.status !== 0 || !existsSync(out)) throw new Error(`LibreOffice не сконвертировал ${name}: ${res.stderr || res.stdout}`);
  return new Uint8Array(readFileSync(out));
}

const LO_ENCRYPT = 'pdf:writer_pdf_Export:{"EncryptFile":{"type":"boolean","value":"true"},"DocumentOpenPassword":{"type":"string","value":"secret"}}';

/* ---------- набор ---------- */

const SAMPLE_CATEGORIES = {
  company1: 'COMPANY',
  company2: 'COMPANY',
  person1: 'PERSON',
  person1Gen: 'PERSON',
  person1Short: 'PERSON',
  person1ShortGen: 'PERSON',
  person2Gen: 'PERSON',
  person2Short: 'PERSON',
  author1: 'PERSON',
  author2: 'PERSON',
};

/** Колонтитул и колонки каждой фикстуры (текст колонтитула вымышленный, как и сам договор). */
const SPEC = {
  'ip-contract': { header: 'ООО «Лунный свет» — Договор оказания услуг № 5/ИП-2026' },
  'two-companies': { header: 'ООО «Альфа-Трейд» — Договор транспортной экспедиции № 88', columns: [1, 4] },
  'english-contract': { header: 'Northwind Solutions Ltd — Services Agreement', list: [2, 4] },
  structures: { header: 'ООО «Северный Ветер» — Договор № 3' },
  'third-persons': { header: 'ООО «Кедровый Бор» — Договор № 12/К' },
  'sample-contract': { header: 'ООО «Ромашка» — Договор поставки № 17/ПС-2026' },
  'perf-50p': { header: 'Договор подряда № 50/П-2026' },
};

/**
 * Все PDF-фикстуры. kind: 'text' — с текстовым слоем (есть gold и снимок), иначе — для отказов (scan, empty, encrypted).
 * @param {{only?: string[], libreOffice?: boolean}} [o]
 * @returns {Promise<{name: string, bytes: Uint8Array, gold?: object[], kind: 'text'|'scan'|'empty'|'encrypted'|'mixed'}[]>}
 */
export async function buildPdfFixtures(o = {}) {
  const want = (n) => !o.only || o.only.includes(n);
  const useLo = o.libreOffice ?? libreOfficeAvailable();
  const docs = buildFixtures();
  const sample = buildSampleDocx();
  const sampleGold = Object.entries(sample.gold).map(([key, value]) => ({ key, category: SAMPLE_CATEGORIES[key] || 'OTHER', value }));
  const sources = [...docs.map((d) => ({ name: d.name, bytes: d.bytes, gold: d.gold })), { name: 'sample-contract', bytes: sample.bytes, gold: sampleGold }];

  const out = [];
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    for (const s of sources) {
      if (!want(s.name)) continue;
      const html = htmlPage(documentToHtml(documentXml(s.bytes), { columns: SPEC[s.name]?.columns, list: SPEC[s.name]?.list }));
      out.push({ name: s.name, bytes: await htmlToPdf(browser, html, SPEC[s.name]?.header), gold: s.gold, kind: 'text' });
    }
    if (want('perf-50p')) {
      const perf = perfDocument();
      out.push({
        name: 'perf-50p',
        bytes: await htmlToPdf(browser, htmlPage(documentToHtml(perf.xml)), SPEC['perf-50p'].header),
        gold: perf.gold,
        kind: 'text',
      });
    }
    // снимок экрана в headless изредка падает на ожидании шрифтов — одна повторная попытка
    const png = await scanPng(browser).catch(() => scanPng(browser));
    const img = `<img src="data:image/png;base64,${Buffer.from(png).toString('base64')}" style="width:170mm">`;
    if (want('scan')) out.push({ name: 'scan', bytes: await htmlToPdf(browser, htmlPage(img), null), kind: 'scan' });
    for (const name of Object.keys(WILD_VARIANTS)) {
      if (want(name)) out.push({ name, bytes: await wildPdf(browser, name), gold: WILD_GOLD, kind: 'text' });
    }
    if (want('rotated')) {
      const ip = docs.find((d) => d.name === 'ip-contract');
      const html = htmlPage(documentToHtml(documentXml(ip.bytes)));
      out.push({ name: 'rotated', bytes: rotatePdf(await htmlToPdf(browser, html, SPEC['ip-contract'].header)), gold: ip.gold, kind: 'text' });
    }
    if (want('mixed')) {
      const ip = docs.find((d) => d.name === 'ip-contract');
      const html = htmlPage(`${documentToHtml(documentXml(ip.bytes))}<span class="pb"></span>${img}`);
      out.push({ name: 'mixed', bytes: await htmlToPdf(browser, html, null), gold: ip.gold, kind: 'mixed' });
    }
  } finally {
    await browser.close();
  }
  if (want('empty')) out.push({ name: 'empty', bytes: emptyPdf(), kind: 'empty' });
  if (useLo) {
    // ip-contract, two-companies; structures (надпись, мягкий перенос в ИНН) и sample-contract (колонтитулы
    // обычного кегля на одной странице, сноски) — ревью WP10-A (Д1, Д4, Д8)
    for (const s of [...docs, { name: 'sample-contract', bytes: sample.bytes, gold: sampleGold }]) {
      if (!['ip-contract', 'two-companies', 'structures', 'sample-contract'].includes(s.name) || !want(`${s.name}.lo`)) continue;
      out.push({ name: `${s.name}.lo`, bytes: libreOfficePdf(s.name, s.bytes), gold: s.gold, kind: 'text' });
    }
    if (want('encrypted')) {
      const d = docs.find((x) => x.name === 'ip-contract');
      out.push({ name: 'encrypted', bytes: libreOfficePdf('encrypted', d.bytes, LO_ENCRYPT), kind: 'encrypted' });
    }
  }
  return out;
}

/** Снимок Markdown после разметки (то, что увидит ИИ без замен). */
export async function layoutSnapshot(bytes) {
  const { extractPdfNode } = await import('../tests/integration/support/pdf.js');
  const { fromText } = await import('../src/core/text/model.js');
  const { serializeText } = await import('../src/core/text/serialize.js');
  const layout = await extractPdfNode(bytes);
  return serializeText(fromText(layout.blocks), [], { format: 'md' }).text;
}

/* ---------- CLI ---------- */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const update = process.argv.includes('--update-snapshots');
  const outArg = process.argv.find((a) => a.startsWith('--out='));
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const out = resolve(outArg ? outArg.slice('--out='.length) : PDF_FIXTURES_DIR);
  mkdirSync(out, { recursive: true });
  if (process.argv.includes('--snapshots-only')) {
    // только снимки разметки из уже записанных PDF (после правки core/pdf/layout.js), PDF не пересоздаются
    const { readdirSync } = await import('node:fs');
    for (const f of readdirSync(out).filter((x) => x.endsWith('.pdf'))) {
      const name = f.slice(0, -4);
      if (!existsSync(join(out, `${name}.txt`))) continue;
      writeFileSync(join(out, `${name}.txt`), await layoutSnapshot(new Uint8Array(readFileSync(join(out, f)))));
      console.log(`${name}.txt обновлён`);
    }
    process.exit(0);
  }
  const list = await buildPdfFixtures({ only: onlyArg ? onlyArg.slice('--only='.length).split(',') : undefined });
  for (const f of list) {
    writeFileSync(join(out, `${f.name}.pdf`), f.bytes);
    let note = '';
    if (f.gold) writeFileSync(join(out, `${f.name}.gold.json`), JSON.stringify(f.gold, null, 2) + '\n');
    if (f.kind === 'text' || f.kind === 'mixed') {
      const snap = join(out, `${f.name}.txt`);
      if (update || !existsSync(snap)) {
        writeFileSync(snap, await layoutSnapshot(f.bytes));
        note = ', снимок записан';
      } else note = ', снимок не тронут (--update-snapshots)';
    }
    console.log(`${f.name}.pdf: ${f.bytes.length} байт${f.gold ? `, gold ${f.gold.length}` : ''}${note}`);
  }
  if (!libreOfficeAvailable()) console.log('LibreOffice не найден — *.lo.pdf и encrypted.pdf не пересозданы');
}
