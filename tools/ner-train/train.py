"""Fine-tune rubert-tiny2 for token classification on the prepared training mix (prepare.py).

The best checkpoint by eval_f1 (seqeval micro F1 on ru+en validation) is saved to runs/<run_id>/model/.
"""
from __future__ import annotations

import json
import time

import numpy as np
from common import load_config, run_dir, set_seed, update_eval  # noqa: E402
import torch
from datasets import load_from_disk
from seqeval.metrics import f1_score, precision_score, recall_score
from transformers import (AutoModelForTokenClassification, AutoTokenizer, DataCollatorForTokenClassification,
                          Trainer, TrainingArguments)

EXTRA_COLUMNS = ["tokens", "ner_tags", "lang", "word_ids"]


def add_teacher_logits(train, teacher_path, fingerprint=None):
    """Attach teacher word logits to the student's first sub-token positions (zeros elsewhere)."""
    from datasets import load_from_disk as _load
    tl = _load(str(teacher_path))
    assert len(tl) == len(train), "teacher logits do not match the train split; rerun teacher.py"
    tjson = teacher_path.parent / "teacher.json"
    if fingerprint and tjson.exists():
        tfp = json.loads(tjson.read_text(encoding="utf-8")).get("train_fingerprint")
        assert tfp in (None, fingerprint), "teacher was trained on a different train split; rerun teacher.py"
    train = train.add_column("_teacher_words", tl["word_logits"])

    def fn(row):
        n_labels = len(row["_teacher_words"][0]) if row["_teacher_words"] else 7
        out = [[0.0] * n_labels for _ in row["input_ids"]]
        prev = None
        for pos, w in enumerate(row["word_ids"]):
            if w >= 0 and w != prev:
                out[pos] = row["_teacher_words"][w]
            prev = w
        return {"teacher_logits": out}
    return train.map(fn, remove_columns=["_teacher_words"], desc="teacher logits")


class DistillCollator:
    def __init__(self, base):
        self.base = base

    def __call__(self, features):
        teacher = [f.pop("teacher_logits") for f in features] if "teacher_logits" in features[0] else None
        batch = self.base(features)
        if teacher is not None:
            n = batch["input_ids"].shape[1]
            t = torch.zeros((len(teacher), n, len(teacher[0][0])), dtype=torch.float32)
            for i, rows in enumerate(teacher):
                t[i, :len(rows)] = torch.tensor(rows, dtype=torch.float32)
            batch["teacher_logits"] = t
        return batch


class DistillTrainer(Trainer):
    def __init__(self, *a, temperature=2.0, alpha=0.5, **kw):
        super().__init__(*a, **kw)
        self.temperature = temperature
        self.alpha = alpha

    def compute_loss(self, model, inputs, return_outputs=False, num_items_in_batch=None):
        teacher = inputs.pop("teacher_logits", None)
        outputs = model(**inputs)
        loss = outputs.loss
        if teacher is not None:
            T = self.temperature
            mask = inputs["labels"] != -100
            s = torch.nn.functional.log_softmax(outputs.logits[mask].float() / T, dim=-1)
            t = torch.nn.functional.softmax(teacher[mask] / T, dim=-1)
            kl = torch.nn.functional.kl_div(s, t, reduction="batchmean") * T * T
            loss = self.alpha * loss + (1 - self.alpha) * kl
        return (loss, outputs) if return_outputs else loss


def main():
    cfg, _ = load_config()
    set_seed(cfg["seed"])
    rd = run_dir(cfg)
    labels = cfg["labels"]
    id2label = dict(enumerate(labels))
    label2id = {l: i for i, l in enumerate(labels)}
    tc = cfg["train"]

    data = load_from_disk(str(rd / "data"))
    dc = cfg.get("distill", {})
    distill = bool(dc.get("enabled"))
    train_ds = data["train"]
    if distill:
        data_info = json.loads((rd / "data_info.json").read_text(encoding="utf-8"))
        train_ds = add_teacher_logits(train_ds, rd / "teacher" / "train_word_logits", data_info.get("train_fingerprint"))
    train_ds = train_ds.remove_columns(EXTRA_COLUMNS)
    eval_ds = data["validation"].remove_columns(EXTRA_COLUMNS)

    tokenizer = AutoTokenizer.from_pretrained(cfg["base_model"])
    model = AutoModelForTokenClassification.from_pretrained(
        cfg["base_model"], num_labels=len(labels), id2label=id2label, label2id=label2id)

    def compute_metrics(p):
        logits, gold = p
        pred = np.argmax(logits, axis=-1)
        y_true, y_pred = [], []
        for pr, gl in zip(pred, gold):
            m = gl != -100
            y_true.append([labels[x] for x in gl[m]])
            y_pred.append([labels[x] for x in pr[m]])
        return {"precision": precision_score(y_true, y_pred), "recall": recall_score(y_true, y_pred),
                "f1": f1_score(y_true, y_pred)}

    use_fp16 = bool(tc["fp16"]) and torch.cuda.is_available()
    args = TrainingArguments(
        output_dir=str(rd / "checkpoints"),
        learning_rate=float(tc["learning_rate"]),
        per_device_train_batch_size=int(tc["batch_size"]),
        per_device_eval_batch_size=128,
        num_train_epochs=float(tc["epochs"]),
        warmup_ratio=float(tc["warmup_ratio"]),
        weight_decay=float(tc["weight_decay"]),
        label_smoothing_factor=float(tc["label_smoothing"]),
        lr_scheduler_type="linear",
        eval_strategy="epoch",
        save_strategy="epoch",
        save_total_limit=2,
        load_best_model_at_end=True,
        metric_for_best_model="f1",
        greater_is_better=True,
        fp16=use_fp16,
        seed=cfg["seed"],
        data_seed=cfg["seed"],
        dataloader_num_workers=int(tc["num_workers"]),
        logging_steps=200,
        report_to=[],
        remove_unused_columns=not distill,
    )
    collator = DataCollatorForTokenClassification(tokenizer)
    if distill:
        trainer = DistillTrainer(model=model, args=args, train_dataset=train_ds, eval_dataset=eval_ds,
                                 data_collator=DistillCollator(collator), processing_class=tokenizer,
                                 compute_metrics=compute_metrics, temperature=float(dc["temperature"]),
                                 alpha=float(dc["alpha"]))
    else:
        trainer = Trainer(model=model, args=args, train_dataset=train_ds, eval_dataset=eval_ds,
                          data_collator=collator, processing_class=tokenizer, compute_metrics=compute_metrics)
    device = torch.cuda.get_device_name() if torch.cuda.is_available() else "cpu"
    print(f"device: {device}, fp16: {use_fp16}, train examples: {len(train_ds)}")
    t0 = time.time()
    trainer.train()
    seconds = time.time() - t0
    best = trainer.evaluate()
    trainer.save_model(str(rd / "model"))
    tokenizer.save_pretrained(str(rd / "model"))
    history = [h for h in trainer.state.log_history if "eval_f1" in h]
    info = {"seconds": round(seconds, 1), "device": device, "fp16": use_fp16,
            "best_checkpoint": trainer.state.best_model_checkpoint, "best_eval": best,
            "epochs": [{"epoch": h["epoch"], "eval_f1": h["eval_f1"], "eval_loss": h["eval_loss"]} for h in history],
            "hyperparameters": tc, "torch": torch.__version__,
            "data": {"mode": cfg["data"].get("mode", "sources"),
                     "sources": [{"id": x["id"], "weight": x.get("weight", 1)} for x in cfg["data"]["sources"]],
                     "synth": cfg["data"]["synth"]}}
    if distill:
        tinfo = json.loads((rd / "teacher" / "teacher.json").read_text(encoding="utf-8"))
        info["distillation"] = {"teacher": dc["teacher"], "teacher_license": dc.get("teacher_license"),
                                "temperature": dc["temperature"], "alpha": dc["alpha"],
                                "teacher_test_f1": tinfo["test_f1"], "teacher_seconds": tinfo["seconds"]}
    update_eval(cfg, "training", info)
    (rd / "train.json").write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")
    print(f"training time: {seconds:.1f} s ({seconds / 60:.1f} min) on {device}")
    print(f"best eval_f1: {best['eval_f1']:.4f}")


if __name__ == "__main__":
    main()
