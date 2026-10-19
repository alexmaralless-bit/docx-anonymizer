// WP7, К4: время анализа ~300-страничного синтетического текста со словарным детектором ≤ 130 % от времени без него.
// 2 400 абзацев × ~65 слов из фиксированного словаря, ~8 % слов с заглавной, ~1 % — пары «Имя Фамилия».
// Прогрев, затем медиана из 3 прогонов для dictNames: false и true. Детекторы — полный встроенный набор.
import { describe, it, expect, beforeAll } from 'vitest';
import { analyze } from '../../../src/core/detect/runner.js';
import { clearDetectors, registerBuiltinDetectors } from '../../../src/core/index.js';
import { docFromParagraphs, allOnSettings } from './helpers.js';

// prettier-ignore
const WORDS = [
  'стороны', 'обязуются', 'выполнить', 'работы', 'в', 'срок', 'согласно', 'договору', 'и', 'приложению', 'по', 'акту', 'приёмки',
  'оплата', 'производится', 'на', 'расчётный', 'счёт', 'исполнителя', 'течение', 'десяти', 'рабочих', 'дней', 'с', 'даты', 'подписания',
  'заказчик', 'вправе', 'требовать', 'устранения', 'недостатков', 'качество', 'услуг', 'должно', 'соответствовать', 'требованиям',
  'настоящего', 'документа', 'при', 'этом', 'ответственность', 'наступает', 'за', 'нарушение', 'сроков', 'поставки', 'товара', 'не',
  'более', 'чем', 'пять', 'процентов', 'от', 'стоимости', 'уведомление', 'направляется', 'письменно', 'адресу', 'указанному', 'разделе',
];
// prettier-ignore
const CAPS = ['Договор', 'Сторона', 'Заказчик', 'Исполнитель', 'Приложение', 'Акт', 'Товар', 'Москва', 'Работы', 'Покупатель', 'Стороны', 'Услуги', 'Порядок', 'Срок', 'Цена'];
// prettier-ignore
const PAIRS = [
  'Зульфие Хасановой', 'Прохору Шевчуку', 'Анвара Юсупова', 'Есения Павловская', 'Тихоном Брагиным', 'Ильнуре Сафине', 'Остап Ткаченко',
  'Мирославы Зайцевой', 'Елисею Голубеву', 'Аделину Мухаметзянову', 'Петру Смирнову', 'Анне Кузнецовой',
];

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function corpus(paragraphs, seed) {
  const rand = rng(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const out = [];
  for (let p = 0; p < paragraphs; p++) {
    const words = [];
    for (let w = 0; w < 65; w++) {
      const r = rand();
      if (r < 0.005)
        words.push(pick(PAIRS)); // пара — 2 слова, ~1 % слов
      else if (r < 0.085) words.push(pick(CAPS));
      else words.push(pick(WORDS));
      if (rand() < 0.07) words[words.length - 1] += '.';
    }
    out.push(words.join(' ') + '.');
  }
  return out;
}

async function median3(doc, settings) {
  const times = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    await analyze(doc, settings);
    times.push(performance.now() - t0);
  }
  return times.sort((a, b) => a - b)[1];
}

describe('К4: производительность словарного детектора', () => {
  beforeAll(() => {
    clearDetectors();
    registerBuiltinDetectors();
  });

  it('dictNames: true ≤ 130 % времени dictNames: false (2 400 абзацев)', async () => {
    const doc = docFromParagraphs(corpus(2400, 7));
    const off = allOnSettings({ dictNames: false });
    const on = allOnSettings({ dictNames: true });
    // прогрев: JIT, декодирование словарей, мемо
    await analyze(doc, off);
    await analyze(doc, on);
    const tOff = await median3(doc, off);
    const tOn = await median3(doc, on);
    const ratio = tOn / tOff;
    console.log(`К4: без словаря ${tOff.toFixed(0)} мс, со словарём ${tOn.toFixed(0)} мс, отношение ${ratio.toFixed(3)}`);
    expect(ratio).toBeLessThanOrEqual(1.3);
  }, 120000);
});
