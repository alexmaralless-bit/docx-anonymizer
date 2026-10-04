#!/usr/bin/env node
// Генератор образца: реалистичный договор поставки на русском с ВЫМЫШЛЕННЫМИ сторонами.
// Покрывает части ТЗ §4.2: колонтитулы, сноски, концевые сноски, комментарии, people.xml,
// рецензирование (w:ins/w:del, rPrChange), поля (instrText, fldSimple), внешние гиперссылки,
// текстовое поле (VML), рисунок с alt-текстом, таблицу реквизитов, разбитые по ранам слова,
// мягкий перенос, табуляцию, метаданные docProps (core/app/custom/thumbnail).
//
// Использование: node scripts/make-sample.mjs [путь.docx]  (по умолчанию tests/fixtures/sample-contract.docx)
// Из кода: import { buildSampleDocx } from './scripts/make-sample.mjs' → { bytes, gold }
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeZip } from '../src/core/docx/zip.js';

/* ---------- контрольные суммы (только для генерации валидных вымышленных номеров) ---------- */
const digits = (s) => s.split('').map(Number);
function inn10(prefix9) {
  const w = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const d = digits(prefix9);
  return prefix9 + ((w.reduce((s, x, i) => s + x * d[i], 0) % 11) % 10);
}
function inn12(prefix10) {
  const w1 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
  const w2 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
  let d = digits(prefix10);
  const c1 = (w1.reduce((s, x, i) => s + x * d[i], 0) % 11) % 10;
  d = [...d, c1];
  const c2 = (w2.reduce((s, x, i) => s + x * d[i], 0) % 11) % 10;
  return prefix10 + c1 + c2;
}
const ogrn13 = (p12) => p12 + String((BigInt(p12) % 11n) % 10n);
function snils(p9) {
  const d = digits(p9);
  let s = d.reduce((acc, x, i) => acc + x * (9 - i), 0);
  let c;
  if (s < 100) c = s;
  else if (s === 100 || s === 101) c = 0;
  else {
    c = s % 101;
    if (c === 100) c = 0;
  }
  return `${p9.slice(0, 3)}-${p9.slice(3, 6)}-${p9.slice(6, 9)} ${String(c).padStart(2, '0')}`;
}
/** Счёт с контрольным ключом (9-я цифра) по БИК: р/с — 3 последние цифры БИК; к/с — '0' + 5–6 цифры БИК. */
function account(bik, acc20, kind) {
  const prefix = kind === 'ks' ? '0' + bik.slice(4, 6) : bik.slice(6, 9);
  const w = [7, 1, 3];
  for (let k = 0; k <= 9; k++) {
    const a = acc20.slice(0, 8) + k + acc20.slice(9);
    const s = digits(prefix + a).reduce((acc, x, i) => acc + ((x * w[i % 3]) % 10), 0);
    if (s % 10 === 0) return a;
  }
  throw new Error('нет ключа');
}

export function makeGold() {
  const bik = '044525901';
  return {
    company1: 'Ромашка',
    company2: 'Вектор-М',
    person1: 'Иванов Пётр Сергеевич',
    person1Gen: 'Иванова Петра Сергеевича',
    person1Short: 'Иванов П.С.',
    person1ShortGen: 'Иванова П.С.',
    person2Gen: 'Сидоровой Анны Викторовны',
    person2Short: 'Сидорова А.В.',
    author1: 'Петров Олег',
    author2: 'Сидорова Анна',
    inn1: inn10('773605000'),
    inn2: inn12('5004001234'),
    kpp1: '773601001',
    kpp2: '500401001',
    ogrn1: ogrn13('102500401234'),
    ogrn2: ogrn13('112774612345'),
    bik,
    rs1: account(bik, '40702810400000012345', 'rs'),
    rs2: account(bik, '40702810900000054321', 'rs'),
    ks: account(bik, '30101810400000000901', 'ks'),
    snils: snils('112233445'),
    passport: '45 05 123456',
    phone1: '+7 (495) 123-45-67',
    phone2: '8-900-123-45-67',
    email1: 'p.ivanov@romashka.ru',
    email2: 'info@romashka.ru',
    email3: 'info@vector-m.ru',
    emailOld: 'old.mail@romashka.ru',
    url1: 'https://romashka.ru/contract',
    address1: '123456, г. Москва, ул. Ленина, д. 1, офис 5',
    address2: '141000, Московская обл., г. Мытищи, пр-т Мира, д. 10, корп. 2',
  };
}

/* ---------- XML ---------- */
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const NS =
  'xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" ' +
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
  'xmlns:o="urn:schemas-microsoft-com:office:office" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" ' +
  'xmlns:v="urn:schemas-microsoft-com:vml" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:w10="urn:schemas-microsoft-com:office:word" ' +
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" ' +
  'xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ' +
  'mc:Ignorable="w14 w15"';
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

/** Ран с текстом и необязательным форматированием */
const r = (text, rPr = '') => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const B = '<w:b/>';
const I = '<w:i/>';
const p = (inner, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${inner}</w:p>`;
const D = '2026-09-20T10:00:00Z';

export function buildSampleDocx() {
  const g = makeGold();
  const enc = new TextEncoder();

  const titlePPr = '<w:jc w:val="center"/>';
  const body = [
    p(r('ДОГОВОР ПОСТАВКИ № 17/ПС-2026', B), titlePPr),
    p(`${r('г. Москва')}<w:r><w:tab/></w:r>${r('15 сентября 2026 г.')}`),
    // Преамбула: ФИО разбито на 3 рана с разным форматированием, название компании — на 2
    p(
      r('ООО «Рома') +
        r('шка»', B) +
        r(`, ИНН ${g.inn1}, КПП ${g.kpp1}, именуемое в дальнейшем «Поставщик», в лице генерального директора `) +
        r('Ива', B) +
        r('нова Пет', I) +
        r('ра Сергеевича', B) +
        r(', действующего на основании Устава, с одной стороны, и АО «Вектор-М», именуемое в дальнейшем «Покупатель», в лице генерального директора ') +
        r(g.person2Gen) +
        r(', действующей на основании Устава, с другой стороны, заключили настоящий договор о нижеследующем:'),
      '<w:jc w:val="both"/>',
    ),
    p(r('1. ПРЕДМЕТ ДОГОВОРА', B)),
    // Мягкий перенос внутри ИНН Покупателя
    p(r(`1.1. Покупатель (ИНН ${g.inn2.slice(0, 10)}`) + '<w:r><w:softHyphen/></w:r>' + r(`${g.inn2.slice(10)}) обязуется принять и оплатить товар.`)),
    // Рецензирование: вставка и удаление, автор правок
    p(
      r('1.2. Уведомления направляются на адрес ') +
        `<w:ins w:id="101" w:author="${esc(g.author1)}" w:date="${D}">${r(g.email1)}</w:ins>` +
        `<w:del w:id="102" w:author="${esc(g.author1)}" w:date="${D}"><w:r><w:delText xml:space="preserve">${esc(g.emailOld)}</w:delText></w:r></w:del>` +
        r('.'),
    ),
    // Поле HYPERLINK с instrText + форматирование с rPrChange
    p(
      r('1.3. Электронная почта Поставщика: ') +
        '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
        `<w:r><w:instrText xml:space="preserve"> HYPERLINK "mailto:${g.email2}" </w:instrText></w:r>` +
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
        `<w:r><w:rPr><w:u w:val="single"/><w:rPrChange w:id="103" w:author="${esc(g.author2)}" w:date="${D}"><w:rPr/></w:rPrChange></w:rPr><w:t>${esc(g.email2)}</w:t></w:r>` +
        '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
        r('; Покупателя: ') +
        `<w:hyperlink r:id="rId10">${r(g.email3, '<w:u w:val="single"/>')}</w:hyperlink>` +
        r('.'),
    ),
    // fldSimple с URL в атрибуте
    p(
      r('1.4. Условия размещены на ') +
        `<w:fldSimple w:instr=" HYPERLINK &quot;${esc(g.url1)}&quot; ">${r('сайте Поставщика')}</w:fldSimple>` +
        r(` (${g.url1}).`),
    ),
    // Комментарий и сноска
    p(
      '<w:commentRangeStart w:id="0"/>' +
        r(`2.1. Контактный телефон Поставщика: ${g.phone1}.`) +
        '<w:commentRangeEnd w:id="0"/>' +
        '<w:r><w:commentReference w:id="0"/></w:r>' +
        r(' Ответственное лицо указано в сноске') +
        '<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="1"/></w:r>' +
        r(' и в примечании') +
        '<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:endnoteReference w:id="1"/></w:r>' +
        r('.'),
    ),
    p(
      r(
        `2.2. Представитель Поставщика ${g.person1}, СНИЛС ${g.snils}, паспорт ${g.passport}, выдан ОВД района Арбат г. Москвы 12.03.2005, код подразделения 770-001.`,
      ),
    ),
    // Текстовое поле (VML) с alt-текстом
    p(
      r('Подписант: ') +
        '<w:r><w:pict>' +
        '<v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>' +
        `<v:shape id="TextBox1" o:spid="_x0000_s1026" type="#_x0000_t202" style="width:220pt;height:36pt" alt="Подпись ${esc(g.person1ShortGen)}">` +
        `<v:textbox><w:txbxContent>${p(r(`Подписант: ${g.person1Short}`, B))}</w:txbxContent></v:textbox>` +
        '</v:shape></w:pict></w:r>',
    ),
    // Рисунок с alt-текстом
    p(
      '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="190500" cy="190500"/>' +
        `<wp:docPr id="1" name="Рисунок 1" descr="Паспорт ${esc(g.person1ShortGen)}"/>` +
        '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
        '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
        `<pic:nvPicPr><pic:cNvPr id="1" name="image1.png" descr="Паспорт ${esc(g.person1ShortGen)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
        '<pic:blipFill><a:blip r:embed="rId20"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
        '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="190500" cy="190500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
        '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>',
    ),
    p(r('3. РЕКВИЗИТЫ И ПОДПИСИ СТОРОН', B), titlePPr),
    table(g),
    p(`${r('_______________ / ')}${r(g.person1Short)}${r(' /')}<w:r><w:br/></w:r>${r('М.П.')}`),
  ].join('');

  const sectPr =
    '<w:sectPr><w:headerReference w:type="default" r:id="rId6"/><w:footerReference w:type="default" r:id="rId7"/>' +
    '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1701" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>';
  const documentXml = `${DECL}<w:document ${NS}><w:body>${body}${sectPr}</w:body></w:document>`;

  const header = `${DECL}<w:hdr ${NS}>${p(r(`ООО «${g.company1}» — Договор поставки № 17/ПС-2026`, I), '<w:jc w:val="right"/>')}</w:hdr>`;
  const footer =
    `${DECL}<w:ftr ${NS}>` +
    p(
      r(`Тел.: ${g.phone1}, e-mail: ${g.email2}. Стр. `) +
        '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
        r('1') +
        '<w:r><w:fldChar w:fldCharType="end"/></w:r>',
    ) +
    '</w:ftr>';
  const sep = (tag) =>
    `<w:${tag} w:type="separator" w:id="-1">${p('<w:r><w:separator/></w:r>')}</w:${tag}>` +
    `<w:${tag} w:type="continuationSeparator" w:id="0">${p('<w:r><w:continuationSeparator/></w:r>')}</w:${tag}>`;
  const footnotes =
    `${DECL}<w:footnotes ${NS}>${sep('footnote')}` +
    `<w:footnote w:id="1">${p('<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteRef/></w:r>' + r(` Контактное лицо: ${g.person1}, тел. ${g.phone2}.`))}</w:footnote>` +
    '</w:footnotes>';
  const endnotes =
    `${DECL}<w:endnotes ${NS}>${sep('endnote')}` +
    `<w:endnote w:id="1">${p('<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:endnoteRef/></w:r>' + r(` Банк Покупателя: БИК ${g.bik}, р/с ${g.rs2}.`))}</w:endnote>` +
    '</w:endnotes>';
  const comments =
    `${DECL}<w:comments ${NS}>` +
    `<w:comment w:id="0" w:author="${esc(g.author2)}" w:date="${D}" w:initials="СА">${p(
      '<w:r><w:annotationRef/></w:r>' + r(`Проверить ИНН ${g.inn1} и адрес ${g.email1}`),
    )}</w:comment>` +
    '</w:comments>';
  const people =
    `${DECL}<w15:people ${NS}>` +
    `<w15:person w15:author="${esc(g.author1)}"><w15:presenceInfo w15:providerId="None" w15:userId="${esc(g.author1)}"/></w15:person>` +
    `<w15:person w15:author="${esc(g.author2)}"><w15:presenceInfo w15:providerId="None" w15:userId="${esc(g.author2)}"/></w15:person>` +
    '</w15:people>';
  const styles =
    `${DECL}<w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="24"/><w:lang w:val="ru-RU"/></w:rPr></w:rPrDefault><w:pPrDefault/></w:docDefaults>` +
    '<w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/></w:style>' +
    '<w:style w:type="table" w:default="1" w:styleId="a1"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
    '</w:styles>';
  const settings = `${DECL}<w:settings ${NS}><w:defaultTabStop w:val="708"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;

  const docRels =
    `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>' +
    '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"/>' +
    '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>' +
    '<Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>' +
    '<Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' +
    '<Relationship Id="rId8" Type="http://schemas.microsoft.com/office/2011/relationships/people" Target="people.xml"/>' +
    `<Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="mailto:${esc(g.email3)}" TargetMode="External"/>` +
    '<Relationship Id="rId20" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>' +
    '</Relationships>';
  const rootRels =
    `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="docProps/thumbnail.jpeg"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/>' +
    '</Relationships>';
  const W = 'application/vnd.openxmlformats-officedocument.wordprocessingml';
  const contentTypes =
    `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Default Extension="jpeg" ContentType="image/jpeg"/>' +
    `<Override PartName="/word/document.xml" ContentType="${W}.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="${W}.styles+xml"/>` +
    `<Override PartName="/word/settings.xml" ContentType="${W}.settings+xml"/>` +
    `<Override PartName="/word/footnotes.xml" ContentType="${W}.footnotes+xml"/>` +
    `<Override PartName="/word/endnotes.xml" ContentType="${W}.endnotes+xml"/>` +
    `<Override PartName="/word/comments.xml" ContentType="${W}.comments+xml"/>` +
    `<Override PartName="/word/header1.xml" ContentType="${W}.header+xml"/>` +
    `<Override PartName="/word/footer1.xml" ContentType="${W}.footer+xml"/>` +
    `<Override PartName="/word/people.xml" ContentType="application/vnd.ms-word.people+xml"/>` +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/>' +
    '</Types>';
  const core =
    `${DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>Договор поставки с ООО «${g.company1}»</dc:title><dc:subject>Поставка</dc:subject><dc:creator>${g.person1}</dc:creator>` +
    `<cp:keywords>${g.company2}</cp:keywords><dc:description>Контакт: ${g.email1}</dc:description><cp:lastModifiedBy>${g.author2}</cp:lastModifiedBy>` +
    '<cp:revision>3</cp:revision><dcterms:created xsi:type="dcterms:W3CDTF">2026-09-15T09:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-09-20T10:00:00Z</dcterms:modified>' +
    '</cp:coreProperties>';
  const app =
    `${DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
    `<Template>Normal.dotm</Template><Application>Microsoft Office Word</Application><Company>ООО «${g.company1}»</Company><Manager>${g.person1}</Manager>` +
    `<TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>Договор с ${g.company2}</vt:lpstr></vt:vector></TitlesOfParts>` +
    '<AppVersion>16.0000</AppVersion></Properties>';
  const custom =
    `${DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
    `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="Контрагент"><vt:lpwstr>${g.company2}, ИНН ${g.inn2}</vt:lpwstr></property>` +
    '</Properties>';

  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
  // Миниатюра: псевдо-JPEG (содержимое не важно — часть удаляется при очистке метаданных)
  const thumb = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

  const files = [
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', rootRels],
    ['word/document.xml', documentXml],
    ['word/_rels/document.xml.rels', docRels],
    ['word/styles.xml', styles],
    ['word/settings.xml', settings],
    ['word/header1.xml', header],
    ['word/footer1.xml', footer],
    ['word/footnotes.xml', footnotes],
    ['word/endnotes.xml', endnotes],
    ['word/comments.xml', comments],
    ['word/people.xml', people],
    ['word/media/image1.png', png],
    ['docProps/core.xml', core],
    ['docProps/app.xml', app],
    ['docProps/custom.xml', custom],
    ['docProps/thumbnail.jpeg', thumb],
  ];
  const bytes = writeZip(files.map(([name, data]) => ({ name, data: typeof data === 'string' ? enc.encode(data) : data })));
  return { bytes, gold: g };
}

function table(g) {
  const cell = (lines) =>
    `<w:tc><w:tcPr><w:tcW w:w="4677" w:type="dxa"/></w:tcPr>${lines.map((l) => (typeof l === 'string' ? p(r(l)) : l.raw)).join('')}</w:tc>`;
  const border =
    '<w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`).join('') +
    '</w:tblBorders>';
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="9354" w:type="dxa"/>${border}<w:tblLook w:val="04A0"/></w:tblPr><w:tblGrid><w:gridCol w:w="4677"/><w:gridCol w:w="4677"/></w:tblGrid>` +
    '<w:tr>' +
    cell([
      { raw: p(r('Поставщик:', B)) },
      { raw: p(r('ООО «') + r(g.company1, B) + r('»')) },
      `ИНН/КПП ${g.inn1}/${g.kpp1}`,
      `ОГРН ${g.ogrn1}`,
      `Юридический адрес: ${g.address1}`,
      `р/с ${g.rs1}`,
      `к/с ${g.ks}`,
      `БИК ${g.bik}`,
      `Тел.: ${g.phone1}`,
      `E-mail: ${g.email2}`,
    ]) +
    cell([
      { raw: p(r('Покупатель:', B)) },
      `АО «${g.company2}»`,
      `ИНН/КПП ${g.inn2}/${g.kpp2}`,
      `ОГРН ${g.ogrn2}`,
      `Адрес: ${g.address2}`,
      `р/с ${g.rs2}`,
      `БИК ${g.bik}`,
      `Тел.: ${g.phone2}`,
      `E-mail: ${g.email3}`,
    ]) +
    '</w:tr>' +
    '<w:tr>' +
    cell([`Генеральный директор`, `_____________ / ${g.person1Short} /`]) +
    cell([`Генеральный директор`, `_____________ / ${g.person2Short} /`]) +
    '</w:tr></w:tbl>'
  );
}

/* ---------- CLI ---------- */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const out = resolve(process.argv[2] || join(root, 'tests/fixtures/sample-contract.docx'));
  await mkdir(dirname(out), { recursive: true });
  const { bytes } = buildSampleDocx();
  await writeFile(out, bytes);
  console.log(`Образец записан: ${out} (${bytes.length} байт)`);
}
