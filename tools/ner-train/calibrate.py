"""Calibrate the span score threshold (extension setting nerThreshold) on ru+en validation with the int8 model.

Span decoding mirrors the extension: label of the first sub-token of every word, lenient BIO merge
(B-X starts a span, I-X continues a span of the same type, otherwise starts a new one).
Span score (calibrate.score):
  "marginal" (default, same as the JS provider) — mean over the span's words of P(B-X) + P(I-X) at the word's
             first sub-token, X = span type;
  "argmax"   — mean over the span's words of the softmax probability of the predicted label. Spans with score < threshold are dropped. Exact-match span micro F1.
Output: runs/<run_id>/calibration.json (+ "calibration" section of eval.json).
"""
from __future__ import annotations

import json

import numpy as np
from common import bio_spans, load_config, ort_logits, ort_session, run_dir, update_eval, word_level  # noqa: E402
from datasets import load_from_disk


def word_probs(logits_row, word_ids_row, n_words):
    """Softmax vector at the first sub-token of every word (truncated words: one-hot O)."""
    x = np.exp(logits_row - logits_row.max(axis=-1, keepdims=True))
    x /= x.sum(axis=-1, keepdims=True)
    out = [np.eye(x.shape[-1])[0] for _ in range(n_words)]
    prev = None
    for pos, w in enumerate(word_ids_row):
        if w >= 0 and w != prev:
            out[w] = x[pos]
        prev = w
    return out


def prf(tp, fp, fn):
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    return p, r, (2 * p * r / (p + r) if p + r else 0.0)


def main():
    cfg, _ = load_config()
    rd = run_dir(cfg)
    labels = cfg["labels"]
    c = cfg["calibrate"]
    mode = c.get("score", "marginal")
    assert mode in ("marginal", "argmax"), mode
    grid = [round(x, 2) for x in np.arange(c["grid_start"], c["grid_stop"] + 1e-9, c["grid_step"])]
    data = load_from_disk(str(rd / "data"))
    sess = ort_session(rd / "onnx" / "model.int8.onnx")

    # per split: list of (gold spans set, predicted spans with scores)
    items = []
    for name in ("validation_ru", "validation_en"):
        split = data[name]
        logits = ort_logits(sess, split, batch_size=128)
        for lg, wid, tags in zip(logits, split["word_ids"], split["ner_tags"]):
            pred, conf = word_level(lg, wid, len(tags), labels)
            gold = set(bio_spans([labels[t] for t in tags]))
            if mode == "marginal":
                probs = word_probs(lg, wid, len(tags))
                spans = [(s, float(np.mean([probs[w][labels.index("B-" + s[0])] + probs[w][labels.index("I-" + s[0])]
                                            for w in range(s[1], s[2])]))) for s in bio_spans(pred)]
            else:
                spans = [(s, float(np.mean(conf[s[1]:s[2]]))) for s in bio_spans(pred)]
            items.append((name, gold, spans))

    def counts(th, subset=None):
        tp = fp = fn = 0
        per_type = {}
        for name, gold, spans in items:
            if subset and name != subset:
                continue
            kept = {s for s, sc in spans if sc >= th}
            tp += len(kept & gold)
            fp += len(kept - gold)
            fn += len(gold - kept)
            for t in ("PER", "ORG", "LOC"):
                d = per_type.setdefault(t, [0, 0, 0])
                k = {s for s in kept if s[0] == t}
                g = {s for s in gold if s[0] == t}
                d[0] += len(k & g); d[1] += len(k - g); d[2] += len(g - k)
        return (tp, fp, fn), per_type

    table = []
    for th in [0.0] + grid:
        (tp, fp, fn), per_type = counts(th)
        p, r, f = prf(tp, fp, fn)
        row = {"threshold": th, "precision": round(p, 4), "recall": round(r, 4), "f1": round(f, 4),
               "f1_by_type": {t: round(prf(*v)[2], 4) for t, v in per_type.items()},
               "f1_ru": round(prf(*counts(th, "validation_ru")[0])[2], 4),
               "f1_en": round(prf(*counts(th, "validation_en")[0])[2], 4)}
        table.append(row)
    best = max((r for r in table if r["threshold"] > 0), key=lambda r: (r["f1"], -r["threshold"]))
    default = next(r for r in table if abs(r["threshold"] - 0.6) < 1e-9)
    result = {"model": "int8", "data": ["validation_ru", "validation_en"],
              "score": mode, "score_definition": {
                  "marginal": "mean over span words of P(B-X)+P(I-X) at the first sub-token (as in the JS provider)",
                  "argmax": "mean over span words of the softmax probability of the predicted label"}[mode],
              "decoding": "first sub-token per word, lenient BIO merge", "metric": "exact span micro F1 (PER+ORG+LOC)",
              "grid": grid, "best_threshold": best["threshold"], "best": best,
              "at_default_0.6": default, "no_threshold": table[0], "table": table}
    (rd / "calibration.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    update_eval(cfg, "calibration", {k: result[k] for k in ("best_threshold", "best", "at_default_0.6", "no_threshold")})
    print("threshold  P       R       F1      F1_ru   F1_en")
    for r in table:
        print(f"{r['threshold']:.2f}      {r['precision']:.4f}  {r['recall']:.4f}  {r['f1']:.4f}  {r['f1_ru']:.4f}  {r['f1_en']:.4f}")
    print(f"best threshold: {best['threshold']} (micro F1 {best['f1']}); at 0.6: {default['f1']}")


if __name__ == "__main__":
    main()
