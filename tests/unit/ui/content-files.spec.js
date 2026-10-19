import { describe, it, expect } from 'vitest';
import {
  isDocx,
  hasDocx,
  mergeInOrder,
  mappingFileName,
  makeResultName,
  isInvalidatedError,
  fileSignature,
  formatSize,
  DOCX_MIME,
  PDF_MIME,
  fileKind,
  isSupported,
  hasSupported,
  resultType,
} from '../../../src/content/files.js';
import { siteState } from '../../../src/ui/components/site-state.js';
import { defaultSettings } from '../../../src/core/settings.js';

describe('определение .docx (FR-04)', () => {
  it('по расширению без учёта регистра и по MIME', () => {
    expect(isDocx({ name: 'A.DOCX', type: '' })).toBe(true);
    expect(isDocx({ name: 'm.docm', type: '' })).toBe(true);
    expect(isDocx({ name: 'без-расширения', type: DOCX_MIME })).toBe(true);
    expect(isDocx({ name: 'a.pdf', type: 'application/pdf' })).toBe(false);
    expect(isDocx({ name: 'a.doc', type: 'application/msword' })).toBe(false);
    expect(
      hasDocx([
        { name: 'a.txt', type: '' },
        { name: 'b.docx', type: '' },
      ]),
    ).toBe(true);
    expect(hasDocx([])).toBe(false);
  });
});

describe('порядок и имена (FR-06)', () => {
  it('сохраняет порядок: замены только на своих местах', () => {
    const orig = ['a.docx', 'b.pdf', 'c.docx'];
    expect(
      mergeInOrder(
        orig,
        new Map([
          [0, 'a.anon.docx'],
          [2, 'c.anon.docx'],
        ]),
      ),
    ).toEqual(['a.anon.docx', 'b.pdf', 'c.anon.docx']);
  });
  it('имя результата и маппинга', () => {
    expect(makeResultName('договор.docx')).toBe('договор.anon.docx');
    expect(makeResultName('Doc.DOCM', '.anon')).toBe('Doc.anon.DOCM');
    expect(makeResultName('без', '.anon')).toBe('без.anon.docx');
    expect(mappingFileName('договор.anon.docx')).toBe('договор.mapping.json');
  });
  it('сигнатура и размер', () => {
    expect(fileSignature({ name: 'a', size: 1, lastModified: 2 })).toBe('a|1|2');
    expect(formatSize(340 * 1024)).toBe('340 КБ');
    expect(formatSize(1.5 * 1024 * 1024)).toBe('1,5 МБ');
  });
});

describe('инвалидация контекста (FR-09)', () => {
  it('узнаёт сообщения Chrome', () => {
    expect(isInvalidatedError(new Error('Extension context invalidated.'))).toBe(true);
    expect(isInvalidatedError(new Error('Could not establish connection. Receiving end does not exist.'))).toBe(true);
    expect(isInvalidatedError(new Error('другое'))).toBe(false);
  });
});

describe('состояние сайта для popup и бейджа (FR-43)', () => {
  const on = { ...defaultSettings(), interceptEnabled: true };
  it('on / notListed / blocked / off / unsupported', () => {
    expect(siteState(on, 'https://claude.ai/chat/1').state).toBe('on');
    expect(siteState(on, 'https://example.com/').state).toBe('notListed');
    expect(siteState({ ...on, blocklist: ['https://claude.ai'] }, 'https://claude.ai/').state).toBe('blocked');
    expect(siteState(defaultSettings(), 'https://claude.ai/').state).toBe('off');
    expect(siteState(on, 'chrome://extensions').state).toBe('unsupported');
    expect(siteState(on, undefined).state).toBe('unsupported');
  });
  it('host и origin', () => {
    expect(siteState(on, 'https://chatgpt.com/c/1')).toMatchObject({ host: 'chatgpt.com', origin: 'https://chatgpt.com' });
  });
});

describe('PDF (версия 0.3)', () => {
  const md = 'text/markdown';
  it('вид файла и настройка pdfMode', () => {
    expect(fileKind({ name: 'a.PDF', type: '' })).toBe('pdf');
    expect(fileKind({ name: 'скан', type: PDF_MIME })).toBe('pdf');
    expect(fileKind({ name: 'a.docx', type: '' })).toBe('docx');
    expect(fileKind({ name: 'a.txt', type: 'text/plain' })).toBe(null);
    expect(isSupported({ name: 'a.pdf' }, { pdfMode: 'markdown' })).toBe(true);
    expect(isSupported({ name: 'a.pdf' }, { pdfMode: 'text' })).toBe(true);
    expect(isSupported({ name: 'a.pdf' }, { pdfMode: 'off' })).toBe(false);
    expect(isSupported({ name: 'a.pdf' }, defaultSettings())).toBe(true);
    expect(isSupported({ name: 'a.docx' }, { pdfMode: 'off' })).toBe(true);
    expect(isSupported({ name: 'a.anon.md' }, defaultSettings())).toBe(false);
    expect(hasSupported([{ name: 'a.pdf' }, { name: 'b.txt' }], { pdfMode: 'off' })).toBe(false);
    expect(hasSupported([{ name: 'a.pdf' }], { pdfMode: 'markdown' })).toBe(true);
  });
  it('имя и тип результата, имя маппинга', () => {
    expect(makeResultName('a.pdf', '.anon', { ext: '.md' })).toBe('a.anon.md');
    expect(makeResultName('Договор.PDF', '.anon', { ext: '.txt' })).toBe('Договор.anon.txt');
    expect(mappingFileName('a.anon.md')).toBe('a.mapping.json');
    expect(mappingFileName('a.anon.txt')).toBe('a.mapping.json');
    expect(resultType({ type: PDF_MIME }, md)).toBe(md);
    expect(resultType({ type: '' }, 'text/plain')).toBe('text/plain');
    expect(resultType({ type: 'application/vnd.ms-word.document.macroEnabled.12' }, DOCX_MIME)).toBe('application/vnd.ms-word.document.macroEnabled.12');
    expect(resultType({ type: '' })).toBe(DOCX_MIME);
  });
});
