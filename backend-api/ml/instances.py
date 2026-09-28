"""Organ instances from centroid votes, and how instance results are scored.

A model with an offset head (``ml.models.pointnext``) predicts, for every
point, the metric vector to the centroid of the organ it belongs to. Shifting
each leaf point by its vote collapses one leaflet's points onto a tight blob
while a neighbouring leaflet's collapse onto another, even where the two
blades touch. Clustering the SHIFTED points is therefore easy where clustering
the points themselves is not.

:func:`cluster` does it in two steps. Organs here range from a 5 mm tomato
cotyledon to a 30 cm beet leaf, so neither step can use one fixed distance:
each vote carries a bandwidth proportional to the instance radius the network
predicts along with it (``alpha`` x radius, clipped to ``[h_min, h_max]``).

1. **Mean shift.** Real votes scatter (a crop rim, an ambiguous junction), and
   single-linkage on scattered votes chains neighbouring leaflets together:
   with 3 mm of vote noise a soybean trifoliate's three blobs merged into one.
   A few flat-kernel mean-shift iterations pull every vote to its blob's mode
   first. Votes are summarised as cell means on a grid half their own
   bandwidth (one grid per octave of bandwidth), so a kernel sums over at most
   a few dozen cells however large the organ or however tight its blob.
2. **Linking.** Two cells join when their means are closer than ``link`` x the
   smaller of their bandwidths; connected cells are one instance, and one with
   less than ``min_area`` of surface is dropped. A member point left unclaimed
   takes the instance of its nearest claimed point in the ORIGINAL cloud, so
   it joins the blade it is physically on, not the one its bad vote pointed at.
"""

from __future__ import annotations

import numpy as np
from scipy.spatial import cKDTree

def _cells(v: np.ndarray, h: np.ndarray, h_min: float):
    """Group votes into cells: one grid per octave of bandwidth, cell edge a
    half that octave's bandwidth. Returns (inverse, means, counts,
    cell bandwidths)."""
    band = np.floor(np.log2(h / h_min)).astype(np.int64)
    edge = h_min * np.exp2(band) / 2
    q = np.floor(v / edge[:, None]).astype(np.int64)
    _, inv, cnt = np.unique(np.column_stack([band, q]), axis=0, return_inverse=True, return_counts=True)
    inv = inv.reshape(-1)
    n = len(cnt)
    means = np.stack([np.bincount(inv, weights=v[:, j], minlength=n) for j in range(3)], axis=1) / cnt[:, None]
    hc = np.bincount(inv, weights=h, minlength=n) / cnt
    return inv, means, cnt, hc


def _ball_pairs(means: np.ndarray, r: np.ndarray):
    """(owner, neighbour) index pairs with |means[n] - means[o]| <= r[o]."""
    tree = cKDTree(means)
    nbrs = tree.query_ball_point(means, r)
    lens = np.fromiter((len(x) for x in nbrs), np.int64, len(nbrs))
    owner = np.repeat(np.arange(len(means)), lens)
    other = np.concatenate([np.asarray(x, np.int64) for x in nbrs]) if len(nbrs) else np.empty(0, np.int64)
    return owner, other


def _radius_ratio(xyz: np.ndarray, radii: np.ndarray, comp: np.ndarray, ids: np.ndarray) -> np.ndarray:
    """Per cluster id: its measured RMS radius over the median radius its
    members predicted. A whole small organ measures about what it predicts; a
    fragment of a large one measures far less, because the network still
    predicts the large organ's radius on it."""
    pos = np.searchsorted(ids, comp)
    n = np.maximum(np.bincount(pos, minlength=len(ids)), 1)
    c = np.stack([np.bincount(pos, weights=xyz[:, j], minlength=len(ids)) for j in range(3)], 1) / n[:, None]
    rms = np.sqrt(np.bincount(pos, weights=((xyz - c[pos]) ** 2).sum(1), minlength=len(ids)) / n)
    order = np.argsort(pos, kind="stable")
    split = np.split(radii[order], np.cumsum(np.bincount(pos, minlength=len(ids)))[:-1])
    med = np.array([np.median(x) if len(x) else np.inf for x in split])
    return rms / np.maximum(med, 1e-9)


def cluster(xyz: np.ndarray, offsets: np.ndarray, radii: np.ndarray, is_member: np.ndarray,
            alpha: float = 0.75, link: float = 0.5, h_min: float = 0.0015, h_max: float = 0.05,
            iters: int = 5, min_area: float = 1e-4, voxel: float = 0.003,
            radius_ratio_min: float | None = None, min_keep_points: int = 3) -> np.ndarray:
    """Instance id per point (``-1`` for points that are not members, or that
    no cluster claimed). ``is_member`` selects the points that belong to some
    instance (predicted leaf); ``offsets`` (N, 3) and ``radii`` (N,) are the
    offset head's outputs. Ids are 0..K-1, largest instance first.

    ``alpha``, ``link`` and ``iters`` were chosen on the organ corpus's
    VALIDATION plants (``research/ml/organ_tune_cluster.py``): 0.75 / 0.5 / 5
    scored a mean leaflet F1 of 0.88 against 0.80 for 0.5 / 0.5 / 5. Smaller
    bandwidths split beet leaves; larger ones merge soybean trifoliates.

    An instance needs ``min_area`` (m^2; 1 cm^2, also chosen on validation)
    of surface, counted in points at the cloud's own spacing rather than as a
    fixed point count: 20 points is a speck at 1 mm and a whole tomato leaflet
    at 5 mm, where a fixed count dropped 60 % of the leaflets.

    ``radius_ratio_min`` (None = off) rescues a cluster below ``min_area``
    whose measured RMS radius is at least that fraction of the median radius
    its members predicted: a whole small leaflet measures about what the
    network predicts for it, while a fragment of a large leaflet measures far
    less, because the network still predicts the large leaflet's radius on it.
    On the validation plants the ratio separates the two well (small clusters
    at >= 0.9 matched a true leaflet 120 times in 134; below 0.7, 5 in 115).
    It is off by default because it did not close the gap it was built for.
    With perfect votes the ``min_area`` floor costs tomato most leaflets under
    15 mm, but with the model's own votes, over three seeds, rescuing them
    and raising the floor to 4e-4 moved mean validation F1 only 0.884 ->
    0.888: beet +0.035 (the higher floor removes its fragments), tomato
    -0.029. Tomato's small leaflets are limited by vote quality, not by the
    floor. Clusters need ``min_keep_points`` representatives to be rescued.

    The votes are clustered at one representative per ``voxel`` of the
    original cloud and every other point takes its representative's instance:
    finer than any organ, and it bounds the cost on a dense scan."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components

    xyz = np.asarray(xyz, np.float64)
    out = np.full(len(xyz), -1, np.int64)
    members = np.flatnonzero(is_member)
    if len(members) < 3:
        return out
    rep_inverse = None
    rows = members
    if voxel > 0:
        from .grid import grid_sample
        keep, rep_inverse = grid_sample(xyz[members], voxel)
        rows = members[keep]
    # Point spacing of what is clustered: the median nearest-neighbour gap,
    # but never below the sampling voxel. One representative per voxel covers
    # about voxel^2 of surface wherever it sits in the voxel, while two
    # representatives either side of a voxel face can be a fraction of a
    # millimetre apart: on a 0.07 mm Pheno4D scan the median gap between 3 mm
    # representatives was 0.66 mm, and the area threshold then asked a
    # seedling's 83 representatives for 46 per leaflet.
    spacing = voxel
    if len(rows) > 1:
        d, _ = cKDTree(xyz[rows]).query(xyz[rows], k=2)
        spacing = max(voxel, float(np.median(d[:, 1])))
    spacing = spacing or 0.001
    min_points = max(3, int(round(min_area / max(spacing, 1e-4) ** 2)))
    v = xyz[rows] + np.asarray(offsets, np.float64)[rows]
    h = np.clip(alpha * np.asarray(radii, np.float64)[rows], h_min, h_max)
    for _ in range(iters):
        inv, means, cnt, hc = _cells(v, h, h_min)
        owner, other = _ball_pairs(means, hc)
        w = cnt[other].astype(np.float64)
        wsum = np.bincount(owner, weights=w, minlength=len(means))
        new = np.stack([np.bincount(owner, weights=w * means[other, j], minlength=len(means))
                        for j in range(3)], axis=1) / wsum[:, None]
        v = v + (new - means)[inv]
    inv, means, cnt, hc = _cells(v, h, h_min)
    owner, other = _ball_pairs(means, link * hc)
    d = np.linalg.norm(means[owner] - means[other], axis=1)
    ok = d <= link * np.minimum(hc[owner], hc[other])
    g = coo_matrix((np.ones(int(ok.sum()), np.int8), (owner[ok], other[ok])), shape=(len(means),) * 2)
    comp = connected_components(g, directed=False)[1][inv]
    # Drop instances with too few votes (unless rescued), then renumber by size.
    ids, sizes = np.unique(comp, return_counts=True)
    keep = sizes >= min_points
    small = (~keep) & (sizes >= min_keep_points)
    if radius_ratio_min is not None and small.any():
        ratio = _radius_ratio(xyz[rows], np.asarray(radii, np.float64)[rows], comp, ids)
        keep = keep | (small & (ratio >= radius_ratio_min))
    order = ids[keep][np.argsort(-sizes[keep], kind="stable")]
    remap = np.full(int(comp.max()) + 1, -1, np.int64)
    remap[order] = np.arange(len(order))
    lab = remap[comp]
    # Unclaimed members join the instance of their nearest claimed neighbour.
    claimed = lab >= 0
    if claimed.any() and (~claimed).any():
        _, nb = cKDTree(xyz[rows[claimed]]).query(xyz[rows[~claimed]], k=1)
        lab[~claimed] = lab[claimed][nb]
    out[members] = lab[rep_inverse] if rep_inverse is not None else lab
    return out


def match(truth: np.ndarray, pred: np.ndarray, iou_threshold: float = 0.5,
          ignore: np.ndarray | None = None) -> dict:
    """Score predicted instances against true ones (both per-point ids, ``-1``
    = none). A pair matches when its IoU exceeds ``iou_threshold`` (above 0.5
    a match is necessarily unique). Returns precision, recall, F1 and the
    counts, plus mean coverage (each true instance's best IoU, averaged): the
    F1 says whether the leaflets were found, coverage how well.

    ``ignore`` marks points whose instances the labeller did not draw (Sugar4D's
    crown holds leaves too young to separate). A predicted instance with most
    of its points there is neither right nor wrong, so it is dropped before
    scoring; otherwise every young leaf the model finds would count against it."""
    truth = np.asarray(truth, np.int64)
    pred = np.asarray(pred, np.int64)
    if ignore is not None and ignore.any():
        ids, inv = np.unique(pred, return_inverse=True)
        inv = inv.reshape(-1)
        frac = np.bincount(inv, weights=ignore.astype(np.float64), minlength=len(ids)) / np.bincount(inv)
        dropped = (ids >= 0) & (frac > 0.5)
        pred = np.where(dropped[inv], -1, pred)
    t_ids, t_inv = np.unique(truth, return_inverse=True)
    p_ids, p_inv = np.unique(pred, return_inverse=True)
    t_inv, p_inv = t_inv.reshape(-1), p_inv.reshape(-1)
    t_sizes = np.bincount(t_inv, minlength=len(t_ids))
    p_sizes = np.bincount(p_inv, minlength=len(p_ids))
    both = (truth >= 0) & (pred >= 0)
    pair = t_inv[both] * len(p_ids) + p_inv[both]
    keys, inter = np.unique(pair, return_counts=True)
    ti, pi = keys // len(p_ids), keys % len(p_ids)
    iou = inter / (t_sizes[ti] + p_sizes[pi] - inter)
    t_real = t_ids >= 0
    p_real = p_ids >= 0
    n_true, n_pred = int(t_real.sum()), int(p_real.sum())
    tp = int((iou > iou_threshold).sum())
    best = np.zeros(len(t_ids))
    np.maximum.at(best, ti, iou)
    prec = tp / n_pred if n_pred else float("nan")
    rec = tp / n_true if n_true else float("nan")
    f1 = 2 * tp / (n_true + n_pred) if n_true + n_pred else float("nan")
    return {"n_true": n_true, "n_pred": n_pred, "tp": tp, "precision": prec, "recall": rec, "f1": f1,
            "mcov": float(best[t_real].mean()) if n_true else float("nan"),
            "count_error": n_pred - n_true}
