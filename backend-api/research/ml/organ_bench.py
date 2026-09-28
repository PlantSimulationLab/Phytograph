"""Score plant-organ models on the held-out plants of the organ corpus.

    PYTHONPATH=backend-api python -u backend-api/research/ml/organ_bench.py \\
        --cache .../cache_organ --out .../bench/organ.json \\
        --package NAME=path/to/package [--package ...] [--splits test] [--decimate 0.005]

Every item is predicted through :func:`ml.infer.predict` (the app's path) at the
cache's 1 mm resolution, or thinned first with ``--decimate``, and scored for:

- **semantics**: soil / stem / leaf IoU where the source draws those lines
  (Pheno4D, Demeter). Sugar4D's leaf is blade and petiole undivided, so it has
  no semantic truth here. Each item is scored over all points and with a 4 mm
  band around label changes removed (``core``), where hand labels are least
  reliable.
- **instances**: leaflet instances from :func:`ml.instances.cluster`, matched
  at IoU > 0.5 (F1), best-IoU coverage per true leaflet (mCov) and the leaflet
  count error. On Sugar4D a true instance includes its petiole while a
  predicted one is blade only, so its mCov is a lower bound, and a predicted
  leaf inside the crown (young leaves the labellers left undivided) is not
  scored.

Results are pooled per ``split:dataset`` and also written per item.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ml.data.cache import open_cache  # noqa: E402
from ml.grid import grid_sample  # noqa: E402
from ml.infer import predict  # noqa: E402
from ml.instances import cluster, match  # noqa: E402
from ml.metrics import boundary_mask, confusion, scores  # noqa: E402
from ml.package import load_meta, load_model  # noqa: E402
from ml.tasks import TASKS, task_map  # noqa: E402

TASK = "plant_organ"


def _nanmean(xs):
    xs = [x for x in xs if x is not None and not math.isnan(x)]
    return float(np.mean(xs)) if xs else float("nan")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--splits", default="test")
    ap.add_argument("--package", action="append", default=[], help="NAME=path")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--only-datasets", default="")
    ap.add_argument("--decimate", type=float, default=0.0)
    ap.add_argument("--cluster", default="{}", help="JSON kwargs for ml.instances.cluster")
    ap.add_argument("--suffix", default="")
    args = ap.parse_args()

    from ml.device import best_device

    device = best_device(args.device)
    task = TASKS[TASK]
    names = [c["name"] for c in task["classes"]]
    n_cls = len(names)
    tm = task_map(TASK)
    lut = tm.lut()
    inst_codes = np.array(task["instance_codes"], np.int64)
    ckw = json.loads(args.cluster)
    items = open_cache(args.cache)
    splits = set(args.splits.split(","))
    eval_items = [it for it in items.values() if it.meta["split"] in splits]
    if args.only_datasets:
        keep = set(args.only_datasets.split(","))
        eval_items = [it for it in eval_items if it.meta["dataset"] in keep]
    print(f"{len(eval_items)} evaluation items on {device}", flush=True)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    results = json.loads(out_path.read_text()) if out_path.exists() else {}
    for spec in args.package:
        mname, path = spec.split("=", 1)
        pkg = load_meta(path)
        model = load_model(pkg, device)
        inst_value = pkg.classes[task["instance_class"]]["value"]
        index_of = np.full(256, -1, np.int64)
        for j, c in enumerate(pkg.classes):
            index_of[c["value"]] = j
        per_item = {}
        pooled = defaultdict(lambda: np.zeros((n_cls, n_cls), np.int64))
        pooled_core = defaultdict(lambda: np.zeros((n_cls, n_cls), np.int64))
        for it in eval_items:
            key = f"{it.meta['dataset']}/{it.meta['name']}"
            group = f"{it.meta['split']}:{it.meta['dataset']}"
            xyz = np.asarray(it.xyz, np.float64)
            sem = np.asarray(it.sem)
            tinst = np.where(np.isin(sem, inst_codes), np.asarray(it.inst), -1) if it.inst is not None else None
            if args.decimate > 0:
                keep, _ = grid_sample(xyz, args.decimate)
                xyz, sem = xyz[keep], sem[keep]
                tinst = None if tinst is None else tinst[keep]
            truth = lut[sem]
            t0 = time.time()
            values, offsets, radii = predict(model, pkg, xyz, device=device, batch_crops=16, return_offsets=True)
            t_pred = time.time() - t0
            pred = index_of[values]
            rec = {"split": it.meta["split"], "n_points": len(xyz), "seconds": round(t_pred, 1)}
            if (truth >= 0).any():
                cm = confusion(truth, pred, n_cls)
                pooled[group] += cm
                rec["all"] = scores(cm, names)
                core = ~boundary_mask(xyz, truth, radius=0.004)
                cmc = confusion(np.where(core, truth, -1), pred, n_cls)
                pooled_core[group] += cmc
                rec["core"] = scores(cmc, names)
            if tinst is not None and (tinst >= 0).any():
                t1 = time.time()
                pinst = cluster(xyz, offsets, radii, values == inst_value, **ckw)
                rec["inst"] = match(tinst, pinst, ignore=np.isin(sem, task.get("instance_ignore_codes", ())))
                rec["inst"]["seconds"] = round(time.time() - t1, 1)
            per_item[key] = rec
            a = rec.get("all", {})
            i = rec.get("inst", {})
            print(f"{mname:14s} {key:40s} mIoU {a.get('miou', float('nan')):.3f} "
                  f"stem {a.get('iou_stem', float('nan')):.3f} leaf {a.get('iou_leaf', float('nan')):.3f} | "
                  f"inst F1 {i.get('f1', float('nan')):.3f} mCov {i.get('mcov', float('nan')):.3f} "
                  f"n {i.get('n_pred', 0)}/{i.get('n_true', 0)}  {t_pred:.0f}s", flush=True)
        by_group = {}
        for g in sorted({f"{r['split']}:{k.split('/')[0]}" for k, r in per_item.items()}):
            rs = [r for k, r in per_item.items() if f"{r['split']}:{k.split('/')[0]}" == g]
            d = {"n_items": len(rs),
                 "mean_item_miou": _nanmean([r.get("all", {}).get("miou") for r in rs]),
                 "mean_item_miou_core": _nanmean([r.get("core", {}).get("miou") for r in rs]),
                 "mean_item_inst_f1": _nanmean([r.get("inst", {}).get("f1") for r in rs]),
                 "mean_item_inst_mcov": _nanmean([r.get("inst", {}).get("mcov") for r in rs]),
                 "mean_abs_count_error": _nanmean([abs(r["inst"]["count_error"]) for r in rs if "inst" in r]),
                 "mean_rel_count_error": _nanmean([r["inst"]["count_error"] / r["inst"]["n_true"]
                                                   for r in rs if "inst" in r and r["inst"]["n_true"]])}
            if g in pooled:
                d["pooled"] = scores(pooled[g], names)
                d["pooled_core"] = scores(pooled_core[g], names)
            by_group[g] = d
            print(f"{mname:14s} {g:28s} " + " ".join(f"{k} {v:.3f}" for k, v in d.items()
                                                     if isinstance(v, float)), flush=True)
        results[mname + args.suffix] = {"items": per_item, "groups": by_group, "decimate": args.decimate,
                                        "cluster": ckw, "package": str(path)}
        out_path.write_text(json.dumps(results, indent=1) + "\n")
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
