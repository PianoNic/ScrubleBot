"""From-scratch color-aware detector: a small CNN over the harvested vocabulary,
exported to ONNX for the Bun bot to load.

Color is a *cue*, not a crutch: `gray_dropout` randomly desaturates a fraction of
each batch, so the model also recognizes the plain black-and-white (monochrome)
drawing — while still exploiting color when present (brown + green -> plant).
"""

import json
import os

import torch
import torch.nn as nn

# luminance weights (ITU-R 601) for desaturation
GRAY_W = torch.tensor([0.299, 0.587, 0.114]).view(1, 3, 1, 1)


def gray_dropout(x, p=0.3):
    """With prob `p` per sample, replace RGB with its grayscale (3x luminance)."""
    if p <= 0:
        return x
    w = GRAY_W.to(x.device)
    gray = (x * w).sum(1, keepdim=True).repeat(1, 3, 1, 1)
    mask = (torch.rand(x.size(0), 1, 1, 1, device=x.device) < p).float()
    return x * (1 - mask) + gray * mask


class Net(nn.Module):
    """3x28x28 -> conv/conv/conv -> global pool -> linear over the vocabulary."""

    def __init__(self, n_classes):
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv2d(3, 32, 3, padding=1), nn.BatchNorm2d(32), nn.ReLU(), nn.MaxPool2d(2),
            nn.Conv2d(32, 64, 3, padding=1), nn.BatchNorm2d(64), nn.ReLU(), nn.MaxPool2d(2),
            nn.Conv2d(64, 128, 3, padding=1), nn.BatchNorm2d(128), nn.ReLU(), nn.AdaptiveAvgPool2d(1),
        )
        self.head = nn.Linear(128, n_classes)

    def forward(self, x):
        return self.head(self.features(x).flatten(1))


def train(X, y, vocab, epochs=40, lr=1e-3, batch=64, gray_p=0.3, device=None):
    device = device or ("cuda" if torch.cuda.is_available() else "cpu")
    print(f"training on {device}: {len(X)} samples, {len(vocab)} classes")
    net = Net(len(vocab)).to(device)
    opt = torch.optim.Adam(net.parameters(), lr=lr)
    loss_fn = nn.CrossEntropyLoss()
    Xt, yt = torch.from_numpy(X), torch.from_numpy(y)
    n = len(Xt)
    for ep in range(epochs):
        net.train()
        perm = torch.randperm(n)
        total = 0.0
        for i in range(0, n, batch):
            idx = perm[i:i + batch]
            xb = gray_dropout(Xt[idx].to(device), gray_p)
            yb = yt[idx].to(device)
            opt.zero_grad()
            loss = loss_fn(net(xb), yb)
            loss.backward()
            opt.step()
            total += loss.item() * len(idx)
        print(f"  epoch {ep + 1}/{epochs}  loss {total / n:.4f}")
    return net


def export(net, vocab, out_dir):
    """Write detector.onnx + detector.vocab.json. Atomic so the bot never loads
    a half-written model while hot-reloading."""
    os.makedirs(out_dir, exist_ok=True)
    net.eval().cpu()
    dummy = torch.zeros(1, 3, 28, 28)
    tmp = os.path.join(out_dir, "detector.onnx.tmp")
    final = os.path.join(out_dir, "detector.onnx")
    torch.onnx.export(
        net, dummy, tmp,
        input_names=["input"], output_names=["logits"],
        dynamic_axes={"input": {0: "n"}, "logits": {0: "n"}},
        opset_version=17,
    )
    os.replace(tmp, final)
    with open(os.path.join(out_dir, "detector.vocab.json"), "w") as f:
        json.dump(vocab, f)
    return final
