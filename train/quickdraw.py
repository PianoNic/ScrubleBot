"""Fetch QuickDraw 'simplified' drawings as training data — the base that seeds
the single model with the 345-category knowledge doodleNet had.

QuickDraw is colorless, so these teach *shape* (rasterized grayscale on white);
the live harvest adds color and new words on top. A QuickDraw stroke is already
[[xs], [ys]] — exactly our drawing format — so it maps straight in. Categories
are cached on disk so retrains don't re-download.
"""

import json
import os
import urllib.parse
import urllib.request

BASE = "https://storage.googleapis.com/quickdraw_dataset/full/simplified"


def categories_from_file(path):
    """class_names.txt (underscored) -> lowercased category names, minus the
    proper-noun 'the ...' files QuickDraw can't be fetched for."""
    cats = []
    try:
        f = open(path)
    except FileNotFoundError:
        return cats
    with f:
        for line in f:
            c = line.strip().replace("_", " ").lower()
            if c and not c.startswith("the "):
                cats.append(c)
    return cats


def _fetch(cat, limit):
    # Pull enough bytes to actually yield `limit` drawings (~1.2 KB each, + headroom),
    # so a big --quickdraw isn't silently capped by a fixed range.
    byte_cap = max(400000, limit * 1200)
    url = f"{BASE}/{urllib.parse.quote(cat)}.ndjson"
    req = urllib.request.Request(url, headers={"Range": f"bytes=0-{byte_cap}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            text = r.read().decode("utf-8", "ignore")
    except Exception as e:  # noqa: BLE001
        print("  quickdraw fetch failed:", cat, e)
        return []
    out = []
    for line in text.split("\n"):
        line = line.strip()
        if not line or not line.endswith("}"):  # skip the truncated tail line
            continue
        try:
            o = json.loads(line)
        except ValueError:
            continue
        if o.get("recognized") and isinstance(o.get("drawing"), list):
            out.append({"word": cat, "drawing": o["drawing"], "colors": None})
            if len(out) >= limit:
                break
    return out


def load_quickdraw(categories, per_cat=150, cache_dir="data/quickdraw_cache"):
    """-> list of {word, drawing, colors:None}, cached per category on disk."""
    os.makedirs(cache_dir, exist_ok=True)
    samples = []
    for cat in categories:
        cf = os.path.join(cache_dir, cat.replace(" ", "_") + ".json")
        items = None
        if os.path.exists(cf):
            try:
                items = json.load(open(cf))
            except ValueError:
                items = None
        if items is None or len(items) < per_cat:
            items = _fetch(cat, per_cat)
            json.dump(items, open(cf, "w"))
        samples.extend(items[:per_cat])
    return samples
