"""Loaders of the training corpora listed in config.yaml data.sources[].

Every loader returns {"train": rows, "validation": rows | None, "test": rows | None} where rows is a dict of columns
tokens / ner_tags (label ids in config order) / lang. Labels outside PER/ORG/LOC become O.

Kinds:
  wikiann — Hugging Face datasets `unimelb-nlp/wikiann` (config ru / en), tags already in the right order;
  factru  — factRuEval-2016 (dialogue-evaluation, MIT; texts from OpenCorpora, CC BY-SA 3.0), downloaded from a
            pinned commit; object layer Person -> PER, Org -> ORG, Location / LocOrg -> LOC, Project -> O.
"""
from __future__ import annotations

import hashlib
import tarfile
import urllib.request
from pathlib import Path

from common import ROOT

FACTRU_TYPES = {"Person": "PER", "Org": "ORG", "Location": "LOC", "LocOrg": "LOC"}
# span types that carry the name itself; descriptors ("компания", "город"), jobs and geo adjectives are left out
FACTRU_NAME_SPANS = {"PER": {"name", "surname", "patronymic", "nickname"}, "ORG": {"org_name", "loc_name", "geo_adj"},
                     "LOC": {"loc_name"}}
OPEN_QUOTES = {"«", '"', "“", "„", "'"}
CLOSE_QUOTES = {"»", '"', "”", "“", "'"}
LEGAL_FORMS = {"ООО", "ОАО", "ЗАО", "ПАО", "АО", "НАО", "АНО", "НКО", "ФГУП", "ГУП", "МУП", "ИП", "ТОО", "НПО", "ФГБУ",
               "ГБУ", "ФКУ", "LLC", "Inc", "Ltd"}


def load_source(src: dict, labels: list[str]) -> dict:
    kind = src["kind"]
    if kind == "wikiann":
        return _load_wikiann(src, labels)
    if kind == "factru":
        return _load_factru(src, labels)
    raise ValueError(f"unknown source kind: {kind}")


def _load_wikiann(src, labels):
    from datasets import load_dataset
    ds = load_dataset(src["dataset"], src["config"])
    names = ds["train"].features["ner_tags"].feature.names
    assert names == labels, f"label order mismatch for {src['id']}: {names}"
    out = {}
    for split in ("train", "validation", "test"):
        part = ds[split]
        out[split] = {"tokens": part["tokens"], "ner_tags": part["ner_tags"], "lang": [src["lang"]] * len(part)}
    return out


# ---- factRuEval-2016 ------------------------------------------------------------------------------------------

def _download_factru(src) -> Path:
    cache = ROOT / ".cache" / "factru"
    cache.mkdir(parents=True, exist_ok=True)
    tgz = cache / f"factRuEval-2016-{src['commit']}.tar.gz"
    if not tgz.exists():
        url = f"https://codeload.github.com/dialogue-evaluation/factRuEval-2016/tar.gz/{src['commit']}"
        urllib.request.urlretrieve(url, tgz)
    digest = hashlib.sha256(tgz.read_bytes()).hexdigest()
    assert digest == src["sha256"], f"factRuEval archive sha256 mismatch: {digest}"
    root = cache / f"factRuEval-2016-{src['commit']}"
    if not root.exists():
        with tarfile.open(tgz) as tf:
            tf.extractall(cache, filter="data")
    return root


def _read_doc(stem: Path):
    """Sentences of one document: list of (tokens, tags)."""
    toks, sent_of, sents = [], [], [[]]
    id2idx = {}
    for line in stem.with_suffix(".tokens").read_text(encoding="utf-8").splitlines():
        if not line.strip():
            if sents[-1]:
                sents.append([])
            continue
        tid, _start, _len, text = line.split(" ", 3)
        id2idx[tid] = len(toks)
        sents[-1].append(len(toks))
        sent_of.append(len(sents) - 1)
        toks.append(text)
    if not sents[-1]:
        sents.pop()
    spans = {}
    for line in stem.with_suffix(".spans").read_text(encoding="utf-8").splitlines():
        f = line.split("#")[0].split()
        if len(f) < 6:
            continue
        sid, typ, first, ntok = f[0], f[1], f[4], int(f[5])
        if first not in id2idx:
            continue
        i0 = id2idx[first]
        spans[sid] = (typ, list(range(i0, i0 + ntok)))
    mentions = []
    for line in stem.with_suffix(".objects").read_text(encoding="utf-8").splitlines():
        f = line.split("#")[0].split()
        if len(f) < 3 or f[1] not in FACTRU_TYPES:
            continue
        lab = FACTRU_TYPES[f[1]]
        idx = [i for s in f[2:] if s in spans and spans[s][0] in FACTRU_NAME_SPANS[lab] for i in spans[s][1]]
        if lab == "ORG" and not any(spans[s][0] == "org_name" for s in f[2:] if s in spans):
            continue  # descriptor-only organisation mention ("дипмиссия", "правительство")
        if not idx:
            continue
        a, b = min(idx), max(idx) + 1
        if sent_of[a] != sent_of[b - 1]:
            continue
        if lab == "ORG":  # anonymizer convention: quotes and a legal form in front belong to the organisation
            if a > 0 and b < len(toks) and toks[a - 1] in OPEN_QUOTES and toks[b] in CLOSE_QUOTES \
                    and sent_of[a - 1] == sent_of[a] and sent_of[b] == sent_of[a]:
                a, b = a - 1, b + 1
            if a > 0 and toks[a - 1].rstrip(".") in LEGAL_FORMS and sent_of[a - 1] == sent_of[a]:
                a -= 1
        mentions.append((b - a, a, b, lab))
    tags = ["O"] * len(toks)
    taken = [False] * len(toks)
    for _, a, b, lab in sorted(mentions, key=lambda m: (-m[0], m[1])):  # outermost mention wins
        if any(taken[a:b]):
            continue
        for i in range(a, b):
            taken[i] = True
            tags[i] = ("B-" if i == a else "I-") + lab
    return [([toks[i] for i in s], [tags[i] for i in s]) for s in sents]


def _load_factru(src, labels):
    root = _download_factru(src)
    l2i = {l: i for i, l in enumerate(labels)}
    stems = sorted({p.with_suffix("") for d in ("devset", "testset") for p in (root / d).glob("*.objects")})
    holdout = float(src.get("holdout_docs", 0.2))
    out = {"train": {"tokens": [], "ner_tags": [], "lang": []}, "test": {"tokens": [], "ner_tags": [], "lang": []}}
    for stem in stems:
        # deterministic document-level hold-out by a hash of the file name
        h = int(hashlib.sha256(stem.name.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
        part = out["test" if h < holdout else "train"]
        for toks, tags in _read_doc(stem):
            if not toks:
                continue
            part["tokens"].append(toks)
            part["ner_tags"].append([l2i[t] for t in tags])
            part["lang"].append("ru")
    out["validation"] = None
    return out
