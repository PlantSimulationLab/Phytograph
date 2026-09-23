"""Segmentation scores from a confusion matrix.

Overall accuracy alone is not a usable score for leaf/wood. Wood is the
minority class, so a leaf-biased classifier scores well on OA while missing
the branches, which is the failure users see. So the headline is per-class
IoU and F1, and model selection uses mean IoU.
"""

from __future__ import annotations

import numpy as np


def confusion(truth_idx: np.ndarray, pred_idx: np.ndarray, n: int) -> np.ndarray:
    """(n, n) counts, rows = truth, columns = prediction. Truth < 0 is ignored."""
    ok = truth_idx >= 0
    return np.bincount(truth_idx[ok] * n + pred_idx[ok], minlength=n * n).reshape(n, n)


def scores(cm: np.ndarray, names: list[str]) -> dict:
    cm = cm.astype(np.float64)
    tp = np.diag(cm)
    fp = cm.sum(axis=0) - tp
    fn = cm.sum(axis=1) - tp
    with np.errstate(invalid="ignore", divide="ignore"):
        iou = tp / (tp + fp + fn)
        f1 = 2 * tp / (2 * tp + fp + fn)
        recall = tp / (tp + fn)
        precision = tp / (tp + fp)
    total = cm.sum()
    out = {"n": int(total), "oa": float(tp.sum() / total) if total else float("nan"),
           "miou": float(np.nanmean(iou))}
    for j, name in enumerate(names):
        key = name.lower()
        out[f"iou_{key}"] = float(iou[j])
        out[f"f1_{key}"] = float(f1[j])
        out[f"recall_{key}"] = float(recall[j])
        out[f"precision_{key}"] = float(precision[j])
    return out


def boundary_mask(xyz: np.ndarray, truth_idx: np.ndarray, radius: float = 0.02) -> np.ndarray:
    """True for points with a differently labelled neighbour within ``radius``.

    Hand labels are least reliable exactly there, so every real-data score is
    also reported with this band excluded. A model that loses points only in
    the band is disagreeing with the labeller, not necessarily with the tree.
    """
    from scipy.spatial import cKDTree

    tree = cKDTree(xyz)
    out = np.zeros(len(xyz), bool)
    step = 500_000
    for s in range(0, len(xyz), step):
        q = xyz[s:s + step]
        _, nb = tree.query(q, k=9, distance_upper_bound=radius, workers=-1)
        valid = nb < len(xyz)
        lab = np.where(valid, truth_idx[np.minimum(nb, len(xyz) - 1)], truth_idx[s:s + step, None])
        out[s:s + step] = (lab != truth_idx[s:s + step, None]).any(axis=1)
    return out
