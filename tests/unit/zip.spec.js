import { describe, it, expect } from 'vitest';
import { unzipSync } from 'fflate';
import { readZip, writeZip, inflateEntry, crc32 } from '../../src/core/docx/zip.js';

const enc = new TextEncoder();

describe('zip', () => {
  it('crc32 совпадает с эталоном', () => {
    expect(crc32(enc.encode('123456789')).toString(16)).toBe('cbf43926');
  });

  it('запись → чтение сохраняет содержимое и порядок; fflate читает результат', () => {
    const bytes = writeZip([
      { name: 'b.xml', data: enc.encode('<b>второй</b>') },
      { name: 'a/имя.xml', data: enc.encode('<a/>') },
      { name: 'empty', data: new Uint8Array(0) },
    ]);
    const entries = readZip(bytes);
    expect(entries.map((e) => e.name)).toEqual(['b.xml', 'a/имя.xml', 'empty']);
    expect(new TextDecoder().decode(inflateEntry(entries[0]))).toBe('<b>второй</b>');
    const ff = unzipSync(bytes);
    expect(Object.keys(ff)).toEqual(['b.xml', 'a/имя.xml', 'empty']);
  });

  it('детерминирован и копирует нетронутые записи байт-в-байт', () => {
    const a = writeZip([
      { name: 'x', data: enc.encode('x'.repeat(1000)) },
      { name: 'y', data: enc.encode('y') },
    ]);
    const b = writeZip([
      { name: 'x', data: enc.encode('x'.repeat(1000)) },
      { name: 'y', data: enc.encode('y') },
    ]);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const src = readZip(a);
    const c = writeZip([
      { name: 'x', source: src[0] },
      { name: 'y', data: enc.encode('z') },
    ]);
    const back = readZip(c);
    expect(Buffer.from(back[0].raw).equals(Buffer.from(src[0].raw))).toBe(true);
    expect(new TextDecoder().decode(inflateEntry(back[1]))).toBe('z');
  });

  it('распознаёт OLE (зашифрованный/doc) и не-ZIP', () => {
    expect(() => readZip(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]))).toThrow(expect.objectContaining({ code: 'ENCRYPTED' }));
    expect(() => readZip(enc.encode('%PDF-1.7 и так далее, достаточно длинный текст'))).toThrow(expect.objectContaining({ code: 'NOT_DOCX' }));
  });
});
