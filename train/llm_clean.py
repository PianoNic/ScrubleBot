"""Figure-ground cleaning with a local vision LLM (Ollama, OpenAI-compatible).

"Not everything someone draws is the thing itself" — players add a sea, a garden,
background scenery. We render each harvested drawing and ask a vision model whether
the labelled word is actually the clear subject; scene-polluted samples are dropped
before training. Results are cached, and the step fails *open* (keeps the sample)
whenever the LLM is unreachable, so training is never blocked.

Needs a *vision* model (it looks at a picture): llava, qwen2-vl, llama3.2-vision,
or LFM2.5-VL-1.6B. A text-only model (e.g. plain LFM2.5-1.2B) cannot do this step.

Config via env: OLLAMA_URL (default http://localhost:11434/v1),
OLLAMA_VISION_MODEL (default llava), OLLAMA_KEY (default 'ollama').
"""

import base64
import hashlib
import io
import json
import os
import urllib.request

from raster import to_png

URL = os.environ.get("OLLAMA_URL", "http://localhost:11434/v1")
MODEL = os.environ.get("OLLAMA_VISION_MODEL", "llava")
KEY = os.environ.get("OLLAMA_KEY", "ollama")
CACHE = os.environ.get("CLEAN_CACHE", "data/model/clean_cache.json")


def _key(sample):
    blob = sample["word"] + json.dumps(sample["drawing"])
    return hashlib.sha1(blob.encode()).hexdigest()


def _ask(word, img):
    """True = keep. Ask the vision model if `word` is the clear subject."""
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()
    prompt = (
        f"This is a drawing from a Pictionary-style game; the answer is '{word}'. "
        f"Is '{word}' clearly the main subject, drawn recognizably and not lost in "
        f'unrelated background scenery? Reply only JSON: {{"keep": true|false}}.'
    )
    body = json.dumps({
        "model": MODEL,
        "temperature": 0,
        "stream": False,
        "response_format": {"type": "json_object"},  # force clean JSON from small models
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
        ]}],
    }).encode()
    req = urllib.request.Request(
        URL.rstrip("/") + "/chat/completions", data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {KEY}"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        out = json.loads(resp.read())
    txt = out["choices"][0]["message"]["content"]
    i, j = txt.find("{"), txt.rfind("}")
    return bool(json.loads(txt[i:j + 1]).get("keep", True))


def clean(samples):
    """Filter scene-polluted samples; cache decisions; keep on any error."""
    cache = {}
    if os.path.exists(CACHE):
        try:
            cache = json.load(open(CACHE))
        except ValueError:
            cache = {}
    kept = []
    for s in samples:
        k = _key(s)
        if k not in cache:
            try:
                img = to_png(s["drawing"], s.get("colors"))
                cache[k] = _ask(s["word"], img) if img else True
            except Exception as e:  # noqa: BLE001 - never let cleaning break training
                print("  llm-clean skipped (kept):", e)
                cache[k] = True
        if cache[k]:
            kept.append(s)
    os.makedirs(os.path.dirname(CACHE) or ".", exist_ok=True)
    json.dump(cache, open(CACHE, "w"))
    print(f"  llm-clean kept {len(kept)}/{len(samples)} samples")
    return kept
