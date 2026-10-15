"""Download WikiANN ru+en, tokenize with the base WordPiece tokenizer and align labels.

Labels are put on the first sub-token of every word; other sub-tokens and special tokens get -100.
Output: runs/<run_id>/data/ (datasets.DatasetDict saved to disk).
"""
from __future__ import annotations

import json

from common import load_config, run_dir, set_seed  # noqa: E402  (sets HF_HOME)
from datasets import DatasetDict, concatenate_datasets, load_dataset
from transformers import AutoTokenizer


def tokenize_and_align(batch, tokenizer, max_length):
    enc = tokenizer(batch["tokens"], is_split_into_words=True, truncation=True, max_length=max_length)
    all_labels, all_word_ids = [], []
    for i, tags in enumerate(batch["ner_tags"]):
        word_ids = enc.word_ids(batch_index=i)
        labels, prev = [], None
        for w in word_ids:
            if w is None or w == prev:
                labels.append(-100)
            else:
                labels.append(tags[w])
            prev = w
        all_labels.append(labels)
        all_word_ids.append([-1 if w is None else w for w in word_ids])
    enc["labels"] = all_labels
    enc["word_ids"] = all_word_ids
    return enc


def main():
    cfg, _ = load_config()
    set_seed(cfg["seed"])
    out = run_dir(cfg) / "data"
    tokenizer = AutoTokenizer.from_pretrained(cfg["base_model"])
    max_length = cfg["data"]["max_length"]

    splits = {"train": [], "validation": []}
    result = {}
    for lang in cfg["data"]["configs"]:
        ds = load_dataset(cfg["data"]["dataset"], lang)
        names = ds["train"].features["ner_tags"].feature.names
        assert names == cfg["labels"], f"label order mismatch for {lang}: {names}"
        for split in ("train", "validation", "test"):
            part = ds[split].remove_columns([c for c in ds[split].column_names if c not in ("tokens", "ner_tags")])
            part = part.add_column("lang", [lang] * len(part))
            if split == "train":
                # optional oversampling of a language in the training mix (data.oversample: {ru: 2})
                for _ in range(int(cfg["data"].get("oversample", {}).get(lang, 1))):
                    splits[split].append(part)
            elif split in splits:
                splits[split].append(part)
            if split != "train":
                result[f"{split}_{lang}"] = part

    train = concatenate_datasets(splits["train"])
    synth_info = None
    if cfg["data"]["synth"]["enabled"]:
        from synth import generate
        n = int(len(train) * float(cfg["data"]["synth"]["ratio"]))
        assert n <= 0.2 * len(train) + 1, "synthetic share must be <= 20%"
        synth_ds = generate(n, cfg["data"]["synth"]["seed"], cfg["labels"])
        train = concatenate_datasets([train, synth_ds.cast(train.features)])
        synth_info = {"sentences": n}
    result["train"] = train.shuffle(seed=cfg["seed"])
    result["validation"] = concatenate_datasets(splits["validation"])

    dd = DatasetDict(result)
    dd = dd.map(tokenize_and_align, batched=True, fn_kwargs={"tokenizer": tokenizer, "max_length": max_length},
                desc="tokenize")
    dd.save_to_disk(str(out))
    truncated = {k: sum(1 for wi, t in zip(v["word_ids"], v["tokens"]) if max(wi) + 1 < len(t)) for k, v in dd.items()}
    info = {"sizes": {k: len(v) for k, v in dd.items()}, "truncated_sentences": truncated, "synth": synth_info,
            "max_length": max_length, "dataset": cfg["data"]["dataset"], "configs": cfg["data"]["configs"]}
    (run_dir(cfg) / "data_info.json").write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(info, indent=2))


if __name__ == "__main__":
    main()
