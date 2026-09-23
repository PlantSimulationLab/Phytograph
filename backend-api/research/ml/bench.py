"""Score leaf/wood methods on the held-out splits.

    PYTHONPATH=backend-api python -u backend-api/research/ml/bench.py \\
        --cache .../cache --out .../bench/results.json \\
        --package NAME=path/to/package [--package ...] \\
        [--sota] [--gbdt real|joint ...] [--splits test,leafoff,test_synth]

Every method sees the same items (``corpus.py`` splits) at the cache's 5 mm
resolution, and is scored per item and pooled per dataset. Each real item is
scored twice: over every labelled point, and with the 2 cm label-boundary
band excluded (``ml.metrics.boundary_mask``), because hand labels are least
reliable there.

- ``--sota`` is the current shipped method, ``main.segment_wood(method="sota")``.
- ``--gbdt`` trains the boosted-tree baseline on the named source mix first.
- ``--package`` runs a trained model through ``ml.infer.predict``, the app's
  own inference path.
- ``--decimate 0.03`` first thins every item to 3 cm spacing, which is what
  a user's pre-decimated cloud looks like.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from ml.data.cache import open_cache  # noqa: E402
from ml.grid import grid_sample  # noqa: E402
from ml.metrics import boundary_mask, confusion, scores  # noqa: E402
from ml.tasks import TASKS, task_map  # noqa: E402

NAMES = [c["name"] for c in TASKS["wood_leaf"]["classes"]]  # index 0 wood, 1 leaf


def method_sota():
    import main

    def run(xyz):
        labels = main.segment_wood(xyz, method="sota")
        # wood_class values 1 wood / 2 leaf -> output index 0 / 1
        return np.where(labels == main.WOOD_CLASS_WOOD, 0, 1)
    return run


def method_package(path: str, device: str):
    from ml.package import load_meta, load_model
    from ml.infer import predict

    pkg = load_meta(path)
    model = load_model(pkg, device)
    index_of = np.full(256, -1, np.int64)
    for j, c in enumerate(pkg.classes):
        index_of[c["value"]] = j

    def run(xyz):
        return index_of[predict(model, pkg, xyz, device=device, batch_crops=16)]
    return run


def method_gbdt(items, lut, regime: str):
    from gbdt import GBDT

    sel = {"real": lambda m: m["domain"] == "real",
           "synthetic": lambda m: m["domain"] == "synthetic",
           "joint": lambda m: True}[regime]
    train = [it for it in items.values() if it.meta["split"] == "train" and sel(it.meta)]
    t0 = time.time()
    xs = [np.asarray(it.xyz, np.float64) for it in train]
    ys = [lut[np.asarray(it.sem)] for it in train]
    model = GBDT().fit(xs, ys)
    print(f"gbdt[{regime}] trained on {len(train)} items in {time.time() - t0:.0f}s", flush=True)
    return model.predict_index


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--splits", default="test,leafoff,test_synth")
    ap.add_argument("--package", action="append", default=[], help="NAME=path")
    ap.add_argument("--sota", action="store_true")
    ap.add_argument("--gbdt", action="append", default=[], help="real | synthetic | joint")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--only-datasets", default="")
    ap.add_argument("--decimate", type=float, default=0.0,
                    help="grid-decimate every item to this spacing (m) first, to "
                         "measure robustness to sparse, pre-thinned input")
    ap.add_argument("--suffix", default="", help="appended to each method name in the output")
    args = ap.parse_args()

    from ml.device import best_device

    device = best_device(args.device)
    items = open_cache(args.cache)
    lut = task_map("wood_leaf").lut()
    splits = set(args.splits.split(","))
    eval_items = [it for it in items.values() if it.meta["split"] in splits]
    if args.only_datasets:
        keep = set(args.only_datasets.split(","))
        eval_items = [it for it in eval_items if it.meta["dataset"] in keep]
    print(f"{len(eval_items)} evaluation items on {device}", flush=True)

    methods = {}
    if args.sota:
        methods["sota"] = method_sota()
    for regime in args.gbdt:
        methods[f"gbdt_{regime}"] = method_gbdt(items, lut, regime)
    for spec in args.package:
        name, path = spec.split("=", 1)
        methods[name] = method_package(path, device)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    results = json.loads(out_path.read_text()) if out_path.exists() else {}
    for mname, run in methods.items():
        per_item = {}
        pooled = defaultdict(lambda: np.zeros((2, 2), np.int64))
        pooled_core = defaultdict(lambda: np.zeros((2, 2), np.int64))
        for it in eval_items:
            key = f"{it.meta['dataset']}/{it.meta['name']}"
            xyz = np.asarray(it.xyz, np.float64)
            truth = lut[np.asarray(it.sem)]
            if args.decimate > 0:
                keep, _ = grid_sample(xyz, args.decimate)
                xyz, truth = xyz[keep], truth[keep]
            t0 = time.time()
            pred = run(xyz)
            secs = time.time() - t0
            cm = confusion(truth, pred, 2)
            rec = {"split": it.meta["split"], "n_points": len(xyz), "seconds": round(secs, 1),
                   "all": scores(cm, NAMES)}
            group = f"{it.meta['split']}:{it.meta['dataset']}"
            pooled[group] += cm
            if it.meta.get("noisy") and it.meta["split"] != "leafoff":
                core = ~boundary_mask(xyz, truth)
                cmc = confusion(np.where(core, truth, -1), pred, 2)
                rec["core"] = scores(cmc, NAMES)
                pooled_core[group] += cmc
            per_item[key] = rec
            a = rec["all"]
            print(f"{mname:16s} {key:48s} OA {a['oa']:.3f} wIoU {a['iou_wood']:.3f} "
                  f"wF1 {a['f1_wood']:.3f} mIoU {a['miou']:.3f}  {secs:.0f}s", flush=True)
        by_group = {}
        for g in sorted(pooled):
            item_mious = [r["all"]["miou"] for k, r in per_item.items()
                          if f"{r['split']}:{k.split('/')[0]}" == g]
            by_group[g] = {"pooled": scores(pooled[g], NAMES),
                           "mean_item_miou": float(np.nanmean(item_mious)),
                           "n_items": len(item_mious)}
            if g in pooled_core:
                by_group[g]["pooled_core"] = scores(pooled_core[g], NAMES)
        results[mname + args.suffix] = {"items": per_item, "groups": by_group,
                                        "decimate": args.decimate}
        out_path.write_text(json.dumps(results, indent=1) + "\n")
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
