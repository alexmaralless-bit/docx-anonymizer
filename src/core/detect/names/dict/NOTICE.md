# Словари ФИО: источники и лицензии

Модули `ru-surnames.js`, `ru-first.js`, `en-first.js`, `en-surnames.js` сгенерированы `scripts/make-dicts.mjs`
(`npm run dicts`, выгрузка 2026-10-15) из перечисленных ниже наборов данных. Данные отфильтрованы
(нижний регистр, «ё» → «е», без стоп-слов и нарицательных), фамилии приведены к мужской лемме и упакованы front-coding (`codec.js`).

## datacoon/russiannames

- Репозиторий: https://github.com/datacoon/russiannames, коммит `ac26a24a9bf0ac05e3330668c5103400a1cbf4ea`
- Файлы: `russiannames/data/surnames.parquet`, `russiannames/data/names.parquet`
- Используется в: `ru-surnames.js`, `ru-first.js`
- Лицензия: BSD-3-Clause

```
BSD 3-Clause License

Copyright (c) 2018, Ivan Begtin
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the copyright holder nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## natasha/natasha

- Репозиторий: https://github.com/natasha/natasha, коммит `08ae8452db9391f7c19730e61201cd442014a242`
- Файл: `natasha/data/dict/maybe_first.txt` (имена-омонимы нарицательных); `last.txt` — только для метрики генератора, в расширение не входит
- Используется в: `ru-first.js` (`AMBIGUOUS`)
- Лицензия: MIT (Natasha project)

```
The MIT License (MIT)

Copyright (c) 2016

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## U.S. Census Bureau

- 1990 Census, Frequently Occurring Names: https://www2.census.gov/topics/genealogy/1990surnames/ (`dist.male.first`, `dist.female.first`) → `en-first.js`
- 2010 Census, Frequently Occurring Surnames: https://www2.census.gov/topics/genealogy/2010surnames/ (`names.zip`) → `en-surnames.js`
- Лицензия: public domain — работы федерального правительства США не охраняются авторским правом (17 U.S.C. § 105).
