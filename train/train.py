"""Autonomous training loop: harvest -> (LLM clean) -> train -> export ONNX.

One pass by default; `--watch` re-trains as the harvest grows. The Bun bot
hot-reloads the new detector.onnx on its own. Paths come from env so it works
the same on the host or in the container:
  HARVEST_FILE (default data/harvest/samples.ndjson)
  MODEL_DIR    (default data/model)
  LLM_CLEAN=1  to enable the vision-LLM figure-ground cleaning
"""

import argparse
import os
import time

from dataset import build_dataset, build_vocab, load_samples

HARVEST = os.environ.get("HARVEST_FILE", "data/harvest/samples.ndjson")
MODEL_DIR = os.environ.get("MODEL_DIR", "data/model")


def run_once(args):
    """Train+export once. Returns the sample count used (0 if it skipped)."""
    import train_detector as td

    samples = load_samples(HARVEST)
    if len(samples) < args.min_samples:
        print(f"only {len(samples)} samples (<{args.min_samples}) — skipping")
        return 0
    if os.environ.get("LLM_CLEAN", "0") == "1":
        from llm_clean import clean
        samples = clean(samples)

    vocab = build_vocab(samples, args.min_per_word)
    if not vocab:
        print(f"no word has >= {args.min_per_word} samples yet — skipping")
        return 0
    X, y = build_dataset(samples, vocab)
    if X is None:
        print("nothing rasterizable — skipping")
        return 0

    net = td.train(X, y, vocab, epochs=args.epochs, gray_p=args.gray)
    path = td.export(net, vocab, MODEL_DIR)
    print(f"exported {path}  ({len(vocab)} words, {len(X)} samples)")
    return len(samples)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--min-samples", type=int, default=50, help="min total samples to train")
    p.add_argument("--min-per-word", type=int, default=3, help="min examples for a word to be learned")
    p.add_argument("--epochs", type=int, default=40)
    p.add_argument("--gray", type=float, default=0.3, help="grayscale-augment probability (monochrome robustness)")
    p.add_argument("--watch", action="store_true", help="keep retraining as the harvest grows")
    p.add_argument("--interval", type=int, default=600, help="seconds between watch checks")
    p.add_argument("--min-new", type=int, default=20, help="new samples needed to retrain")
    args = p.parse_args()

    last = run_once(args)
    if not args.watch:
        return
    while True:
        time.sleep(args.interval)
        n = len(load_samples(HARVEST))
        if n - last >= args.min_new or (last == 0 and n >= args.min_samples):
            last = run_once(args) or last
        else:
            print(f"{n} samples (+{n - last}) — waiting for +{args.min_new}")


if __name__ == "__main__":
    main()
