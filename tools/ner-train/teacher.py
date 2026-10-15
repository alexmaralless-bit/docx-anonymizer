"""Optional knowledge distillation: train a larger teacher on the same WikiANN ru+en data and store its
word-level logits for the student's train split.

The teacher (default FacebookAI/xlm-roberta-base, MIT) is only used to produce soft labels; it is not distributed.
Outputs in runs/<run_id>/teacher/: model/, teacher.json (per-class F1 on ru/en test), train_word_logits/
(datasets.Dataset, same row order as data["train"]; one [n_words, num_labels] logit list per row).
"""
from __future__ import annotations

import json
import time

import numpy as np
from common import load_config, run_dir, set_seed  # noqa: E402
import torch
from datasets import Dataset, load_from_disk
from seqeval.metrics import classification_report, f1_score
from transformers import (AutoModelForTokenClassification, AutoTokenizer, DataCollatorForTokenClassification,
                          Trainer, TrainingArguments)

KEEP = ["tokens", "ner_tags"]


def retokenize(ds, tok, max_length):
    def fn(batch):
        enc = tok(batch["tokens"], is_split_into_words=True, truncation=True, max_length=max_length)
        labels, wids = [], []
        for i, tags in enumerate(batch["ner_tags"]):
            prev, lab = None, []
            w_ids = enc.word_ids(batch_index=i)
            for w in w_ids:
                lab.append(-100 if w is None or w == prev else tags[w])
                prev = w
            labels.append(lab)
            wids.append([-1 if w is None else w for w in w_ids])
        enc["labels"] = labels
        enc["word_ids"] = wids
        return enc
    return ds.select_columns(KEEP).map(fn, batched=True)


def word_logits(model, ds, collator, batch_size=128):
    """Teacher logits at the first sub-token of each word: list of [n_words, L] arrays (truncated words -> 0)."""
    model.eval()
    device = next(model.parameters()).device
    out = []
    cols = ["input_ids", "attention_mask", "labels"]
    with torch.no_grad():
        for i in range(0, len(ds), batch_size):
            rows = ds[i:i + batch_size]
            feats = [{c: rows[c][j] for c in cols} for j in range(len(rows["input_ids"]))]
            b = collator(feats)
            logits = model(input_ids=b["input_ids"].to(device), attention_mask=b["attention_mask"].to(device)).logits
            logits = logits.float().cpu().numpy()
            for j, (wid, toks) in enumerate(zip(rows["word_ids"], rows["tokens"])):
                arr = np.zeros((len(toks), logits.shape[-1]), np.float32)
                prev = None
                for pos, w in enumerate(wid):
                    if w >= 0 and w != prev:
                        arr[w] = logits[j, pos]
                    prev = w
                out.append(arr)
    return out


def main():
    cfg, _ = load_config()
    set_seed(cfg["seed"])
    rd = run_dir(cfg)
    dc = cfg["distill"]
    labels = cfg["labels"]
    td = rd / "teacher"
    td.mkdir(exist_ok=True)
    data = load_from_disk(str(rd / "data"))
    tok = AutoTokenizer.from_pretrained(dc["teacher"])
    max_len = int(cfg["data"]["max_length"])
    tr = retokenize(data["train"], tok, max_len)
    va = retokenize(data["validation"], tok, max_len)
    model = AutoModelForTokenClassification.from_pretrained(
        dc["teacher"], num_labels=len(labels), id2label=dict(enumerate(labels)), label2id={l: i for i, l in enumerate(labels)})
    collator = DataCollatorForTokenClassification(tok)

    def compute_metrics(p):
        lg, gold = p
        pred = lg.argmax(-1)
        yt = [[labels[x] for x in g[g != -100]] for g in gold]
        yp = [[labels[x] for x in pr[g != -100]] for pr, g in zip(pred, gold)]
        return {"f1": f1_score(yt, yp)}

    args = TrainingArguments(
        output_dir=str(td / "checkpoints"), learning_rate=float(dc["teacher_lr"]),
        per_device_train_batch_size=int(dc["teacher_batch"]), per_device_eval_batch_size=128,
        num_train_epochs=float(dc["teacher_epochs"]), warmup_ratio=0.1, weight_decay=0.01,
        eval_strategy="epoch", save_strategy="epoch", save_total_limit=1, load_best_model_at_end=True,
        metric_for_best_model="f1", fp16=torch.cuda.is_available(), seed=cfg["seed"], data_seed=cfg["seed"],
        logging_steps=200, report_to=[], dataloader_num_workers=2)
    rm = ["tokens", "ner_tags", "word_ids"]
    trainer = Trainer(model=model, args=args, train_dataset=tr.remove_columns(rm), eval_dataset=va.remove_columns(rm),
                      data_collator=collator, processing_class=tok, compute_metrics=compute_metrics)
    t0 = time.time()
    trainer.train()
    seconds = time.time() - t0
    trainer.save_model(str(td / "model"))

    report = {}
    for name in ("test_ru", "test_en"):
        ds = retokenize(data[name], tok, max_len)
        wl = word_logits(trainer.model, ds, collator)
        yt = [[labels[t] for t in tags] for tags in data[name]["ner_tags"]]
        yp = [[labels[int(k)] for k in a.argmax(-1)] for a in wl]
        rep = classification_report(yt, yp, output_dict=True)
        report[name] = {k: round(float(rep[k]["f1-score"]), 4) for k in ("PER", "ORG", "LOC", "micro avg")}
        print(f"teacher {name}: {report[name]}")

    wl = word_logits(trainer.model, tr, collator)
    Dataset.from_dict({"word_logits": [a.tolist() for a in wl]}).save_to_disk(str(td / "train_word_logits"))
    info = {"teacher": dc["teacher"], "seconds": round(seconds, 1), "test_f1": report}
    (td / "teacher.json").write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")
    print(f"teacher training time: {seconds:.0f} s")


if __name__ == "__main__":
    main()
