"""Automatic trunk seeds for tree segmentation.

Method specification (with sources): docs/docs/concepts/stem-detection-and-
tiling.md#automatic-stem-seeds. In a 1-2 m height-above-ground layer, trunks
are compact, vertical, circular clusters; cluster the layer on a 5 cm grid,
screen the clusters, and keep those that fit a stem circle twice (lower and
upper half of the layer) about the same axis.

Pure numpy/scipy; the session endpoint in main.py collects the layer.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import List, Optional

import numpy as np

import tree_inventory as ti


@dataclass
class StemSeedParams:
    band_min_m: float = 1.0
    band_max_m: float = 2.0
    cell_m: float = 0.05
    min_points: int = 20
    max_diameter_m: float = 3.0
    n_sublayers: int = 4
    min_sublayers: int = 3
    min_inliers: int = 15
    min_inlier_fraction: float = 0.3
    seed_height_m: float = 1.3

    @classmethod
    def from_dict(cls, d: Optional[dict]) -> "StemSeedParams":
        p = cls()
        for k, v in (d or {}).items():
            if v is not None and hasattr(p, k):
                setattr(p, k, type(getattr(p, k))(v))
        if not (0 <= p.band_min_m < p.band_max_m and p.cell_m > 0 and p.max_diameter_m > 0):
            raise ValueError("stem seed layer must satisfy 0 <= band_min < band_max, cell and diameter > 0")
        if not (1 <= p.min_sublayers <= p.n_sublayers):
            raise ValueError("min_sublayers must be between 1 and n_sublayers")
        return p


def cluster_cells(xy: np.ndarray, cell_m: float) -> np.ndarray:
    """Cluster id per point: points share a cluster when their `cell_m` grid
    cells are connected through touching occupied cells (8-connectivity).

    Sparse: only occupied cells are indexed (a dense raster of a 100 ha plot
    at 5 cm would be 4e8 cells), and neighbors are found by binary search
    on the sorted cell keys, so the cost is O(U log U) in occupied cells."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components

    if len(xy) == 0:
        return np.zeros(0, dtype=np.int64)
    ij = np.floor((xy - xy.min(axis=0)) / cell_m).astype(np.int64)
    ny = int(ij[:, 1].max()) + 3
    key = (ij[:, 0] + 1) * ny + (ij[:, 1] + 1)
    cells, inverse = np.unique(key, return_inverse=True)
    inverse = inverse.reshape(-1)
    rows, cols = [], []
    for dx, dy in ((1, 0), (0, 1), (1, 1), (1, -1)):
        nb = cells + dx * ny + dy
        pos = np.searchsorted(cells, nb)
        pos = np.minimum(pos, len(cells) - 1)
        hit = cells[pos] == nb
        rows.append(np.flatnonzero(hit))
        cols.append(pos[hit])
    r = np.concatenate(rows) if rows else np.zeros(0, np.int64)
    c = np.concatenate(cols) if cols else np.zeros(0, np.int64)
    g = coo_matrix((np.ones(len(r), dtype=np.int8), (r, c)), shape=(len(cells), len(cells)))
    _n, comp = connected_components(g, directed=False)
    return comp[inverse]


def detect_stems(points: np.ndarray, hag: np.ndarray, params: Optional[StemSeedParams] = None,
                 fit_params: Optional[ti.InventoryParams] = None) -> List[dict]:
    """Seeds from the points of the breast-height layer.

    `points` (N, 3) and `hag` (N,) are the candidate layer (the caller may pass
    more; points outside [band_min, band_max] are dropped here). Returns
    [{x, y, z, radius_m, n_inliers, arc_coverage}] with z at `seed_height_m`
    above the ground under the stem, strongest first."""
    p = params or StemSeedParams()
    fp = fit_params or ti.InventoryParams()
    rng = np.random.default_rng(fp.random_seed)
    pts = np.asarray(points, dtype=np.float64)
    h = np.asarray(hag, dtype=np.float64)
    m = np.isfinite(h) & (h >= p.band_min_m) & (h <= p.band_max_m)
    pts, h = pts[m], h[m]
    if len(pts) < p.min_points:
        return []
    comp = cluster_cells(pts[:, :2], p.cell_m)
    order = np.argsort(comp, kind="stable")
    cuts = np.flatnonzero(np.diff(comp[order])) + 1
    band = p.band_max_m - p.band_min_m
    mid = p.band_min_m + band / 2
    found: List[dict] = []
    for grp in np.split(order, cuts):
        if len(grp) < p.min_points:
            continue
        c_pts, c_h = pts[grp], h[grp]
        ext = c_pts[:, :2].max(axis=0) - c_pts[:, :2].min(axis=0)
        if max(ext) > p.max_diameter_m:
            continue
        sub = np.clip(((c_h - p.band_min_m) / band * p.n_sublayers).astype(int), 0, p.n_sublayers - 1)
        if len(np.unique(sub)) < p.min_sublayers:
            continue
        f = ti.fit_stem_circle(c_pts[:, :2], fp, rng)
        if (f is None or "high_residual" in f["flags"] or f["n_inliers"] < p.min_inliers
                or f["n_inliers"] < p.min_inlier_fraction * len(c_pts)):
            continue
        lo, hi = c_h < mid, c_h >= mid
        f_lo = ti.fit_stem_circle(c_pts[lo, :2], fp, rng) if lo.sum() >= 8 else None
        f_hi = ti.fit_stem_circle(c_pts[hi, :2], fp, rng) if hi.sum() >= 8 else None
        if f_lo is None or f_hi is None:
            continue
        r = f["radius"]
        if np.hypot(*(f_lo["center"] - f_hi["center"])) > max(0.10, r):
            continue
        ground = float(np.median(c_pts[:, 2] - c_h))
        found.append({
            "x": float(f["center"][0]), "y": float(f["center"][1]),
            "z": ground + p.seed_height_m, "radius_m": float(r),
            "n_inliers": int(f["n_inliers"]), "arc_coverage": float(f["arc_coverage"]),
        })
    # One seed per trunk: strongest first, drop any seed too close to a kept one.
    found.sort(key=lambda s: -s["n_inliers"])
    kept: List[dict] = []
    for s in found:
        if all(math.hypot(s["x"] - k["x"], s["y"] - k["y"]) >= max(0.30, s["radius_m"] + k["radius_m"])
               for k in kept):
            kept.append(s)
    return kept
