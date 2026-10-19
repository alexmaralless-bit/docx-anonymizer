// applyDecisions для текстовой модели PDF (версия 0.3): сериализатор по doc.kind, MIME, формат, маппинг.
import { describe, it, expect, beforeAll } from 'vitest';
import { fromText } from '../../src/core/text/model.js';
import { applyDecisions, planEdits, DOCX_MIME, analyze, defaultSettings, registerBuiltinDetectors, clearDetectors, parseDocx } from '../../src/core/index.js';
import { buildSampleDocx } from '../../scripts/make-sample.mjs';

const BLOCKS = [
  { kind: 'h2', text: 'ДОГОВОР № 15', page: 1 },
  { kind: 'p', text: 'ООО «Ромашка», ИНН 7736050003, e-mail info@romashka.example, тел. +7 (495) 123-45-67.', page: 1 },
  { kind: 'footer', text: 'info@romashka.example', page: 1 },
];

beforeAll(() => {
  clearDetectors();
  registerBuiltinDetectors();
});

describe('applyDecisions: текст', () => {
  it('Markdown по умолчанию: bytes = docxBytes, MIME text/markdown, части и маппинг', async () => {
    const doc = fromText(BLOCKS, { name: 'a.pdf' });
    const a = await analyze(doc, defaultSettings());
    const r = applyDecisions(doc, a.groups, {
      placeholderLanguage: 'ru',
      createdAt: '2026-10-19T00:00:00Z',
      document: { name: 'a.pdf', resultName: 'a.anon.md' },
    });
    expect(r.mime).toBe('text/markdown');
    expect(r.docxBytes).toBe(r.bytes);
    const text = new TextDecoder().decode(r.bytes);
    expect(text.startsWith('## ДОГОВОР № 15\n\n')).toBe(true);
    expect(text).toMatch(/\[EMAIL_\d+\]/);
    expect(text).not.toContain('info@romashka.example');
    expect(text).not.toContain('7736050003');
    expect(r.stats.changedParts).toEqual(['word/document.xml', 'word/footer1.xml']);
    expect(r.stats.removedParts).toEqual([]);
    expect(r.mapping.documents).toEqual([{ name: 'a.pdf', resultName: 'a.anon.md' }]);
    expect(r.mapping.entries.some((e) => e.category === 'EMAIL')).toBe(true);
  });

  it("textFormat: 'txt' → text/plain без разметки", async () => {
    const doc = fromText(BLOCKS);
    const a = await analyze(doc, defaultSettings());
    const r = applyDecisions(doc, a.groups, { textFormat: 'txt' });
    expect(r.mime).toBe('text/plain');
    expect(new TextDecoder().decode(r.bytes).startsWith('ДОГОВОР № 15\n\n')).toBe(true);
  });

  it('режимы mask/delete работают и для текста; модель не мутируется', async () => {
    const doc = fromText(BLOCKS);
    const a = await analyze(doc, defaultSettings());
    const before = doc.streams.map((s) => s.text);
    const masked = new TextDecoder().decode(applyDecisions(doc, a.groups, { mode: 'mask' }).bytes);
    expect(masked).toContain('XXXXXXXXXX');
    const deleted = new TextDecoder().decode(applyDecisions(doc, a.groups, { mode: 'delete', placeholderLanguage: 'ru' }).bytes);
    expect(deleted).toContain('[удалено]');
    expect(doc.streams.map((s) => s.text)).toEqual(before);
  });

  it('planEdits одинаков для DOCX и текста; DOCX — MIME .docx', async () => {
    const { bytes } = buildSampleDocx();
    const doc = parseDocx(bytes);
    const a = await analyze(doc, defaultSettings());
    const { edits, applied } = planEdits(doc, a.groups, { mode: 'placeholder', placeholderLanguage: 'ru' });
    const r = applyDecisions(doc, a.groups, { placeholderLanguage: 'ru' });
    expect(r.mime).toBe(DOCX_MIME);
    expect(r.docxBytes).toBe(r.bytes);
    expect(r.stats.replacements).toBe(edits.length);
    expect(r.stats.entities).toBe(applied.size);
  });
});
