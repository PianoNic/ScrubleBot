"""Turn the harvested samples.ndjson into RGB tensors + integer labels."""

import hashlib
import json
import multiprocessing as mp
import os
from collections import Counter

import numpy as np

from raster import rasterize


def load_samples(path):
    """Read every harvest shard (samples*.ndjson alongside `path`) into
    [{word, drawing, colors}], skipping bad lines. Supports a fleet of harvest
    bots each writing its own shard."""
    import glob
    out = []
    directory = os.path.dirname(path) or "."
    files = sorted(glob.glob(os.path.join(directory, "samples*.ndjson"))) or [path]
    for fp in files:
        try:
            f = open(fp)
        except FileNotFoundError:
            continue
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


def _raster_one(item):
    """Worker: (drawing, colors, label) -> (raster_or_None, label)."""
    drawing, colors, label = item
    return rasterize(drawing, colors), label


def _signature(items, vocab):
    """Content hash of the (rasterizable) dataset, to validate the raster cache."""
    h = hashlib.sha1()
    h.update("|".join(vocab).encode())
    for drawing, colors, label in items:
        h.update(repr(drawing).encode())
        if colors:
            h.update(repr(colors).encode())
    return h.hexdigest()


def build_dataset(samples, vocab, cache_dir=None):
    """-> (X[N,3,28,28] float32, y[N] int64), dropping words outside the vocab.

    Rasterizing is CPU-bound, so it runs across all cores but one (leaving one for
    the system) and is cached: an identical dataset on the next run loads instantly.
    """
    cache_dir = cache_dir or os.environ.get("MODEL_DIR", "data/model")
    idx = {w: i for i, w in enumerate(vocab)}
    items = [(s["drawing"], s.get("colors"), idx[s["word"]]) for s in samples if s["word"] in idx]
    if not items:
        return None, None

    # cache: skip rasterizing if the exact same dataset was built before
    sig = _signature(items, vocab)
    cache, sigfile = os.path.join(cache_dir, "raster_cache.npz"), os.path.join(cache_dir, "raster_cache.sig")
    if os.path.exists(cache) and os.path.exists(sigfile):
        try:
            if open(sigfile).read().strip() == sig:
                d = np.load(cache)
                print(f"  raster cache hit ({len(d['y'])} samples) — skipping rasterization")
                return d["X"], d["y"]
        except Exception:  # noqa: BLE001 - a bad cache just means we rasterize
            pass

    workers = max(1, (os.cpu_count() or 2) - 1)  # leave one core for the system
    total = len(items)
    print(f"  rasterizing {total} drawings on {workers} workers…")
    xs, ys = [], []
    with mp.Pool(workers) as pool:
        for i, (r, label) in enumerate(pool.imap(_raster_one, items, chunksize=64), 1):
            if r is not None:
                xs.append(r)
                ys.append(label)
            if i % 20000 == 0 or i == total:
                print(f"    rasterized {i}/{total}")
    if not xs:
        return None, None

    X, y = np.stack(xs), np.asarray(ys, dtype=np.int64)
    try:
        os.makedirs(cache_dir, exist_ok=True)
        np.savez_compressed(cache, X=X, y=y)
        with open(sigfile, "w") as f:
            f.write(sig)
    except Exception as e:  # noqa: BLE001 - caching is best-effort
        print("  raster cache save skipped:", e)
    return X, y
