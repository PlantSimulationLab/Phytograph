"""Where does the synthetic-to-real gap of the plant-organ model come from?

    PYTHONPATH=backend-api python -u backend-api/research/ml/organ_gap.py conventions --out ...json
    PYTHONPATH=backend-api python -u backend-api/research/ml/organ_gap.py appearance  --out ...json

Two hypotheses, tested separately because they call for opposite fixes:

**Label conventions** (``conventions``). Hand labellers paint a boundary; the ray tracer knows it.
If humans systematically put the stem/leaf line somewhere else -- a painted stem that runs into
the blade base, a petiolule counted as leaflet -- a model trained on exact synthetic labels is
"wrong" by human standards exactly there, however real its input looks. The signature is errors
concentrated within a few millimetres of human label boundaries, and leaning one way. Both the
real-only and the synthetic-only model are run on the real test plants, and each error is placed
by its distance to the nearest differently labelled point (the human boundary). The real-only
model has learned the human convention, so the part of the synthetic model's excess error that
sits in the boundary band is the convention gap; the part far from any boundary is appearance.
The same pass measures what a "stem" label looks like geometrically on either side (how planar
the neighbourhood of a stem point beside a leaf is: a painted stem that covers blade is planar).

**Appearance** (``appearance``). Local-geometry features (SyntheticLiDAR_Organs' pcmetrics:
surface thickness, planarity, linearity, curvature...) at radii matched to herbaceous organs, per
class, for real and synthetic plants of the same species at the same 2 mm grid the model sees, and
a per-class real-vs-synthetic logistic classifier whose weights name what gives synthetic away.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, "/group/bnbaileygrp/bnbailey/Helios/projects/SyntheticLiDAR_Organs/scripts")

from ml.data.cache import open_cache  # noqa: E402
from ml.data.readers import SEM_BLADE, SEM_GROUND, SEM_STEM  # noqa: E402
from ml.grid import grid_sample  # noqa: E402

ML = Path("/group/bnbaileygrp/bnbailey/phytograph_ml")
CACHE = ML / "cache_organ"
SYN = ML / "organ_data" / "synthetic"
CLASS_OF = {SEM_GROUND: 0, SEM_STEM: 1, SEM_BLADE: 2}
NAMES = ["soil", "stem", "leaf"]


def truth_index(sem: np.ndarray) -> np.ndarray:
    out = np.full(len(sem), -1, np.int64)
    for code, j in CLASS_OF.items():
        out[sem == code] = j
    return out


def boundary_distance(xyz: np.ndarray, truth: np.ndarray, cls_a: int, cls_b: int) -> np.ndarray:
    """For points of class a, distance to the nearest point of class b (inf elsewhere)."""
    out = np.full(len(xyz), np.inf)
    a, b = truth == cls_a, truth == cls_b
    if a.any() and b.any():
        out[a] = cKDTree(xyz[b]).query(xyz[a], k=1)[0]
    return out


def local_planarity(xyz: np.ndarray, queries: np.ndarray, radius: float) -> np.ndarray:
    """(l2 - l3) / l1 of each query's neighbourhood in xyz, NaN below 5 neighbours."""
    tree = cKDTree(xyz)
    out = np.full(len(queries), np.nan)
    for i, nb in enumerate(tree.query_ball_point(queries, radius)):
        if len(nb) < 5:
            continue
        p = xyz[nb] - xyz[nb].mean(axis=0)
        w = np.sort(np.linalg.eigvalsh(p.T @ p / len(nb)))[::-1]
        if w[0] > 0:
            out[i] = (w[1] - w[2]) / w[0]
    return out


def synthetic_items(items: dict, species: set[str], max_spacing: float) -> list:
    """Potted synthetic scenes of the given species scanned no coarser than max_spacing."""
    wanted = {}
    for f in sorted((SYN / "herb_potted").glob("manifest_*.csv")):
        for r in csv.DictReader(open(f)):
            if r["species"] in species:
                wanted[Path(r["cloud_file"]).stem] = r["species"]
    out = []
    for key, it in items.items():
        if not key.startswith("synth_herb_potted/") or it.meta["name"] not in wanted:
            continue
        xyz = np.asarray(it.xyz)
        plant = np.flatnonzero(np.isin(np.asarray(it.sem), (SEM_STEM, SEM_BLADE)))
        if len(plant) < 2000:
            continue
        # Spacing of the plant as scanned (the cache keeps it down to 1 mm): all its points
        # in the tree, a sample of them as queries.
        pts = xyz[plant]
        q = pts[np.random.default_rng(0).choice(len(pts), min(20000, len(pts)), replace=False)]
        s = np.median(cKDTree(pts).query(q, k=2)[0][:, 1])
        if s <= max_spacing:
            out.append((it, wanted[it.meta["name"]]))
    return out


class _Scene:
    """A synthetic scene read straight from its .xyz (not yet cached), shaped like a CachedItem."""

    def __init__(self, path: Path):
        from ml.data.readers import read_helios_herb

        c = read_helios_herb(path)
        keep, _ = grid_sample(c.xyz, 0.001, rng=np.random.default_rng(0))
        self.xyz, self.sem, self.inst = c.xyz[keep], c.sem[keep], c.inst[keep]
        self.meta = {"name": path.stem}


def synthetic_from_dir(directory: Path, species: set[str], max_spacing: float, limit: int = 40) -> list:
    """Like synthetic_items, for a directory of scenes that has not been cached."""
    wanted = {}
    for f in sorted(directory.glob("manifest_*.csv")):
        for r in csv.DictReader(open(f)):
            if r["species"] in species:
                wanted[Path(r["cloud_file"]).stem] = r["species"]
    out = []
    for name, sp in sorted(wanted.items()):
        if len(out) >= limit:
            break
        f = directory / f"{name}.xyz"
        if not f.exists():
            continue
        sc = _Scene(f)
        plant = np.flatnonzero(np.isin(sc.sem, (SEM_STEM, SEM_BLADE)))
        if len(plant) < 2000:
            continue
        pts = sc.xyz[plant]
        q = pts[np.random.default_rng(0).choice(len(pts), min(20000, len(pts)), replace=False)]
        if np.median(cKDTree(pts).query(q, k=2)[0][:, 1]) <= max_spacing:
            out.append((sc, sp))
    return out


def conventions(args):
    from ml.device import best_device
    from ml.infer import predict
    from ml.package import load_meta, load_model

    device = best_device(args.device)
    items = open_cache(CACHE)
    tests = [it for it in items.values() if it.meta["split"] == "test" and it.meta["dataset"] in ("pheno4d_tomato", "demeter_soybean")]
    bands = [0, 0.002, 0.004, 0.008, 0.016, np.inf]
    report = {}
    for spec in args.package:
        name, path = spec.split("=", 1)
        pkg = load_meta(path)
        model = load_model(pkg, device)
        per_ds: dict = {}
        for it in tests:
            xyz = np.asarray(it.xyz, np.float64)
            truth = truth_index(np.asarray(it.sem))
            keep, _ = grid_sample(xyz, 0.002)
            xyz, truth = xyz[keep], truth[keep]
            pred = predict(model, pkg, xyz, device=device, batch_crops=16) - 1
            lab = truth >= 0
            # distance to the nearest differently labelled point = distance to the human boundary
            tree_by = {c: cKDTree(xyz[truth == c]) for c in range(3) if (truth == c).any()}
            dist = np.full(len(xyz), np.inf)
            for c in tree_by:
                for o, t in tree_by.items():
                    if o != c and (truth == c).any():
                        d = t.query(xyz[truth == c], k=1)[0]
                        dist[truth == c] = np.minimum(dist[truth == c], d)
            d = per_ds.setdefault(it.meta["dataset"], {"err": np.zeros(len(bands) - 1), "n": np.zeros(len(bands) - 1),
                                                       "leaf_as_stem_near": [0, 0], "stem_as_leaf_near": [0, 0],
                                                       "leaf_as_stem_far": [0, 0], "stem_as_leaf_far": [0, 0]})
            b = np.digitize(dist, bands) - 1
            wrong = (pred != truth) & lab
            for k in range(len(bands) - 1):
                sel = lab & (b == k)
                d["n"][k] += sel.sum()
                d["err"][k] += (wrong & sel).sum()
            near = dist <= 0.008
            for key, t, p, where in (("leaf_as_stem_near", 2, 1, near), ("stem_as_leaf_near", 1, 2, near),
                                     ("leaf_as_stem_far", 2, 1, ~near), ("stem_as_leaf_far", 1, 2, ~near)):
                sel = (truth == t) & where
                d[key][0] += int((sel & (pred == p)).sum())
                d[key][1] += int(sel.sum())
        out = {}
        for ds, d in per_ds.items():
            n_err = d["err"].sum()
            out[ds] = {"band_edges_mm": [x * 1000 for x in bands[1:-1]],
                       "error_rate_by_band": (d["err"] / np.maximum(d["n"], 1)).tolist(),
                       "share_of_errors_by_band": (d["err"] / max(n_err, 1)).tolist(),
                       "points_by_band": d["n"].tolist(), "errors": int(n_err)}
            for key in ("leaf_as_stem_near", "stem_as_leaf_near", "leaf_as_stem_far", "stem_as_leaf_far"):
                out[ds][key] = d[key][0] / max(d[key][1], 1)
        report[name] = out
        print(name, json.dumps(out, indent=1), flush=True)

    # What a stem label looks like beside a leaf: planarity of the neighbourhood of stem points within
    # 3 mm of a leaf point, and linearity-ish of leaf points within 3 mm of stem. Real (test plants)
    # against exact synthetic labels of the same species.
    geom = {}
    groups = {"real_tomato": [it for it in tests if it.meta["dataset"] == "pheno4d_tomato"],
              "real_soybean": [it for it in tests if it.meta["dataset"] == "demeter_soybean"]}
    syn = synthetic_items(items, {"tomato", "cherrytomato", "soybean"}, 0.0015)
    groups["synth_tomato"] = [it for it, sp in syn if "tomato" in sp][:25]
    groups["synth_soybean"] = [it for it, sp in syn if sp == "soybean"][:25]
    for g, its in groups.items():
        pl_stem, pl_leaf, stem_frac = [], [], []
        for it in its:
            xyz = np.asarray(it.xyz, np.float64)
            truth = truth_index(np.asarray(it.sem))
            keep, _ = grid_sample(xyz, 0.002)
            xyz, truth = xyz[keep], truth[keep]
            plant = (truth == 1) | (truth == 2)
            if plant.sum() < 500:
                continue
            stem_frac.append((truth == 1).sum() / plant.sum())
            ds = boundary_distance(xyz, truth, 1, 2)
            dl = boundary_distance(xyz, truth, 2, 1)
            qs = np.flatnonzero(ds <= 0.003)
            ql = np.flatnonzero(dl <= 0.003)
            rng = np.random.default_rng(0)
            qs = rng.choice(qs, min(len(qs), 1500), replace=False) if len(qs) else qs
            ql = rng.choice(ql, min(len(ql), 1500), replace=False) if len(ql) else ql
            pl_stem.extend(local_planarity(xyz[plant], xyz[qs], 0.006))
            pl_leaf.extend(local_planarity(xyz[plant], xyz[ql], 0.006))
        pl_stem, pl_leaf = np.array(pl_stem), np.array(pl_leaf)
        geom[g] = {"n_plants": len(stem_frac), "stem_share_of_plant_points_median": float(np.median(stem_frac)) if stem_frac else None,
                   "planarity_of_stem_points_beside_leaf_median": float(np.nanmedian(pl_stem)) if len(pl_stem) else None,
                   "planarity_of_leaf_points_beside_stem_median": float(np.nanmedian(pl_leaf)) if len(pl_leaf) else None}
        print(g, geom[g], flush=True)
    report["label_geometry"] = geom
    Path(args.out).write_text(json.dumps(report, indent=1) + "\n")


def appearance(args):
    from pcmetrics.compare import domain_classifier, summarize_feature
    from pcmetrics.features import EIGEN_FEATURE_NAMES, eigen_features

    items = open_cache(CACHE)
    radii = (0.004, 0.008, 0.016)
    rng = np.random.default_rng(0)
    real = {"tomato": [it for it in items.values() if it.meta["dataset"] == "pheno4d_tomato" and it.meta["split"] in ("train", "test")],
            "soybean": [it for it in items.values() if it.meta["dataset"] == "demeter_soybean" and it.meta["split"] in ("train", "test")]}
    if args.synth_dir:
        syn = synthetic_from_dir(Path(args.synth_dir), {"tomato", "cherrytomato", "soybean"}, 0.0015)
    else:
        syn = synthetic_items(items, {"tomato", "cherrytomato", "soybean"}, 0.0015)
    synth = {"tomato": [it for it, sp in syn if "tomato" in sp], "soybean": [it for it, sp in syn if sp == "soybean"]}
    print(f"synthetic scenes: tomato {len(synth['tomato'])}, soybean {len(synth['soybean'])}", flush=True)
    report = {}

    def features_of(its, cls_code, per_item):
        rows = []
        for it in its:
            xyz = np.asarray(it.xyz, np.float64)
            sem = np.asarray(it.sem)
            keep, _ = grid_sample(xyz, 0.002, rng=rng)
            xyz, sem = xyz[keep], sem[keep]
            q = np.flatnonzero(sem == cls_code)
            if len(q) < 50:
                continue
            q = rng.choice(q, min(per_item, len(q)), replace=False)
            cols = []
            for r in radii:
                f = eigen_features(xyz, xyz[q], r, rng=rng)
                cols.append(np.column_stack([f[n] for n in EIGEN_FEATURE_NAMES]))
            rows.append(np.concatenate(cols, axis=1))
        return np.concatenate(rows) if rows else np.empty((0, len(radii) * len(EIGEN_FEATURE_NAMES)))

    names = [f"{n}_r{int(r * 1000)}mm" for r in radii for n in EIGEN_FEATURE_NAMES]
    for sp in ("tomato", "soybean"):
        for cls_name, code in (("stem", SEM_STEM), ("leaf", SEM_BLADE)):
            R = features_of(real[sp], code, 300)
            S = features_of(synth[sp], code, 300)
            per_feature = {}
            for j, n in enumerate(names):
                per_feature[n] = summarize_feature(R[:, j], S[:, j])
            dc = domain_classifier({n: R[:, j] for j, n in enumerate(names)}, {n: S[:, j] for j, n in enumerate(names)}, names, rng=rng)
            wn = lambda kv: kv[1].get("wasserstein_normalized")
            worst = sorted(per_feature.items(), key=lambda kv: -(wn(kv) if wn(kv) == wn(kv) else 0))[:8]
            top_w = sorted(dc["weights"].items(), key=lambda kv: -abs(kv[1]))[:8]
            report[f"{sp}_{cls_name}"] = {"n_real": len(R), "n_synth": len(S), "domain_auc": dc.get("auc"),
                                          "top_weights": dict(top_w),
                                          "worst_features": {k: v for k, v in worst},
                                          "real_median": {n: float(np.nanmedian(R[:, j])) for j, n in enumerate(names)},
                                          "synth_median": {n: float(np.nanmedian(S[:, j])) for j, n in enumerate(names)}}
            print(sp, cls_name, "real", len(R), "synth", len(S), "domain AUC", dc.get("auc"), flush=True)
            for k, v in worst:
                print(f"   {k:32s} W1/IQR {v.get('wasserstein_normalized'):.3f}  AUC {v.get('auc'):.3f}  real med {v.get('real_median'):.4g}  synth med {v.get('synthetic_median'):.4g}", flush=True)
            print("   top classifier weights:", ", ".join(f"{k} {w:+.2f}" for k, w in top_w), flush=True)
    Path(args.out).write_text(json.dumps(report, indent=1, default=float) + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=("conventions", "appearance"))
    ap.add_argument("--out", required=True)
    ap.add_argument("--package", action="append", default=[], help="NAME=path (conventions)")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--synth-dir", default="", help="appearance: read synthetic scenes from this directory instead of the cache")
    args = ap.parse_args()
    {"conventions": conventions, "appearance": appearance}[args.what](args)


if __name__ == "__main__":
    main()
