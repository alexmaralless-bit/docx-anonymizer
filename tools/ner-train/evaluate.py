"""Per-class seqeval metrics of the trained PyTorch model on WikiANN ru/en test -> runs/<run_id>/eval.json."""
from __future__ import annotations

import json

from common import load_config, run_dir, torch_logits, update_eval, word_level  # noqa: E402
import torch
from datasets import load_from_disk
from seqeval.metrics import classification_report, f1_score
from transformers import AutoModelForTokenClassification


def score_split(model, split, labels):
    logits = torch_logits(model, split)
    y_true, y_pred = [], []
    for lg, wid, tags in zip(logits, split["word_ids"], split["ner_tags"]):
        pred, _ = word_level(lg, wid, len(tags), labels)
        y_true.append([labels[t] for t in tags])
        y_pred.append(pred)
    rep = classification_report(y_true, y_pred, output_dict=True, digits=4)
    res = {k: {m: round(float(v), 4) for m, v in rep[k].items()} for k in ("PER", "ORG", "LOC", "micro avg")}
    res["micro_f1"] = round(float(f1_score(y_true, y_pred)), 4)
    return res


def main():
    cfg, _ = load_config()
    rd = run_dir(cfg)
    labels = cfg["labels"]
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = AutoModelForTokenClassification.from_pretrained(str(rd / "model")).to(device)
    data = load_from_disk(str(rd / "data"))
    results = {name: score_split(model, data[name], labels) for name in ("test_ru", "test_en", "validation_ru", "validation_en")}
    g = cfg["gates"]
    gates = {
        "ru_per_f1": {"value": results["test_ru"]["PER"]["f1-score"], "min": g["ru_per_f1"]},
        "ru_org_f1": {"value": results["test_ru"]["ORG"]["f1-score"], "min": g["ru_org_f1"]},
        "en_per_f1": {"value": results["test_en"]["PER"]["f1-score"], "min": g["en_per_f1"], "informational": True},
    }
    for v in gates.values():
        v["passed"] = v["value"] >= v["min"]
    update_eval(cfg, "metrics", {"model": "pytorch-fp32", "splits": results, "gates": gates})
    for name, r in results.items():
        print(f"{name:14s} PER {r['PER']['f1-score']:.4f}  ORG {r['ORG']['f1-score']:.4f}  "
              f"LOC {r['LOC']['f1-score']:.4f}  micro {r['micro_f1']:.4f}")
    for k, v in gates.items():
        print(f"gate {k}: {v['value']:.4f} >= {v['min']} -> {'PASS' if v['passed'] else 'FAIL'}"
              + (" (informational)" if v.get("informational") else ""))
    print(json.dumps({"eval.json": str(rd / "eval.json")}))


if __name__ == "__main__":
    main()
