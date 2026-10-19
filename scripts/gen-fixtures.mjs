#!/usr/bin/env node
// Генератор набора тестовых договоров (WP5): ИП, две компании, английский договор, «структуры»
// (три автора правок, таблица в таблице, sdtContent, mc:AlternateContent, посимвольные раны, 40 страниц),
// «третьи лица» (WP7: ФИО без лейблов в разных падежах — словарный детектор).
// Все данные ВЫМЫШЛЕННЫЕ. Для каждого документа — `<имя>.docx` и `<имя>.gold.json` в tests/fixtures/docs/.
//
// Использование: node scripts/gen-fixtures.mjs [каталог]   (по умолчанию tests/fixtures/docs)
// Из кода: import { buildFixtures } from './scripts/gen-fixtures.mjs' → [{name, bytes, gold:[{key,category,value}]}]
//
// Не покрыто: OLE-вложение (FR-15) — для него нужен бинарный контейнер; см. отчёт WP5.
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeZip } from '../src/core/docx/zip.js';
import { inn10, inn12, ogrn13, account, esc, NS, DECL, r, p, B, I } from './make-sample.mjs';

const enc = new TextEncoder();
const W = 'application/vnd.openxmlformats-officedocument.wordprocessingml';
const NS_X = NS + ' xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"';
const D = '2026-09-20T10:00:00Z';

/** ОГРНИП: 15 цифр, ключ — остаток от деления первых 14 на 13. */
const ogrnip15 = (p14) => p14 + String((BigInt(p14) % 13n) % 10n);

/** IBAN с контрольными цифрами mod-97. */
function iban(country, bban) {
  const num = (s) => s.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  const rem = BigInt(num(bban + country + '00')) % 97n;
  return `${country}${String(98n - rem).padStart(2, '0')}${bban}`;
}

/* ---------- упаковка ---------- */
export function pack({ body, extra = {}, core, app, rels = '', contentTypeParts = [] }) {
  const sectPr =
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1701" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>';
  const files = {
    '[Content_Types].xml':
      `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      `<Override PartName="/word/document.xml" ContentType="${W}.document.main+xml"/>` +
      `<Override PartName="/word/styles.xml" ContentType="${W}.styles+xml"/>` +
      contentTypeParts.map(([part, type]) => `<Override PartName="/${part}" ContentType="${type}"/>`).join('') +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      '</Types>',
    '_rels/.rels':
      `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
      '</Relationships>',
    'word/document.xml': `${DECL}<w:document ${NS_X}><w:body>${body}<w:p/>${sectPr}</w:body></w:document>`,
    'word/_rels/document.xml.rels':
      `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      rels +
      '</Relationships>',
    'word/styles.xml':
      `${DECL}<w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault/></w:docDefaults>` +
      '<w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/></w:style></w:styles>',
    ...extra,
    'docProps/core.xml':
      `${DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
      `${core}<dcterms:created xsi:type="dcterms:W3CDTF">2026-09-15T09:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-09-20T10:00:00Z</dcterms:modified></cp:coreProperties>`,
    'docProps/app.xml': `${DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">${app}<AppVersion>16.0000</AppVersion></Properties>`,
  };
  return writeZip(Object.entries(files).map(([name, d]) => ({ name, data: enc.encode(d) })));
}

export const cell = (...lines) =>
  `<w:tc><w:tcPr><w:tcW w:w="4677" w:type="dxa"/></w:tcPr>${lines.map((l) => (l.startsWith('<') ? l : p(r(l)))).join('')}</w:tc>`;
export const tbl = (rows, grid = 2) =>
  `<w:tbl><w:tblPr><w:tblW w:w="9354" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr>` +
  `<w:tblGrid>${'<w:gridCol w:w="4677"/>'.repeat(grid)}</w:tblGrid>${rows.map((c) => `<w:tr>${c.join('')}</w:tr>`).join('')}</w:tbl>`;
const g = (key, category, value) => ({ key, category, value });
export const title = (t) => p(r(t, B), '<w:jc w:val="center"/>');

/* ---------- 1. Договор с ИП ---------- */
function ipContract() {
  const bik = '044525225';
  const v = {
    ipInn: inn12('7728168971'),
    ogrnip: ogrnip15('30477461234567'),
    co: 'Лунный свет',
    coInn: inn10('770712345'),
    coKpp: '770701001',
    coOgrn: ogrn13('102770712345'),
    rs: account(bik, '40802810200000077777', 'rs'),
    ks: account(bik, '30101810400000000225', 'ks'),
    bik,
    ipPerson: 'Кузнецов Андрей Николаевич',
    ipPersonGen: 'Кузнецова Андрея Николаевича',
    ipShort: 'Кузнецов А.Н.',
    dirGen: 'Белова Марина Игоревна',
    dirShort: 'Белова М.И.',
    phone: '+7 (916) 555-01-23',
    email: 'kuznetsov.an@example.ru',
    coEmail: 'office@lunny-svet.example',
    addr: '199034, г. Санкт-Петербург, Университетская наб., д. 7, кв. 12',
    coAddr: '125009, г. Москва, Газетный пер., д. 3, стр. 1',
    passport: '40 12 765432',
  };
  const body = [
    title('ДОГОВОР ОКАЗАНИЯ УСЛУГ № 5/ИП-2026'),
    p(
      r('Индивидуальный предприниматель ') +
        r(v.ipPerson.slice(0, 8), B) +
        r(v.ipPerson.slice(8)) +
        r(`, ИНН ${v.ipInn}, ОГРНИП ${v.ogrnip}, именуемый в дальнейшем «Исполнитель», и ООО «${v.co}», в лице директора `) +
        r(v.dirGen) +
        r(', действующей на основании Устава, именуемое «Заказчик», заключили договор.'),
    ),
    p(r(`1. Исполнитель в лице ${v.ipPersonGen} оказывает услуги, паспорт ${v.passport}, проживает по адресу: ${v.addr}.`)),
    p(r(`2. Связь: ${v.phone}, ${v.email}; Заказчик — ${v.coEmail}.`)),
    tbl([
      [
        cell(p(r('Исполнитель', B)), `ИП ${v.ipPerson}`, `ИНН ${v.ipInn}`, `ОГРНИП ${v.ogrnip}`, `р/с ${v.rs}`, `БИК ${v.bik}`, `к/с ${v.ks}`),
        cell(p(r('Заказчик', B)), `ООО «${v.co}»`, `ИНН/КПП ${v.coInn}/${v.coKpp}`, `ОГРН ${v.coOgrn}`, `Адрес: ${v.coAddr}`),
      ],
      [cell(`_________ / ${v.ipShort} /`), cell(`_________ / ${v.dirShort} /`)],
    ]),
  ].join('');
  const core = `<dc:title>Договор с ИП</dc:title><dc:creator>${v.ipPerson}</dc:creator><cp:lastModifiedBy>${v.dirShort}</cp:lastModifiedBy>`;
  const app = `<Company>ООО «${v.co}»</Company>`;
  const gold = [
    g('ipInn', 'INN', v.ipInn),
    g('ogrnip', 'OGRN', v.ogrnip),
    g('co', 'COMPANY', v.co),
    g('coInn', 'INN', v.coInn),
    g('coKpp', 'KPP', v.coKpp),
    g('coOgrn', 'OGRN', v.coOgrn),
    g('rs', 'ACCOUNT', v.rs),
    g('ks', 'ACCOUNT', v.ks),
    g('bik', 'BIK', v.bik),
    g('ipPerson', 'PERSON', v.ipPerson),
    g('ipPersonGen', 'PERSON', v.ipPersonGen),
    g('ipShort', 'PERSON', v.ipShort),
    g('dirGen', 'PERSON', v.dirGen),
    g('dirShort', 'PERSON', v.dirShort),
    g('phone', 'PHONE', v.phone),
    g('email', 'EMAIL', v.email),
    g('coEmail', 'EMAIL', v.coEmail),
    g('addr', 'ADDRESS', v.addr),
    g('coAddr', 'ADDRESS', v.coAddr),
    g('passport', 'PASSPORT', v.passport),
  ];
  return { name: 'ip-contract', bytes: pack({ body, core, app }), gold };
}

/* ---------- 2. Две компании + третья ---------- */
function twoCompanies() {
  const v = {
    a: 'Альфа-Трейд',
    b: 'Бета Логистик',
    c: 'Гамма Капитал',
    aInn: inn10('781000123'),
    bInn: inn10('540200456'),
    cInn: inn10('166100789'),
    aKpp: '781001001',
    bKpp: '540201001',
    aOgrn: ogrn13('115781000123'),
    bOgrn: ogrn13('105540200456'),
    aDir: 'Орлов Сергей Дмитриевич',
    aDirGen: 'Орлова Сергея Дмитриевича',
    aDirShort: 'Орлов С.Д.',
    bDir: 'Лебедева Ирина Павловна',
    bDirGen: 'Лебедевой Ирины Павловны',
    bDirShort: 'Лебедева И.П.',
    aMail: 'sales@alfa-trade.example',
    bMail: 'logistics@beta-log.example',
    aAddr: '191036, г. Санкт-Петербург, Невский пр-т, д. 100, офис 4',
    bAddr: '630007, г. Новосибирск, Красный пр-т, д. 25, оф. 301',
  };
  const body = [
    title('ДОГОВОР ТРАНСПОРТНОЙ ЭКСПЕДИЦИИ № 88'),
    p(
      r(`ООО «${v.a.slice(0, 5)}`) +
        r(`${v.a.slice(5)}»`, B) +
        r(`, ИНН ${v.aInn}, в лице ${v.aDirGen}, и ООО «${v.b}», ИНН ${v.bInn}, в лице ${v.bDirGen}, заключили договор. Гарант — АО «${v.c}», ИНН ${v.cInn}.`),
    ),
    p(r(`Экспедитор — «${v.b}»; Клиент — «${v.a}». Руководитель ${v.aDir} вправе подписывать акты; ${v.bDirShort} — счета.`)),
    p(r(`Адреса: ${v.aAddr}; ${v.bAddr}. Почта: ${v.aMail}, ${v.bMail}.`)),
    tbl([
      [cell(`ООО «${v.a}»`, `ИНН/КПП ${v.aInn}/${v.aKpp}`, `ОГРН ${v.aOgrn}`), cell(`ООО «${v.b}»`, `ИНН/КПП ${v.bInn}/${v.bKpp}`, `ОГРН ${v.bOgrn}`)],
      [cell(`_____ / ${v.aDirShort} /`), cell(`_____ / ${v.bDirShort} /`)],
    ]),
  ].join('');
  const core = `<dc:title>Договор экспедиции ${v.a}</dc:title><dc:creator>${v.aDir}</dc:creator><cp:keywords>${v.b}</cp:keywords>`;
  const app = `<Company>ООО «${v.a}»</Company>`;
  const gold = [
    g('a', 'COMPANY', v.a),
    g('b', 'COMPANY', v.b),
    g('c', 'COMPANY', v.c),
    g('aInn', 'INN', v.aInn),
    g('bInn', 'INN', v.bInn),
    g('cInn', 'INN', v.cInn),
    g('aKpp', 'KPP', v.aKpp),
    g('bKpp', 'KPP', v.bKpp),
    g('aOgrn', 'OGRN', v.aOgrn),
    g('bOgrn', 'OGRN', v.bOgrn),
    g('aDir', 'PERSON', v.aDir),
    g('aDirGen', 'PERSON', v.aDirGen),
    g('aDirShort', 'PERSON', v.aDirShort),
    g('bDirGen', 'PERSON', v.bDirGen),
    g('bDirShort', 'PERSON', v.bDirShort),
    g('aMail', 'EMAIL', v.aMail),
    g('bMail', 'EMAIL', v.bMail),
    g('aAddr', 'ADDRESS', v.aAddr),
    g('bAddr', 'ADDRESS', v.bAddr),
  ];
  return { name: 'two-companies', bytes: pack({ body, core, app }), gold };
}

/* ---------- 3. English parties ---------- */
function englishContract() {
  const v = {
    a: 'Northwind Solutions',
    b: 'Contoso Holdings',
    aEin: '12-3456789',
    pA: 'John Michael Smith',
    pAShort: 'J. M. Smith',
    pB: 'Emily Rose Carter',
    iban: iban('GB', 'NWBK60161331926819'),
    swift: 'NWBKGB2L',
    mailA: 'john.smith@northwind.example',
    mailB: 'legal@contoso-holdings.example',
    phoneA: '+1 (415) 555-0132',
    phoneB: '+44 20 7946 0958',
    addrA: '500 Market Street, Suite 210, San Francisco, CA 94105',
    addrB: '221 Baker Street, London NW1 6XE',
    ssn: '078-05-1120',
    site: 'https://www.northwind.example/terms',
  };
  const body = [
    title('SERVICES AGREEMENT'),
    p(
      r(`This Agreement is made between ${v.a.slice(0, 9)}`) +
        r(`${v.a.slice(9)} Ltd`, B) +
        r(` (EIN ${v.aEin}), represented by `) +
        r(v.pA, I) +
        r(`, and ${v.b} LLC, represented by ${v.pB} (together, the "Parties").`),
    ),
    p(r(`Notices to ${v.pAShort} at ${v.mailA}, ${v.phoneA}, ${v.addrA}. Notices to ${v.pB} at ${v.mailB}, ${v.phoneB}, ${v.addrB}.`)),
    p(r(`Payments to IBAN ${v.iban}, SWIFT ${v.swift}. Contractor SSN ${v.ssn}. Terms at ${v.site}.`)),
    tbl([
      [cell(`${v.a} Ltd`, `EIN ${v.aEin}`, v.addrA), cell(`${v.b} LLC`, v.addrB)],
      [cell(`By: ${v.pAShort}`), cell(`By: ${v.pB}`)],
    ]),
  ].join('');
  const core = `<dc:title>Services Agreement ${v.a}</dc:title><dc:creator>${v.pA}</dc:creator><cp:lastModifiedBy>${v.pB}</cp:lastModifiedBy>`;
  const app = `<Company>${v.a} Ltd</Company>`;
  const gold = [
    g('a', 'COMPANY', v.a),
    g('b', 'COMPANY', v.b),
    g('aEin', 'TAXID', v.aEin),
    g('pA', 'PERSON', v.pA),
    g('pAShort', 'PERSON', v.pAShort),
    g('pB', 'PERSON', v.pB),
    g('iban', 'IBAN', v.iban),
    g('swift', 'SWIFT', v.swift),
    g('mailA', 'EMAIL', v.mailA),
    g('mailB', 'EMAIL', v.mailB),
    g('phoneA', 'PHONE', v.phoneA),
    g('phoneB', 'PHONE', v.phoneB),
    g('addrA', 'ADDRESS', v.addrA),
    g('addrB', 'ADDRESS', v.addrB),
    g('ssn', 'SSN', v.ssn),
    g('site', 'URL', v.site),
  ];
  return { name: 'english-contract', bytes: pack({ body, core, app }), gold };
}

/* ---------- 4. Структуры: правки трёх авторов, вложенные таблицы, sdt, AlternateContent, посимвольные раны, 40 страниц ---------- */
function structures() {
  const v = {
    co: 'Северный Ветер',
    inn: inn10('780500321'),
    person: 'Морозов Виктор Андреевич',
    mail: 'v.morozov@severny-veter.example',
    phone: '+7 (812) 555-77-88',
    au1: 'Крылов Денис',
    au2: 'Фомина Алла',
    au3: 'Громов Кирилл',
    boxPerson: 'Зайцева Ольга Петровна',
    sdtInn: inn12('7810000123'),
    split: 'Тихонов Борис Львович',
  };
  const textbox = (inner) =>
    '<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="2000000" cy="500000"/>' +
    '<wp:docPr id="7" name="Надпись 7"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/>' +
    `<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2000000" cy="500000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></wps:spPr><wps:txbx><w:txbxContent>${inner}</w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:inline></w:drawing></mc:Choice>` +
    `<mc:Fallback><w:pict><v:shape id="Box7" type="#_x0000_t202" style="width:150pt;height:40pt"><v:textbox><w:txbxContent>${inner}</w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r>`;
  const chars = (s) => [...s].map((c) => r(c, c === ' ' ? '' : B)).join(''); // каждый символ — свой ран
  const ins = (id, au, text) => `<w:ins w:id="${id}" w:author="${esc(au)}" w:date="${D}">${r(text)}</w:ins>`;
  const del = (id, au, text) =>
    `<w:del w:id="${id}" w:author="${esc(au)}" w:date="${D}"><w:r><w:delText xml:space="preserve">${esc(text)}</w:delText></w:r></w:del>`;
  const nested = tbl([
    [
      cell(
        p(r('Внешняя ячейка 1')),
        tbl([
          [cell(`ИНН ${v.inn}`), cell(`Тел.: ${v.phone}`)],
          [cell(`ООО «${v.co}»`), cell(v.mail)],
        ]),
      ),
      cell('Пусто'),
    ],
  ]);
  const filler = [];
  for (let i = 1; i <= 40; i++) {
    filler.push(p(r(`${i}. Пункт-заполнитель номер ${i}: стороны руководствуются условиями приложений. ${'Текст пункта. '.repeat(30)}`)));
    filler.push(p('<w:r><w:br w:type="page"/></w:r>'));
  }
  const body = [
    title(`ДОГОВОР № 3 (${v.co})`),
    p(
      r(`Подписант: `) +
        chars(v.split) +
        r(` — директор ООО «${v.co}», ИНН `) +
        r(v.inn.slice(0, 4)) +
        '<w:r><w:softHyphen/></w:r>' +
        r(v.inn.slice(4)) +
        r('.'),
    ),
    p(r('Редакция: ') + ins(11, v.au1, `контакт ${v.mail}`) + del(12, v.au2, `контакт ${v.phone}`) + ins(13, v.au3, ' согласовано')),
    p('<w:commentRangeStart w:id="0"/>' + r('Спорное условие.') + '<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="1"/></w:r>'),
    `<w:sdt><w:sdtPr><w:alias w:val="Поле"/><w:tag w:val="f1"/></w:sdtPr><w:sdtContent>${p(r(`ИНН подписанта (ИП): ${v.sdtInn}`))}</w:sdtContent></w:sdt>`,
    p(r('Надпись: ') + textbox(p(r(`Согласовано: ${v.boxPerson}`)))),
    nested,
    p(r(`Исполнитель: ${v.person}.`)),
    ...filler,
  ].join('');
  const comments =
    `${DECL}<w:comments ${NS}>` +
    [0, 1]
      .map(
        (i) =>
          `<w:comment w:id="${i}" w:author="${esc([v.au1, v.au3][i])}" w:date="${D}" w:initials="${['КД', 'ГК'][i]}">${p(r(i ? `Позвоните ${v.phone}` : 'Ок'))}</w:comment>`,
      )
      .join('') +
    '</w:comments>';
  const people =
    `${DECL}<w15:people ${NS}>` +
    [v.au1, v.au2, v.au3]
      .map((a) => `<w15:person w15:author="${esc(a)}"><w15:presenceInfo w15:providerId="None" w15:userId="${esc(a)}"/></w15:person>`)
      .join('') +
    '</w15:people>';
  const T = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const core = `<dc:title>Договор ${v.co}</dc:title><dc:creator>${v.person}</dc:creator><cp:lastModifiedBy>${v.au3}</cp:lastModifiedBy>`;
  const app = `<Company>ООО «${v.co}»</Company>`;
  const bytes = pack({
    body,
    core,
    app,
    extra: { 'word/comments.xml': comments, 'word/people.xml': people },
    rels:
      `<Relationship Id="rId5" Type="${T}/comments" Target="comments.xml"/>` +
      '<Relationship Id="rId8" Type="http://schemas.microsoft.com/office/2011/relationships/people" Target="people.xml"/>',
    contentTypeParts: [
      ['word/comments.xml', `${W}.comments+xml`],
      ['word/people.xml', 'application/vnd.ms-word.people+xml'],
    ],
  });
  const gold = [
    g('co', 'COMPANY', v.co),
    g('inn', 'INN', v.inn),
    g('person', 'PERSON', v.person),
    g('mail', 'EMAIL', v.mail),
    g('phone', 'PHONE', v.phone),
    g('au1', 'PERSON', v.au1),
    g('au2', 'PERSON', v.au2),
    g('au3', 'PERSON', v.au3),
    g('boxPerson', 'PERSON', v.boxPerson),
    g('sdtInn', 'INN', v.sdtInn),
    g('split', 'PERSON', v.split),
  ];
  return { name: 'structures', bytes, gold };
}

/* ---------- 5. Третьи лица без лейблов (WP7, К8): словарный детектор ФИО ---------- */
function thirdPersons() {
  const v = {
    a: 'Кедровый Бор',
    b: 'Лесная Гавань',
    aInn: inn10('663200111'),
    bInn: inn10('590400222'),
    aDirGen: 'Сафиной Гульнары Рашитовны',
    aDirShort: 'Сафина Г.Р.',
    bDirGen: 'Горбунова Святослава Игоревича',
    bDirShort: 'Горбунов С.И.',
    // третьи лица: формы, как они записаны в тексте
    t1: 'Тимофеем Бойко',
    t2dat: 'Зульфие Хасановой',
    t2nom: 'Зульфия Хасанова',
    t3: 'Прохору Шевчуку',
    t4: 'Есения Павловская',
    t5: 'Римский-Корсаков Николай',
    t6: 'Аделине Мухаметзяновой',
    t7: 'Ефимом Борисовичем',
    t8: 'Ковалёва Алёна',
    t9: 'Oliver Hart',
    t10: 'Brenda Collins',
    t11gen: 'Прохора Шевчука',
  };
  const body = [
    title('ДОГОВОР ОКАЗАНИЯ КОНСУЛЬТАЦИОННЫХ УСЛУГ № 12/К'),
    p(
      r(
        `ООО «${v.a}», ИНН ${v.aInn}, в лице генерального директора ${v.aDirGen}, действующей на основании Устава, именуемое «Заказчик», ` +
          `и ООО «${v.b}», ИНН ${v.bInn}, в лице директора ${v.bDirGen}, именуемое «Исполнитель», заключили настоящий договор.`,
      ),
    ),
    p(r(`1. Исполнитель консультирует Заказчика. Работы согласованы с ${v.t1} в рабочем порядке.`)),
    p(r(`2. Документы передать ${v.t2dat} до 1 декабря 2026 года; копии — ${v.t3}.`)),
    p(r(`3. Отчёт подготовила ${v.t4}, проверил ${v.t5}. ${v.t2nom} подтвердила получение.`)),
    p(r(`4. Экспертиза поручена ${v.t6}; вопросы согласовать с ${v.t7}.`)),
    p(r(`5. С отчётом ознакомлена ${v.t8}. Возражений со стороны ${v.t11gen} не поступило.`)),
    p(r(`6. The English summary was agreed with ${v.t9} and ${v.t10}.`)),
    p(r('7. Встреча пройдёт по адресу: 123456, г. Москва, ул. Ивана Петрова, д. 5. Призы: Лада Веста и чай «Иван Купала».')),
    p(r('8. Порядок Приёмки Работ определяется Приложением. Российская Федерация, Торговый Дом и Альфа Банк Стороной не являются.')),
    p(r('Реквизиты сторон', B)),
    tbl([
      [cell(`ООО «${v.a}»`, `ИНН ${v.aInn}`), cell(`ООО «${v.b}»`, `ИНН ${v.bInn}`)],
      [cell(`_____ / ${v.aDirShort} /`), cell(`_____ / ${v.bDirShort} /`)],
    ]),
  ].join('');
  const core = `<dc:title>Договор консультационных услуг</dc:title><dc:creator>${v.bDirShort}</dc:creator>`;
  const app = `<Company>ООО «${v.b}»</Company>`;
  const gold = [
    g('a', 'COMPANY', v.a),
    g('b', 'COMPANY', v.b),
    g('aInn', 'INN', v.aInn),
    g('bInn', 'INN', v.bInn),
    g('aDirGen', 'PERSON', v.aDirGen),
    g('aDirShort', 'PERSON', v.aDirShort),
    g('bDirGen', 'PERSON', v.bDirGen),
    g('bDirShort', 'PERSON', v.bDirShort),
    ...['t1', 't2dat', 't2nom', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10', 't11gen'].map((k) => g(k, 'PERSON', v[k])),
  ];
  return { name: 'third-persons', bytes: pack({ body, core, app }), gold };
}

export function buildFixtures() {
  return [ipContract(), twoCompanies(), englishContract(), structures(), thirdPersons()];
}

/* ---------- CLI ---------- */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const out = resolve(process.argv[2] || join(root, 'tests/fixtures/docs'));
  await mkdir(out, { recursive: true });
  for (const f of buildFixtures()) {
    await writeFile(join(out, `${f.name}.docx`), f.bytes);
    await writeFile(join(out, `${f.name}.gold.json`), JSON.stringify(f.gold, null, 2) + '\n');
    console.log(`${f.name}: ${f.bytes.length} байт, gold ${f.gold.length}`);
  }
}
