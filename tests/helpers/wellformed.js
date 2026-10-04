import { tokenize } from '../../src/core/docx/xml.js';

/** Простая проверка корректности XML: парность тегов, один корень. Бросает Error. */
export function assertWellFormed(xml, name = '') {
  const stack = [];
  let roots = 0;
  tokenize(xml, (t) => {
    if (t.type === 'open') {
      if (!stack.length) roots++;
      stack.push(t.name);
    } else if (t.type === 'selfclose') {
      if (!stack.length) roots++;
    } else if (t.type === 'close') {
      const top = stack.pop();
      if (top !== t.name) throw new Error(`${name}: </${t.name}> закрывает <${top}> @${t.start}`);
    } else if (t.type === 'text' && !stack.length && xml.slice(t.start, t.end).trim()) {
      throw new Error(`${name}: текст вне корня`);
    }
  });
  if (stack.length) throw new Error(`${name}: не закрыт <${stack[stack.length - 1]}>`);
  if (roots !== 1) throw new Error(`${name}: корней ${roots}`);
}
