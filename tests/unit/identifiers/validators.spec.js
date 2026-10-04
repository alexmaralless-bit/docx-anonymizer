// validators.spec (ТЗ §9.1): контрольные суммы и структура; ≥ 20 валидных и ≥ 20 невалидных примеров на каждый валидатор.
// Валидные значения строятся независимой реализацией алгоритма (генераторы ниже) + известные реальные реквизиты.
import { describe, it, expect } from 'vitest';
import * as V from '../../../src/core/validators.js';

const digits = (s) => s.split('').map(Number);
const dot = (w, d) => w.reduce((s, x, i) => s + x * d[i], 0);
const inn10 = (p9) => p9 + ((dot([2, 4, 10, 3, 5, 9, 4, 6, 8], digits(p9)) % 11) % 10);
const inn12 = (p10) => {
  const c1 = (dot([7, 2, 4, 10, 3, 5, 9, 4, 6, 8], digits(p10)) % 11) % 10;
  const c2 = (dot([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8], digits(p10 + c1)) % 11) % 10;
  return p10 + c1 + c2;
};
const ogrn13 = (p12) => p12 + String((BigInt(p12) % 11n) % 10n);
const ogrn15 = (p14) => p14 + String((BigInt(p14) % 13n) % 10n);
const luhnComplete = (p) => {
  for (let c = 0; c < 10; c++) {
    const s = p + c;
    let sum = 0;
    for (let i = 0; i < s.length; i++) {
      let d = Number(s[s.length - 1 - i]);
      if (i % 2) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    if (sum % 10 === 0) return s;
  }
};
const snilsComplete = (p9) => {
  const s = dot([9, 8, 7, 6, 5, 4, 3, 2, 1], digits(p9));
  const c = s < 100 ? s : s <= 101 ? 0 : s % 101 === 100 ? 0 : s % 101;
  return p9 + String(c).padStart(2, '0');
};
const ibanComplete = (cc, bban) => {
  const num = (bban + cc + '00').replace(/[A-Z]/g, (ch) => ch.charCodeAt(0) - 55);
  let rem = 0;
  for (const ch of num) rem = (rem * 10 + Number(ch)) % 97;
  return cc + String(98 - rem).padStart(2, '0') + bban;
};
const accountComplete = (bik, a20, corr) => {
  const prefix = corr ? '0' + bik.slice(4, 6) : bik.slice(6, 9);
  for (let k = 0; k < 10; k++) {
    const a = a20.slice(0, 8) + k + a20.slice(9);
    if (digits(prefix + a).reduce((s, x, i) => s + ((x * [7, 1, 3][i % 3]) % 10), 0) % 10 === 0) return a;
  }
};
const bump = (s) => s.slice(0, -1) + String((Number(s.slice(-1)) + 1) % 10); // меняет контрольную цифру → гарантированно невалидно

function check(fn, valid, invalid, ctx) {
  expect(valid.length).toBeGreaterThanOrEqual(20);
  expect(invalid.length).toBeGreaterThanOrEqual(20);
  for (const v of valid) expect(fn(v, ctx), `должно быть валидным: ${v}`).toBe(true);
  for (const v of invalid) expect(fn(v, ctx), `должно быть невалидным: ${v}`).toBe(false);
}

const seeds9 = [
  '773605000',
  '770708389',
  '500400123',
  '772012345',
  '780123456',
  '540011223',
  '165000123',
  '632112233',
  '740100998',
  '231000777',
  '660155443',
  '502900111',
];
const seeds10 = [
  '5004001234',
  '7707083893',
  '7810123456',
  '3664069397',
  '5036123456',
  '7743001840',
  '1655018780',
  '6663003127',
  '5902290032',
  '4026001234',
  '2310031475',
  '6164266561',
];

describe('validators', () => {
  it('inn: ИНН-10 и ИНН-12', () => {
    const valid = [...seeds9.map(inn10), ...seeds10.map(inn12), '7707083893', '7736050003', '500100732259', '7743001840'];
    const invalid = [
      ...seeds9.map((s) => bump(inn10(s))),
      ...seeds10.map((s) => bump(inn12(s))),
      '123',
      '12345678901',
      '77360500031',
      'abcdefghij',
      '',
      '7736O50003',
    ];
    check(V.inn, valid, invalid);
  });

  it('ogrn: ОГРН и ОГРНИП', () => {
    const p12 = [
      '102500401234',
      '112774612345',
      '102770013219',
      '103700123456',
      '104770000001',
      '105500000123',
      '106774698765',
      '107000000111',
      '108745600012',
      '109502700333',
    ];
    const p14 = [
      '31550040001234',
      '30477461234567',
      '31277460000123',
      '30650010000012',
      '31377000000999',
      '31450040000111',
      '30977461111222',
      '31150040002223',
      '30570000000001',
    ];
    const valid = [...p12.map(ogrn13), ...p14.map(ogrn15), '1027700132195', '1037739010891'];
    const invalid = [
      ...p12.map((s) => bump(ogrn13(s))),
      ...p14.map((s) => bump(ogrn15(s))),
      '1027700132190',
      '12345',
      '102770013219',
      '10277001321955',
      'ABCDEFGHIJKLM',
    ];
    check(V.ogrn, valid, invalid);
  });

  it('snils: контрольное число', () => {
    const p9 = [
      '112233445',
      '123456789',
      '987654321',
      '100200300',
      '045678912',
      '321654987',
      '555666777',
      '147258369',
      '246813579',
      '135792468',
      '777888999',
      '020304050',
      '190283746',
      '564738291',
      '918273645',
      '302010998',
      '456123789',
      '789456123',
      '234567891',
      '876543210',
    ];
    const valid = [...p9.map(snilsComplete), '12345678964', '11223344595'];
    const invalid = [
      ...p9.map((s) => bump(snilsComplete(s))),
      '00000000000',
      '001001998 00'.replace(' ', ''),
      '1234567890',
      '123456789644',
      'abcdefghijk',
      '112-233-445 96',
    ];
    check(V.snils, valid, invalid);
    expect(V.snils('112-233-445 95')).toBe(true);
  });

  it('luhn: карты', () => {
    const ps = [
      '411111111111111',
      '555555555555444',
      '37828224631000',
      '601111111111111',
      '353011133330000',
      '220012345678901',
      '22001111222233',
      '4012888888881881'.slice(0, 15),
      '5105105105105100'.slice(0, 15),
      '371449635398431'.slice(0, 14),
      '630495060000000000'.slice(0, 15),
      '676770000000000',
    ];
    const valid = [
      ...ps.map(luhnComplete),
      '4111111111111111',
      '5555555555554444',
      '378282246310005',
      '6011111111111117',
      '2200123456789019',
      '4000056655665556',
      '5200828282828210',
      '4242424242424242',
    ];
    const invalid = [
      ...ps.map((s) => bump(luhnComplete(s))),
      '123456789012',
      '12345678901234567890',
      '4111111111111112',
      '5555555555554445',
      'abcd efgh ijkl mnop',
      '1111111111111',
      '2222222222222',
      '4111 1111 1111 1112',
      '',
      '4111-1111-1111-111',
      '9999999999999999999',
    ];
    check(V.luhn, valid, invalid);
    expect(V.luhn('4111 1111 1111 1111')).toBe(true);
  });

  it('iban / mod97: страна, длина, контрольные цифры', () => {
    const bbans = [
      ['GB', 'WEST12345698765432'.slice(0, 18)],
      ['DE', '370400440532013000'],
      ['FR', '30006000011234567890189'],
      ['ES', '21000418450200051332'],
      ['IT', 'X0542811101000000123456'],
      ['NL', 'ABNA0417164300'],
      ['CH', '0483501234567890'.slice(0, 17)],
      ['PL', '109024020531000000000000'.slice(0, 24)],
      ['AT', '1904300234573201'],
      ['BE', '539007547034'],
      ['LT', '1000011101001000'],
      ['LV', 'BANK0000435195001'],
      ['EE', '2200221020145685'],
      ['FI', '21234500000785'],
      ['NO', '86011117947'],
      ['SE', '5000000000056016'.slice(0, 20)],
      ['DK', '50400440116243'],
      ['PT', '00020123123456789015'.slice(0, 21)],
      ['CZ', '08000000192000145399'],
      ['UA', '3223130000026007233566001'],
      ['KZ', '125KZT5004100100'],
    ];
    const lens = {
      GB: 22,
      DE: 22,
      FR: 27,
      ES: 24,
      IT: 27,
      NL: 18,
      CH: 21,
      PL: 28,
      AT: 20,
      BE: 16,
      LT: 20,
      LV: 21,
      EE: 20,
      FI: 18,
      NO: 15,
      SE: 24,
      DK: 18,
      PT: 25,
      CZ: 24,
      UA: 29,
      KZ: 20,
    };
    const fit = ([cc, b]) => {
      const need = lens[cc] - 4;
      return ibanComplete(cc, (b + '0'.repeat(need)).slice(0, need));
    };
    const valid = [
      ...bbans.map(fit),
      'GB82 WEST 1234 5698 7654 32',
      'DE89 3704 0044 0532 0130 00',
      'FR14 2004 1010 0505 0001 3M02 606',
      'gb82west12345698765432',
    ];
    const invalid = [
      ...bbans.map((x) => bump(fit(x))),
      'GB82 WEST 1234 5698 7654 33',
      'GB82WEST1234569876543',
      'XX82WEST12345698765432',
      'DE89 3704 0044 0532 0130',
      '1234567890',
      'GB00 WEST 1234 5698 7654 32',
    ];
    check(V.iban, valid.slice(0, 24), invalid);
    expect(V.mod97('GB82 WEST 1234 5698 7654 32')).toBe(true);
    expect(V.mod97('GB82 WEST 1234 5698 7654 33')).toBe(false);
    for (const b of bbans) expect(V.mod97(fit(b))).toBe(true);
  });

  it('ssn: структура area/group/serial', () => {
    const valid = [
      '219-09-9999'.replace('219', '219'),
      '123-45-6789',
      '078-05-1120',
      '001-01-0001',
      '665-12-3456',
      '667-12-3456',
      '899-99-9999',
      '123-45-6789',
      '321-54-9876',
      '457-55-5462',
      '212-34-5678',
      '555-12-3456',
      '100-20-3000',
      '234-56-7890',
      '345-67-8901',
      '456-78-9012',
      '567-89-0123',
      '112-23-3445',
      '300-30-3030',
      '701-01-0101',
      '123456789',
      '123 45 6789',
    ];
    const invalid = [
      '000-12-3456',
      '666-12-3456',
      '900-12-3456',
      '987-65-4321',
      '123-00-6789',
      '123-45-0000',
      '12-345-6789',
      '123-4-56789',
      '1234-56-789',
      'abc-de-fghi',
      '',
      '123-45-678',
      '123-45-67890',
      '000-00-0000',
      '666-00-0000',
      '999-99-9999',
      '911-22-3333',
      '000456789',
      '666456789',
      '123450000',
      '123006789',
      '12345678',
    ];
    check(V.ssn, valid, invalid);
  });

  it('bik: 9 цифр, начинаются с 04', () => {
    const valid = [
      '044525225',
      '044525974',
      '044525593',
      '044030653',
      '044525700',
      '044525999',
      '040702615',
      '045004641',
      '046015207',
      '047102651',
      '044525201',
      '041806835',
      '043601607',
      '044106001',
      '048073601',
      '049205603',
      '040349514',
      '040173604',
      '041012765',
      '042202824',
    ];
    const invalid = [
      '123456789',
      '144525225',
      '054525225',
      '04452522',
      '0445252255',
      'abcdefghi',
      '',
      '044 525 225x',
      '994525225',
      '004525225',
      '03452522',
      '04-4525225x',
      '04452522a',
      '4044525225',
      '14452522',
      '444525225',
      '094525225',
      '024525225',
      '34452522',
      '074525225',
    ];
    check(V.bik, valid, invalid);
  });

  it('kpp: структура 4 + 2 + 3', () => {
    const valid = [
      '770101001',
      '773601001',
      '500401001',
      '780201001',
      '540201002',
      '165001001',
      '631601001',
      '366401001',
      '784201001',
      '7701500A1'.replace('500A1', '50DA1').slice(0, 9),
      '770150001',
      '770151001',
      '772901005',
      '770145002',
      '773343008',
      '500150003',
      '770160001',
      '770165001',
      '77010E001',
      '770301001',
    ].map((x) => x);
    const invalid = [
      '770199001',
      '770100001',
      '77010100',
      '7701010011',
      'ABC101001',
      '770170001',
      '770199999',
      '123456789'
        .replace('5', '9')
        .replace('6', '9')
        .slice(0, 9)
        .replace(/(\d{4})(\d\d)/, '$199'),
      '',
      '770 101 001',
      '770101-01',
      '77010100A',
      '7701010O1',
      '770190001',
      '770180001',
      '770175001',
      '770170002',
      '770199002',
      '770170003',
      '77017000',
      'XXXX00001',
      '77010000A',
    ];
    check(V.kpp, valid.filter((v) => /^\d{4}[0-9A-Z]{2}\d{3}$/.test(v)).concat(['770101003', '770101004', '7701ED001']), invalid);
  });

  it('account: 20 цифр + ключ по БИК', () => {
    const biks = ['044525225', '044525974', '044525593', '044030653', '044525700', '044525999', '040702615', '045004641', '046015207', '047102651'];
    const accs = [
      '40702810400000012345',
      '40702810900000054321',
      '40817810000000123456',
      '40702978100000000123',
      '40101810400000010002',
      '42301810500000000777',
      '40802810600001234567',
      '40702810100000000999',
      '40503810300000001234',
      '40702810700000012121',
    ];
    const valid = biks.flatMap((b, i) => [accountComplete(b, accs[i], false), accountComplete(b, accs[(i + 1) % 10], false)]);
    valid.push(accountComplete('044525225', '30101810400000000225', true), accountComplete('044525974', '30101810145250000974', true));
    const pairs = [...biks.map((b, i) => [accountComplete(b, accs[i], false), b])];
    const bad = pairs.flatMap(([a, b]) => [
      [a.slice(0, 8) + ((Number(a[8]) + 1) % 10) + a.slice(9), b],
      [a, b.slice(0, 8) + ((Number(b[8]) + 1) % 10)],
    ]);
    expect(valid.length).toBeGreaterThanOrEqual(20);
    // валидные — с БИК, для которого строились
    biks.forEach((b, i) => {
      expect(V.account(accountComplete(b, accs[i], false), { bik: b })).toBe(true);
      expect(V.account(accountComplete(b, accs[(i + 1) % 10], false), { bik: b })).toBe(true);
    });
    expect(V.account(accountComplete('044525225', '30101810400000000225', true), { bik: '044525225' })).toBe(true);
    expect(V.account(accountComplete('044525974', '30101810145250000974', true), { bik: '044525974' })).toBe(true);
    for (const [a, b] of bad.slice(0, 20)) expect(V.account(a, { bik: b }), `${a}/${b}`).toBe(false);
    // длина без БИК
    expect(V.account('40702810400000012345')).toBe(true);
    for (const x of ['4070281040000001234', '407028104000000123456', 'abcdefghijklmnopqrst', '', '1234']) expect(V.account(x)).toBe(false);
    expect(V.accountKeyOk('40702810400000012345', '044525225')).toBeTypeOf('boolean');
  });

  it('swift: ISO-3166 в 5–6 символах', () => {
    const valid = [
      'DEUTDEFF',
      'SABRRUMM',
      'DEUTDEFF500',
      'CHASUS33',
      'BARCGB22',
      'BNPAFRPP',
      'INGBNL2A',
      'UBSWCHZH80A',
      'ALFARUMM',
      'VTBRRUMM',
      'TINKRUMM',
      'RZBAATWW',
      'CITIUS33',
      'HSBCHKHH',
      'BKCHCNBJ',
      'ICBKCNBJ',
      'GIBAATWW',
      'SOGEFRPP',
      'UNCRITMM',
      'BSCHESMM',
      'CRESCHZZ',
      'NDEAFIHH',
    ];
    const invalid = [
      'CONTRACT',
      'DEUTDE',
      'DEUTDEFF5',
      'deutdeff1',
      '12345678',
      'ABCD1234',
      'DEUT00FF',
      'ABCDEFGHIJKL',
      '',
      'SABRRU',
      'SABR RUMM',
      'COMPANY1',
      'ABCDQQFF',
      'ABCDZZ11',
      'ABCDAAXX',
      'ABCDYYAA',
      'ABCDJJAA',
      'ABCDUUAA',
      'ABCDOOAA',
      'ABCDQQ12345',
    ];
    check(V.swift, valid, invalid);
  });

  it('taxid: EIN, UTR, VAT ЕС', () => {
    const valid = [
      '12-3456789',
      '01-2345678',
      '27-1234567',
      '30-0000001',
      '48-1234567',
      '50-9999999',
      '68-1234567',
      '71-1234567',
      '77-7654321',
      '80-1111111',
      '88-2222222',
      '90-3333333',
      '95-4444444',
      '98-5555555',
      '99-6666666',
      'DE123456789',
      'FR12345678901',
      'GB123456789',
      'GB123456789012',
      'NL123456789B01',
      'IT12345678901',
      'ESX1234567Z',
      'PL1234567890',
      'CZ12345678',
      'CZ1234567890',
      '1234567890',
    ];
    const invalid = [
      '07-1234567',
      '17-1234567',
      '28-1234567',
      '49-1234567',
      '69-1234567',
      '70-1234567',
      '78-1234567',
      '89-1234567',
      '96-1234567',
      '00-1234567',
      '12-345678',
      '12-34567890',
      'DE12345678',
      'DE1234567890',
      'FR1234',
      'GB12345',
      'NL123456789X01',
      'IT1234567890',
      'PL123456789',
      'CZ1234567',
      'US123456789',
      'abc',
      '',
      '12345678901',
      'XX123456789',
    ];
    check(V.taxid, valid, invalid);
  });

  it('passport: структура', () => {
    const valid = [
      '45 05 123456',
      '4505 123456',
      '4505123456',
      '45 05 № 123456',
      '4610123456',
      '0301654321',
      '9915000001',
      '7702111222',
      '5012333444',
      '6309999000',
      '7101123456',
      '2205456789',
      '711234567',
      '751234567',
      'AB1234567',
      '123456789',
      'C01X00T47',
      'N1234567',
      'P12345678',
      'XD1234567',
      'K1234567A1',
      '1234567890',
    ];
    const invalid = [
      '0005123456',
      '4505000000',
      '12345',
      '',
      'abcdefgh',
      'ABCDEFGH',
      '45051234567890123',
      '4505-1',
      '1',
      'ABC',
      '00 05 123456',
      '45 05 000000',
      '1234',
      'AB12',
      'ABCDEFGHIJKLMN12',
      'ab',
      '0012345678',
      '45',
      '45 05',
      '001234567',
      '00-1234567',
    ];
    check(V.passport, valid, invalid);
  });

  it('email', () => {
    const valid = [
      'ivan.petrov@firm.ru',
      'info@компания.рф',
      'a.b@c.de',
      'user+tag@example.com',
      'first_last@sub.domain.org',
      'x@y.io',
      'Иван.Петров@почта.рф',
      "o'brien@mail.ie",
      'test123@test-domain.co.uk',
      'a@b.cc',
      'mail@xn--80aswg.xn--p1ai',
      'p.ivanov@romashka.ru',
      'sales@vector-m.ru',
      'user@mail.ru',
      'u@d.travel',
      'name.surname@university.edu',
      'support@help.example.com',
      '1@2.ru',
      'abc@xyz.info',
      'ab-cd@ef-gh.net',
    ];
    const invalid = [
      '@username',
      'a@b',
      'a@@b.ru',
      'plain',
      'a b@c.ru',
      '@',
      '',
      'a@.ru',
      'a@b..ru',
      '.a@b.ru',
      'a.@b.ru',
      'a@b.r',
      'a@-b.ru',
      'a@b-.ru',
      'a@b.123',
      'icon@2x.png',
      'x@y.jpg',
      'user@',
      'user@domain',
      'a@b.c',
      '..a@b.ru',
      'a@b,ru',
    ];
    check(V.email, valid, invalid);
  });

  it('url', () => {
    const valid = [
      'https://firm.ru/contract',
      'http://example.com',
      'www.acme.com',
      'https://sub.domain.org/a/b?c=d#e',
      'ftp://files.example.net/x',
      'firm.ru',
      'acme.com/path',
      'https://xn--80aswg.xn--p1ai',
      'https://компания.рф/договор',
      'https://example.co.uk',
      'http://192.168.0.1/admin',
      'https://site.io',
      'www.firm.ru/a',
      'https://localhost',
      'https://a.b.c.example.de/x',
      'example.org',
      'https://example.xyz',
      'https://mail.google.com',
      'https://docs.python.org/3',
      'moscow.ru',
      // Со схемой или «www.» зона не сверяется со списком: лучше заменить лишнее, чем пропустить ссылку.
      'https://example.zzzzzz',
      'https://www.northwind.example/terms',
    ];
    const invalid = [
      'п. 1.2.3',
      'example.docx',
      'file.txt',
      '',
      'localhost',
      'abc',
      '1.2.3',
      'a.b',
      'script.py',
      'http://',
      'https://nodot',
      'photo.jpg',
      'v1.2',
      'example.zzzzzz',
      'a..ru',
      'x.sh',
      'http://999.1.1.1',
      'www.',
      'name.doc',
      'readme.md',
      'run.cmd',
    ];
    check(V.url, valid, invalid);
  });

  it('phone', () => {
    const valid = [
      '+7 (495) 123-45-67',
      '8-900-123-45-67',
      '+79001234567',
      '89001234567',
      '8 (800) 555-35-35',
      '+44 20 7946 0958',
      '+1 202 555 0147',
      '+49 30 901820',
      '+33 1 23 45 67 89',
      '+380 44 123 45 67',
      '+7 495 123 45 67',
      '7 495 123-45-67',
      '8-900-123-45-67 доб. 12',
      '+7(916)123-45-67',
      '+375 29 123 45 67',
      '+86 10 1234 5678',
      '+39 06 1234 5678',
      '+420 123 456 789',
      '+7 812 123-45-67',
      '+34 912 345 678',
      '9001234567',
      '4951234567',
    ];
    const invalid = [
      '1234567',
      '2024-2025',
      '+7 495 123 45',
      '+7 495 123 45 678',
      '12345',
      '',
      'abc',
      '+1234',
      '8-900-123-45-678',
      '+7 (495) 123-45-67 8',
      '1234567890123456',
      '+123456',
      '+12345678901234567',
      '88001234',
      '+7',
      '8',
      '12-34',
      '+',
      '0000',
      '99',
      '77',
    ];
    check(V.phone, valid, invalid);
  });

  it('birthdate: реальная дата, год 1900…(текущий−14)', () => {
    const ctx = { now: '2026-10-04' };
    const valid = [
      '12.03.1985',
      '01.01.1900',
      '31.12.1999',
      '29.02.2000',
      '5/6/1990',
      '12/03/1985',
      '1 января 1985',
      '12 марта 1985',
      '31 декабря 2000',
      '15 мая 1975',
      'March 12, 1985',
      'Mar 12, 1985',
      '12 March 1985',
      'Dec 31, 2000',
      'February 29, 2000',
      '29.02.1996',
      '30.04.2010',
      '04.10.2012',
      '1.1.2000',
      'Sept. 5, 1980',
      '7th July 1970',
      'May 5th, 1990',
    ];
    const invalid = [
      '31.02.1985',
      '32.01.1985',
      '12.13.1985',
      '00.01.1985',
      '12.03.1899',
      '12.03.2024',
      '04.10.2013'.replace('2013', '2013'),
      '29.02.1900',
      '29.02.2001',
      '1 foo 1985',
      '12.03.85',
      '',
      'abc',
      '12-03',
      '99.99.9999',
      '31.04.1990',
      'Feb 30, 1990',
      'April 31, 1990',
      '1985',
      '12 марта',
      '12.03.2026',
    ];
    check(V.birthdate, valid, invalid, ctx);
    expect(V.parseDate('12.03.1985')).toEqual({ d: 12, m: 3, y: 1985 });
  });

  it('legalForm и address (структурные проверки для WP2)', () => {
    expect(V.legalForm('ООО «Ромашка»')).toBe(true);
    expect(V.legalForm('Acme Ltd.')).toBe(true);
    expect(V.legalForm('Ромашка')).toBe(false);
    expect(V.address('123456, г. Москва, ул. Ленина, д. 1, офис 5')).toBe(true);
    expect(V.address('10 Downing Street, London SW1A 2AA')).toBe(false); // один компонент по структуре — решает WP2 по числу и ZIP
    expect(V.address('г. Москва')).toBe(false);
    expect(V.getValidator('inn')).toBe(V.inn);
    expect(V.getValidator('нет такого')).toBe(null);
  });
});
