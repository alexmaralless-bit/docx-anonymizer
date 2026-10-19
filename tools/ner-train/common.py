"""Shared helpers: config loading, paths, seeding, eval.json updates."""
from __future__ import annotations

import argparse
import json
import os
import random
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent.parent
os.environ.setdefault("HF_HOME", str(ROOT / ".cache" / "hf"))


def _parse_value(raw: str) -> Any:
    return yaml.safe_load(raw)


def load_config(argv: list[str] | None = None, extra_args=None) -> tuple[dict, argparse.Namespace]:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=str(ROOT / "config.yaml"))
    parser.add_argument("--set", action="append", default=[], metavar="KEY=VALUE",
                        help="override a config key (dotted path), e.g. train.epochs=10")
    if extra_args:
        extra_args(parser)
    args = parser.parse_args(argv)
    with open(args.config, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    for item in args.set:
        key, _, raw = item.partition("=")
        node = cfg
        parts = key.split(".")
        for p in parts[:-1]:  # list items by index: --set data.sources.1.weight=0.5
            node = node[int(p)] if isinstance(node, list) else node.setdefault(p, {})
        if isinstance(node, list):
            node[int(parts[-1])] = _parse_value(raw)
        else:
            node[parts[-1]] = _parse_value(raw)
    labels = cfg["labels"]
    assert labels[0] == "O" and labels == ["O", "B-PER", "I-PER", "B-ORG", "I-ORG", "B-LOC", "I-LOC"], labels
    return cfg, args


def run_dir(cfg: dict) -> Path:
    d = ROOT / "runs" / cfg["run_id"]
    d.mkdir(parents=True, exist_ok=True)
    return d


def set_seed(seed: int) -> None:
    random.seed(seed)
    import numpy as np
    np.random.seed(seed)
    try:
        import torch
        torch.manual_seed(seed)
        torch.cuda.manual_seed_all(seed)
    except ImportError:
        pass


def update_eval(cfg: dict, section: str, data: Any) -> Path:
    """Merge one section into runs/<id>/eval.json (each script owns its section)."""
    path = run_dir(cfg) / "eval.json"
    current = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    current["id"] = cfg["id"]
    current["run_id"] = cfg["run_id"]
    current[section] = data
    path.write_text(json.dumps(current, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def bio_spans(tags: list[str]) -> list[tuple[str, int, int]]:
    """Lenient IOB2 merge (same as seqeval default mode): returns (type, start, end_exclusive).
    I-X after O or after a different type starts a new span."""
    spans = []
    cur = None
    for i, t in enumerate(tags):
        if t == "O":
            if cur:
                spans.append(tuple(cur)); cur = None
            continue
        prefix, typ = t.split("-", 1)
        if prefix == "B" or cur is None or cur[0] != typ:
            if cur:
                spans.append(tuple(cur))
            cur = [typ, i, i + 1]
        else:
            cur[2] = i + 1
    if cur:
        spans.append(tuple(cur))
    return spans


def word_level(logits_row, word_ids_row, n_words: int, labels: list[str]):
    """First-sub-token label and softmax probability per word. Words cut by truncation get ('O', 1.0)."""
    import numpy as np
    x = logits_row - logits_row.max(axis=-1, keepdims=True)
    probs = np.exp(x)
    probs /= probs.sum(axis=-1, keepdims=True)
    tags = ["O"] * n_words
    conf = [1.0] * n_words
    prev = None
    for pos, w in enumerate(word_ids_row):
        if w is None or w < 0 or w == prev:
            prev = w
            continue
        k = int(probs[pos].argmax())
        tags[w] = labels[k]
        conf[w] = float(probs[pos, k])
        prev = w
    return tags, conf


def torch_logits(model, split, batch_size: int = 256):
    """Run a PyTorch model over a tokenized split; returns list of [seq_len, num_labels] numpy arrays."""
    import torch
    device = next(model.parameters()).device
    out = []
    model.eval()
    with torch.no_grad():
        for i in range(0, len(split), batch_size):
            rows = split[i:i + batch_size]
            n = max(len(x) for x in rows["input_ids"])
            ids = torch.zeros((len(rows["input_ids"]), n), dtype=torch.long)
            mask = torch.zeros_like(ids)
            for j, x in enumerate(rows["input_ids"]):
                ids[j, :len(x)] = torch.tensor(x)
                mask[j, :len(x)] = 1
            logits = model(input_ids=ids.to(device), attention_mask=mask.to(device),
                           token_type_ids=torch.zeros_like(ids).to(device)).logits.float().cpu().numpy()
            for j, x in enumerate(rows["input_ids"]):
                out.append(logits[j, :len(x)])
    return out


def ort_session(path, threads: int = 0):
    import onnxruntime as ort
    so = ort.SessionOptions()
    if threads:
        so.intra_op_num_threads = threads
        so.inter_op_num_threads = 1
    return ort.InferenceSession(str(path), sess_options=so, providers=["CPUExecutionProvider"])


def ort_logits(sess, split, batch_size: int = 64, pad_to: int | None = None):
    """Run an ONNX session over a tokenized split; returns list of [seq_len, num_labels] arrays."""
    import numpy as np
    out = []
    for i in range(0, len(split), batch_size):
        rows = split[i:i + batch_size]["input_ids"]
        n = pad_to or max(len(x) for x in rows)
        ids = np.zeros((len(rows), n), np.int64)
        mask = np.zeros_like(ids)
        for j, x in enumerate(rows):
            ids[j, :len(x)] = x
            mask[j, :len(x)] = 1
        logits = sess.run(["logits"], {"input_ids": ids, "attention_mask": mask, "token_type_ids": np.zeros_like(ids)})[0]
        for j, x in enumerate(rows):
            out.append(logits[j, :len(x)])
    return out
