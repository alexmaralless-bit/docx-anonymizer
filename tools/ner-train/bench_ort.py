"""onnxruntime CPU latency of the int8 model with one intra-op thread (rough reference for WASM, single thread).

Measures ms per call for [1,maxLen] and [8,maxLen] windows and the session creation time.
"""
from __future__ import annotations

import statistics
import time

import numpy as np
from common import load_config, ort_session, run_dir, update_eval  # noqa: E402


def bench(sess, batch, seq, runs=30, warmup=5):
    rng = np.random.default_rng(0)
    feeds = {"input_ids": rng.integers(5, 83828, size=(batch, seq), dtype=np.int64),
             "attention_mask": np.ones((batch, seq), np.int64), "token_type_ids": np.zeros((batch, seq), np.int64)}
    for _ in range(warmup):
        sess.run(["logits"], feeds)
    times = []
    for _ in range(runs):
        t = time.perf_counter()
        sess.run(["logits"], feeds)
        times.append((time.perf_counter() - t) * 1000)
    return statistics.median(times)


def main():
    cfg, _ = load_config()
    rd = run_dir(cfg)
    seq = int(cfg["data"]["max_length"])
    res = {"threads": 1, "provider": "CPUExecutionProvider"}
    for name in ("int8", "fp32"):
        path = rd / "onnx" / f"model.{name}.onnx"
        t = time.perf_counter()
        sess = ort_session(path, threads=1)
        load_ms = (time.perf_counter() - t) * 1000
        b1 = bench(sess, 1, seq)
        b8 = bench(sess, 8, seq)
        res[name] = {"session_create_ms": round(load_ms, 1), f"ms_1x{seq}": round(b1, 2), f"ms_8x{seq}": round(b8, 2),
                     f"ms_per_window_8x{seq}": round(b8 / 8, 2)}
        print(f"{name}: session {load_ms:.0f} ms; [1,{seq}] {b1:.2f} ms; [8,{seq}] {b8:.2f} ms ({b8 / 8:.2f} ms/window)")
    update_eval(cfg, "bench_ort", res)


if __name__ == "__main__":
    main()
