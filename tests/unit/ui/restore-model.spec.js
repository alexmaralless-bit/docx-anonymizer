// WP10-B: логика страницы «Восстановить» без DOM — файл от ИИ (FR-36а), предвыбор сессии по ?docId=, словарь ru/en.
import { describe, it, expect } from 'vitest';
import { aiFileKind, restoredName, pickSession, mimeFor, mixedValueWarnings } from '../../../src/ui/deanon/index.js';
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

  it('снимает и пользовательский суффикс, и .anon; хвост повторного скачивания « (n)» убирается', () => {
    expect(restoredName('договор.обезл.docx', '.обезл')).toBe('договор.restored.docx');
    expect(restoredName('договор.anon.docx', '.обезл')).toBe('договор.restored.docx'); // суффикс поменяли после анонимизации
    expect(restoredName('договор.anon (1).docx')).toBe('договор.restored.docx');
    expect(restoredName('договор.обезл (12).md', '.обезл')).toBe('договор.restored.md');
    expect(restoredName('ответ (2).txt')).toBe('ответ.restored.txt');
    expect(restoredName('договор.anon.x.docx', '.x')).toBe('договор.anon.restored.docx'); // снимается один суффикс
    expect(restoredName('(1).docx')).toBe('(1).restored.docx');
  });
});

describe('mixedValueWarnings (FR-36а)', () => {
  // вымышленная карта: паспорт с органом выдачи и кодом подразделения под одной меткой (поведение с 0.2)
  const mapping = {
    entries: [
      { token: '[ПАСПОРТ_1]', category: 'PASSPORT', value: '45 05 123456', variants: ['ОВД района Лесной г. Энска', '770-001'] },
      { token: '[ФИО_1]', category: 'PERSON', value: 'Иванов Пётр Сергеевич', variants: ['Иванова П.С.', 'Петров'] },
      { token: '[КОМПАНИЯ_1]', category: 'COMPANY', original: 'ООО «Ромашка»', value: 'Ромашка', variants: ['Ромашка Плюс'] },
      { token: '[ТЕЛ_1]', category: 'PHONE', value: '+7 900 000-00-01', variants: ['+7 (900) 000 00 01', '+79000000001'] },
      { token: '[ИНН_1]', category: 'INN', value: '7700000001', variants: [] },
      { token: '[EMAIL_1]', category: 'EMAIL', value: 'a@example.com', variants: ['A@Example.com', 'b@example.com'] },
    ],
  };

  it('другие значения под меткой — предупреждение; формы того же значения и PERSON/COMPANY — нет', () => {
    expect(mixedValueWarnings(mapping)).toEqual([
      { token: '[ПАСПОРТ_1]', n: 2 },
      { token: '[EMAIL_1]', n: 1 },
    ]);
  });

  it('только метки, найденные в восстанавливаемом тексте', () => {
    expect(mixedValueWarnings(mapping, ['[ПАСПОРТ_1]', '[ФИО_1]'])).toEqual([{ token: '[ПАСПОРТ_1]', n: 2 }]);
    expect(mixedValueWarnings(mapping, [])).toEqual([]);
    expect(mixedValueWarnings(null)).toEqual([]);
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
