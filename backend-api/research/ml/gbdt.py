"""The strong classical baseline: gradient-boosted trees on multi-scale
eigen features.

This is the standard non-deep leaf/wood method (Weinmann-style covariance
features at several scales, fed to a boosted classifier). It is here to
answer whether a network is needed at all. If PointNeXt cannot clearly beat
it on held-out real trees, the network is not worth shipping.

It works at the same 1 cm base voxel as the network. Features are computed per
voxel point at k = 10, 20, 40, 80 neighbours:

- linearity, planarity, sphericity
- omnivariance, eigenentropy
- change of curvature
- verticality (1 - |n_z|)
- neighbourhood radius (a density and scale cue)

That is 32 features. Predictions go back to full resolution through the grid
inverse, exactly like ``ml.infer``.
"""

from __future__ import annotations

import numpy as np
from scipy.spatial import cKDTree

from ml.grid import grid_sample

SCALES = (10, 20, 40, 80)
NAMES = [f"{f}_k{k}" for k in SCALES for f in
         ("lin", "pla", "sph", "omni", "entropy", "curv", "vert", "radius")]


def features(xyz: np.ndarray, rows: np.ndarray | None = None, chunk: int = 100_000) -> np.ndarray:
    """(len(rows), 32) float32 multi-scale covariance features of ``xyz[rows]``
    (all points when ``rows`` is None), with neighbourhoods drawn from all of
    ``xyz``."""
    n = len(xyz)
    tree = cKDTree(xyz)
    kmax = min(max(SCALES), n)
    rows = np.arange(n) if rows is None else np.asarray(rows)
    out = np.zeros((len(rows), len(NAMES)), np.float32)
    eps = 1e-12
    for s in range(0, len(rows), chunk):
        q = xyz[rows[s:s + chunk]]
        d, idx = tree.query(q, k=kmax, workers=-1)
        cols = []
        for k in SCALES:
            k = min(k, kmax)
            nb = xyz[idx[:, :k]]
            mu = nb.mean(axis=1, keepdims=True)
            dd = nb - mu
            cov = np.einsum("mki,mkj->mij", dd, dd) / max(k - 1, 1)
            w, v = np.linalg.eigh(cov)
            l3, l2, l1 = [np.clip(w[:, j], eps, None) for j in range(3)]  # l1 >= l2 >= l3
            ssum = l1 + l2 + l3
            a1, a2, a3 = l1 / ssum, l2 / ssum, l3 / ssum
            cols += [(l1 - l2) / l1, (l2 - l3) / l1, l3 / l1,
                     np.cbrt(a1 * a2 * a3),
                     -(a1 * np.log(a1) + a2 * np.log(a2) + a3 * np.log(a3)),
                     a3, 1.0 - np.abs(v[:, 2, 0]), d[:, k - 1]]
        out[s:s + chunk] = np.column_stack(cols).astype(np.float32)
    return np.nan_to_num(out)


def voxelize(xyz: np.ndarray, voxel: float = 0.01):
    keep, inverse = grid_sample(xyz, voxel)
    return keep, inverse


class GBDT:
    def __init__(self, voxel: float = 0.01, **params):
        from sklearn.ensemble import HistGradientBoostingClassifier

        self.voxel = voxel
        self.clf = HistGradientBoostingClassifier(
            max_iter=params.get("max_iter", 400), learning_rate=params.get("learning_rate", 0.1),
            max_leaf_nodes=params.get("max_leaf_nodes", 63), l2_regularization=1.0,
            early_stopping=True, validation_fraction=0.1, random_state=0)

    def fit(self, xs: list[np.ndarray], ys: list[np.ndarray], per_item: int = 60_000, seed: int = 0):
        """``xs``: per-item xyz; ``ys``: per-item output index (-1 = ignore).
        Each item contributes at most ``per_item`` labelled voxels, drawn
        class-balanced, so big items do not dominate and wood is not starved."""
        rng = np.random.default_rng(seed)
        F, Y = [], []
        for xyz, y in zip(xs, ys):
            keep, _ = voxelize(xyz, self.voxel)
            v, yv = xyz[keep], y[keep]
            ok = np.flatnonzero(yv >= 0)
            classes = np.unique(yv[ok])
            take = []
            for c in classes:
                rows = ok[yv[ok] == c]
                take.append(rng.choice(rows, size=min(len(rows), per_item // len(classes)), replace=False))
            take = np.concatenate(take)
            F.append(features(v, take)); Y.append(yv[take])
        self.clf.fit(np.concatenate(F), np.concatenate(Y))
        return self

    def predict_index(self, xyz: np.ndarray) -> np.ndarray:
        keep, inverse = voxelize(xyz, self.voxel)
        pred = self.clf.predict(features(xyz[keep]))
        return pred[inverse]
