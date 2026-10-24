"""Assemble models-src/<id>/ (source of the model pack zip built by `npm run pack:model -- --id=<id>`).

Files: model.onnx (int8), vocab.txt, config.json (id2label/label2id), LICENSE, NOTICE, pack.src.json.
"""
from __future__ import annotations

import datetime as dt
import json
import shutil
import sys
from pathlib import Path

from common import REPO, load_config, run_dir  # noqa: E402
import onnx

BASE_LICENSE = """MIT License

Copyright (c) 2021 David Dale (cointegrated)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""


def license_text(year: int) -> str:
    own = BASE_LICENSE.replace("Copyright (c) 2021 David Dale (cointegrated)",
                               f"Copyright (c) {year} argmaster-dev")
    return ("This model pack contains two works, both under the MIT License.\n\n"
            "1. Fine-tuned weights (model.onnx, config.json)\n"
            "------------------------------------------------\n\n" + own +
            "\n\n2. Base model cointegrated/rubert-tiny2 (architecture, pre-trained weights, vocab.txt)\n"
            "-----------------------------------------------------------------------------------\n"
            "https://huggingface.co/cointegrated/rubert-tiny2 (license: MIT)\n\n" + BASE_LICENSE)


def used_sources(cfg: dict, data_info: dict) -> list[dict]:
    """config.yaml data.sources[] entries that went into the training mix (data_info.json from prepare.py)."""
    used = {x["id"] for x in data_info.get("sources", []) if not x.get("skipped")}
    out = [s for s in cfg["data"]["sources"] if s["id"] in used]
    assert out, "no training sources recorded in data_info.json; rerun prepare.py"
    for s in out:
        for key in ("id", "license", "url"):
            assert s.get(key), f"data.sources[{s.get('id')}].{key} is required for NOTICE / pack.src.json"
    return out


def notice_text(cfg: dict, sources: list[dict], extra: list[str]) -> str:
    lines = [
        f"{cfg['id']} {cfg['version']} — NER model pack for DOCX Anonymizer",
        "",
        "Base model",
        "  cointegrated/rubert-tiny2 — https://huggingface.co/cointegrated/rubert-tiny2",
        "  David Dale. License: MIT (see LICENSE). Vocabulary (vocab.txt) is taken unchanged from the base model.",
        "",
        "Training data (used for fine-tuning only; NOT included in this pack)",
    ]
    for s in sources:
        lines += [f"  {s['id']} — {s['url']}", f"    License: {s['license']}"]
        if s.get("citation"):
            lines.append(f"    Citation: {s['citation']}")
    lines += [
        *extra,
        "",
        "What is distributed",
        "  Only the fine-tuned model weights (model.onnx, int8 quantized), the model configuration and the base",
        "  model vocabulary. No sentences or annotations from the training data are distributed.",
        "",
        "Labels: " + ", ".join(cfg["labels"]),
    ]
    return "\n".join(lines) + "\n"


def main():
    def extra_args(p):
        p.add_argument("--out", help="output directory (default: models-src/<id> in the repository root)")
        p.add_argument("--force", action="store_true", help="overwrite an existing pack source of another version")
    cfg, args = load_config(extra_args=extra_args)
    rd = run_dir(cfg)
    out = Path(args.out).resolve() if args.out else REPO / "models-src" / cfg["id"]
    prev = out / "pack.src.json"
    if prev.exists() and not args.force:
        old = json.loads(prev.read_text(encoding="utf-8")).get("version")
        if old != cfg["version"]:
            sys.exit(f"{prev} holds version {old}, config has {cfg['version']}: pass --force to overwrite "
                     f"or --out <dir> for a separate copy")
    out.mkdir(parents=True, exist_ok=True)

    src_onnx = rd / "onnx" / "model.int8.onnx"
    onnx.checker.check_model(onnx.load(str(src_onnx)))
    shutil.copyfile(src_onnx, out / "model.onnx")
    shutil.copyfile(rd / "model" / "vocab.txt", out / "vocab.txt")

    tcfg = json.loads((rd / "model" / "tokenizer_config.json").read_text(encoding="utf-8"))
    lowercase = bool(tcfg.get("do_lower_case", False))
    strip = tcfg.get("strip_accents")
    strip_accents = bool(strip) if strip is not None else lowercase  # BERT: None follows lowercase
    vocab_lines = (out / "vocab.txt").read_text(encoding="utf-8").split("\n")
    vocab_size = len([l for l in vocab_lines if l != ""]) if vocab_lines[-1] == "" else len(vocab_lines)

    mcfg = json.loads((rd / "model" / "config.json").read_text(encoding="utf-8"))
    assert mcfg["vocab_size"] == vocab_size, (mcfg["vocab_size"], vocab_size)
    mcfg["id2label"] = {str(i): l for i, l in enumerate(cfg["labels"])}
    mcfg["label2id"] = {l: i for i, l in enumerate(cfg["labels"])}
    (out / "config.json").write_text(json.dumps(mcfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    train_info = json.loads((rd / "train.json").read_text(encoding="utf-8"))
    calib = json.loads((rd / "calibration.json").read_text(encoding="utf-8"))
    extra = []
    if train_info.get("distillation"):
        d = train_info["distillation"]
        extra += ["", "Knowledge distillation",
                  f"  Soft labels from a teacher model fine-tuned on the same training data: {d['teacher']}",
                  f"  ({d.get('teacher_license', 'MIT')}). The teacher is not distributed."]
    data_info = json.loads((rd / "data_info.json").read_text(encoding="utf-8"))
    sources = used_sources(cfg, data_info)
    if data_info.get("synth"):
        extra += ["", "Synthetic data",
                  "  Template sentences with fictitious names/companies/addresses generated by tools/ner-train/synth.py",
                  "  (contracts and business-document genres: proposals, letters, invoices, manuals, resumes, chats)."]

    year = dt.date.today().year
    (out / "LICENSE").write_text(license_text(year), encoding="utf-8")
    (out / "NOTICE").write_text(notice_text(cfg, sources, extra), encoding="utf-8")

    trained_at = dt.datetime.fromtimestamp((rd / "train.json").stat().st_mtime, dt.timezone.utc).date().isoformat()
    pack = {
        "kind": "docx-anonymizer-model-pack", "schemaVersion": 1, "id": cfg["id"], "version": cfg["version"],
        "name": {"ru": "RuBERT-tiny2 NER (ru/en)", "en": "RuBERT-tiny2 NER (ru/en)"},
        "languages": ["ru", "en"], "task": "token-classification", "labels": cfg["labels"],
        "tokenizer": {"type": "wordpiece", "vocab": "vocab.txt", "lowercase": lowercase, "stripAccents": strip_accents,
                      "maxLen": int(cfg["data"]["max_length"]), "stride": 16, "cls": "[CLS]", "sep": "[SEP]",
                      "pad": "[PAD]", "unk": "[UNK]"},
        "model": {"file": "model.onnx", "inputs": {"ids": "input_ids", "mask": "attention_mask", "types": "token_type_ids"},
                  "output": "logits", "indexType": "int64"},
        "license": "MIT",
        "source": {"baseModel": cfg["base_model"],
                   "data": [f"{x['id']} ({x['license']}) {x['url']}"[:500] for x in sources][:20]
                   + (["synthetic: tools/ner-train/synth.py (fictitious data)"] if data_info.get("synth") else []),
                   "trainedAt": trained_at},
        "minExtensionVersion": "0.2.0",
        "recommendedThreshold": calib["best_threshold"],
    }
    (out / "pack.src.json").write_text(json.dumps(pack, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for f in sorted(out.iterdir()):
        print(f"{f}  {f.stat().st_size / 2**20:.2f} MB")


if __name__ == "__main__":
    main()
