"""Export the trained model to ONNX (opset 17, dynamic batch/sequence axes).

Inputs: input_ids, attention_mask, token_type_ids (int64, [batch, seq]); output: logits [batch, seq, num_labels].
Output file: runs/<run_id>/onnx/model.fp32.onnx
"""
from __future__ import annotations

import numpy as np
from common import load_config, run_dir, update_eval  # noqa: E402
import onnx
import onnxruntime as ort
import torch
from transformers import AutoModelForTokenClassification


def main():
    cfg, _ = load_config()
    rd = run_dir(cfg)
    out_dir = rd / "onnx"
    out_dir.mkdir(exist_ok=True)
    out = out_dir / "model.fp32.onnx"
    # eager attention keeps the graph to plain MatMul/Softmax ops (no SDPA-specific patterns)
    model = AutoModelForTokenClassification.from_pretrained(str(rd / "model"), attn_implementation="eager").eval()
    model.config.return_dict = False

    class Wrapper(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, input_ids, attention_mask, token_type_ids):
            return self.m(input_ids=input_ids, attention_mask=attention_mask, token_type_ids=token_type_ids)[0]

    seq = cfg["data"]["max_length"]
    ids = torch.randint(5, 1000, (2, seq), dtype=torch.long)
    mask = torch.ones_like(ids)
    mask[1, seq // 2:] = 0
    types = torch.zeros_like(ids)
    axes = {0: "batch", 1: "sequence"}
    # the wrapper must be in eval mode: export restores the wrapper's mode recursively afterwards
    wrapper = Wrapper(model).eval()
    torch.onnx.export(
        wrapper, (ids, mask, types), str(out),
        input_names=["input_ids", "attention_mask", "token_type_ids"], output_names=["logits"],
        dynamic_axes={"input_ids": axes, "attention_mask": axes, "token_type_ids": axes, "logits": axes},
        opset_version=int(cfg["export"]["opset"]), do_constant_folding=True, dynamo=False,
    )
    m = onnx.load(str(out))
    onnx.checker.check_model(m, full_check=True)
    ops = sorted({n.op_type for n in m.graph.node})

    # sanity: ORT fp32 vs PyTorch on a different shape than the trace
    sess = ort.InferenceSession(str(out), providers=["CPUExecutionProvider"])
    ids2 = torch.randint(5, 1000, (3, 37), dtype=torch.long)
    feeds = {"input_ids": ids2.numpy(), "attention_mask": np.ones((3, 37), np.int64),
             "token_type_ids": np.zeros((3, 37), np.int64)}
    onnx_logits = sess.run(["logits"], feeds)[0]
    with torch.no_grad():
        pt = model(input_ids=ids2, attention_mask=torch.ones_like(ids2), token_type_ids=torch.zeros_like(ids2))[0].numpy()
    diff = float(np.abs(onnx_logits - pt).max())
    size_mb = out.stat().st_size / 2**20
    info = {"file": str(out.relative_to(rd)), "opset": int(cfg["export"]["opset"]), "size_mb": round(size_mb, 2),
            "ops": ops, "max_abs_diff_vs_torch": diff, "torch": torch.__version__, "onnx": onnx.__version__}
    update_eval(cfg, "export", info)
    print(f"exported {out} ({size_mb:.1f} MB), opset {cfg['export']['opset']}, checker OK")
    print(f"ops: {ops}")
    print(f"max |ORT fp32 - torch| on [3,37]: {diff:.2e}")
    assert diff < 1e-3, "fp32 export differs from PyTorch"


if __name__ == "__main__":
    main()
