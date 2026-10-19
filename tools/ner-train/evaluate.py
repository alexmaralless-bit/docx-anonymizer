"""Per-class seqeval metrics of the trained PyTorch model -> runs/<run_id>/eval.json (section "metrics") + gates.

Splits: WikiANN ru/en test and validation; held-out parts of other corpora (test_factru, informational);
test_synth_genre — held-out genre sentences: ORG precision (gate), PER/ORG/LOC P/R/F1 per genre and the number of
false ORG spans on entity-free (negative) sentences (informational).

--strict: exit code 1 when a non-informational gate fails (for scripts / CI).
"""
from __future__ import annotations

import json
import sys

from common import bio_spans, load_config, run_dir, torch_logits, update_eval, word_level  # noqa: E402
import torch
from datasets import load_from_disk
from seqeval.metrics import classification_report, f1_score
from transformers import AutoModelForTokenClassification


def predict(model, split, labels):
    logits = torch_logits(model, split)
    y_true, y_pred = [], []
    for lg, wid, tags in zip(logits, split["word_ids"], split["ner_tags"]):
        pred, _ = word_level(lg, wid, len(tags), labels)
        y_true.append([labels[t] for t in tags])
        y_pred.append(pred)
    return y_true, y_pred


def report(y_true, y_pred):
    rep = classification_report(y_true, y_pred, output_dict=True, digits=4, zero_division=0)
    res = {k: {m: round(float(v), 4) for m, v in rep[k].items()} for k in ("PER", "ORG", "LOC", "micro avg") if k in rep}
    res["micro_f1"] = round(float(f1_score(y_true, y_pred)), 4)
    return res


def genre_report(split, y_true, y_pred):
    """Per genre: seqeval report + false ORG spans on entity-free sentences."""
    out = {}
    by_genre = {}
    for g, neg, yt, yp in zip(split["genre"], split["negative"], y_true, y_pred):
        by_genre.setdefault(g, []).append((neg, yt, yp))
    total_neg, total_false_org, total_false_any = 0, 0, 0
    for g, rows in sorted(by_genre.items()):
        yt = [r[1] for r in rows]
        yp = [r[2] for r in rows]
        negs = [r for r in rows if r[0]]
        false_org = sum(1 for _, _, p in negs for s in bio_spans(p) if s[0] == "ORG")
        false_any = sum(len(bio_spans(p)) for _, _, p in negs)
        total_neg += len(negs)
        total_false_org += false_org
        total_false_any += false_any
        out[g] = {"sentences": len(rows), "negative_sentences": len(negs), "false_org_on_negatives": false_org,
                  "false_spans_on_negatives": false_any, **report(yt, yp)}
    return out, {"negative_sentences": total_neg, "false_org_on_negatives": total_false_org,
                 "false_spans_on_negatives": total_false_any}


def main():
    cfg, args = load_config(extra_args=lambda p: p.add_argument(
        "--strict", action="store_true", help="exit with code 1 when a non-informational gate fails"))
    rd = run_dir(cfg)
    labels = cfg["labels"]
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = AutoModelForTokenClassification.from_pretrained(str(rd / "model")).to(device)
    data = load_from_disk(str(rd / "data"))
    names = [n for n in ("test_ru", "test_en", "validation_ru", "validation_en") if n in data]
    names += sorted(n for n in data if n.startswith("test_") and n not in names and n != "test_synth_genre")
    results = {}
    for name in names:
        results[name] = report(*predict(model, data[name], labels))
    genre = None
    if "test_synth_genre" in data:
        split = data["test_synth_genre"]
        yt, yp = predict(model, split, labels)
        results["test_synth_genre"] = report(yt, yp)
        by_genre, neg = genre_report(split, yt, yp)
        genre = {"by_genre": by_genre, **neg}
    g = cfg["gates"]
    gates = {
        "ru_per_f1": {"value": results["test_ru"]["PER"]["f1-score"], "min": g["ru_per_f1"]},
        "ru_org_f1": {"value": results["test_ru"]["ORG"]["f1-score"], "min": g["ru_org_f1"]},
        "en_per_f1": {"value": results["test_en"]["PER"]["f1-score"], "min": g["en_per_f1"], "informational": True},
    }
    if "synth_genre_org_precision" in g:
        gates["synth_genre_org_precision"] = {
            "value": results["test_synth_genre"]["ORG"]["precision"] if genre else None,
            "min": g["synth_genre_org_precision"]}
    for v in gates.values():
        v["passed"] = v["value"] is not None and v["value"] >= v["min"]
    section = {"model": "pytorch-fp32", "splits": results, "gates": gates}
    if genre:
        section["synth_genre"] = genre
    update_eval(cfg, "metrics", section)
    for name, r in results.items():
        print(f"{name:17s} PER {r['PER']['f1-score']:.4f}  ORG {r['ORG']['f1-score']:.4f} "
              f"(P {r['ORG']['precision']:.4f})  LOC {r['LOC']['f1-score']:.4f}  micro {r['micro_f1']:.4f}")
    if genre:
        print(f"synth_genre: false ORG on {genre['negative_sentences']} negative sentences: "
              f"{genre['false_org_on_negatives']} (any type: {genre['false_spans_on_negatives']})")
        for gname, r in genre["by_genre"].items():
            print(f"  {gname:10s} n={r['sentences']:4d}  PER P/R {r.get('PER', {}).get('precision', 0):.3f}/"
                  f"{r.get('PER', {}).get('recall', 0):.3f}  ORG P/R {r.get('ORG', {}).get('precision', 0):.3f}/"
                  f"{r.get('ORG', {}).get('recall', 0):.3f}  false ORG on negatives {r['false_org_on_negatives']}")
    failed = []
    for k, v in gates.items():
        val = "n/a" if v["value"] is None else f"{v['value']:.4f}"
        print(f"gate {k}: {val} >= {v['min']} -> {'PASS' if v['passed'] else 'FAIL'}"
              + (" (informational)" if v.get("informational") else ""))
        if not v["passed"] and not v.get("informational"):
            failed.append(k)
    print(json.dumps({"eval.json": str(rd / "eval.json"), "failed_gates": failed}))
    if args.strict and failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
