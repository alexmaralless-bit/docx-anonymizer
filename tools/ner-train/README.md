# Обучение NER-модели `rubert-tiny2-ner-ruen`

Здесь обучается, экспортируется в ONNX, квантуется и готовится к упаковке модель распознавания имён
(PER / ORG / LOC) для локального ONNX-провайдера расширения DOCX Anonymizer (WP9, ступень 3 NER).

* База: [`cointegrated/rubert-tiny2`](https://huggingface.co/cointegrated/rubert-tiny2) (MIT; BERT, 3 слоя, hidden 312,
  словарь WordPiece 83 828, `do_lower_case=false`, `strip_accents=null` → регистр и диакритика не меняются).
* Данные: WikiANN, [`unimelb-nlp/wikiann`](https://huggingface.co/datasets/unimelb-nlp/wikiann), конфигурации `ru` и `en`
  (разбиение Rahimi et al.: train/validation/test = 20k/10k/10k на язык; теги BIO уже в нужном порядке).
  Обучение — на объединённом train ru+en. Датасет загружается под этим именем напрямую (parquet, `datasets` 5.x),
  зеркало не понадобилось. Collection3/NEREL/CoNLL не используются (лицензии).
* Метки (ровно в этом порядке): `O, B-PER, I-PER, B-ORG, I-ORG, B-LOC, I-LOC`.
* Код — на английском, все параметры — в `config.yaml`; любой ключ переопределяется флагом `--set ключ=значение`
  (например, `--set run_id=exp1 --set train.epochs=10`). Сиды фиксированы (`seed: 42`).
* Артефакты — в `runs/<run_id>/` (в git не попадают, см. `.gitignore`), итоговый пакет-источник — в
  `models-src/<id>/` в корне репозитория (тоже вне git).

## Окружение

* Python 3.12 через [`uv`](https://docs.astral.sh/uv/) (системный `python3` не нужен).
* PyTorch с CUDA 12.8 (индекс `pytorch-cu128` в `pyproject.toml`) — нужен для Blackwell (RTX 50xx, `sm_120`).
  Без GPU всё работает на CPU, обучение заметно дольше.
* Кэш Hugging Face — в `tools/ner-train/.cache/hf` (задаётся в `common.py`).

```bash
cd tools/ner-train
uv sync
uv run python -c "import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_arch_list())"
```

## Последовательность команд

```bash
cd tools/ner-train
uv sync                                   # Python 3.12 + torch cu128 и остальные зависимости
uv run python prepare.py                  # WikiANN ru+en + 10 % синтетики -> runs/rubert-tiny2-ner-ruen/data/
uv run python teacher.py                  # учитель XLM-R base, ~6 мин на RTX 5070 Laptop (8 ГБ)
uv run python train.py                    # ученик rubert-tiny2 с дистилляцией, 15 эпох, ~5 мин
uv run python evaluate.py                 # F1 по классам на ru/en test + гейты
uv run python export_onnx.py              # ONNX fp32, opset 17
uv run python quantize.py                 # int8, гейт <= 40 МБ
uv run python verify_onnx.py              # согласие argmax int8 <-> PyTorch >= 99 %
uv run python calibrate.py                # порог nerThreshold
uv run python bench_ort.py                # мс/окно в ORT CPU, 1 нить
uv run python make_tokenizer_fixture.py   # tests/fixtures/ner/wordpiece-cases.json
uv run python make_pack_src.py            # models-src/rubert-tiny2-ner-ruen/
```

Варианты: без синтетики — `--set data.synth.enabled=false` ко всем командам (WikiANN-гейты берутся, но на
договорных текстах ORG почти не находится — см. ниже); без дистилляции — пропустить `teacher.py` и добавить
`--set distill.enabled=false` (F1(ORG) ru ≈ 0.73, гейт К7 не берётся).
Эксперимент в отдельном каталоге: добавить ко всем командам `--set run_id=<имя>`.

После обучения можно освободить место: `runs/<id>/checkpoints/`, `runs/<id>/teacher/checkpoints/` не нужны
(на диске остаётся ≈ 1.6 ГБ, из них 1.1 ГБ — учитель).

Затем в корне репозитория: `npm run pack:model -- --id=rubert-tiny2-ner-ruen` (zip в `release/`, хеши файлов
добавляет JS-упаковщик).

## Что делает каждый скрипт

| Скрипт | Что делает | Результат |
|---|---|---|
| `prepare.py` | Загружает WikiANN ru/en, токенизирует базовым `BertTokenizerFast` (`max_length` 128), метка — на первый субтокен слова, остальным `-100` | `runs/<id>/data/`, `data_info.json` |
| `teacher.py` | (Дистилляция) обучает учителя `FacebookAI/xlm-roberta-base` на тех же данных и сохраняет его логиты по словам train | `runs/<id>/teacher/` |
| `train.py` | `AutoModelForTokenClassification` + `Trainer`, оценка каждую эпоху, лучшая по `eval_f1` (seqeval, ru+en validation); при `distill.enabled` — CE + KL к учителю | `runs/<id>/model/`, `train.json` |
| `evaluate.py` | seqeval по классам на ru/en test (PyTorch fp32), гейты | раздел `metrics` в `eval.json` |
| `export_onnx.py` | ONNX opset 17, динамические оси `batch`/`sequence`, входы `input_ids`, `attention_mask`, `token_type_ids` (int64), выход `logits`; `onnx.checker` и сверка с PyTorch | `runs/<id>/onnx/model.fp32.onnx` |
| `quantize.py` | `quant_pre_process` + `quantize_dynamic` (MatMul, int8, per-channel) + построчная uint8-квантизация таблицы эмбеддингов (см. ниже); гейт ≤ 40 МБ | `runs/<id>/onnx/model.int8.onnx` |
| `verify_onnx.py` | 50 предложений test: согласие argmax int8 ↔ PyTorch fp32 (гейт ≥ 99 %), средняя \|Δlogit\|, батч [8,128] на `CPUExecutionProvider`, F1 int8 на полном test | раздел `verify` |
| `calibrate.py` | Порог `nerThreshold` по int8-модели на ru+en validation: сетка 0.30…0.95 шаг 0.05, максимум span micro-F1 | `runs/<id>/calibration.json` |
| `bench_ort.py` | мс на окно [1,128] и [8,128] в onnxruntime CPU, одна нить (ориентир для WASM) | раздел `bench_ort` |
| `make_tokenizer_fixture.py` | 40 случаев для JS-токенизатора: слова с офсетами (UTF-16) и id субтокенов | `tests/fixtures/ner/wordpiece-cases.json` |
| `make_pack_src.py` | Собирает `model.onnx`, `vocab.txt`, `config.json`, `LICENSE`, `NOTICE`, `pack.src.json` | `models-src/<id>/` |
| `synth.py` | (Опционально) шаблонные предложения в стиле договоров с вымышленными сущностями, ≤ 20 % примеси (`data.synth.enabled`) | — |

Все числа собираются в `runs/<id>/eval.json` (каждый скрипт пишет свой раздел).

## Решения и находки

**Почему дистилляция.** С гиперпараметрами из задания (lr 5e-5, batch 32, 5 эпох, warmup 10 %) F1(ORG) на ru test
= 0.708 при гейте 0.75. Перебор не помог — потолок маленькой модели (3 слоя) на ORG ≈ 0.73–0.74
(выбор — по `eval_f1` на validation, test только для сводки):

| Вариант | val F1 | ru PER | ru ORG | ru LOC | en PER |
|---|---|---|---|---|---|
| lr 5e-5, 5 эп. (задание) | 0.7571 | 0.903 | 0.708 | 0.835 | 0.768 |
| lr 5e-5, 10 эп. | 0.7608 | 0.899 | 0.717 | 0.843 | 0.769 |
| lr 1e-4, 5 эп. | 0.7626 | 0.904 | 0.726 | 0.851 | 0.775 |
| lr 1e-4, 10 эп. | 0.7619 | 0.898 | 0.733 | 0.847 | 0.772 |
| lr 1e-4, 10 эп., label smoothing 0.1 | 0.7627 | 0.896 | 0.729 | 0.843 | 0.778 |
| lr 1e-4, 10 эп., batch 16 | 0.7655 | 0.897 | 0.736 | 0.853 | 0.777 |
| lr 2e-4, 10 эп. | 0.7623 | 0.898 | 0.738 | 0.850 | 0.773 |
| lr 2e-4, 10 эп., ru×2 в train | 0.7611 | 0.893 | 0.731 | 0.845 | 0.771 |
| lr 3e-4, 15 эп. | 0.7548 | 0.889 | 0.727 | 0.838 | 0.764 |
| **KD**, lr 1e-4, 10 эп., α 0.5 | 0.7855 | 0.915 | 0.756 | 0.864 | 0.801 |
| **KD**, lr 2e-4, 10 эп., α 0.5 | 0.7933 | 0.915 | 0.761 | 0.866 | 0.813 |
| **KD**, lr 2e-4, 15 эп., α 0.5 | 0.7942 | 0.916 | 0.765 | 0.870 | 0.808 |
| **KD, lr 2e-4, 10 эп., α 0.3 — лучший без синтетики** | 0.7964 | 0.915 | 0.758 | 0.863 | 0.809 |

Помогла только дистилляция знаний: учитель `FacebookAI/xlm-roberta-base` (MIT), обученный на тех же
WikiANN ru+en (3 эпохи, lr 3e-5; ru test: PER 0.942, ORG 0.805), даёт мягкие метки на словах train;
ученик учится на `α·CE(gold) + (1−α)·T²·KL(учитель‖ученик)`, T = 2. Учитель не распространяется, в пакет
попадают только веса ученика.

**Почему синтетика.** WikiANN — это заголовки статей Википедии: там нет организаций с ОПФ и кавычками
(«ООО “Меридиан-М”», «Общество с ограниченной ответственностью «…»») и ФИО в косвенных падежах и с
инициалами. Модель только на WikiANN (KD, без синтетики) на договорном корпусе `tests/fixtures/ner/eval-ru.json`
(приближённая оценка этим кодом, точное совпадение спанов, порог 0.7) давала PER 0.742, ORG 0.228; JS-провайдер на
том же экспорте — ORG 0.595 (гейт К8 ≥ 0.65 не взят). `synth.py` добавляет 4 000 шаблонных предложений (10 % от
train WikiANN; 75 % ru, 25 % en): короткие и полные ОПФ, три вида кавычек, названия без ОПФ, ФИО в 4 падежах,
инициалы до и после фамилии, фамилии на -ский и несклоняемые, «ИП» вне спана, адреса, негативы
(«Заказчик», должности). Словари и шаблоны собственные, не из генератора корпуса оценки; но стиль тот же,
поэтому числа на `eval-ru.json` оптимистичны — решающими для К7 остаются числа WikiANN. Сравнение (KD, α 0.3, lr 2e-4):

| Вариант | val F1 WikiANN | ru PER | ru ORG | en PER | eval-ru PER / ORG (Python, точное совпадение) |
|---|---|---|---|---|---|
| без синтетики, 10 эп. | 0.7963 | 0.917 | 0.764 | 0.809 | 0.742 / 0.228 |
| синтетика 10 %, 10 эп. | 0.7947 | 0.914 | 0.755 | 0.814 | 0.929 / 0.837 |
| **синтетика 10 %, 15 эп. — выбран** (по val F1) | 0.7978 | 0.916 | 0.762 | 0.810 | 0.941 / 0.758 |

**Квантизация.** Стандартный `quantize_dynamic` с `Gather` квантует таблицу эмбеддингов одним масштабом на всю
таблицу (uint8, per-tensor) — файл 27.9 МБ, но согласие argmax падает до 98.1 % на 50 предложениях
(98.5 % на 2000). Поэтому: MatMul — `quantize_dynamic` int8 per-channel; эмбеддинги слов — построчная
асимметричная uint8-квантизация (масштаб и минимум на каждую строку словаря), собранная из стандартных
операторов `Gather → Cast → Mul → Add` (+0.67 МБ на масштабы). Позиционные эмбеддинги (2048×312) и
token_type оставлены fp32. В графе только операторы домена `ai.onnx` (opset 17): `MatMulInteger`,
`DynamicQuantizeLinear`, `Gather`, `LayerNormalization`, `Softmax`, `Erf` и т. п. — без com.microsoft.
Обрезка словаря не понадобилась.

**Экспорт.** `torch.onnx.export(..., dynamo=False)` с `attn_implementation="eager"`; оболочка модели
обязательно в `eval()` — иначе экспортёр после трассировки возвращает режим обучения (dropout) и сверка
с PyTorch ломается. `quant_pre_process` запускается без symbolic shape inference (на этом графе она падает
с «Incomplete symbolic shape inference»), ONNX shape inference достаточно.

**Калибровка.** Декодирование как в расширении: метка первого субтокена каждого слова, мягкое слияние BIO
(I-X после O или другого типа начинает новый спан). Score спана по умолчанию — как в JS-провайдере:
средняя по словам маргинальная вероятность типа P(B-X)+P(I-X) на первом субтокене (`calibrate.score: marginal`);
вариант `argmax` — средняя вероятность предсказанной метки. Метрика — точное совпадение спанов, micro-F1 по
PER+ORG+LOC на ru+en validation. Обе шкалы дают порог 0.70; кривая плоская (0.65–0.75 различаются < 0.001 F1).

**Токенизатор (для JS).** `BertNormalizer(clean_text=true, handle_chinese_chars=true, strip_accents=null,
lowercase=false)` + `BertPreTokenizer`, WordPiece `##`, `max_input_chars_per_word=100` (слово длиннее —
целиком `[UNK]`). Управляющие и форматирующие символы (например, U+200B) удаляются, NBSP — пробел,
иероглифы CJK — отдельные слова, эмодзи и «—», «“», «‘» — `[UNK]`. Офсеты в фикстуре — в единицах UTF-16
(индексы строк JS), а не в кодовых точках Python. `vocabSample` — все токены, встречающиеся в случаях, и
спецтокены: жадный longest-match по такому подмножеству даёт тот же результат, что и по полному словарю.

**Воспроизводимость.** Сиды фиксированы (`seed: 42`, `data_seed`), но обучение на GPU (fp16, cuDNN) не
бит-в-бит детерминировано: повторные прогоны одного рецепта расходятся на ±0.005 F1 (например, ru ORG 0.758 / 0.764).

## Результаты

Прогон `runs/rubert-tiny2-ner-ruen/` (2026-10-15, RTX 5070 Laptop, torch 2.11.0+cu128, transformers 4.57.6,
onnxruntime 1.31.0; рецепт из `config.yaml`: KD + синтетика 10 %, lr 2e-4, 15 эпох). Полные числа —
в `runs/rubert-tiny2-ner-ruen/eval.json`.

| | PER | ORG | LOC | micro |
|---|---|---|---|---|
| ru test, PyTorch fp32 | **0.9146** (гейт ≥ 0.85) | **0.7601** (гейт ≥ 0.75) | 0.8617 | 0.8441 |
| en test, PyTorch fp32 | 0.8106 (≥ 0.80, справочно) | 0.6511 | 0.7707 | 0.7439 |
| ru test, ONNX int8 | 0.9159 | 0.7616 | 0.8612 | 0.8448 |
| en test, ONNX int8 | 0.8091 | 0.6521 | 0.7719 | 0.7442 |

* Время обучения: ученик 306 с (15 эпох), учитель 374 с (3 эпохи); весь конвейер ≈ 15 мин.
* Размер: `model.fp32.onnx` 111.1 МБ → `model.int8.onnx` 30.4 МБ (гейт ≤ 40 МБ).
* Согласие argmax int8 ↔ PyTorch fp32: 99.70 % на 50 предложениях (670 токенов, гейт ≥ 99 %),
  99.65 % на 2000 предложениях; средняя |Δlogit| 0.026. ONNX fp32 ↔ PyTorch: 100 %, |Δ| 6e-7.
* Калиброванный порог: **0.70** (marginal; span micro-F1 0.8089 на ru+en validation, при 0.60 — 0.8074).
* onnxruntime CPU (нативный), 1 нить: [1,128] 2.8 мс, [8,128] 24.9 мс (3.1 мс/окно); создание сессии ≈ 0.1 с.
* JS-провайдер (`node scripts/bench-ner.mjs`, onnxruntime-web WASM, порог 0.7): холодная инициализация 293 мс,
  ≈ 12.5 мс/окно; `eval-ru.json`: PER 0.982, ORG 0.923, LOC 0.938 (micro 0.956).
