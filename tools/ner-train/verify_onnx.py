"""Check the int8 ONNX model against the PyTorch fp32 model.

1. 50 test sentences (half ru, half en), padded to [*,128]: argmax agreement on non-padding tokens (gate >= 99 %)
   and mean |logit difference|.
2. A [8,128] batch runs on CPUExecutionProvider without errors.
3. Word-level seqeval F1 of the int8 model on the full ru/en test sets (the model that is actually shipped).
"""
from __future__ import annotations

import random

import numpy as np
from common import (load_config, ort_logits, ort_session, run_dir, torch_logits, update_eval,  # noqa: E402
                    word_level)
from datasets import concatenate_datasets, load_from_disk
from seqeval.metrics import classification_report
from transformers import AutoModelForTokenClassification


def agreement(sess, model, sample, max_len):
    pt = torch_logits(model, sample)
    ox = ort_logits(sess, sample, batch_size=8, pad_to=max_len)
    same = total = 0
    diffs = []
    for a, b in zip(pt, ox):
        same += int((a.argmax(-1) == b.argmax(-1)).sum())
        total += a.shape[0]
        diffs.append(np.abs(a - b).reshape(-1))
    d = np.concatenate(diffs)
    return same / total, float(d.mean()), float(d.max()), total


def int8_f1(sess, split, labels):
    logits = ort_logits(sess, split, batch_size=128)
    y_true, y_pred = [], []
    for lg, wid, tags in zip(logits, split["word_ids"], split["ner_tags"]):
        y_pred.append(word_level(lg, wid, len(tags), labels)[0])
        y_true.append([labels[t] for t in tags])
    rep = classification_report(y_true, y_pred, output_dict=True)
    return {k: round(float(rep[k]["f1-score"]), 4) for k in ("PER", "ORG", "LOC", "micro avg")}


def main():
    cfg, _ = load_config()
    rd = run_dir(cfg)
    labels = cfg["labels"]
    max_len = cfg["data"]["max_length"]
    n = int(cfg["verify"]["sentences"])
    data = load_from_disk(str(rd / "data"))
    rng = random.Random(cfg["seed"])
    parts = []
    for name, k in (("test_ru", n - n // 2), ("test_en", n // 2)):
        idx = sorted(rng.sample(range(len(data[name])), k))
        parts.append(data[name].select(idx))
    sample = concatenate_datasets(parts)

    model = AutoModelForTokenClassification.from_pretrained(str(rd / "model")).eval()  # CPU fp32 reference
    int8 = ort_session(rd / "onnx" / "model.int8.onnx")
    fp32 = ort_session(rd / "onnx" / "model.fp32.onnx")
    assert int8.get_providers() == ["CPUExecutionProvider"], int8.get_providers()

    agr8, mean8, max8, tokens = agreement(int8, model, sample, max_len)
    agr32, mean32, max32, _ = agreement(fp32, model, sample, max_len)
    # informational: the same check on a larger sample (1000 ru + 1000 en test sentences)
    big = concatenate_datasets([data[name].select(sorted(rng.sample(range(len(data[name])), 1000)))
                                for name in ("test_ru", "test_en")])
    agr_big, mean_big, _, tokens_big = agreement(int8, model, big, max_len)

    # [8,128] batch smoke test
    ids = np.random.default_rng(cfg["seed"]).integers(5, 83828, size=(8, max_len), dtype=np.int64)
    mask = np.ones_like(ids)
    mask[4:, max_len // 2:] = 0
    out = int8.run(["logits"], {"input_ids": ids, "attention_mask": mask, "token_type_ids": np.zeros_like(ids)})[0]
    assert out.shape == (8, max_len, len(labels)) and np.isfinite(out).all()

    f1 = {name: int8_f1(int8, data[name], labels) for name in ("test_ru", "test_en")}
    min_agr = float(cfg["verify"]["min_agreement"])
    info = {"sentences": len(sample), "tokens": tokens, "padded_to": max_len,
            "int8_vs_torch": {"argmax_agreement": round(agr8, 5), "mean_abs_logit_diff": round(mean8, 5),
                              "max_abs_logit_diff": round(max8, 4)},
            "int8_vs_torch_2000_sentences": {"tokens": tokens_big, "argmax_agreement": round(agr_big, 5),
                                             "mean_abs_logit_diff": round(mean_big, 5)},
            "fp32_onnx_vs_torch": {"argmax_agreement": round(agr32, 5), "mean_abs_logit_diff": mean32},
            "batch_8x128": {"provider": int8.get_providers()[0], "output_shape": list(out.shape), "ok": True},
            "int8_test_f1": f1, "gate": {"min_agreement": min_agr, "passed": agr8 >= min_agr}}
    update_eval(cfg, "verify", info)
    print(f"{len(sample)} sentences, {tokens} non-padding tokens")
    print(f"int8 vs torch fp32: argmax agreement {agr8:.4%}, mean |dlogit| {mean8:.4f}, max {max8:.3f}")
    print(f"int8 vs torch fp32 on 2000 sentences ({tokens_big} tokens): agreement {agr_big:.4%}, mean |dlogit| {mean_big:.4f}")
    print(f"fp32 onnx vs torch: argmax agreement {agr32:.4%}, mean |dlogit| {mean32:.2e}")
    print(f"[8,{max_len}] batch on {int8.get_providers()[0]}: OK {out.shape}")
    for k, v in f1.items():
        print(f"int8 {k}: {v}")
    print(f"gate agreement >= {min_agr:.0%}: {'PASS' if agr8 >= min_agr else 'FAIL'}")


if __name__ == "__main__":
    main()
