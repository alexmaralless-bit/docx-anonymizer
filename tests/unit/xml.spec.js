import { describe, it, expect } from 'vitest';
import { tokenize, parseAttrs, unescapeXml, escapeText, escapeAttr, applyRangeEdits } from '../../src/core/docx/xml.js';

describe('tokenizer', () => {
  it('выдаёт open/close/selfclose/text/other со смещениями', () => {
    const xml = '<?xml version="1.0"?><a x="1>2"><!-- c --><b/>t&amp;<![CDATA[<z>]]></a>';
    const toks = [];
    tokenize(xml, (t) => toks.push({ type: t.type, name: t.name, raw: xml.slice(t.start, t.end) }));
    expect(toks).toEqual([
      { type: 'other', name: '', raw: '<?xml version="1.0"?>' },
      { type: 'open', name: 'a', raw: '<a x="1>2">' },
      { type: 'other', name: '', raw: '<!-- c -->' },
      { type: 'selfclose', name: 'b', raw: '<b/>' },
      { type: 'text', name: '', raw: 't&amp;' },
      { type: 'other', name: '', raw: '<![CDATA[<z>]]>' },
      { type: 'close', name: 'a', raw: '</a>' },
    ]);
  });

  it('parseAttrs даёт смещения значений', () => {
    const xml = `<w:t a="1" w:author='Иван &amp; Co'/>`;
    const attrs = parseAttrs(xml, 4, xml.length - 2);
    expect(attrs.map((a) => [a.name, a.raw])).toEqual([
      ['a', '1'],
      ['w:author', 'Иван &amp; Co'],
    ]);
    expect(xml.slice(attrs[1].valueStart, attrs[1].valueEnd)).toBe('Иван &amp; Co');
  });

  it('unescape/escape', () => {
    expect(unescapeXml('a&amp;b&lt;c&gt;&quot;&apos;&#1046;&#x416;')).toBe('a&b<c>"\'ЖЖ');
    expect(escapeText('AT&T <Corp>')).toBe('AT&amp;T &lt;Corp&gt;');
    expect(escapeAttr(`"'`)).toBe('&quot;&apos;');
  });

  it('applyRangeEdits применяет непересекающиеся правки и ловит пересечения', () => {
    expect(
      applyRangeEdits('0123456789', [
        { from: 7, to: 9, text: 'X' },
        { from: 1, to: 2, text: 'YY' },
      ]),
    ).toBe('0YY23456X9');
    expect(() =>
      applyRangeEdits('0123', [
        { from: 0, to: 2, text: '' },
        { from: 1, to: 3, text: '' },
      ]),
    ).toThrow();
  });
});
