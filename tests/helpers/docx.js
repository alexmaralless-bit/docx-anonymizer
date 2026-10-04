// Сборка минимальных .docx для тестов.
import { writeZip, readZip, inflateEntry } from '../../src/core/docx/zip.js';

export const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:v="urn:schemas-microsoft-com:vml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';

/**
 * @param {string} bodyXml содержимое <w:body>
 * @param {Record<string, string|Uint8Array>} [extra] дополнительные части
 */
export function makeDocx(bodyXml, extra = {}) {
  const enc = new TextEncoder();
  const files = {
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document ${W_NS}><w:body>${bodyXml}</w:body></w:document>`,
    ...extra,
  };
  return writeZip(Object.entries(files).map(([name, d]) => ({ name, data: typeof d === 'string' ? enc.encode(d) : d })));
}

/** Все записи ZIP как строки UTF-8 (для grep по частям). */
export function unzipText(bytes) {
  const dec = new TextDecoder();
  return Object.fromEntries(readZip(bytes).map((e) => [e.name, dec.decode(inflateEntry(e))]));
}

export const run = (text, rPr = '') => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
export const para = (inner) => `<w:p>${inner}</w:p>`;
