// WP10-B, К14: восстановление .docx от ИИ — обратная замена во всех потоках с сохранением форматирования (FR-36а, FR-37).
import { describe, it, expect, beforeAll } from 'vitest';
import { buildSampleDocx } from '../../scripts/make-sample.mjs';
import { parseDocx, readZip, inflateEntry, clearDetectors, restoreDocx, restoreText, deanonymize } from '../../src/core/index.js';
import { makeDocx, para, run, unzipText, W_NS } from '../helpers/docx.js';
import { assertWellFormed } from '../helpers/wellformed.js';
import { anonymize, checkPackage } from '../integration/support/pipeline.js';

/** Вымышленная карта замен. */
const MAPPING = {
  schemaVersion: 1,
  mode: 'placeholder',
  entries: [
    { token: '[ФИО_1]', placeholder: '[ФИО_1]', category: 'PERSON', original: 'Иванов Пётр Сергеевич', value: 'Иванов Пётр Сергеевич', variants: [] },
    { token: '[КОМПАНИЯ_1]', placeholder: 'ООО «[КОМПАНИЯ_1]»', category: 'COMPANY', original: 'ООО «Ромашка-Трейд»', value: 'Ромашка-Трейд', variants: [] },
    {
      token: '[URL_1]',
      placeholder: '[URL_1]',
      category: 'URL',
      original: 'https://romashka-trade.example/contract',
      value: 'https://romashka-trade.example/contract',
      variants: [],
    },
    {
      token: '[EMAIL_1]',
      placeholder: '[EMAIL_1]',
      category: 'EMAIL',
      original: 'info@romashka-trade.example',
      value: 'info@romashka-trade.example',
      variants: [],
    },
  ],
};
const FIO = 'Иванов Пётр Сергеевич';
const URL = 'https://romashka-trade.example/contract';
/** Шаблон «нераспознанной» метки в любом виде [ЧТО-ТО_n]. */
const ANY_TOKEN = /\[[\p{L}][\p{L}_ -]*?[ _-]\d+\]/u;

const textOf = (bytes) =>
  parseDocx(bytes)
    .streams.map((s) => s.text)
    .join('\n');
const docXml = (bytes) => unzipText(bytes)['word/document.xml'];

describe('restoreDocx: форматирование и потоки', () => {
  it('плейсхолдер, разбитый на 3 рана: значение в первом ране, остальные пусты, rPr на месте', () => {
    const bytes = makeDocx(para(run('Подписал [Ф', '<w:b/>') + run('ИО_1', '<w:i/>') + run('] и всё', '<w:u w:val="single"/>')));
    const r = restoreDocx(bytes, MAPPING);
    expect(r.replaced).toBe(1);
    expect(r.unresolved).toEqual([]);
    expect(r.changedParts).toEqual(['word/document.xml']);
    const out = parseDocx(r.bytes);
    expect(out.streams.find((s) => s.type === 'live').text).toBe(`Подписал ${FIO} и всё`);
    const xml = docXml(r.bytes);
    assertWellFormed(xml, 'document.xml');
    const runs = xml.match(/<w:r>.*?<\/w:r>/g);
    expect(runs).toHaveLength(3);
    expect(runs[0]).toContain('<w:b/>');
    expect(runs[0]).toContain(`Подписал ${FIO}`);
    expect(runs[1]).toContain('<w:i/>');
    expect(runs[1]).toContain('<w:t xml:space="preserve"></w:t>');
    expect(runs[2]).toContain('<w:u w:val="single"/>');
    expect(runs[2]).toContain('> и всё<');
  });

  it('таблица, колонтитул, сноска, текст ссылки, внешняя ссылка в rels, поле fldSimple', () => {
    const header = `<?xml version="1.0" encoding="UTF-8"?><w:hdr ${W_NS}>${para(run('ООО «[КОМПАНИЯ_1]» — конфиденциально'))}</w:hdr>`;
    const footnotes = `<?xml version="1.0" encoding="UTF-8"?><w:footnotes ${W_NS}><w:footnote w:id="1">${para(run('Контакт: [EMAIL_1]'))}</w:footnote></w:footnotes>`;
    const rels =
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://anonymized.invalid/[URL_1]" TargetMode="External"/>' +
      '<Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="mailto:[EMAIL_1]" TargetMode="External"/>' +
      '</Relationships>';
    const body =
      `<w:tbl><w:tr><w:tc>${para(run('Покупатель'))}</w:tc><w:tc>${para(run('[ФИО_1]'))}</w:tc></w:tr></w:tbl>` +
      para(run('Сайт: ') + `<w:hyperlink r:id="rId5">${run('[URL_1]', '<w:u w:val="single"/>')}</w:hyperlink>`) +
      para(`<w:fldSimple w:instr=" HYPERLINK &quot;[URL_1]&quot; ">${run('сайт Поставщика')}</w:fldSimple>`) +
      para(`<w:hyperlink r:id="rId6">${run('написать')}</w:hyperlink>`);
    const bytes = makeDocx(body, { 'word/header1.xml': header, 'word/footnotes.xml': footnotes, 'word/_rels/document.xml.rels': rels });
    const r = restoreDocx(bytes, MAPPING);
    expect(r.unresolved).toEqual([]);
    expect(r.replaced).toBe(7);
    expect(r.changedParts.sort()).toEqual(['word/_rels/document.xml.rels', 'word/document.xml', 'word/footnotes.xml', 'word/header1.xml']);
    const files = unzipText(r.bytes);
    for (const name of r.changedParts) assertWellFormed(files[name], name);
    expect(files['word/_rels/document.xml.rels']).toContain(`Target="${URL}"`);
    expect(files['word/_rels/document.xml.rels']).toContain('Target="mailto:info@romashka-trade.example"');
    expect(files['word/document.xml']).toContain(`w:instr=" HYPERLINK &quot;${URL}&quot; "`);
    const out = parseDocx(r.bytes);
    const texts = out.streams.map((s) => s.text);
    expect(texts).toContain(FIO); // ячейка таблицы
    expect(texts).toContain(`Сайт: ${URL}`);
    expect(texts).toContain('ООО «Ромашка-Трейд» — конфиденциально');
    expect(texts).toContain('Контакт: info@romashka-trade.example');
    expect(files['word/document.xml']).toContain('<w:u w:val="single"/>');
  });

  it('URL в rels в %-кодировке тоже восстанавливается целиком', () => {
    const rels =
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://anonymized.invalid/%5BURL_1%5D" TargetMode="External"/>' +
      '</Relationships>';
    const r = restoreDocx(makeDocx(para(run('текст')), { 'word/_rels/document.xml.rels': rels }), MAPPING);
    expect(r.replaced).toBe(1);
    expect(unzipText(r.bytes)['word/_rels/document.xml.rels']).toContain(`Target="${URL}"`);
  });

  it('склонение по контексту только по просьбе: «[ФИО_1]у» → дательный; без склонения — литерал', () => {
    const bytes = makeDocx(para(run('Направить письмо [ФИО_1]у до пятницы.')));
    const on = restoreDocx(bytes, MAPPING, { decline: true });
    expect(textOf(on.bytes)).toContain('Направить письмо Иванову Петру Сергеевичу до пятницы.');
    expect(on.declined).toHaveLength(1);
    expect(on.declined[0]).toMatchObject({ case: 'dat', original: FIO, text: 'Иванову Петру Сергеевичу', part: 'word/document.xml' });
    expect(on.declined[0].streamId).toBeTruthy();
    const off = restoreDocx(bytes, MAPPING);
    expect(textOf(off.bytes)).toContain(`Направить письмо ${FIO}у до пятницы.`);
    expect(off.declined).toEqual([]);
  });

  it('склонение не применяется к атрибутам: автор правки в исходной форме', () => {
    const body = para(`<w:ins w:id="1" w:author="[ФИО_1]" w:date="2026-01-01T00:00:00Z">${run('от [ФИО_1]')}</w:ins>`);
    const r = restoreDocx(makeDocx(body), MAPPING, { decline: true });
    const out = parseDocx(r.bytes);
    expect(out.streams.find((s) => s.attrKind === 'author').text).toBe(FIO);
    expect(out.streams.find((s) => s.type === 'live').text).toBe('от Иванова Петра Сергеевича');
  });

  it('нераспознанная метка остаётся и попадает в unresolved; голые и иные формы восстанавливаются', () => {
    const bytes = makeDocx(para(run('[ФИО_9] знает ФИО_1, [фио_1] и [ФИО 1].')));
    const r = restoreDocx(bytes, MAPPING);
    expect(r.replaced).toBe(3);
    const live = parseDocx(r.bytes).streams.find((s) => s.type === 'live');
    expect(live.text).toBe(`[ФИО_9] знает ${FIO}, ${FIO} и ${FIO}.`);
    expect(r.unresolved).toHaveLength(1);
    expect(r.unresolved[0]).toMatchObject({ text: '[ФИО_9]', part: 'word/document.xml' });
    expect(parseDocx(bytes).streamById.get(r.unresolved[0].streamId).type).toBe('live');
  });

  it('удалённый текст (w:del / w:delText) восстанавливается', () => {
    const body = para(
      run('Было: ') +
        `<w:del w:id="2" w:author="Рецензент" w:date="2026-01-01T00:00:00Z"><w:r><w:delText xml:space="preserve">[EMAIL_1]</w:delText></w:r></w:del>`,
    );
    const r = restoreDocx(makeDocx(body), MAPPING);
    expect(r.replaced).toBe(1);
    const xml = docXml(r.bytes);
    expect(xml).toContain('<w:delText xml:space="preserve">info@romashka-trade.example</w:delText>');
    expect(parseDocx(r.bytes).streams.find((s) => s.type === 'deleted').text).toBe('info@romashka-trade.example');
  });

  it('docProps/core.xml восстанавливается, custom.xml сохраняется (keepMetadata)', () => {
    const core =
      '<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
      '<dc:title>Договор с ООО «[КОМПАНИЯ_1]»</dc:title><dc:creator>[ФИО_1]</dc:creator></cp:coreProperties>';
    const custom =
      '<?xml version="1.0" encoding="UTF-8"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties"><property name="x"><vt:lpwstr xmlns:vt="v">константа</vt:lpwstr></property></Properties>';
    const bytes = makeDocx(para(run('текст')), { 'docProps/core.xml': core, 'docProps/custom.xml': custom });
    const r = restoreDocx(bytes, MAPPING, { decline: true });
    const files = unzipText(r.bytes);
    expect(files['docProps/core.xml']).toContain('<dc:title>Договор с ООО «Ромашка-Трейд»</dc:title>');
    expect(files['docProps/core.xml']).toContain(`<dc:creator>${FIO}</dc:creator>`);
    expect(files['docProps/custom.xml']).toBe(custom);
    assertWellFormed(files['docProps/core.xml'], 'core.xml');
  });

  it('.docm: vbaProject.bin переносится побайтно, нетронутые записи — исходные сжатые байты', () => {
    const vba = Uint8Array.from({ length: 4096 }, (_, i) => (i * 131 + 7) & 255);
    const bytes = makeDocx(para(run('[ФИО_1]')), { 'word/vbaProject.bin': vba });
    const r = restoreDocx(bytes, MAPPING);
    const before = readZip(bytes).find((e) => e.name === 'word/vbaProject.bin');
    const after = readZip(r.bytes).find((e) => e.name === 'word/vbaProject.bin');
    expect([...inflateEntry(after)]).toEqual([...vba]);
    expect(Buffer.from(after.raw).equals(Buffer.from(before.raw))).toBe(true);
    expect(readZip(r.bytes).map((e) => e.name)).toEqual(readZip(bytes).map((e) => e.name));
  });

  it('встроенный объект перед плейсхолдером не мешает: skipped пуст, объект на месте', () => {
    const drawing = '<w:drawing><wp:inline><wp:docPr id="1" name="Рисунок 1"/></wp:inline></w:drawing>';
    const bytes = makeDocx(para(`<w:r>${drawing}</w:r>` + run('[ФИО_1] на фото')));
    const r = restoreDocx(bytes, MAPPING);
    expect(r.skipped).toEqual([]);
    expect(r.replaced).toBe(1);
    const xml = docXml(r.bytes);
    expect(xml).toContain(drawing);
    expect(parseDocx(r.bytes).streams.find((s) => s.type === 'live').text).toBe(`￼${FIO} на фото`);
  });

  it('restoreText — то же, что deanonymize', () => {
    expect(restoreText).toBe(deanonymize);
    expect(restoreText('Подписал [ФИО_1]', MAPPING).text).toBe(`Подписал ${FIO}`);
  });

  it('не DOCX → CoreError NOT_DOCX', () => {
    expect(() => restoreDocx(new TextEncoder().encode('просто текст, не zip'), MAPPING)).toThrow();
  });
});

// К14: «.anon.docx из конвейера (образец) — 100 % плейсхолдеров восстановлены, текст потоков без ФИО равен исходному»
describe('restoreDocx: круговой прогон на образце договора', () => {
  const CATEGORY_BY_KEY = (k) =>
    ({
      company: 'COMPANY',
      person: 'PERSON',
      author: 'PERSON',
      inn: 'INN',
      kpp: 'KPP',
      ogrn: 'OGRN',
      bik: 'BIK',
      rs: 'ACCOUNT',
      ks: 'ACCOUNT',
      snils: 'SNILS',
      passport: 'PASSPORT',
      phone: 'PHONE',
      email: 'EMAIL',
      url: 'URL',
      address: 'ADDRESS',
    })[k.replace(/(Gen|Short|ShortGen|Old|\d)+$/, '').replace(/\d/g, '')];

  let sample;
  let goldMap;
  let gold;
  let anon;
  beforeAll(async () => {
    clearDetectors(); // только gold-сущности — прогон детерминирован
    ({ bytes: sample, gold: goldMap } = buildSampleDocx());
    gold = Object.entries(goldMap).map(([k, value]) => ({ category: CATEGORY_BY_KEY(k), value }));
    // keepMetadata: true — иначе docProps очищаются при анонимизации, и их правки (учтённые в stats) некуда восстанавливать
    anon = await anonymize(sample, { gold, apply: { keepMetadata: true } });
  });

  it('все плейсхолдеры восстановлены, текст потоков совпадает с исходным, пакет цел', () => {
    const r = restoreDocx(anon.docxBytes, anon.mapping, { decline: false });
    expect(r.replaced).toBe(anon.stats.replacements);
    expect(r.unresolved).toEqual([]);
    expect(r.skipped).toEqual([]);
    const restored = parseDocx(r.bytes);
    const allText = restored.streams.map((s) => s.text).join('\n');
    expect(allText).not.toMatch(ANY_TOKEN);
    for (const g of gold) expect(allText, g.value).toContain(g.value);
    const original = parseDocx(sample);
    const personValues = gold.filter((g) => g.category === 'PERSON').map((g) => g.value);
    let compared = 0;
    for (const s of original.streams) {
      if (s.attrKind === 'initials' || s.type === 'meta') continue; // инициалы автора → полное имя; docProps — ниже
      if (personValues.some((v) => s.text.includes(v))) continue;
      expect(restored.streamById.get(s.id)?.text, s.id).toBe(s.text);
      compared++;
    }
    expect(compared).toBeGreaterThan(20);
    expect(checkPackage(r.bytes)).toEqual([]);
    const files = unzipText(r.bytes);
    for (const name of Object.keys(files).filter((n) => /\.(xml|rels)$/.test(n))) assertWellFormed(files[name], name);
    // без склонения потоки с ФИО тоже совпадают побайтно: у каждой формы gold свой плейсхолдер
    for (const s of original.streams) {
      if (s.attrKind === 'initials') continue;
      expect(restored.streamById.get(s.id)?.text, s.id).toBe(s.text);
    }
  });

  it('с decline: true абзац «в лице генерального директора …» восстановлен, ФИО — в форме по правилам FR-37', () => {
    const r = restoreDocx(anon.docxBytes, anon.mapping, { decline: true });
    expect(r.unresolved).toEqual([]);
    const pre = (doc) => doc.streams.find((s) => s.type === 'live' && s.text.includes('в лице генерального директора')).text;
    const want = pre(parseDocx(sample));
    const got = pre(parseDocx(r.bytes));
    // «в лице генерального директора [ФИО_n]»: предлог «в» дальше окна в 3 слова (FR-37) — падеж не определён,
    // подставляется именительный; это и видно в списке склонённых. Вне ФИО абзац совпадает с исходным.
    const names = [goldMap.person1Gen, goldMap.person2Gen];
    const declined = r.declined.filter((d) => names.includes(d.original));
    expect(declined.map((d) => d.case)).toEqual(['nom', 'nom']);
    let expected = want;
    for (const d of declined) expected = expected.replace(d.original, d.text);
    expect(got).toBe(expected);
    for (const d of r.declined) expect(d.part).toBe('word/document.xml');
  });
});
