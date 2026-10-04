import { describe, it, expect } from 'vitest';
import { parseDocx } from '../../src/core/docx/model.js';
import { serializeDocx } from '../../src/core/docx/replace.js';
import { findOccurrences } from '../../src/core/search.js';
import { makeDocx, run, para, unzipText } from '../helpers/docx.js';

/** Заменяет все вхождения value на newText и возвращает {doc2, xml} */
function replaceAll(bytes, pairs, options = { keepMetadata: true }) {
  const doc = parseDocx(bytes);
  const edits = [];
  for (const [value, newText] of pairs) for (const o of findOccurrences(doc, value, { wholeWord: true })) edits.push({ ...o, newText });
  const { bytes: out } = serializeDocx(doc, edits, options);
  return { doc2: parseDocx(out), xml: unzipText(out)['word/document.xml'], out };
}
const liveText = (doc) => doc.streams.filter((s) => s.type === 'live').map((s) => s.text);

describe('замена через раны (§6.3)', () => {
  it('один ран: prefix + new + suffix', () => {
    const { doc2 } = replaceAll(makeDocx(para(run('ИНН 7736050003, КПП'))), [['7736050003', '[ИНН_1]']]);
    expect(liveText(doc2)).toEqual(['ИНН [ИНН_1], КПП']);
  });

  it('два и пять ранов: форматирование ранов сохраняется, промежуточные пустеют', () => {
    const body =
      para(run('в лице Ива', '<w:b/>') + run('нова', '<w:i/>') + run(' П.С.', '<w:u w:val="single"/>')) +
      para(['И', 'в', 'а', 'н', 'о', 'в'].map((c, i) => run(c, i % 2 ? '<w:b/>' : '<w:i/>')).join(''));
    const { doc2, xml } = replaceAll(makeDocx(body), [
      ['Иванова П.С.', '[ФИО_1]'],
      ['Иванов', '[ФИО_2]'],
    ]);
    expect(liveText(doc2)).toEqual(['в лице [ФИО_1]', '[ФИО_2]']);
    expect((xml.match(/<w:r>/g) || []).length).toBe(9);
    expect((xml.match(/<w:rPr>/g) || []).length).toBe(9);
    expect(xml).toContain('<w:u w:val="single"/>');
    expect(xml).toMatch(/<w:t xml:space="preserve"><\/w:t>/);
  });

  it('мягкий перенос внутри значения удаляется, вне — остаётся', () => {
    const body = para(run('ИНН 7736') + '<w:r><w:softHyphen/></w:r>' + run('050003 тек') + '<w:r><w:softHyphen/></w:r>' + run('ст'));
    const { doc2, xml } = replaceAll(makeDocx(body), [['7736050003', '[ИНН_1]']]);
    expect(liveText(doc2)).toEqual(['ИНН [ИНН_1] текст']);
    expect((xml.match(/w:softHyphen/g) || []).length).toBe(1);
  });

  it('табуляция внутри диапазона удаляется; специальные символы экранируются (FR-16)', () => {
    const body = para('<w:r><w:t>Тел.: +7</w:t><w:tab/><w:t>495 123</w:t></w:r>') + para(run('ООО Ромашка'));
    const { doc2, xml } = replaceAll(makeDocx(body), [
      ['+7\t495 123', '[ТЕЛ_1]'],
      ['Ромашка', 'AT&T <Corp>'],
    ]);
    expect(liveText(doc2)).toEqual(['Тел.: [ТЕЛ_1]', 'ООО AT&T <Corp>']);
    expect(xml).toContain('AT&amp;T &lt;Corp&gt;');
    expect(xml).not.toContain('<w:tab/>');
  });

  it('xml:space="preserve" добавляется, если текст начинается/кончается пробелом', () => {
    const body = para('<w:r><w:t>Иванов</w:t></w:r>');
    const { xml } = replaceAll(makeDocx(body), [['Иванов', ' X ']]);
    expect(xml).toContain('<w:t xml:space="preserve"> X </w:t>');
  });

  it('несколько правок в одном ране', () => {
    const { doc2 } = replaceAll(makeDocx(para(run('ИНН 7736050003 и 7736050003'))), [['7736050003', '[ИНН_1]']]);
    expect(liveText(doc2)).toEqual(['ИНН [ИНН_1] и [ИНН_1]']);
  });

  it('атрибуты: автор правки экранируется', () => {
    const body = para('<w:ins w:id="1" w:author="Иванов"><w:r><w:t>x</w:t></w:r></w:ins>');
    const { xml } = replaceAll(makeDocx(body), [['Иванов', 'A "&" B']]);
    expect(xml).toContain('w:author="A &quot;&amp;&quot; B"');
  });

  it('пересекающиеся правки — ошибка', () => {
    const doc = parseDocx(makeDocx(para(run('abcdef'))));
    const sid = doc.streams[0].id;
    expect(() =>
      serializeDocx(doc, [
        { streamId: sid, start: 0, end: 3, newText: 'x' },
        { streamId: sid, start: 2, end: 4, newText: 'y' },
      ]),
    ).toThrow();
  });
});
