#!/usr/bin/env python3
"""Quantitative evaluation of TreeIso individual-tree segmentation.

Runs the vendored TreeIso engine over benchmark point clouds that carry
ground-truth per-tree instance labels and reports the field-standard
instance-level metrics: detection precision / recall / F1 (IoU-matched at a
threshold, default 0.5), coverage (mean IoU of matched trees), and
over/under-segmentation counts.

This is a standalone dev tool — NOT part of the app or its tests. Datasets are
large and CC-BY but not redistributable in-repo, so download them yourself into
`example-datasets/` (gitignored). See that folder's README.

Supported inputs (auto-detected by extension and available fields):
  - .ply  — Cherlet TLS benchmark (Zenodo 14615493): scalar fields `instance`
            (1..N, -1 for ground) and `semantic` (0 ground, 1 tree).
  - .las/.laz — FOR-instance (Zenodo 8287792) and similar: an extra dimension
            named treeID / treeid / instance, plus optional classification.
  - .xyz/.txt — whitespace text, x y z [gt_label]; the 4th column (if present)
            is the ground-truth instance id. Handy for the committed
            self-test fixture.

Usage:
  python backend-api/scripts/eval_tree_segmentation.py PATH [PATH ...]
      [--iou 0.5] [--max-points N] [--reg-strength2 15] [--max-gap 2.0]
      [--ground-ids 0,-1] [--quiet]

PATH may be a file or a directory (globs *.ply/*.las/*.laz/*.xyz within).
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

# Make the vendored TreeIso importable (script lives in backend-api/scripts/).
_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND / "vendor"))


# --------------------------------------------------------------------------- #
# Loaders → (xyz: (N,3) float64, gt: (N,) int64, ground_mask: (N,) bool)
# --------------------------------------------------------------------------- #
def _load_xyz_text(path: Path):
    import pandas as pd

    df = pd.read_csv(path, sep=r"\s+", header=None, comment="#")
    xyz = df.iloc[:, :3].to_numpy(dtype=np.float64)
    gt = df.iloc[:, 3].to_numpy().astype(np.int64) if df.shape[1] > 3 else None
    if gt is None:
        raise ValueError(f"{path.name}: text file has no 4th (label) column to evaluate against")
    return xyz, gt


def _load_ply(path: Path):
    try:
        from plyfile import PlyData
    except ImportError:
        return _load_ply_minimal(path)
    ply = PlyData.read(str(path))
    v = ply["vertex"].data
    names = v.dtype.names
    xyz = np.column_stack([v["x"], v["y"], v["z"]]).astype(np.float64)
    inst_name = next((n for n in ("instance", "treeID", "treeid", "tree_id") if n in names), None)
    if inst_name is None:
        raise ValueError(f"{path.name}: no instance/treeID field in PLY (have: {names})")
    gt = np.asarray(v[inst_name]).astype(np.int64)
    return xyz, gt


def _load_ply_minimal(path: Path):
    """Tiny binary/ascii PLY reader for x,y,z + an instance field, used when
    plyfile isn't installed. Handles the common little-endian binary case."""
    import struct

    with open(path, "rb") as f:
        if f.readline().strip() != b"ply":
            raise ValueError(f"{path.name}: not a PLY file")
        fmt = None
        count = 0
        props = []  # (name, struct_char, np_dtype)
        type_map = {
            "char": ("b", 1), "uchar": ("B", 1), "int8": ("b", 1), "uint8": ("B", 1),
            "short": ("h", 2), "ushort": ("H", 2), "int16": ("h", 2), "uint16": ("H", 2),
            "int": ("i", 4), "uint": ("I", 4), "int32": ("i", 4), "uint32": ("I", 4),
            "float": ("f", 4), "float32": ("f", 4), "double": ("d", 8), "float64": ("d", 8),
        }
        in_vertex = False
        while True:
            line = f.readline().decode("ascii", "replace").strip()
            if line.startswith("format"):
                fmt = line.split()[1]
            elif line.startswith("element"):
                _, name, n = line.split()
                in_vertex = name == "vertex"
                if in_vertex:
                    count = int(n)
            elif line.startswith("property") and in_vertex:
                parts = line.split()
                props.append((parts[2], *type_map[parts[1]]))
            elif line == "end_header":
                break
        if fmt != "binary_little_endian":
            raise ValueError(f"{path.name}: minimal PLY reader supports binary_little_endian only "
                             f"(got {fmt}); pip install plyfile for full support")
        chars = "".join(p[1] for p in props)
        size = sum(p[2] for p in props)
        buf = f.read(count * size)
        arr = np.frombuffer(buf, dtype="<" + chars, count=count)
        cols = {p[0]: arr[f"f{i}"] for i, p in enumerate(props)}
    xyz = np.column_stack([cols["x"], cols["y"], cols["z"]]).astype(np.float64)
    inst_name = next((n for n in ("instance", "treeID", "treeid", "tree_id") if n in cols), None)
    if inst_name is None:
        raise ValueError(f"{path.name}: no instance field (have: {list(cols)})")
    return xyz, np.asarray(cols[inst_name]).astype(np.int64)


def _load_las(path: Path):
    import laspy

    las = laspy.read(str(path))
    xyz = np.column_stack([las.x, las.y, las.z]).astype(np.float64)
    dims = set(las.point_format.dimension_names)
    inst_name = next((n for n in ("treeID", "treeid", "instance", "tree_id", "treeSP") if n in dims), None)
    if inst_name is None:
        raise ValueError(f"{path.name}: no treeID/instance extra dim (have: {sorted(dims)})")
    gt = np.asarray(las[inst_name]).astype(np.int64)
    return xyz, gt


def load(path: Path):
    ext = path.suffix.lower()
    if ext == ".ply":
        return _load_ply(path)
    if ext in (".las", ".laz"):
        return _load_las(path)
    if ext in (".xyz", ".txt", ".csv", ".pts"):
        return _load_xyz_text(path)
    raise ValueError(f"{path.name}: unsupported extension {ext}")


# --------------------------------------------------------------------------- #
# Metrics — IoU-matched instance detection
# --------------------------------------------------------------------------- #
def instance_metrics(pred: np.ndarray, gt: np.ndarray, iou_thresh: float):
    """pred, gt are per-point integer instance ids over the SAME points.
    Returns a dict of detection metrics. Background/0 in pred is ignored as a
    predicted instance but still counts against GT recall (those GT points just
    won't be covered)."""
    gt_ids = [g for g in np.unique(gt) if g > 0]
    pred_ids = [p for p in np.unique(pred) if p > 0]
    n_gt, n_pred = len(gt_ids), len(pred_ids)
    if n_gt == 0:
        return dict(n_gt=0, n_pred=n_pred, tp=0, precision=0.0, recall=0.0, f1=0.0,
                    coverage=0.0, over_seg=0, under_seg=0)

    gt_idx = {g: i for i, g in enumerate(gt_ids)}
    pred_idx = {p: j for j, p in enumerate(pred_ids)}
    gt_sets = [np.where(gt == g)[0] for g in gt_ids]
    pred_sets = [np.where(pred == p)[0] for p in pred_ids]
    gt_size = np.array([len(s) for s in gt_sets])
    pred_size = np.array([len(s) for s in pred_sets])

    # Intersection counts via a single pass over points that are in both a pred
    # and a gt instance.
    inter = np.zeros((n_gt, n_pred), dtype=np.int64)
    mask = (gt > 0) & (pred > 0)
    gi = np.array([gt_idx[g] for g in gt[mask]])
    pj = np.array([pred_idx[p] for p in pred[mask]])
    np.add.at(inter, (gi, pj), 1)

    union = gt_size[:, None] + pred_size[None, :] - inter
    with np.errstate(divide="ignore", invalid="ignore"):
        iou = np.where(union > 0, inter / union, 0.0)

    # Greedy one-to-one matching by descending IoU above threshold.
    tp = 0
    cov_sum = 0.0
    used_gt, used_pred = set(), set()
    pairs = np.argwhere(iou >= iou_thresh)
    order = sorted(pairs.tolist(), key=lambda gp: -iou[gp[0], gp[1]])
    for g, p in order:
        if g in used_gt or p in used_pred:
            continue
        used_gt.add(g); used_pred.add(p)
        tp += 1
        cov_sum += iou[g, p]

    precision = tp / n_pred if n_pred else 0.0
    recall = tp / n_gt if n_gt else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
    coverage = cov_sum / tp if tp else 0.0
    return dict(
        n_gt=n_gt, n_pred=n_pred, tp=tp,
        precision=precision, recall=recall, f1=f1, coverage=coverage,
        over_seg=max(0, n_pred - tp),    # predicted trees with no GT match
        under_seg=max(0, n_gt - tp),     # GT trees left undetected
    )


# --------------------------------------------------------------------------- #
def _voxel_downsample(xyz, gt, res):
    keys = np.floor(xyz / res).astype(np.int64)
    _, idx = np.unique(keys, axis=0, return_index=True)
    idx = np.sort(idx)
    return xyz[idx], gt[idx]


def evaluate_file(path: Path, args) -> dict:
    from treeiso.treeiso_core import segment_trees, TreeIsoParams

    xyz, gt = load(path)
    # Drop ground / unlabelled points so TreeIso (above-ground) is judged fairly.
    ground_ids = set(int(x) for x in args.ground_ids.split(",")) if args.ground_ids else set()
    keep = ~np.isin(gt, list(ground_ids)) if ground_ids else np.ones(len(gt), bool)
    xyz, gt = xyz[keep], gt[keep]
    if args.max_points and len(xyz) > args.max_points:
        # Voxel size that roughly hits the target point budget.
        res = max(0.02, (np.prod(np.ptp(xyz, axis=0)) / args.max_points) ** (1 / 3))
        xyz, gt = _voxel_downsample(xyz, gt, res)

    params = TreeIsoParams(reg_strength2=args.reg_strength2, max_gap=args.max_gap)
    pred = segment_trees(xyz, params)
    m = instance_metrics(pred, gt, args.iou)
    m["file"] = path.name
    m["points"] = len(xyz)
    return m


def _gather(paths):
    exts = (".ply", ".las", ".laz", ".xyz", ".txt", ".pts")
    out = []
    for p in paths:
        p = Path(p)
        if p.is_dir():
            out += sorted(q for q in p.iterdir() if q.suffix.lower() in exts)
        else:
            out.append(p)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="+", help="benchmark file(s) or directory")
    ap.add_argument("--iou", type=float, default=0.5, help="IoU match threshold (default 0.5)")
    ap.add_argument("--max-points", type=int, default=0, help="voxel-downsample above this count (0 = off)")
    ap.add_argument("--reg-strength2", type=float, default=15.0, help="TreeIso lambda2")
    ap.add_argument("--max-gap", type=float, default=2.0, help="TreeIso max intra-tree gap (m)")
    ap.add_argument("--ground-ids", default="0,-1", help="GT ids treated as ground/ignore (comma list)")
    ap.add_argument("--quiet", action="store_true", help="only the summary table")
    args = ap.parse_args(argv)

    files = _gather(args.paths)
    if not files:
        ap.error("no input files found")

    rows = []
    hdr = f"{'file':<28} {'pts':>9} {'GT':>5} {'pred':>5} {'TP':>4} {'P':>6} {'R':>6} {'F1':>6} {'cov':>6} {'over':>5} {'under':>6}"
    print(hdr); print("-" * len(hdr))
    for f in files:
        try:
            m = evaluate_file(f, args)
        except Exception as e:
            print(f"{f.name:<28} ERROR: {e}")
            continue
        rows.append(m)
        print(f"{m['file']:<28} {m['points']:>9} {m['n_gt']:>5} {m['n_pred']:>5} {m['tp']:>4} "
              f"{m['precision']:>6.3f} {m['recall']:>6.3f} {m['f1']:>6.3f} {m['coverage']:>6.3f} "
              f"{m['over_seg']:>5} {m['under_seg']:>6}")

    if len(rows) > 1:
        print("-" * len(hdr))
        agg = lambda k: float(np.mean([r[k] for r in rows]))
        print(f"{'MEAN':<28} {'':>9} {'':>5} {'':>5} {'':>4} "
              f"{agg('precision'):>6.3f} {agg('recall'):>6.3f} {agg('f1'):>6.3f} {agg('coverage'):>6.3f}")
    return 0 if rows else 1


if __name__ == "__main__":
    raise SystemExit(main())
