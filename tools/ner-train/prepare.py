"""Build the training mix from config.yaml data.sources[] + synthetic sentences, tokenize with the base WordPiece
tokenizer and align labels.

Labels are put on the first sub-token of every word; other sub-tokens and special tokens get -100.
Splits in runs/<run_id>/data/ (datasets.DatasetDict saved to disk):
  train                      — weighted mix of the sources' train splits + synthetic sentences (shuffled);
  validation                 — validation splits of the sources that have one (WikiANN ru+en), model selection;
  validation_<lang>, test_<lang> — WikiANN per language (gates ru_per_f1 / ru_org_f1);
  test_<source id>           — held-out part of other corpora (e.g. test_factru, informational);
  test_synth_genre           — held-out genre sentences (gate synth_genre_org_precision; columns genre, negative).
"""
from __future__ import annotations

import glob
import hashlib
import json
import random

from common import REPO, bio_spans, load_config, run_dir, set_seed  # noqa: E402  (sets HF_HOME)
from datasets import ClassLabel, Dataset, DatasetDict, Features, Sequence, Value, concatenate_datasets
from pathlib import Path

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


def features(labels):
    return Features({"tokens": Sequence(Value("string")), "ner_tags": Sequence(ClassLabel(names=labels)),
                     "lang": Value("string")})


def weighted(rows: dict, weight: float, rng: random.Random) -> dict:
    """Repeat a split int(weight) times and add a random subsample for the fractional part."""
    n = len(rows["tokens"])
    idx = list(range(n)) * int(weight)
    frac = weight - int(weight)
    if frac > 0:
        idx += sorted(rng.sample(range(n), round(n * frac)))
    return {k: [v[i] for i in idx] for k, v in rows.items()}


def fingerprint(ds) -> str:
    h = hashlib.sha256()
    for toks, tags in zip(ds["tokens"], ds["ner_tags"]):
        h.update(("\x1f".join(toks) + "\x1e" + ",".join(map(str, tags)) + "\x1d").encode())
    return h.hexdigest()


def gold_values(pattern: str) -> tuple[dict, list[str]]:
    """PERSON / COMPANY values of the genre corpus gold files (WP11-B), to keep them out of the synthetic data."""
    files = sorted(glob.glob(str(REPO / pattern), recursive=True))
    vals = {"PERSON": set(), "COMPANY": set()}
    for f in files:
        for e in json.loads(Path(f).read_text(encoding="utf-8")).get("entities", []):
            if e.get("category") in vals:
                vals[e["category"]].add(e["value"])
    return vals, files


def entity_strings(ds, labels) -> dict:
    out = {"PER": set(), "ORG": set(), "LOC": set()}
    for toks, tags in zip(ds["tokens"], ds["ner_tags"]):
        for typ, a, b in bio_spans([labels[t] for t in tags]):
            out[typ].add(" ".join(toks[a:b]))
    return out


def gold_overlap(gold: dict, ds, labels) -> dict:
    """Exact matches of gold values (tokenized like synth.py) with entity spans of a split."""
    from synth import TOKEN_RE, _norm
    ents = {k: {_norm(x) for x in v} for k, v in entity_strings(ds, labels).items()}
    res = {}
    for cat, typ in (("PERSON", "PER"), ("COMPANY", "ORG")):
        hits = sorted(v for v in gold[cat] if _norm(" ".join(TOKEN_RE.findall(v))) in ents[typ])
        res[cat] = {"gold_values": len(gold[cat]), "exact_matches": len(hits), "values": hits}
    return res


def synth_count(n_real: int, sc: dict, mode: str) -> tuple[int, float]:
    if "share" in sc:
        share = float(sc["share"])
        if mode == "teacher_synth":
            share = max(share, float(sc.get("teacher_synth_min_share", 0.5)))
        assert 0 <= share <= float(sc.get("max_ratio", 0.5)), f"synthetic share {share} > synth.max_ratio"
        assert share < 1
        return round(n_real * share / (1 - share)), share
    n = int(n_real * float(sc["ratio"]))  # legacy 1.0.0 key: relative to the real train size
    share = n / (n + n_real)
    assert share <= float(sc.get("max_ratio", 0.5)), f"synthetic share {share:.3f} > synth.max_ratio"
    return n, share


def main():
    cfg, _ = load_config()
    set_seed(cfg["seed"])
    rng = random.Random(cfg["seed"])
    labels = cfg["labels"]
    feats = features(labels)
    out = run_dir(cfg) / "data"
    tokenizer = AutoTokenizer.from_pretrained(cfg["base_model"])
    dc = cfg["data"]
    max_length = dc["max_length"]
    mode = dc.get("mode", "sources")
    assert mode in ("sources", "teacher_synth"), mode

    from sources import load_source
    train_parts, val_parts, result, src_info = [], [], {}, []
    for src in dc["sources"]:
        if mode == "teacher_synth" and src["kind"] != "wikiann":
            src_info.append({"id": src["id"], "skipped": "data.mode=teacher_synth"})
            continue
        d = load_source(src, labels)
        tr = weighted(d["train"], float(src.get("weight", 1)), rng)
        train_parts.append(Dataset.from_dict(tr, features=feats))
        info = {"id": src["id"], "kind": src["kind"], "weight": src.get("weight", 1),
                "train_sentences": len(d["train"]["tokens"]), "train_used": len(tr["tokens"])}
        if src["kind"] == "wikiann":
            lang = src["lang"]
            v = Dataset.from_dict(d["validation"], features=feats)
            val_parts.append(v)
            result[f"validation_{lang}"] = v
            result[f"test_{lang}"] = Dataset.from_dict(d["test"], features=feats)
        elif d.get("test"):
            name = f"test_{src['kind']}"
            result[name] = Dataset.from_dict(d["test"], features=feats)
            info["test_split"] = name
            info["test_sentences"] = len(d["test"]["tokens"])
        src_info.append(info)

    real = concatenate_datasets(train_parts)
    synth_info = None
    parts = [real]
    sc = dc["synth"]
    if sc["enabled"]:
        from synth import Lex, generate, generate_genre_test, gold_block_words
        n, share = synth_count(len(real), sc, mode)
        gold, gold_files, block = None, [], None
        if sc.get("exclude_gold"):
            gold, gold_files = gold_values(sc["exclude_gold"])
            block = gold_block_words(gold["PERSON"] | gold["COMPANY"])
        sd = generate(n, int(sc["seed"]), labels, genre_share=float(sc.get("genre_share", 0.0)),
                      negative_share=float(sc.get("negative_share", 0.45)), block=block)
        neg = sum(sd["negative"]) / max(1, len(sd))
        assert neg >= float(sc.get("min_negative_share", 0.0)), f"entity-free synthetic share {neg:.3f} too low"
        genres = {}
        for g in sd["genre"]:
            genres[g] = genres.get(g, 0) + 1
        exclude = {tuple(t) for t in sd["tokens"]}
        gt = generate_genre_test(int(sc.get("test_size", 2000)), int(sc["test_seed"]), labels,
                                 float(sc.get("negative_share", 0.45)), exclude, block=block)
        result["test_synth_genre"] = gt.cast_column("ner_tags", Sequence(ClassLabel(names=labels)))
        parts.append(sd.remove_columns(["genre", "negative"]).cast(feats))
        synth_info = {"sentences": n, "share": round(share, 4), "negative_share": round(neg, 4), "genres": genres,
                      "test_synth_genre": {"sentences": len(gt), "negative": int(sum(gt["negative"]))}}
        if gold is not None:
            removed = {k: v for part in ("train", "test") for k, v in Lex(part, block).removed.items()}
            synth_info["gold_exclusion"] = {
                "pattern": sc["exclude_gold"], "files": len(gold_files),
                "gold_hash": hashlib.sha256("".join(Path(f).read_text(encoding="utf-8") for f in gold_files)
                                            .encode()).hexdigest()[:16],
                "block_words": len(block), "removed_items": sum(len(v) for v in removed.values()),
                "removed": removed,
                "synth_train": gold_overlap(gold, sd, labels), "synth_genre_test": gold_overlap(gold, gt, labels),
                "real_train": gold_overlap(gold, real, labels)}
    train = concatenate_datasets(parts)
    result["train"] = train.shuffle(seed=cfg["seed"])
    result["validation"] = concatenate_datasets(val_parts)

    dd = DatasetDict(result)
    dd = dd.map(tokenize_and_align, batched=True, fn_kwargs={"tokenizer": tokenizer, "max_length": max_length},
                desc="tokenize")
    dd.save_to_disk(str(out))
    truncated = {k: sum(1 for wi, t in zip(v["word_ids"], v["tokens"]) if max(wi) + 1 < len(t)) for k, v in dd.items()}
    info = {"sizes": {k: len(v) for k, v in dd.items()}, "truncated_sentences": truncated, "mode": mode,
            "sources": src_info, "real_train": len(real), "synth": synth_info, "max_length": max_length,
            "train_fingerprint": fingerprint(dd["train"])}
    (run_dir(cfg) / "data_info.json").write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(info, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
