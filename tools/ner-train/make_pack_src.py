"""Assemble models-src/<id>/ (source of the model pack zip built by `npm run pack:model -- --id=<id>`).

Files: model.onnx (int8), vocab.txt, config.json (id2label/label2id), LICENSE, NOTICE, pack.src.json.
"""
from __future__ import annotations

import datetime as dt
import json
import shutil

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
                               f"Copyright (c) {year} alexmaralless-bit")
    return ("This model pack contains two works, both under the MIT License.\n\n"
            "1. Fine-tuned weights (model.onnx, config.json)\n"
            "------------------------------------------------\n\n" + own +
            "\n\n2. Base model cointegrated/rubert-tiny2 (architecture, pre-trained weights, vocab.txt)\n"
            "-----------------------------------------------------------------------------------\n"
            "https://huggingface.co/cointegrated/rubert-tiny2 (license: MIT)\n\n" + BASE_LICENSE)


def notice_text(cfg: dict, extra: list[str]) -> str:
    lines = [
        f"{cfg['id']} {cfg['version']} — NER model pack for DOCX Anonymizer",
        "",
        "Base model",
        "  cointegrated/rubert-tiny2 — https://huggingface.co/cointegrated/rubert-tiny2",
        "  David Dale. License: MIT (see LICENSE). Vocabulary (vocab.txt) is taken unchanged from the base model.",
        "",
        "Training data (used for fine-tuning only; NOT included in this pack)",
        "  WikiANN, Hugging Face dataset unimelb-nlp/wikiann, configurations \"ru\" and \"en\"",
        "  (balanced train/validation/test splits by Rahimi et al.).",
        "  - Xiaoman Pan, Boliang Zhang, Jonathan May, Joel Nothman, Kevin Knight, Heng Ji.",
        "    Cross-lingual Name Tagging and Linking for 282 Languages. ACL 2017.",
        "  - Afshin Rahimi, Yuan Li, Trevor Cohn. Massively Multilingual Transfer for NER. ACL 2019.",
        "  The annotations are derived from Wikipedia; Wikipedia text is licensed under CC BY-SA.",
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
    cfg, _ = load_config()
    rd = run_dir(cfg)
    out = REPO / "models-src" / cfg["id"]
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
                  f"  Soft labels from a teacher model fine-tuned on the same WikiANN data: {d['teacher']}",
                  f"  ({d.get('teacher_license', 'MIT')}). The teacher is not distributed."]
    data_info = json.loads((rd / "data_info.json").read_text(encoding="utf-8"))
    if data_info.get("synth"):
        extra += ["", "Synthetic data",
                  "  Template sentences with fictitious names/companies/addresses generated by tools/ner-train/synth.py."]

    year = dt.date.today().year
    (out / "LICENSE").write_text(license_text(year), encoding="utf-8")
    (out / "NOTICE").write_text(notice_text(cfg, extra), encoding="utf-8")

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
                   "data": [f"{cfg['data']['dataset']}:{c}" for c in cfg["data"]["configs"]], "trainedAt": trained_at},
        "minExtensionVersion": "0.2.0",
        "recommendedThreshold": calib["best_threshold"],
    }
    (out / "pack.src.json").write_text(json.dumps(pack, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for f in sorted(out.iterdir()):
        print(f"{f.relative_to(REPO)}  {f.stat().st_size / 2**20:.2f} MB")


if __name__ == "__main__":
    main()
