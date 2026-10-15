"""Generate tests/fixtures/ner/wordpiece-cases.json for the JS WordPiece tokenizer.

Reference: BertTokenizerFast of the base model (do_lower_case=false, strip_accents=null,
tokenize_chinese_chars=true, max_input_chars_per_word=100).
Every case lists the pre-tokenized words (char offsets in the source string, in UTF-16 code units = JS string
indices) and the sub-token ids of each word. vocabSample holds every token used by the cases plus the special
tokens; greedy longest-match-first over this subset gives the same result as over the full vocabulary because
any longer candidate is absent from the full vocabulary too.
"""
from __future__ import annotations

import json

from common import REPO, load_config  # noqa: E402
from transformers import AutoTokenizer

LONG = "Ф" + "ы" * 299  # one 300-char word (> max_input_chars_per_word -> [UNK])

TEXTS = [
    "Иванов Пётр Сергеевич",
    "ООО «Ромашка» в лице генерального директора Семёнова Алексея Фёдоровича",
    "Договор № 15/2024-А от 01.02.2024 г.",
    "г. Санкт-Петербург, ул. Ленина, д. 5, кв. 12",
    "Ёлкин Артём и Королёва Алёна",
    "John Smith signed the agreement with Acme Corp.",
    "Компания Google LLC и ПАО «Сбербанк»",
    "ИНН 7707083893, КПП 773601001",
    "Сумма: 1 250 000,00 (один миллион двести пятьдесят тысяч) рублей",
    "Версия 3.14 и 2.0.1",
    "Северо-Западный федеральный округ",
    "Римский-Корсаков, Мамин-Сибиряк, Салтыков-Щедрин",
    "Привет 👋 мир",
    "Договор 🤝🏻 подписан",
    "漢字 и 東京",
    "Москва—Тула – Калуга",
    "\"Кавычки\" и „лапки“ и ‘одинарные’",
    "E-mail: ivanov@example.ru, сайт https://example.com/path?a=1",
    "Тел.: +7 (495) 123-45-67",
    "",
    "   ",
    "\t\n  \r\n",
    "Слово",
    "Сверхдлинное слово: " + LONG + " конец",
    LONG,
    "МГУ им. М. В. Ломоносова",
    "НИУ ВШЭ, РАН, РФ, США, EU",
    "О'Коннор и д'Артаньян",
    "Muller Müller Mueller naïve café",
    "За́мок и замо́к",
    "Неопределённость, непредсказуемость, нечаянно",
    "Abracadabraxyzzy Qwertyuiopasdf",
    "Александр Сергеевич Пушкин родился в Москве в 1799 году.",
    "Mr. O'Neil met Dr. Jean-Luc Picard at 10:30 a.m.",
    "Акционерное общество «Российские железные дороги» (АО «РЖД»)",
    "§ 5.1. Права и обязанности сторон; п. 3) — см. выше…",
    "Х/ф «Иван Васильевич меняет профессию»",
    "50%-ная предоплата, 3-й этап, 1-го числа",
    "Contract No. 42/B between Alpha-Beta GmbH and Ivanov I. I.",
    "ЗАО «Вектор» — неразрывные пробелы и​нулевой пробел",
]


def utf16_index(text: str) -> list[int]:
    """Map Python code-point index -> UTF-16 code-unit index (len(text)+1 entries)."""
    out, pos = [0], 0
    for ch in text:
        pos += 2 if ord(ch) > 0xFFFF else 1
        out.append(pos)
    return out


def main():
    cfg, _ = load_config()
    tok = AutoTokenizer.from_pretrained(cfg["base_model"])
    assert len(TEXTS) == 40, len(TEXTS)
    used: dict[str, int] = {}
    cases = []
    for text in TEXTS:
        enc = tok(text, return_offsets_mapping=True, add_special_tokens=False)
        ids = enc["input_ids"]
        u16 = utf16_index(text)
        words: list[dict] = []
        word_ids: list[list[int]] = []
        prev = None
        for i, (w, (s, e)) in enumerate(zip(enc.word_ids(), enc["offset_mapping"])):
            if w != prev:
                words.append({"start": u16[s], "end": u16[e], "text": text[s:e]})
                word_ids.append([])
                prev = w
            word_ids[-1].append(ids[i])
            words[-1]["end"] = max(words[-1]["end"], u16[e])
            words[-1]["text"] = text[_back(u16, words[-1]["start"]):_back(u16, words[-1]["end"])]
            used[tok.convert_ids_to_tokens(ids[i])] = ids[i]
        cases.append({"text": text, "words": words, "ids": word_ids,
                      "tokens": [tok.convert_ids_to_tokens(x) for x in word_ids]})
    for t in ("[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]"):
        used[t] = tok.convert_tokens_to_ids(t)
    fixture = {
        "source": cfg["base_model"],
        "tokenizer": {"lowercase": False, "stripAccents": False, "tokenizeChineseChars": True,
                      "maxInputCharsPerWord": tok.backend_tokenizer.model.max_input_chars_per_word,
                      "continuingSubwordPrefix": "##"},
        "offsets": "utf16",
        "cls": tok.cls_token_id, "sep": tok.sep_token_id, "unk": tok.unk_token_id, "pad": tok.pad_token_id,
        "vocabSize": len(tok),
        "vocabSample": dict(sorted(used.items(), key=lambda kv: kv[1])),
        "cases": cases,
    }
    out = REPO / "tests" / "fixtures" / "ner" / "wordpiece-cases.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(fixture, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    n_unk = sum(1 for c in cases for w in c["ids"] if tok.unk_token_id in w)
    n_cont = sum(1 for c in cases for w in c["ids"] if len(w) > 1)
    print(f"{out}: {len(cases)} cases, {len(used)} vocab entries, {n_unk} [UNK] words, {n_cont} multi-piece words")


def _back(u16: list[int], unit: int) -> int:
    return u16.index(unit)


if __name__ == "__main__":
    main()
