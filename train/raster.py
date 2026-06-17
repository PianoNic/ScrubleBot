"""Rasterize harvested (drawing, colors) into the same RGB image the Bun runtime
feeds the detector — a faithful port of StrokeCanvas.toRGB (src/canvas.js).

Parity matters: if the Python training raster and the Bun inference raster differ,
the model sees a different distribution at test time. The constants, bbox-fit,
square-brush Bresenham stamping and 10x10 box-downsample below mirror canvas.js
exactly. Output is CHW float32 in 0..1 on a white background.
"""

import math

import numpy as np

from palette import color_rgb

HI = 280        # high-res raster size   (canvas.js HI)
OUT = 28        # model input size       (canvas.js OUT)
POOL = HI // OUT  # 10
MARGIN = 0.12   # padding fraction       (canvas.js MARGIN)
RADIUS = max(1, round(0.9 * POOL))  # stroke half-thickness in hi-res px (= 9)


def _r(v):
    """Round like JS Math.round (floor(x+0.5)) so the raster matches canvas.js exactly."""
    return int(math.floor(v + 0.5))


def _stamp(buf, cx, cy, r, rgb):
    """Square brush: overwrite an (2r+1)^2 block with rgb (matches _lineRGB)."""
    y0, y1 = max(0, cy - r), min(HI - 1, cy + r)
    x0, x1 = max(0, cx - r), min(HI - 1, cx + r)
    if y0 <= y1 and x0 <= x1:
        buf[y0:y1 + 1, x0:x1 + 1] = rgb


def _line(buf, x0, y0, x1, y1, r, rgb):
    """Bresenham line with a square brush — identical traversal to canvas.js."""
    x0, y0, x1, y1 = _r(x0), _r(y0), _r(x1), _r(y1)
    dx, dy = abs(x1 - x0), abs(y1 - y0)
    sx = 1 if x0 < x1 else -1
    sy = 1 if y0 < y1 else -1
    err = dx - dy
    while True:
        _stamp(buf, x0, y0, r, rgb)
        if x0 == x1 and y0 == y1:
            break
        e2 = 2 * err
        if e2 > -dy:
            err -= dy
            x0 += sx
        if e2 < dx:
            err += dx
            y0 += sy


def _bbox(drawing):
    pts_x, pts_y = [], []
    for xs, ys in drawing:
        pts_x.extend(xs)
        pts_y.extend(ys)
    if not pts_x:
        return None
    return min(pts_x), min(pts_y), max(pts_x), max(pts_y)


def rasterize(drawing, colors=None, out=OUT):
    """(drawing, colors) -> CHW float32 array [3, out, out], or None if empty.

    drawing: list of strokes [[xs, ys], ...] in canvas coords.
    colors:  parallel list of palette indices (defaults to black where missing).
    """
    bb = _bbox(drawing)
    if bb is None:
        return None
    pool = HI // out
    min_x, min_y, max_x, max_y = bb
    w = max(1, max_x - min_x)
    h = max(1, max_y - min_y)
    span = max(w, h)
    scale = (HI * (1 - 2 * MARGIN)) / span
    off_x = (HI - w * scale) / 2 - min_x * scale
    off_y = (HI - h * scale) / 2 - min_y * scale

    hi = np.ones((HI, HI, 3), dtype=np.float32)  # white background
    for si, (xs, ys) in enumerate(drawing):
        rgb = np.asarray(color_rgb(colors[si] if colors and si < len(colors) else 1),
                         dtype=np.float32)
        for i in range(1, len(xs)):
            _line(hi,
                  xs[i - 1] * scale + off_x, ys[i - 1] * scale + off_y,
                  xs[i] * scale + off_x, ys[i] * scale + off_y,
                  RADIUS, rgb)

    # box-downsample HIxHI -> out x out, average pooling (matches canvas.js)
    small = hi.reshape(out, pool, out, pool, 3).mean(axis=(1, 3))
    return np.transpose(small, (2, 0, 1)).copy()  # HWC -> CHW


def _flood(hi, px, py, rgb):
    """4-connectivity flood fill (exact-color) — same region as canvas.js _fillRGB."""
    if not (0 <= px < HI and 0 <= py < HI):
        return
    tr, tg, tb = hi[py, px, 0].item(), hi[py, px, 1].item(), hi[py, px, 2].item()
    r, g, b = float(rgb[0]), float(rgb[1]), float(rgb[2])
    if tr == r and tg == g and tb == b:
        return
    stack = [(px, py)]
    while stack:
        x, y = stack.pop()
        if not (0 <= x < HI and 0 <= y < HI):
            continue
        if hi[y, x, 0].item() != tr or hi[y, x, 1].item() != tg or hi[y, x, 2].item() != tb:
            continue
        hi[y, x, 0] = r; hi[y, x, 1] = g; hi[y, x, 2] = b
        stack.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))


def _bbox_ops(ops):
    xs, ys = [], []
    for s in ops:
        if s[0] == 0 and len(s) >= 7:
            xs += [s[3], s[5]]; ys += [s[4], s[6]]
    if not xs:
        return None
    return min(xs), min(ys), max(xs), max(ys)


def rasterize_ops(ops, out=OUT):
    """Rasterize an ordered op19 list (pen [0,…] + fill [1,color,x,y]) -> CHW float32,
    mirroring StrokeCanvas.toRGB. Fills flood the region as it was at that moment."""
    bb = _bbox_ops(ops)
    if bb is None:
        return None
    pool = HI // out
    min_x, min_y, max_x, max_y = bb
    w = max(1, max_x - min_x)
    h = max(1, max_y - min_y)
    span = max(w, h)
    scale = (HI * (1 - 2 * MARGIN)) / span
    off_x = (HI - w * scale) / 2 - min_x * scale
    off_y = (HI - h * scale) / 2 - min_y * scale

    hi = np.ones((HI, HI, 3), dtype=np.float32)
    for s in ops:
        if s[0] == 0 and len(s) >= 7:
            rgb = np.asarray(color_rgb(s[1]), dtype=np.float32)
            _line(hi, s[3] * scale + off_x, s[4] * scale + off_y,
                  s[5] * scale + off_x, s[6] * scale + off_y, RADIUS, rgb)
        elif s[0] == 1 and len(s) >= 4:
            rgb = np.asarray(color_rgb(s[1]), dtype=np.float32)
            _flood(hi, _r(s[2] * scale + off_x), _r(s[3] * scale + off_y), rgb)

    small = hi.reshape(out, pool, out, pool, 3).mean(axis=(1, 3))
    return np.transpose(small, (2, 0, 1)).copy()


def to_png(drawing, colors=None, size=448):
    """Render a drawing to a PIL RGB image for the vision LLM (full-res, resized)."""
    from PIL import Image
    chw = rasterize(drawing, colors, out=HI)  # HI//HI = 1 -> full-res, valid reshape
    if chw is None:
        return None
    hwc = (np.transpose(chw, (1, 2, 0)) * 255).clip(0, 255).astype(np.uint8)
    img = Image.fromarray(hwc, "RGB")
    return img.resize((size, size), Image.BILINEAR) if size else img
