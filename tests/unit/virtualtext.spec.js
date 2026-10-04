import { describe, it, expect } from 'vitest';
import { parseDocx } from '../../src/core/docx/model.js';
import { makeDocx, run, para } from '../helpers/docx.js';

const live = (doc) => doc.streams.filter((s) => s.type === 'live').map((s) => s.text);

describe('virtualText и charMap (§6.2)', () => {
  it('спецэлементы: tab, br, cr, sym, noBreakHyphen, ptab; tabs в pPr не считаются', () => {
    const doc = parseDocx(
      makeDocx(
        para(
          '<w:pPr><w:tabs><w:tab w:val="left" w:pos="100"/></w:tabs></w:pPr>' +
            '<w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t><w:cr/><w:sym w:font="Wingdings" w:char="F0FC"/><w:noBreakHyphen/><w:ptab w:relativeTo="margin" w:alignment="right" w:leader="none"/></w:r>',
        ),
      ),
    );
    expect(live(doc)).toEqual(['a\tb\nc\n\uFFFC\u2011\t']);
  });

  it('мягкий перенос не даёт символа; &amp; раскрывается; посимвольно разбитый текст склеивается', () => {
    const doc = parseDocx(
      makeDocx(
        para(run('ИНН 7736') + '<w:r><w:softHyphen/></w:r>' + run('050003')) +
          para(run('AT&amp;T &lt;Corp&gt;')) +
          para(['И', 'в', 'а', 'н', 'ов'].map((c) => run(c)).join('')),
      ),
    );
    expect(live(doc)).toEqual(['ИНН 7736050003', 'AT&T <Corp>', 'Иванов']);
    const s = doc.streams[2];
    expect(s.segments.length).toBe(5);
    expect(s.segIndex[4]).toBe(4);
    expect(s.segOffset[5]).toBe(1);
  });

  it('потоки live/deleted/field разделены; ins/del/hyperlink/sdt/smartTag принадлежат параграфу', () => {
    const doc = parseDocx(
      makeDocx(
        para(
          run('Живой ') +
            '<w:ins w:id="1" w:author="Автор"><w:r><w:t>вставка </w:t></w:r></w:ins>' +
            '<w:del w:id="2" w:author="Автор"><w:r><w:delText>удалено</w:delText><w:tab/></w:r></w:del>' +
            '<w:r><w:instrText> HYPERLINK "mailto:a@b.ru" </w:instrText></w:r>' +
            '<w:hyperlink r:id="rId1"><w:r><w:t>ссылка</w:t></w:r></w:hyperlink>' +
            '<w:sdt><w:sdtContent><w:r><w:t> sdt</w:t></w:r></w:sdtContent></w:sdt>' +
            '<w:smartTag><w:r><w:t> tag</w:t></w:r></w:smartTag>',
        ),
      ),
    );
    const byType = Object.fromEntries(doc.streams.filter((s) => s.pid).map((s) => [s.type, s.text]));
    expect(byType).toEqual({ live: 'Живой вставка ссылка sdt tag', deleted: 'удалено\t', field: ' HYPERLINK "mailto:a@b.ru" ' });
    const authors = doc.streams.filter((s) => s.attrKind === 'author').map((s) => s.text);
    expect(authors).toEqual(['Автор', 'Автор']);
  });

  it('вложенные параграфы: текстовое поле и таблица в таблице', () => {
    const tbl = (inner) => `<w:tbl><w:tr><w:tc>${inner}</w:tc></w:tr></w:tbl>`;
    const doc = parseDocx(
      makeDocx(
        para(
          run('До') +
            `<w:r><w:pict><v:shape><v:textbox><w:txbxContent>${para(run('Внутри'))}</w:txbxContent></v:textbox></v:shape></w:pict></w:r>` +
            run('После'),
        ) + tbl(para(run('Ячейка')) + tbl(para(run('Вложенная')))),
      ),
    );
    expect(live(doc)).toEqual(['До\uFFFCПосле', 'Внутри', 'Ячейка', 'Вложенная']);
    const depths = doc.paragraphs.map((p) => p.depth);
    expect(depths).toEqual([0, 1, 0, 0]);
  });

  it('язык документа: ru / en / both', () => {
    expect(parseDocx(makeDocx(para(run('Договор поставки')))).language).toBe('ru');
    expect(parseDocx(makeDocx(para(run('Supply agreement')))).language).toBe('en');
    expect(parseDocx(makeDocx(para(run('Договор Supply')))).language).toBe('both');
  });

  it('нет word/document.xml → NOT_DOCX', async () => {
    const { writeZip } = await import('../../src/core/docx/zip.js');
    const bytes = writeZip([{ name: 'a.txt', data: new TextEncoder().encode('x') }]);
    expect(() => parseDocx(bytes)).toThrow(expect.objectContaining({ code: 'NOT_DOCX' }));
  });
});
