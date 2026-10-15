"""Int8 quantization of the exported ONNX model.

* MatMul: onnxruntime dynamic quantization, int8 weights per output channel (MatMulInteger + DynamicQuantizeLinear).
* Word-embedding Gather (~26M of ~29M parameters): row-wise (per-token) asymmetric uint8 quantization built from
  standard ops only:  emb = Cast(Gather(Wq, ids)) * Gather(scale, ids) + Gather(rowmin, ids).
  ORT's built-in Gather quantization is per-tensor, which alone drops argmax agreement by ~0.7 pp on this model.
  Without quantizing this Gather the file is > 100 MB.
* Position / token-type embeddings stay fp32 (2.6 MB).

Output: runs/<run_id>/onnx/model.int8.onnx
"""
from __future__ import annotations

import numpy as np
from common import load_config, run_dir, update_eval  # noqa: E402
import onnx
from onnx import TensorProto, helper, numpy_helper
from onnxruntime.quantization import QuantType, quantize_dynamic

try:
    from onnxruntime.quantization.shape_inference import quant_pre_process
except ImportError:  # older onnxruntime
    quant_pre_process = None

WORD_EMB = "word_embeddings"


def quantize_word_embeddings(model: onnx.ModelProto) -> dict:
    graph = model.graph
    inits = {i.name: i for i in graph.initializer}
    nodes = [n for n in graph.node if n.op_type == "Gather" and n.input[0] in inits and WORD_EMB in n.input[0]]
    assert len(nodes) == 1, f"expected one word-embedding Gather, found {[n.name for n in nodes]}"
    node = nodes[0]
    w_init = inits[node.input[0]]
    w = numpy_helper.to_array(w_init).astype(np.float32)
    lo = w.min(axis=1, keepdims=True)
    hi = w.max(axis=1, keepdims=True)
    scale = np.maximum(hi - lo, 1e-8) / 255.0
    q = np.clip(np.round((w - lo) / scale), 0, 255).astype(np.uint8)
    err = float(np.abs(q.astype(np.float32) * scale + lo - w).max())

    base = w_init.name
    graph.initializer.remove(w_init)
    graph.initializer.extend([
        numpy_helper.from_array(q, base + "_q_rowwise"),
        numpy_helper.from_array(scale.astype(np.float32), base + "_row_scale"),
        numpy_helper.from_array(lo.astype(np.float32), base + "_row_min"),
    ])
    ids = node.input[1]
    out = node.output[0]
    p = node.name or "word_emb"
    new_nodes = [
        helper.make_node("Gather", [base + "_q_rowwise", ids], [p + "_q"], name=p + "_GatherQ", axis=0),
        helper.make_node("Cast", [p + "_q"], [p + "_qf"], name=p + "_Cast", to=TensorProto.FLOAT),
        helper.make_node("Gather", [base + "_row_scale", ids], [p + "_s"], name=p + "_GatherScale", axis=0),
        helper.make_node("Gather", [base + "_row_min", ids], [p + "_m"], name=p + "_GatherMin", axis=0),
        helper.make_node("Mul", [p + "_qf", p + "_s"], [p + "_qs"], name=p + "_Mul"),
        helper.make_node("Add", [p + "_qs", p + "_m"], [out], name=p + "_Add"),
    ]
    idx = list(graph.node).index(node)
    graph.node.remove(node)
    for k, n in enumerate(new_nodes):
        graph.node.insert(idx + k, n)
    return {"initializer": base, "shape": list(w.shape), "scheme": "row-wise asymmetric uint8",
            "max_abs_error": err}


def main():
    cfg, _ = load_config()
    rd = run_dir(cfg)
    src = rd / "onnx" / "model.fp32.onnx"
    pre = rd / "onnx" / "model.pre.onnx"
    mid = rd / "onnx" / "model.matmul-int8.onnx"
    dst = rd / "onnx" / "model.int8.onnx"

    if quant_pre_process is not None:
        # symbolic shape inference fails on this graph ("Incomplete symbolic shape inference"); ONNX shape
        # inference is sufficient. Basic ORT optimizations only -> standard ai.onnx ops.
        quant_pre_process(str(src), str(pre), skip_optimization=False, skip_onnx_shape=False, skip_symbolic_shape=True)
        used_pre = True
    else:
        pre = src
        used_pre = False

    quantize_dynamic(str(pre), str(mid), weight_type=QuantType.QInt8, op_types_to_quantize=["MatMul"],
                     per_channel=True, reduce_range=False)
    m = onnx.load(str(mid))
    emb = quantize_word_embeddings(m)
    m = onnx.shape_inference.infer_shapes(m)
    onnx.checker.check_model(m)
    onnx.save(m, str(dst))
    mid.unlink()

    ops = sorted({n.op_type for n in m.graph.node})
    domains = sorted({n.domain or "ai.onnx" for n in m.graph.node})
    big = [i for i in m.graph.initializer if len(i.dims) == 2 and i.dims[0] > 80000 and i.dims[1] > 1]
    gather_quantized = bool(big) and all(i.data_type in (TensorProto.UINT8, TensorProto.INT8) for i in big)
    size_before = src.stat().st_size / 2**20
    size_after = dst.stat().st_size / 2**20
    limit = float(cfg["quantize"]["max_size_mb"])
    info = {"file": str(dst.relative_to(rd)), "quant_pre_process": used_pre,
            "matmul": {"weight_type": "QInt8", "per_channel": True, "activations": "dynamic uint8"},
            "word_embeddings": emb, "size_fp32_mb": round(size_before, 2), "size_int8_mb": round(size_after, 2),
            "size_int8_bytes": dst.stat().st_size, "gather_quantized": gather_quantized, "ops": ops,
            "domains": domains, "opset": [f"{o.domain or 'ai.onnx'}:{o.version}" for o in m.opset_import],
            "gate": {"max_mb": limit, "passed": size_after <= limit and gather_quantized}}
    update_eval(cfg, "quantize", info)
    print(f"fp32 {size_before:.1f} MB -> int8 {size_after:.1f} MB (limit {limit} MB), "
          f"word-embedding Gather quantized: {gather_quantized} ({emb['scheme']}, max err {emb['max_abs_error']:.2e})")
    print(f"ops: {ops}; domains: {domains}")
    assert gather_quantized, "word embeddings were not quantized"
    assert size_after <= limit, f"model.int8.onnx is {size_after:.1f} MB > {limit} MB"


if __name__ == "__main__":
    main()
