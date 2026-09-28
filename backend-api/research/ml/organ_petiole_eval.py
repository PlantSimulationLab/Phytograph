"""Score where each model puts the petiole/blade line on sugar beet, against Sugar4D's measured petioles.

    PYTHONPATH=backend-api python -u backend-api/research/ml/organ_petiole_eval.py \\
        --cache .../cache_organ --out .../bench/beet_petioles.json --package NAME=path [--package ...]

Sugar4D labels a whole beet leaf as one instance, petiole included, so no point is labelled petiole
and the per-point benchmark cannot score the line PlantCloudFit needs. What the dataset does publish
is a template-matched petiole length and total length for every leaf (``leaf_related.csv``). This
script turns a model's per-point prediction into the same quantity:

- the leaf's base is its point nearest the plant's annotated growth point (``growth_points.npy``);
- every point's distance from the base is its position along the leaf (straight-line, so it
  under-reads a curved leaf the same way for prediction and measurement once both are taken as a
  fraction of the leaf's own extent);
- the predicted petiole fraction is how far the predicted stem points reach along the leaf, over
  the leaf's extent (``predicted_fraction``); the measured fraction is petiole / total length.

Reported per model, over the leaves where it predicts a petiole: median absolute error of the
petiole fraction and its correlation with the measurement; and separately the share of leaves with
no predicted petiole, which mixes real misses with petioles hidden under blades in a top-down scan.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ml.data.cache import open_cache  # noqa: E402
from ml.data.readers import SEM_LEAF_WHOLE  # noqa: E402
from ml.infer import predict  # noqa: E402
from ml.package import load_meta, load_model  # noqa: E402
from ml.tasks import TASKS  # noqa: E402

S4 = Path("/group/bnbaileygrp/bnbailey/phytograph_ml/organ_data/Sugar4D/data")


def predicted_fraction(dist: np.ndarray, is_stem: np.ndarray, min_points: int = 10) -> float | None:
    """How far along the leaf the predicted petiole reaches: the 90th percentile of the predicted
    stem points' distance from the base, over the leaf's extent. None when the model predicts no
    petiole on this leaf.

    Not "the first run of mostly-stem distance bins": a neighbouring blade that overlaps a leaf's
    base puts blade points in its first bins, and that rule then scored a clearly found petiole as
    zero (seen in renders of 65_das_plant_002). And "no petiole" is scored separately rather than as
    zero, because Sugar4D is scanned from above and many petioles lie under blades, where no model
    can see them."""
    if is_stem.sum() < min_points or dist.max() <= 0:
        return None
    return float(np.percentile(dist[is_stem], 90) / dist.max())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--package", action="append", default=[], help="NAME=path")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--min-points", type=int, default=200, help="skip leaves smaller than this")
    args = ap.parse_args()

    from ml.device import best_device

    device = best_device(args.device)
    measured = {}
    with open(S4 / "measurements" / "leaf_related.csv") as f:
        for r in csv.DictReader(f):
            key = (int(r["days after sowing"]), int(r["plant"]), int(r["instance id"]))
            total = float(r["total length [cm]"])
            if total > 0:
                measured[key] = float(r["petiole length [cm]"]) / total
    growth = np.load(S4 / "supplements" / "growth_points.npy", allow_pickle=True).item()

    items = [it for it in open_cache(args.cache).values() if it.meta["dataset"] == "sugar4d" and it.meta["split"] == "test"]
    results = {}
    for spec in args.package:
        name, path = spec.split("=", 1)
        pkg = load_meta(path)
        model = load_model(pkg, device)
        stem_value = pkg.classes[1]["value"]
        assert pkg.classes[1]["name"] == "Stem" and pkg.task == "plant_organ"
        pred_f, meas_f, no_stem, n_leaves = [], [], 0, 0
        for it in items:
            das, plant = int(it.meta["name"].split("_")[0]), int(it.meta["name"].split("_")[-1])
            xyz = np.asarray(it.xyz, np.float64)
            sem, inst = np.asarray(it.sem), np.asarray(it.inst)
            gp = np.asarray(growth[f"plant_{plant:03d}"], np.float64) - np.asarray(it.meta["origin"])
            values = predict(model, pkg, xyz, device=device, batch_crops=16)
            for k in np.unique(inst[(sem == SEM_LEAF_WHOLE) & (inst >= 0)]):
                key = (das, plant, int(k))
                sel = (inst == k) & (sem == SEM_LEAF_WHOLE)
                if key not in measured or sel.sum() < args.min_points:
                    continue
                p = xyz[sel]
                base = p[np.argmin(((p - gp) ** 2).sum(axis=1))]
                d = np.linalg.norm(p - base, axis=1)
                is_stem = values[sel] == stem_value
                f = predicted_fraction(d, is_stem)
                n_leaves += 1
                if f is None:
                    no_stem += 1
                    continue
                pred_f.append(f)
                meas_f.append(measured[key])
        pred_f, meas_f = np.array(pred_f), np.array(meas_f)
        err = np.abs(pred_f - meas_f)
        results[name] = {"n_leaves": n_leaves, "n_with_petiole": int(len(pred_f)), "median_abs_error": float(np.median(err)),
                         "mean_abs_error": float(err.mean()), "r": float(np.corrcoef(pred_f, meas_f)[0, 1]),
                         "median_pred_fraction": float(np.median(pred_f)), "median_measured_fraction": float(np.median(meas_f)),
                         "share_no_stem": no_stem / max(n_leaves, 1)}
        print(name, json.dumps(results[name]), flush=True)
    Path(args.out).write_text(json.dumps(results, indent=1) + "\n")


if __name__ == "__main__":
    main()
