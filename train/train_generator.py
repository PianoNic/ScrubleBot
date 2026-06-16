"""Conditional Sketch-RNN generator: learn to *draw* harvested words, not just
replay QuickDraw. A class-conditioned LSTM decoder with a Mixture-Density output
over pen offsets (the standard Sketch-RNN decoder, no VAE — KISS).

ONNX export is the fiddly part (per the plan): we export only the *single-step*
decoder — (point, class, h, c) -> (mdn params, next h, c) — and run the
autoregressive sampling + MDN sampling loop in Bun (src/sketchrnn.js). That keeps
the LSTM/MDN graph trivial for onnxruntime and the stochastic loop in JS.

Stroke-5 format per step: (dx, dy, p1, p2, p3) with pen states draw / lift / end.
"""

import json
import os

import numpy as np
import torch
import torch.nn as nn

MAX_LEN = 150     # cap sequence length
M = 20            # MDN mixtures
HIDDEN = 256
PARAMS = 6 * M + 3  # per-mixture (pi,mux,muy,sx,sy,rho) + 3 pen logits


# ---- data: harvested drawings -> normalized stroke-5 sequences ---------------

def to_stroke5(drawing, scale):
    """[[xs,ys],...] absolute coords -> [[dx,dy,p1,p2,p3], ...] (no end token)."""
    pts = []  # (x, y, last_in_stroke)
    for xs, ys in drawing:
        for i in range(len(xs)):
            pts.append((xs[i], ys[i], i == len(xs) - 1))
    if len(pts) < 2:
        return None
    seq = []
    for i in range(1, len(pts)):
        dx = (pts[i][0] - pts[i - 1][0]) / scale
        dy = (pts[i][1] - pts[i - 1][1]) / scale
        lift = pts[i - 1][2]  # the move *into* a new stroke is a pen-lift
        seq.append([dx, dy, 0.0 if lift else 1.0, 1.0 if lift else 0.0, 0.0])
    return seq[:MAX_LEN]


def compute_scale(drawings):
    deltas = []
    for d in drawings:
        pts = [(x, y) for xs, ys in d for x, y in zip(xs, ys)]
        for i in range(1, len(pts)):
            deltas.append(pts[i][0] - pts[i - 1][0])
            deltas.append(pts[i][1] - pts[i - 1][1])
    s = float(np.std(deltas)) if deltas else 1.0
    return s or 1.0


def build_sequences(samples, vocab):
    """-> X[N,T,5] inputs, Y[N,T,5] targets, C[N] class idx, L[N] lengths, scale."""
    idx = {w: i for i, w in enumerate(vocab)}
    drawings = [s["drawing"] for s in samples if s["word"] in idx]
    scale = compute_scale(drawings)
    start = [0.0, 0.0, 1.0, 0.0, 0.0]
    end = [0.0, 0.0, 0.0, 0.0, 1.0]
    X, Y, C, L = [], [], [], []
    for s in samples:
        if s["word"] not in idx:
            continue
        seq = to_stroke5(s["drawing"], scale)
        if not seq:
            continue
        tgt = seq + [end]
        inp = [start] + seq
        n = len(tgt)
        pad = MAX_LEN + 1
        tgt = tgt + [end] * (pad - n)
        inp = inp + [end] * (pad - n)
        X.append(inp[:pad]); Y.append(tgt[:pad]); C.append(idx[s["word"]]); L.append(n)
    if not X:
        return None
    return (np.array(X, np.float32), np.array(Y, np.float32),
            np.array(C, np.int64), np.array(L, np.int64), scale)


# ---- model -------------------------------------------------------------------

class SketchRNN(nn.Module):
    def __init__(self, n_classes, hidden=HIDDEN, m=M):
        super().__init__()
        self.n_classes = n_classes
        self.lstm = nn.LSTM(5 + n_classes, hidden, batch_first=True)
        self.out = nn.Linear(hidden, 6 * m + 3)

    def forward(self, x, cond, hc=None):
        y, hc = self.lstm(torch.cat([x, cond], -1), hc)
        return self.out(y), hc


def mdn_loss(params, target, lengths, m=M):
    B, T, _ = params.shape
    pi, mux, muy, sx, sy, rho = torch.split(params[..., :6 * m], m, dim=-1)
    pen = params[..., 6 * m:]
    pi = torch.softmax(pi, -1)
    sx, sy = torch.exp(sx), torch.exp(sy)
    rho = torch.tanh(rho)
    tx, ty = target[..., 0:1], target[..., 1:2]
    omr = 1 - rho ** 2 + 1e-6
    zx, zy = (tx - mux) / sx, (ty - muy) / sy
    z = zx ** 2 + zy ** 2 - 2 * rho * zx * zy
    prob = torch.exp(-z / (2 * omr)) / (2 * np.pi * sx * sy * torch.sqrt(omr))
    gmm = (pi * prob).sum(-1)                                  # [B,T]
    l_offset = -torch.log(gmm + 1e-6)
    l_pen = -(target[..., 2:5] * torch.log_softmax(pen, -1)).sum(-1)
    # mask out padding past each sequence's length
    mask = (torch.arange(T, device=params.device)[None, :] < lengths[:, None]).float()
    return ((l_offset + l_pen) * mask).sum() / mask.sum().clamp(min=1)


def train(samples, vocab, epochs=80, lr=1e-3, batch=64, device=None):
    device = device or ("cuda" if torch.cuda.is_available() else "cpu")
    built = build_sequences(samples, vocab)
    if built is None:
        print("no trainable sequences"); return None, None
    X, Y, C, L, scale = built
    print(f"generator: {len(X)} sequences, {len(vocab)} classes, scale {scale:.2f} on {device}")
    eye = torch.eye(len(vocab))
    Xt, Yt, Ct, Lt = map(torch.from_numpy, (X, Y, C, L))
    net = SketchRNN(len(vocab)).to(device)
    opt = torch.optim.Adam(net.parameters(), lr=lr)
    n = len(Xt)
    for ep in range(epochs):
        net.train(); perm = torch.randperm(n); total = 0.0
        for i in range(0, n, batch):
            idx = perm[i:i + batch]
            x = Xt[idx].to(device)
            cond = eye[Ct[idx]][:, None, :].expand(-1, x.size(1), -1).to(device)
            params, _ = net(x, cond)
            loss = mdn_loss(params, Yt[idx].to(device), Lt[idx].to(device))
            opt.zero_grad(); loss.backward()
            nn.utils.clip_grad_norm_(net.parameters(), 1.0)
            opt.step(); total += loss.item() * len(idx)
        print(f"  epoch {ep + 1}/{epochs}  loss {total / n:.4f}")
    return net, scale


# ---- single-step export ------------------------------------------------------

class Step(nn.Module):
    """One decoder step for ONNX: (point, cond, h, c) -> (params, h, c)."""

    def __init__(self, net):
        super().__init__()
        self.lstm, self.out = net.lstm, net.out

    def forward(self, point, cond, h, c):
        y, (hn, cn) = self.lstm(torch.cat([point, cond], -1), (h, c))
        return self.out(y), hn, cn


def export(net, vocab, scale, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    step = Step(net).eval().cpu()
    point = torch.zeros(1, 1, 5)
    cond = torch.zeros(1, 1, len(vocab))
    h = torch.zeros(1, 1, HIDDEN)
    c = torch.zeros(1, 1, HIDDEN)
    tmp = os.path.join(out_dir, "generator.onnx.tmp")
    final = os.path.join(out_dir, "generator.onnx")
    torch.onnx.export(
        step, (point, cond, h, c), tmp,
        input_names=["point", "cond", "h", "c"],
        output_names=["params", "hn", "cn"],
        opset_version=18, dynamo=False,  # classic exporter -> single self-contained file
    )
    os.replace(tmp, final)
    with open(os.path.join(out_dir, "generator.meta.json"), "w") as f:
        json.dump({"vocab": vocab, "scale": scale, "hidden": HIDDEN,
                   "mixtures": M, "max_len": MAX_LEN}, f)
    return final
