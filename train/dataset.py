"""Turn the harvested samples.ndjson into RGB tensors + integer labels."""

import json
from collections import Counter

import numpy as np

from raster import rasterize


def load_samples(path):
    """Read samples.ndjson -> [{word, drawing, colors}], skipping bad lines."""
    out = []
    try:
        f = open(path)
    except FileNotFoundError:
        return out
    with f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except ValueError:
                continue
            word, drawing = o.get("word"), o.get("drawing")
            if word and isinstance(drawing, list) and drawing:
                out.append({"word": word.lower(), "drawing": drawing,
                            "colors": o.get("colors")})
    return out


def build_vocab(samples, min_per_word=1):
    """Open-set vocabulary: words with at least `min_per_word` examples, sorted."""
    counts = Counter(s["word"] for s in samples)
    return sorted(w for w, n in counts.items() if n >= min_per_word)


def build_dataset(samples, vocab):
    """-> (X[N,3,28,28] float32, y[N] int64), dropping words outside the vocab."""
    idx = {w: i for i, w in enumerate(vocab)}
    xs, ys = [], []
    for s in samples:
        if s["word"] not in idx:
            continue
        r = rasterize(s["drawing"], s.get("colors"))
        if r is not None:
            xs.append(r)
            ys.append(idx[s["word"]])
    if not xs:
        return None, None
    return np.stack(xs), np.asarray(ys, dtype=np.int64)
