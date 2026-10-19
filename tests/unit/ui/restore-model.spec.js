// WP10-B: логика страницы «Восстановить» без DOM — файл от ИИ (FR-36а), предвыбор сессии по ?docId=, словарь ru/en.
import { describe, it, expect } from 'vitest';
import { aiFileKind, restoredName, pickSession, mimeFor } from '../../../src/ui/deanon/index.js';
import { RESTORE_DICT } from '../../../src/ui/i18n/restore.js';

describe('aiFileKind', () => {
  it('DOCX/DOCM — docx; Markdown и текст — text; остальное — null', () => {
    expect(aiFileKind('ответ.docx')).toBe('docx');
    expect(aiFileKind('ОТВЕТ.DOCM')).toBe('docx');
    expect(aiFileKind('answer.md')).toBe('text');
    expect(aiFileKind('answer.markdown')).toBe('text');
    expect(aiFileKind('answer.TXT')).toBe('text');
    expect(aiFileKind('answer.pdf')).toBeNull();
    expect(aiFileKind('docx')).toBeNull();
    expect(aiFileKind('')).toBeNull();
  });
});

describe('restoredName', () => {
  it('снимает суффикс анонимизации и добавляет .restored перед расширением', () => {
    expect(restoredName('договор.anon.docx')).toBe('договор.restored.docx');
    expect(restoredName('договор.ANON.docx')).toBe('договор.restored.docx');
    expect(restoredName('answer.md')).toBe('answer.restored.md');
    expect(restoredName('отчёт.docm')).toBe('отчёт.restored.docm');
    expect(restoredName('a.x.txt', '.x')).toBe('a.restored.txt');
    expect(restoredName('README')).toBe('README.restored');
    expect(restoredName('.anon.md')).toBe('.anon.restored.md'); // имя из одного суффикса не обнуляется
  });
});

describe('pickSession', () => {
  const sessions = [
    { docId: 'd1', createdAt: 100 },
    { docId: 'd3', createdAt: 300 },
    { docId: 'd2', createdAt: 200 },
  ];
  it('запрошенная сессия, если есть; иначе самая свежая; пусто — пустая строка', () => {
    expect(pickSession(sessions, 'd2')).toBe('d2');
    expect(pickSession(sessions, 'unknown')).toBe('d3');
    expect(pickSession(sessions, null)).toBe('d3');
    expect(pickSession([], 'd1')).toBe('');
    expect(pickSession(undefined, 'd1')).toBe('');
  });
});

describe('mimeFor', () => {
  it('MIME по расширению', () => {
    expect(mimeFor('a.restored.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(mimeFor('a.restored.docm')).toBe('application/vnd.ms-word.document.macroEnabled.12');
    expect(mimeFor('a.restored.md')).toMatch(/^text\/markdown/);
    expect(mimeFor('a.restored.txt')).toMatch(/^text\/plain/);
    expect(mimeFor('a.bin')).toBe('application/octet-stream');
  });
});

describe('RESTORE_DICT', () => {
  it('ключи ru и en совпадают, строки не пусты, новые ключи файла от ИИ есть', () => {
    expect(Object.keys(RESTORE_DICT.en).sort()).toEqual(Object.keys(RESTORE_DICT.ru).sort());
    for (const lang of ['ru', 'en']) for (const [k, v] of Object.entries(RESTORE_DICT[lang])) expect(String(v).trim(), `${lang}.${k}`).not.toBe('');
    for (const k of [
      'mode_text',
      'mode_file',
      'ai_file_pick',
      'ai_file_loaded',
      'ai_file_bad',
      'need_file',
      'file_too_big',
      'download',
      'docx_done',
      'docx_declined_h',
      'docx_skipped',
      'docx_hint',
      'error_not_docx',
    ])
      expect(RESTORE_DICT.ru[k], k).toBeTruthy();
    expect(RESTORE_DICT.ru.docx_done).toContain('{n}');
    expect(RESTORE_DICT.ru.file_too_big).toContain('{limit}');
  });
});
