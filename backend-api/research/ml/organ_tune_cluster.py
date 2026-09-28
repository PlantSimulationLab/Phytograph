"""Choose the instance-clustering parameters on the VALIDATION plants.

    PYTHONPATH=backend-api python -u backend-api/research/ml/organ_tune_cluster.py \\
        --cache .../cache_organ --package .../runs/<run>/package --out .../bench/cluster_sweep.json

The network runs once per item (votes and radii are saved beside ``--out``),
then every combination of ``alpha`` (bandwidth in instance radii), ``link``
(linking distance in bandwidths) and ``iters`` (mean-shift steps) is scored by
mean item instance F1, per dataset and overall. The test split is never
touched, so the chosen setting can be carried into the benchmark and the app
without having been fitted to the numbers it is judged on.
"""

from __future__ import annotations

import argparse
import itertools
import json
import pickle
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ml.data.cache import open_cache  # noqa: E402
from ml.infer import predict  # noqa: E402
from ml.instances import cluster, match  # noqa: E402
from ml.package import load_meta, load_model  # noqa: E402
from ml.tasks import TASKS  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", required=True)
    ap.add_argument("--package", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--splits", default="val")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--alpha", default="0.3,0.5,0.75,1.0")
    ap.add_argument("--link", default="0.5,1.0")
    ap.add_argument("--iters", default="3,5,10")
    ap.add_argument("--voxel", default="0.003")
    ap.add_argument("--min-area", default="1e-4")
    ap.add_argument("--min-keep", default="3")
    ap.add_argument("--radius-ratio", default="off", help="radius_ratio_min values; 'off' disables the test")
    args = ap.parse_args()

    from ml.device import best_device

    device = best_device(args.device)
    task = TASKS["plant_organ"]
    inst_codes = np.array(task["instance_codes"], np.int64)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    preds_path = out.with_suffix(".preds.pkl")
    if preds_path.exists():
        preds = pickle.loads(preds_path.read_bytes())
    else:
        pkg = load_meta(args.package)
        model = load_model(pkg, device)
        leaf = pkg.classes[task["instance_class"]]["value"]
        items = open_cache(args.cache)
        splits = set(args.splits.split(","))
        preds = {}
        for key, it in items.items():
            if it.meta["split"] not in splits or it.inst is None:
                continue
            xyz = np.asarray(it.xyz, np.float64)
            sem = np.asarray(it.sem)
            truth = np.where(np.isin(sem, inst_codes), np.asarray(it.inst), -1)
            if not (truth >= 0).any():
                continue
            values, off, rad = predict(model, pkg, xyz, device=device, batch_crops=16, return_offsets=True)
            preds[key] = {"xyz": xyz.astype(np.float32), "member": values == leaf, "off": off, "rad": rad,
                          "truth": truth.astype(np.int32),
                          "ignore": np.isin(sem, task.get("instance_ignore_codes", ()))}
            print(f"predicted {key}", flush=True)
        preds_path.write_bytes(pickle.dumps(preds))

    floats = lambda s: [None if x == "off" else float(x) for x in s.split(",")]  # noqa: E731
    grid = list(itertools.product(*[floats(s) for s in (args.alpha, args.link, args.iters, args.voxel,
                                                          args.min_area, args.min_keep, args.radius_ratio)]))
    rows = []
    for alpha, link, iters, voxel, min_area, min_keep, rr in grid:
        per_ds: dict[str, list] = {}
        for key, p in preds.items():
            lab = cluster(p["xyz"], p["off"], p["rad"], p["member"], alpha=alpha, link=link, iters=int(iters),
                          voxel=voxel, min_area=min_area, min_keep_points=int(min_keep),
                          radius_ratio_min=rr)
            m = match(p["truth"], lab, ignore=p["ignore"])
            per_ds.setdefault(key.split("/")[0], []).append((m["f1"], m["mcov"], m["count_error"] / max(m["n_true"], 1)))
        row = {"alpha": alpha, "link": link, "iters": int(iters), "voxel": voxel, "min_area": min_area,
               "min_keep": int(min_keep), "radius_ratio_min": rr}
        for ds, v in sorted(per_ds.items()):
            a = np.array(v)
            row[ds] = {"f1": float(a[:, 0].mean()), "mcov": float(a[:, 1].mean()), "rel_count_err": float(a[:, 2].mean())}
        row["mean_f1"] = float(np.mean([row[ds]["f1"] for ds in per_ds]))
        rows.append(row)
        print(f"alpha {alpha:.2f} link {link:.2f} iters {int(iters):2d} vox {voxel:.4f} area {min_area:.0e} "
              f"keep {int(min_keep)} rr {rr}  mean F1 {row['mean_f1']:.3f}  " +
              "  ".join(f"{ds[:8]} F1 {row[ds]['f1']:.3f} cnt {row[ds]['rel_count_err']:+.2f}" for ds in sorted(per_ds)),
              flush=True)
    rows.sort(key=lambda r: -r["mean_f1"])
    out.write_text(json.dumps({"best": rows[0], "all": rows}, indent=1) + "\n")
    print("best:", json.dumps(rows[0]))


if __name__ == "__main__":
    main()
