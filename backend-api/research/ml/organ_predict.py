"""Label a plant scan with a plant-organ model, in PlantCloudFit's input format.

    PYTHONPATH=backend-api python backend-api/research/ml/organ_predict.py \\
        --package .../runs/organ_S_real/package --units mm \\
        IN.txt OUT.txt

``IN`` is an ASCII ``x y z [...]`` table (extra columns are ignored, so a
hand-labeled Pheno4D file works). ``OUT`` is ``x y z label`` in the input's
own units, which is the layout ``LabeledCloud::readASCIICloud`` reads with the
default schema: 0 soil, 1 stem (petioles included), >= 2 one leaflet each.

Leaflet ids are assigned in order of centroid height, lowest first. PlantCloudFit
reads increasing ids as increasing age to find the apex
(``leaf_labels_increase_with_age``); on a single scan the model gives no age,
and height is the proxy that holds for an upright seedling. It is only a proxy:
a drooping old leaf can sit below a younger one.

Leaf points no cluster claimed already take their nearest instance
(``ml.instances.cluster``). Only when a scan yields no instance at all (too
few leaf points to cluster) are its leaf points written as label 1.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ml.infer import predict  # noqa: E402
from ml.instances import cluster  # noqa: E402
from ml.package import load_meta, load_model  # noqa: E402
from ml.tasks import TASKS  # noqa: E402

UNITS = {"m": 1.0, "cm": 0.01, "mm": 0.001}


def label_cloud(xyz_m: np.ndarray, pkg, model, device: str = "cpu", cluster_kw: dict | None = None) -> np.ndarray:
    """PlantCloudFit labels (0 soil, 1 stem, >= 2 leaflet) for points in meters, +z up."""
    task = TASKS[pkg.task]
    values, offsets, radii = predict(model, pkg, xyz_m, device=device, batch_crops=16, return_offsets=True)
    name_of = {c["value"]: c["name"] for c in pkg.classes}
    leaf_value = pkg.classes[task["instance_class"]]["value"]
    inst = cluster(xyz_m, offsets, radii, values == leaf_value, **(cluster_kw or {}))
    out = np.ones(len(xyz_m), np.int64)
    out[np.array([name_of[v] == "Soil" for v in values])] = 0
    ids = np.unique(inst[inst >= 0])
    if len(ids):
        z = np.array([xyz_m[inst == k, 2].mean() for k in ids])
        rank = np.empty(len(ids), np.int64)
        rank[np.argsort(z, kind="stable")] = np.arange(len(ids))
        remap = np.full(int(ids.max()) + 1, -1, np.int64)
        remap[ids] = rank + 2
        has = inst >= 0
        out[has] = remap[inst[has]]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--package", required=True)
    ap.add_argument("--units", default="mm", choices=sorted(UNITS))
    ap.add_argument("--device", default="auto")
    args = ap.parse_args()

    from ml.device import best_device

    device = best_device(args.device)
    df = pd.read_csv(args.input, sep=r"\s+", header=None, comment="#", usecols=[0, 1, 2], dtype=np.float64)
    xyz = df.to_numpy()
    pkg = load_meta(args.package)
    model = load_model(pkg, device)
    t0 = time.time()
    lab = label_cloud(xyz * UNITS[args.units], pkg, model, device)
    ids, counts = np.unique(lab, return_counts=True)
    print(f"{len(xyz):,} points in {time.time() - t0:.0f}s: soil {counts[ids == 0].sum():,}, "
          f"stem {counts[ids == 1].sum():,}, {int((ids >= 2).sum())} leaflets")
    np.savetxt(args.output, np.column_stack([xyz, lab]), fmt=["%.4f", "%.4f", "%.4f", "%d"])


if __name__ == "__main__":
    main()
