// FR-23: морфология ФИО и транслитерация.
import { describe, it, expect } from 'vitest';
import {
  declineSurname,
  declineFirstName,
  declinePatronymic,
  lemmatizeFullName,
  patronymicInfo,
  surnameFormsAnyGender,
} from '../../../src/core/detect/names/morph.js';
import { translitGostB, translitIcao, skeleton, crossScriptMatch } from '../../../src/core/detect/names/translit.js';

describe('склонение', () => {
  it.each([
    ['Иванов', 'm', ['иванов', 'иванова', 'иванову', 'иванова', 'ивановым', 'иванове']],
    ['Иванова', 'f', ['иванова', 'ивановой', 'ивановой', 'иванову', 'ивановой', 'ивановой']],
    ['Чайковский', 'm', ['чайковский', 'чайковского', 'чайковскому', 'чайковского', 'чайковским', 'чайковском']],
    ['Чайковская', 'f', ['чайковская', 'чайковской', 'чайковской', 'чайковскую', 'чайковской', 'чайковской']],
    ['Шевчук', 'm', ['шевчук', 'шевчука', 'шевчуку', 'шевчука', 'шевчуком', 'шевчуке']],
    ['Шевчук', 'f', ['шевчук', 'шевчук', 'шевчук', 'шевчук', 'шевчук', 'шевчук']],
    ['Ткаченко', 'm', ['ткаченко', 'ткаченко', 'ткаченко', 'ткаченко', 'ткаченко', 'ткаченко']],
    ['Гоголь', 'm', ['гоголь', 'гоголя', 'гоголю', 'гоголя', 'гоголем', 'гоголе']],
    ['Бабич', 'm', ['бабич', 'бабича', 'бабичу', 'бабича', 'бабичем', 'бабиче']],
    ['Толстой', 'm', ['толстой', 'толстого', 'толстому', 'толстого', 'толстым', 'толстом']],
    ['Кулига', 'm', ['кулига', 'кулиги', 'кулиге', 'кулигу', 'кулигой', 'кулиге']],
    ['Черных', 'f', ['черных', 'черных', 'черных', 'черных', 'черных', 'черных']],
  ])('фамилия %s (%s)', (n, g, forms) => expect(declineSurname(n, /** @type {any} */ (g))).toEqual(forms));

  it.each([
    ['Пётр', 'm', ['петр', 'петра', 'петру', 'петра', 'петром', 'петре']],
    ['Павел', 'm', ['павел', 'павла', 'павлу', 'павла', 'павлом', 'павле']],
    ['Сергей', 'm', ['сергей', 'сергея', 'сергею', 'сергея', 'сергеем', 'сергее']],
    ['Василий', 'm', ['василий', 'василия', 'василию', 'василия', 'василием', 'василии']],
    ['Игорь', 'm', ['игорь', 'игоря', 'игорю', 'игоря', 'игорем', 'игоре']],
    ['Илья', 'm', ['илья', 'ильи', 'илье', 'илью', 'ильей', 'илье']],
    ['Анна', 'f', ['анна', 'анны', 'анне', 'анну', 'анной', 'анне']],
    ['Мария', 'f', ['мария', 'марии', 'марии', 'марию', 'марией', 'марии']],
    ['Наталья', 'f', ['наталья', 'натальи', 'наталье', 'наталью', 'натальей', 'наталье']],
    ['Ольга', 'f', ['ольга', 'ольги', 'ольге', 'ольгу', 'ольгой', 'ольге']],
    ['Любовь', 'f', ['любовь', 'любови', 'любови', 'любовь', 'любовью', 'любови']],
  ])('имя %s', (n, g, forms) => expect(declineFirstName(n, /** @type {any} */ (g))).toEqual(forms));

  it('отчества', () => {
    expect(declinePatronymic('Сергеевич', 'm')).toEqual(['сергеевич', 'сергеевича', 'сергеевичу', 'сергеевича', 'сергеевичем', 'сергеевиче']);
    expect(declinePatronymic('Викторовна', 'f')).toEqual(['викторовна', 'викторовны', 'викторовне', 'викторовну', 'викторовной', 'викторовне']);
    expect(patronymicInfo('Ильиничной')).toMatchObject({ gender: 'f', cases: [4], lemma: 'ильинична' });
    expect(patronymicInfo('Кузьмичом')).toBeNull();
    expect(patronymicInfo('Москва')).toBeNull();
  });

  it('формы фамилии неизвестного рода/падежа («Сидорова А.В.»)', () => {
    const f = surnameFormsAnyGender('Сидорова');
    for (const x of ['сидоров', 'сидорова', 'сидоровой', 'сидорову', 'сидоровым']) expect(f.has(x), x).toBe(true);
  });
});

// ≥ 95 % покрытие на 500 ФИО (FR-23): 25 фамилий × 10 имён × 2 отчества, каждое — во всех 6 падежах
const SURNAMES_M = [
  'Иванов',
  'Петров',
  'Сидоров',
  'Кузнецов',
  'Смирнов',
  'Лебедев',
  'Соловьёв',
  'Никитин',
  'Ильин',
  'Голубев',
  'Чайковский',
  'Вишневецкий',
  'Толстой',
  'Шевчук',
  'Бабич',
  'Ткаченко',
  'Гоголь',
  'Мельник',
  'Шмидт',
  'Гайдай',
  'Белых',
  'Кравец',
  'Карпенко',
  'Пушкин',
  'Достоевский',
];
const FIRST_M = ['Пётр', 'Иван', 'Сергей', 'Алексей', 'Дмитрий', 'Павел', 'Николай', 'Игорь', 'Максим', 'Олег'];
const FIRST_F = ['Анна', 'Мария', 'Наталья', 'Ольга', 'Екатерина', 'Елена', 'Татьяна', 'Юлия', 'Ирина', 'Дарья'];
const PATR_M = ['Сергеевич', 'Андреевич'];
const PATR_F = ['Викторовна', 'Ильинична'];
const femSurname = (s) =>
  /(?:ов|ев|ёв|ин|ын)$/.test(s) ? s + 'а' : /(?:ский|цкий)$/.test(s) ? s.slice(0, -2) + 'ая' : /ой$/.test(s) ? s.slice(0, -2) + 'ая' : s;

function coverage(gender) {
  let ok = 0;
  let total = 0;
  const firsts = gender === 'm' ? FIRST_M : FIRST_F;
  const patrs = gender === 'm' ? PATR_M : PATR_F;
  for (const s0 of SURNAMES_M) {
    const s = gender === 'm' ? s0 : femSurname(s0);
    for (const f of firsts) {
      for (const p of patrs) {
        const S = declineSurname(s, gender);
        const F = declineFirstName(f, gender);
        const P = declinePatronymic(p, gender);
        for (let c = 0; c < 6; c++) {
          total++;
          const l = lemmatizeFullName({ surname: S[c], first: F[c], patronymic: P[c] });
          const want = `${S[0]} ${F[0]} ${P[0]}`;
          if (l && `${l.surname} ${l.first} ${l.patronymic}` === want) ok++;
        }
      }
    }
  }
  return ok / total;
}

describe('лемматизация ФИО (500 мужских + 500 женских, 6 падежей)', () => {
  it('мужские ≥ 95 %', () => expect(coverage('m')).toBeGreaterThanOrEqual(0.95));
  it('женские ≥ 95 %', () => expect(coverage('f')).toBeGreaterThanOrEqual(0.95));
});

describe('транслитерация', () => {
  it.each([
    ['Ромашка-Трейд', 'Romashka-Trejd', 'Romashka-Treid'],
    ['Щукин', 'Shhukin', 'Shchukin'],
    ['Юлия', 'Yuliya', 'Iuliia'],
    ['Царёв', 'Czaryov', 'Tsarev'],
    ['Цирк', 'Cirk', 'Tsirk'],
    ['Химпром', 'Ximprom', 'Khimprom'],
    ['Объект', 'Ob``ekt', 'Obieekt'],
    ['Выборг', "Vy'borg", 'Vyborg'],
    ['Эра', "E'ra", 'Era'],
  ])('%s → ГОСТ Б %s, ИКАО %s', (ru, gost, icao) => {
    expect(translitGostB(ru)).toBe(gost);
    expect(translitIcao(ru)).toBe(icao);
  });

  it('скелет совпадает у русского, ГОСТ, ИКАО и английского написаний', () => {
    const k = skeleton('Ромашка-Трейд');
    for (const v of ['Romashka-Trejd', 'Romashka-Treid', 'Romashka-Trade']) expect(skeleton(v)).toBe(k);
    expect(skeleton('Вектор')).toBe(skeleton('Vector'));
    expect(crossScriptMatch('Ромашка-Трейд', 'Romashka-Trade')).toBe(true);
    expect(crossScriptMatch('Цветмет-Химпром', 'Czvetmet-Ximprom')).toBe(true);
    expect(crossScriptMatch('Вектор', 'Viktoriya')).toBe(false); // скелет совпадает, длина — нет
    expect(crossScriptMatch('Мир', 'Mir')).toBe(false); // слишком короткий скелет
  });
});
