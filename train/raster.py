"""Rasterize harvested (drawing, colors) into the same RGB image the Bun runtime
feeds the detector — a faithful port of StrokeCanvas.toRGB (src/canvas.js).

Parity matters: if the Python training raster and the Bun inference raster differ,
the model sees a different distribution at test time. The constants, bbox-fit,
square-brush Bresenham stamping and 10x10 box-downsample below mirror canvas.js
exactly. Output is CHW float32 in 0..1 on a white background.
"""

import numpy as np

from palette import color_rgb

HI = 280        # high-res raster size   (canvas.js HI)
OUT = 28        # model input size       (canvas.js OUT)
POOL = HI // OUT  # 10
MARGIN = 0.12   # padding fraction       (canvas.js MARGIN)
RADIUS = max(1, round(0.9 * POOL))  # stroke half-thickness in hi-res px (= 9)


def _stamp(buf, cx, cy, r, rgb):
    """Square brush: overwrite an (2r+1)^2 block with rgb (matches _lineRGB)."""
    y0, y1 = max(0, cy - r), min(HI - 1, cy + r)
    x0, x1 = max(0, cx - r), min(HI - 1, cx + r)
    if y0 <= y1 and x0 <= x1:
        buf[y0:y1 + 1, x0:x1 + 1] = rgb


def _line(buf, x0, y0, x1, y1, r, rgb):
    """Bresenham line with a square brush — identical traversal to canvas.js."""
    x0, y0, x1, y1 = round(x0), round(y0), round(x1), round(y1)
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


def to_png(drawing, colors=None, size=224):
    """Render a drawing to a PIL RGB image for the vision LLM (full-res, resized)."""
    from PIL import Image
    chw = rasterize(drawing, colors, out=HI)  # HI//HI = 1 -> full-res, valid reshape
    if chw is None:
        return None
    hwc = (np.transpose(chw, (1, 2, 0)) * 255).clip(0, 255).astype(np.uint8)
    img = Image.fromarray(hwc, "RGB")
    return img.resize((size, size), Image.BILINEAR) if size else img
