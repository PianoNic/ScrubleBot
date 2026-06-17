"""skribbl's 22-color palette — must stay identical to src/protocol.js PALETTE.

The harvested strokes carry a palette *index*; both the Bun runtime raster
(StrokeCanvas.toRGB) and this training raster turn that index into the same RGB
so the color-aware detector sees the same distribution at train and inference.
"""

PALETTE = [
    "#ffffff", "#000000", "#c1c1c1", "#505050",
    "#ef130b", "#740b07", "#ff7100", "#c23800",
    "#ffe400", "#e8a200", "#00cc00", "#004619",
    "#00ff91", "#00785d", "#00b2ff", "#00569e",
    "#231fd3", "#0e0865", "#a300ba", "#550069",
    "#df69a7", "#873554", "#ffac8e", "#cc774d",
    "#a0522d", "#63300d",
]

# index -> (r, g, b) in 0..1
PALETTE_RGB = [
    tuple(int(h[i:i + 2], 16) / 255.0 for i in (1, 3, 5)) for h in PALETTE
]


def color_rgb(index):
    """Palette index -> (r, g, b) floats, defaulting to black (index 1)."""
    if index is None or index < 0 or index >= len(PALETTE_RGB):
        return PALETTE_RGB[1]
    return PALETTE_RGB[index]
