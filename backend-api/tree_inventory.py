"""Per-tree forest inventory measurements, as pure functions over numpy arrays.

The method specification - every definition, algorithm and default threshold,
each with the published source it follows - is the user-facing concept page
`docs/docs/concepts/tree-inventory.md`. Keep the two in step: a default changed
here without the page is a documented number that is no longer true.

Layout:

  * circle fitting - `circle_through_3_points`, `fit_circle_taubin`,
    `fit_circle_geometric`, the two robust searches `ransac_circle` /
    `rht_circle`, and `fit_stem_circle`, which chains search -> Taubin ->
    geometric and reports the quality evidence (`arc_stats`);
  * ground models - `HagGround` (per-point height above ground), `GroundGrid`
    (ground-labelled points on a coarse grid), `MinZGround` (last resort);
  * `measure_tree`, which turns one tree's points into one tree-list row plus
    its stem curve.

Nothing here reads a session, a file or a lock; `main.py`'s tree-inventory
endpoint streams one tree at a time out of the session store and calls
`measure_tree` on it.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field, asdict
from typing import Callable, Dict, List, Optional, Tuple

import numpy as np

# Angular sectors used for arc coverage (10 degrees each).
N_ARC_SECTORS = 36


@dataclass
class InventoryParams:
    """Tunable defaults. Each is documented, with its source, on the concept page."""
    breast_height_m: float = 1.3
    slice_thickness_m: float = 0.10
    # Breast-height slice widening when the 0.10 m slice is too sparse.
    slice_widen_m: Tuple[float, ...] = (0.20, 0.30)
    fit_method: str = "ransac"          # 'ransac' | 'hough'
    inlier_distance_m: float = 0.02
    min_radius_m: float = 0.02
    max_radius_m: float = 1.5
    # Minimum inliers for a fit to be trusted (the `few_points` flag), and the
    # minimum slice size to attempt a fit at all.
    min_inliers: int = 20
    min_slice_points: int = 8
    partial_arc_coverage: float = 0.5
    # Horizontal pass (axis finding).
    seed_min_m: float = 0.5
    seed_max_m: float = 2.5
    seed_step_m: float = 0.25
    lean_fit_max_m: float = 4.0
    # Perpendicular pass (reported stem curve).
    stem_curve_start_m: float = 0.5
    stem_curve_step_m: float = 0.5
    max_consecutive_failures: int = 2
    # Crown.
    crown_bin_m: float = 0.2
    crown_gap_m: float = 1.0
    crown_occupancy_frac: float = 0.05
    voxel_size_m: float = 0.10
    random_seed: int = 0

    @classmethod
    def from_dict(cls, d: Optional[dict]) -> "InventoryParams":
        p = cls()
        for k, v in (d or {}).items():
            if v is None or not hasattr(p, k):
                continue
            current = getattr(p, k)
            setattr(p, k, tuple(float(x) for x in v) if isinstance(current, tuple) else type(current)(v))
        if p.fit_method not in ("ransac", "hough"):
            raise ValueError(f"unknown fit method {p.fit_method!r} (expected 'ransac' or 'hough')")
        lengths = ("breast_height_m", "slice_thickness_m", "voxel_size_m", "inlier_distance_m",
                   "stem_curve_step_m", "crown_gap_m", "crown_bin_m", "seed_step_m",
                   "min_radius_m", "max_radius_m")
        bad = [k for k in lengths if not (getattr(p, k) > 0 and math.isfinite(getattr(p, k)))]
        if bad:
            raise ValueError(f"inventory lengths must be positive: {', '.join(bad)}")
        if not (0 <= p.crown_occupancy_frac <= 1 and 0 < p.partial_arc_coverage <= 1):
            raise ValueError("inventory fractions must lie in [0, 1]")
        if p.min_radius_m >= p.max_radius_m:
            raise ValueError("min_radius_m must be below max_radius_m")
        return p

    def to_dict(self) -> dict:
        d = asdict(self)
        d["slice_widen_m"] = list(self.slice_widen_m)
        return d


# ==================== circle fitting ====================

def circle_through_3_points(points: np.ndarray):
    """The circle through exactly 3 points, as (center (2,), radius), or
    (None, None) when there are not 3 points or they are collinear."""
    if len(points) != 3:
        return None, None
    (ax, ay), (bx, by), (cx, cy) = np.asarray(points, dtype=np.float64)
    d = 2.0 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if abs(d) < 1e-12:
        return None, None
    a2, b2, c2 = ax * ax + ay * ay, bx * bx + by * by, cx * cx + cy * cy
    ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d
    uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d
    center = np.array([ux, uy])
    return center, float(np.hypot(ax - ux, ay - uy))


def _circles_through_triples(p: np.ndarray, tri: np.ndarray):
    """Vectorised `circle_through_3_points` over index triples `tri` (K,3).
    Returns (cx, cy, r, valid)."""
    a, b, c = p[tri[:, 0]], p[tri[:, 1]], p[tri[:, 2]]
    ax, ay, bx, by, cx, cy = a[:, 0], a[:, 1], b[:, 0], b[:, 1], c[:, 0], c[:, 1]
    d = 2.0 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    valid = np.abs(d) > 1e-12
    d = np.where(valid, d, 1.0)
    a2, b2, c2 = ax * ax + ay * ay, bx * bx + by * by, cx * cx + cy * cy
    ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d
    uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d
    r = np.hypot(ax - ux, ay - uy)
    return ux, uy, r, valid


def fit_circle_taubin(points: np.ndarray):
    """Taubin's algebraic circle fit (Taubin 1991), in the SVD form given by
    Chernov (2010). Returns (center (2,), radius) or (None, None).

    Nearly free of the short-arc radius bias of the Kasa fit (Al-Sharadqah &
    Chernov 2009), which is why it seeds the geometric fit."""
    p = np.asarray(points, dtype=np.float64)
    if len(p) < 3:
        return None, None
    centroid = p.mean(axis=0)
    x = p[:, 0] - centroid[0]
    y = p[:, 1] - centroid[1]
    z = x * x + y * y
    zmean = float(z.mean())
    if not zmean > 0:
        return None, None
    z0 = (z - zmean) / (2.0 * math.sqrt(zmean))
    try:
        _u, _s, vt = np.linalg.svd(np.column_stack([z0, x, y]), full_matrices=False)
    except np.linalg.LinAlgError:
        return None, None
    a = vt[-1].copy()
    a0 = a[0] / (2.0 * math.sqrt(zmean))
    if abs(a0) < 1e-15:
        return None, None  # a line, not a circle
    a3 = -zmean * a0
    center = np.array([-a[1] / (2.0 * a0), -a[2] / (2.0 * a0)]) + centroid
    disc = a[1] * a[1] + a[2] * a[2] - 4.0 * a0 * a3
    if disc <= 0:
        return None, None
    return center, float(math.sqrt(disc) / (2.0 * abs(a0)))


def fit_circle_geometric(points: np.ndarray, center0, radius0, max_nfev: int = 200):
    """Geometric (orthogonal-distance) circle fit: minimise
    sum((|p - c| - r)^2) by Levenberg-Marquardt from (center0, radius0)
    (Chernov & Lesort 2005). Returns (center (2,), radius, rms) or
    (None, None, None)."""
    from scipy.optimize import least_squares

    p = np.asarray(points, dtype=np.float64)
    if len(p) < 3 or center0 is None or radius0 is None:
        return None, None, None
    # Work about the data centroid: world coordinates are large, and the
    # Jacobian is better conditioned near the origin.
    off = p.mean(axis=0)
    q = p - off

    def resid(v):
        return np.hypot(q[:, 0] - v[0], q[:, 1] - v[1]) - v[2]

    def jac(v):
        dx, dy = q[:, 0] - v[0], q[:, 1] - v[1]
        d = np.maximum(np.hypot(dx, dy), 1e-12)
        return np.column_stack([-dx / d, -dy / d, -np.ones_like(d)])

    x0 = [center0[0] - off[0], center0[1] - off[1], radius0]
    try:
        res = least_squares(resid, x0, jac=jac, method="lm", max_nfev=max_nfev)
    except Exception:
        return None, None, None
    cx, cy, r = res.x
    if not (np.isfinite(cx) and np.isfinite(cy) and np.isfinite(r)):
        return None, None, None
    rms = float(np.sqrt(np.mean(res.fun ** 2)))
    return np.array([cx, cy]) + off, float(abs(r)), rms


def _sample_triples(rng: np.random.Generator, n: int, k: int) -> np.ndarray:
    """k random index triples with three distinct members."""
    tri = rng.integers(0, n, size=(k, 3))
    ok = (tri[:, 0] != tri[:, 1]) & (tri[:, 1] != tri[:, 2]) & (tri[:, 0] != tri[:, 2])
    return tri[ok]


def ransac_circle(points: np.ndarray, *, threshold: float, rng: np.random.Generator,
                  min_radius: float, max_radius: float, max_trials: int = 2000,
                  confidence: float = 0.99, batch: int = 128) -> Optional[np.ndarray]:
    """RANSAC circle search (Fischler & Bolles 1981): minimal 3-point circles,
    scored by inlier count; the trial budget adapts to the best inlier ratio w
    as N = log(1 - confidence) / log(1 - w^3). Returns the best inlier mask, or
    None when no admissible circle was found."""
    p = np.asarray(points, dtype=np.float64)
    n = len(p)
    if n < 3:
        return None
    best_count, best = 0, None
    needed, done = max_trials, 0
    while done < min(needed, max_trials):
        tri = _sample_triples(rng, n, batch)
        done += batch
        if len(tri) == 0:
            continue
        ux, uy, r, valid = _circles_through_triples(p, tri)
        valid &= (r >= min_radius) & (r <= max_radius)
        if not valid.any():
            continue
        ux, uy, r = ux[valid], uy[valid], r[valid]
        dist = np.abs(np.hypot(p[None, :, 0] - ux[:, None], p[None, :, 1] - uy[:, None]) - r[:, None])
        counts = (dist < threshold).sum(axis=1)
        k = int(np.argmax(counts))
        if counts[k] > best_count:
            best_count = int(counts[k])
            best = dist[k] < threshold
            w = best_count / n
            if w >= 1.0:
                break
            denom = math.log(max(1e-12, 1.0 - w ** 3))
            needed = int(math.ceil(math.log(1.0 - confidence) / denom)) if denom < 0 else max_trials
    return best if best_count >= 3 else None


def rht_circle(points: np.ndarray, *, threshold: float, rng: np.random.Generator,
               min_radius: float, max_radius: float, n_samples: int = 2000,
               cell: Optional[float] = None) -> Optional[np.ndarray]:
    """Randomized Hough transform (Xu, Oja & Kultanen 1990): each random point
    triple maps to ONE parameter point (a, b, r), which votes for its cell in a
    sparse accumulator; the fullest cell's mean parameters are the candidate,
    and its inliers are returned (or None)."""
    p = np.asarray(points, dtype=np.float64)
    n = len(p)
    if n < 3:
        return None
    cell = float(cell) if cell else max(0.01, threshold / 2.0)
    tri = _sample_triples(rng, n, n_samples)
    if len(tri) == 0:
        return None
    ux, uy, r, valid = _circles_through_triples(p, tri)
    valid &= (r >= min_radius) & (r <= max_radius)
    if not valid.any():
        return None
    params = np.column_stack([ux[valid], uy[valid], r[valid]])
    keys = np.floor(params / cell).astype(np.int64)
    uniq, inverse, counts = np.unique(keys, axis=0, return_inverse=True, return_counts=True)
    inverse = inverse.reshape(-1)
    best = int(np.argmax(counts))
    if counts[best] < 2:
        return None
    a, b, rad = params[inverse == best].mean(axis=0)
    mask = np.abs(np.hypot(p[:, 0] - a, p[:, 1] - b) - rad) < threshold
    return mask if mask.sum() >= 3 else None


def arc_stats(points: np.ndarray, center, n_sectors: int = N_ARC_SECTORS) -> Tuple[float, float]:
    """(arc_coverage, max_gap_deg) of `points` around `center`: the fraction of
    `n_sectors` equal angular sectors holding at least one point, and the
    largest empty angular gap between consecutive points, in degrees."""
    p = np.asarray(points, dtype=np.float64)
    if len(p) == 0:
        return 0.0, 360.0
    ang = np.arctan2(p[:, 1] - center[1], p[:, 0] - center[0])
    sectors = np.floor((ang + math.pi) / (2 * math.pi) * n_sectors).astype(int) % n_sectors
    coverage = len(np.unique(sectors)) / float(n_sectors)
    a = np.sort(ang)
    gaps = np.diff(np.concatenate([a, [a[0] + 2 * math.pi]]))
    return float(coverage), float(np.degrees(gaps.max()))


# Search-stage subsample cap: the robust search scores every candidate against
# every point, so a very dense slice is subsampled for the SEARCH only; inliers
# and the precise fits always use the whole slice.
_SEARCH_MAX_POINTS = 4000


def fit_stem_circle(points2d: np.ndarray, params: InventoryParams,
                    rng: np.random.Generator) -> Optional[dict]:
    """Robust search (RANSAC or RHT) -> Taubin on the inliers -> geometric fit,
    inliers recomputed and the geometric fit repeated once. Returns
    {center, radius, rms_m, arc_coverage, max_gap_deg, n_points, n_inliers,
    flags} or None when no circle could be fitted."""
    p = np.asarray(points2d, dtype=np.float64)
    n = len(p)
    if n < max(3, params.min_slice_points):
        return None
    off = p.mean(axis=0)
    q = p - off
    search = q
    if n > _SEARCH_MAX_POINTS:
        search = q[rng.choice(n, _SEARCH_MAX_POINTS, replace=False)]
    kw = dict(threshold=params.inlier_distance_m, rng=rng,
              min_radius=params.min_radius_m, max_radius=params.max_radius_m)
    mask_s = ransac_circle(search, **kw) if params.fit_method == "ransac" else rht_circle(search, **kw)
    if mask_s is None:
        return None
    c0, r0 = fit_circle_taubin(search[mask_s])
    if c0 is None:
        c0, r0 = circle_through_3_points(search[mask_s][:3])
        if c0 is None:
            return None
    inl = np.abs(np.hypot(q[:, 0] - c0[0], q[:, 1] - c0[1]) - r0) < params.inlier_distance_m
    center, radius, rms = None, None, None
    for _ in range(2):
        if inl.sum() < 3:
            return None
        c, r, _rms = fit_circle_geometric(q[inl], c0, r0)
        if c is None:
            break
        center, radius = c, r
        c0, r0 = c, r
        inl = np.abs(np.hypot(q[:, 0] - c[0], q[:, 1] - c[1]) - r) < params.inlier_distance_m
    if center is None:
        center, radius = c0, r0
    if not (params.min_radius_m <= radius <= params.max_radius_m) or inl.sum() < 3:
        return None
    d = np.hypot(q[inl, 0] - center[0], q[inl, 1] - center[1]) - radius
    rms = float(np.sqrt(np.mean(d * d)))
    coverage, max_gap = arc_stats(q[inl], center)
    n_inl = int(inl.sum())
    flags = []
    if n_inl < params.min_inliers:
        flags.append("few_points")
    if coverage < params.partial_arc_coverage:
        flags.append("partial_arc")
    if rms > max(0.01, 0.1 * radius):
        flags.append("high_residual")
    return {
        "center": center + off, "radius": float(radius), "rms_m": rms,
        "arc_coverage": coverage, "max_gap_deg": max_gap,
        "n_points": int(n), "n_inliers": n_inl, "flags": flags,
    }


# ==================== ground models ====================

class HagGround:
    """Terrain elevation from per-point height above ground: each point carries
    the DTM elevation beneath it as z - hag. The ground at (x, y) is a
    least-squares plane through those values over the tree's low points within
    0.5 m, evaluated at (x, y). A median would be biased on a slope, because
    the stem points around (x, y) sit unevenly up- and downslope of it. With
    too few points (or a degenerate footprint) it falls back to the median of
    the 20 nearest points by x, y - but only those within FALLBACK_RADIUS_M.
    Beyond that it returns None, so the ground chain moves on to the ground
    labels rather than taking the DEM value under a crown metres away (a stem
    past the DEM's edge under an overhanging, DEM-covered crown)."""
    FALLBACK_RADIUS_M = 1.0
    source = "height_above_ground"

    def __init__(self, points: np.ndarray, hag: np.ndarray):
        ok = np.isfinite(hag)
        self._xy = points[ok, :2]
        self._g = points[ok, 2] - hag[ok]
        self._low = hag[ok] < 1.0

    def __call__(self, x: float, y: float) -> Optional[float]:
        if len(self._g) == 0:
            return None
        d = np.hypot(self._xy[:, 0] - x, self._xy[:, 1] - y)
        near = (d <= 0.5) & self._low
        if near.sum() >= 6:
            A = np.column_stack([np.ones(int(near.sum())),
                                 self._xy[near, 0] - x, self._xy[near, 1] - y])
            coef, _res, rank, _sv = np.linalg.lstsq(A, self._g[near], rcond=None)
            if rank == 3:
                return float(coef[0])
        if near.sum() >= 3:
            return float(np.median(self._g[near]))
        close = d <= self.FALLBACK_RADIUS_M
        if not close.any():
            return None
        dc, gc = d[close], self._g[close]
        k = min(20, len(dc))
        idx = np.argpartition(dc, k - 1)[:k]
        return float(np.median(gc[idx]))


class GroundGrid:
    """Ground-labelled points averaged on a coarse x, y grid, built in chunks
    so the whole ground class is never held at once. Evaluated by inverse-
    distance weighting over the occupied cells within `radius` of the query."""
    source = "ground_class"

    def __init__(self, cell: float = 0.5, radius: float = 2.0):
        self.cell = float(cell)
        self.radius = float(radius)
        self._sum: Dict[Tuple[int, int], float] = {}
        self._cnt: Dict[Tuple[int, int], int] = {}

    def add(self, xyz: np.ndarray) -> None:
        if len(xyz) == 0:
            return
        keys = np.floor(xyz[:, :2] / self.cell).astype(np.int64)
        uniq, inv = np.unique(keys, axis=0, return_inverse=True)
        inv = inv.reshape(-1)
        sums = np.bincount(inv, weights=xyz[:, 2])
        cnts = np.bincount(inv)
        for (i, j), s, c in zip(uniq.tolist(), sums.tolist(), cnts.tolist()):
            self._sum[(i, j)] = self._sum.get((i, j), 0.0) + s
            self._cnt[(i, j)] = self._cnt.get((i, j), 0) + c

    def __len__(self) -> int:
        return len(self._cnt)

    def __call__(self, x: float, y: float) -> Optional[float]:
        # Only the cells within `radius` can contribute, and they are dict
        # keys: visiting them is O((radius/cell)^2) per query, independent of
        # the plot's size (a 10 ha plot holds ~400k cells).
        k = int(math.ceil(self.radius / self.cell))
        ci, cj = int(math.floor(x / self.cell)), int(math.floor(y / self.cell))
        num = den = 0.0
        for i in range(ci - k, ci + k + 1):
            for j in range(cj - k, cj + k + 1):
                c = self._cnt.get((i, j))
                if not c:
                    continue
                d = math.hypot((i + 0.5) * self.cell - x, (j + 0.5) * self.cell - y)
                if d > self.radius:
                    continue
                w = 1.0 / max(d, 0.05)
                num += w * self._sum[(i, j)] / c
                den += w
        return num / den if den > 0 else None


class MinZGround:
    """Last resort: the tree's own lowest point, whatever x, y is asked."""
    source = "tree_min_z"

    def __init__(self, zmin: float):
        self._z = float(zmin)

    def __call__(self, x: float, y: float) -> Optional[float]:
        return self._z


# ==================== per-tree measurement ====================

def _perp_basis(axis: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """Two unit vectors spanning the plane perpendicular to `axis`."""
    helper = np.array([1.0, 0.0, 0.0]) if abs(axis[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
    u = np.cross(axis, helper)
    u /= np.linalg.norm(u)
    return u, np.cross(axis, u)


def _plain(v):
    """numpy scalars/arrays -> JSON-safe Python values; non-finite -> None."""
    if v is None:
        return None
    if isinstance(v, dict):
        return {k: _plain(x) for k, x in v.items()}
    if isinstance(v, np.ndarray):
        return [_plain(x) for x in v.tolist()]
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    if isinstance(v, (float, np.floating)):
        f = float(v)
        return f if math.isfinite(f) else None
    if isinstance(v, (np.integer,)):
        return int(v)
    return v


def _horizontal_pass(pts: np.ndarray, z_sorted: np.ndarray, order: np.ndarray, ground_z: float,
                     params: InventoryParams, rng: np.random.Generator):
    """Horizontal slices -> seed, then upward tracking to `lean_fit_max_m`.
    Returns (seed_xy, seed_radius, accepted [(x, y, z, r)])."""
    t = params.slice_thickness_m

    def slice_xy(h: float) -> np.ndarray:
        lo = np.searchsorted(z_sorted, ground_z + h - t / 2)
        hi = np.searchsorted(z_sorted, ground_z + h + t / 2)
        return pts[order[lo:hi]]

    heights = np.arange(params.seed_min_m, params.seed_max_m + 1e-9, params.seed_step_m)
    fits = []
    for h in heights:
        f = fit_stem_circle(slice_xy(h)[:, :2], params, rng)
        if f is not None:
            fits.append(f)
    if not fits:
        return None, None, []
    centres = np.array([f["center"] for f in fits])
    seed = np.median(centres, axis=0)
    r_seed = float(np.median([f["radius"] for f in fits]))

    accepted = []
    prev_c, prev_r = seed, r_seed
    failures = 0
    h = params.seed_min_m
    while h <= params.lean_fit_max_m + 1e-9:
        s = slice_xy(h)
        win = np.hypot(s[:, 0] - prev_c[0], s[:, 1] - prev_c[1]) <= 1.5 * prev_r + 0.10
        f = fit_stem_circle(s[win, :2], params, rng)
        if f is not None and 0.5 * prev_r <= f["radius"] <= 1.5 * prev_r and "high_residual" not in f["flags"]:
            accepted.append((f["center"][0], f["center"][1], ground_z + h, f["radius"]))
            prev_c, prev_r = f["center"], f["radius"]
            failures = 0
        else:
            failures += 1
            if failures >= params.max_consecutive_failures and accepted:
                break
        h += params.seed_step_m
    return seed, r_seed, accepted


def measure_tree(points: np.ndarray, *, params: InventoryParams,
                 hag: Optional[np.ndarray] = None,
                 ground_grid: Optional[GroundGrid] = None,
                 tree_id: int = 0) -> dict:
    """Measure one tree. `points` is (N, 3) world-frame float64, hits only.

    Returns {"tree": <tree-list row>, "stem_curve": [<slice rows>]}. Every value
    is JSON-safe; a quantity that could not be measured is None, never NaN.
    """
    pts = np.asarray(points, dtype=np.float64)
    rng = np.random.default_rng(params.random_seed + int(tree_id))
    flags: List[str] = []
    n = len(pts)
    row: dict = {"tree_id": int(tree_id), "n_points": int(n)}
    if n < 3:
        row.update({"flags": ["too_few_points"]})
        return {"tree": row, "stem_curve": []}

    zmin, zmax = float(pts[:, 2].min()), float(pts[:, 2].max())
    row["bbox_min"] = pts.min(axis=0)
    row["bbox_max"] = pts.max(axis=0)

    # ---- ground model: HAG > ground grid > tree minimum ----
    # Tried in order for EVERY query, not chosen once per tree: a DEM that
    # covers only part of the plot leaves some trees' height-above-ground NaN,
    # and those must fall to the ground labels, not straight to the minimum.
    chain: List = []
    if hag is not None and np.isfinite(hag).any():
        chain.append(HagGround(pts, hag))
    if ground_grid is not None and len(ground_grid) > 0:
        chain.append(ground_grid)

    def ground_at(x: float, y: float) -> Tuple[float, str]:
        for model in chain:
            g = model(x, y)
            if g is not None and math.isfinite(g):
                return float(g), model.source
        return zmin, MinZGround.source

    low = pts[pts[:, 2] <= zmin + 0.5]
    c0 = low[:, :2].mean(axis=0)
    g0, _src = ground_at(c0[0], c0[1])

    order = np.argsort(pts[:, 2], kind="stable")
    z_sorted = pts[order, 2]

    # ---- horizontal pass: seed + tracked centres (twice if the ground under
    # the seed differs from the first guess) ----
    seed, r_seed, accepted = _horizontal_pass(pts, z_sorted, order, g0, params, rng)
    if seed is not None:
        g1, _ = ground_at(seed[0], seed[1])
        if abs(g1 - g0) > 0.05:
            g0 = g1
            seed2, r2, acc2 = _horizontal_pass(pts, z_sorted, order, g0, params, rng)
            if seed2 is not None:
                seed, r_seed, accepted = seed2, r2, acc2

    # ---- stem axis: x, y regressed on z over the accepted centres ----
    anchor_xy = seed if seed is not None else c0
    bx = by = 0.0
    x0, y0 = float(anchor_xy[0]), float(anchor_xy[1])
    if len(accepted) >= 3:
        acc = np.asarray(accepted)
        A = np.column_stack([np.ones(len(acc)), acc[:, 2]])
        (x0, bx), *_ = np.linalg.lstsq(A, acc[:, 0], rcond=None)
        (y0, by), *_ = np.linalg.lstsq(A, acc[:, 1], rcond=None)
    else:
        x0, y0 = float(anchor_xy[0]), float(anchor_xy[1])

    def axis_xy(z: float) -> Tuple[float, float]:
        if len(accepted) >= 3:
            return x0 + bx * z, y0 + by * z
        return x0, y0

    # ---- stem base: the axis meets the terrain ----
    zb = g0
    src = MinZGround.source
    for _ in range(3):
        bxy = axis_xy(zb)
        zb, src = ground_at(bxy[0], bxy[1])
    base = np.array([*axis_xy(zb), zb])
    if src == MinZGround.source:
        flags.append("ground_from_tree_min")
    row["ground_source"] = src
    row["ground_z"] = zb
    row["stem_base"] = base

    axis = np.array([bx, by, 1.0])
    axis /= np.linalg.norm(axis)
    lean = math.degrees(math.atan(math.hypot(bx, by)))
    row["lean_deg"] = lean
    row["lean_azimuth_deg"] = (math.degrees(math.atan2(bx, by)) % 360.0) if lean >= 0.5 else None
    row["stem_axis"] = axis

    # ---- perpendicular pass: the reported stem curve + DBH ----
    u, v = _perp_basis(axis)
    rel = pts - base
    s_all = rel @ axis
    s_order = np.argsort(s_all, kind="stable")
    s_sorted = s_all[s_order]
    uv_all = np.column_stack([rel @ u, rel @ v])

    def perp_slice(s: float, thickness: float) -> np.ndarray:
        lo = np.searchsorted(s_sorted, s - thickness / 2)
        hi = np.searchsorted(s_sorted, s + thickness / 2)
        return s_order[lo:hi]

    def fit_at(s: float, pred_uv, r_pred: float, thicknesses) -> Tuple[Optional[dict], float]:
        f, used = None, thicknesses[0]
        for t in thicknesses:
            idx = perp_slice(s, t)
            uv = uv_all[idx]
            if pred_uv is not None:
                win = np.hypot(uv[:, 0] - pred_uv[0], uv[:, 1] - pred_uv[1]) <= 1.5 * r_pred + 0.10
                uv = uv[win]
            used = t
            if len(uv) < params.min_inliers and t != thicknesses[-1]:
                continue
            f = fit_stem_circle(uv, params, rng)
            break
        return f, used

    def to_world(s: float, c_uv) -> np.ndarray:
        return base + s * axis + c_uv[0] * u + c_uv[1] * v

    stem_curve: List[dict] = []
    top_s = float((pts[:, 2].max() - zb) / max(axis[2], 1e-6))
    r_prev = r_seed if r_seed is not None else 0.25
    prev_uv = np.zeros(2) if seed is not None else None
    failures = 0
    curve_radius: List[Tuple[float, float]] = []
    s = params.stem_curve_start_m
    if seed is not None:
        while s <= top_s:
            f, t_used = fit_at(s, prev_uv, r_prev, (params.slice_thickness_m,))
            # A partial arc is the normal case for a single scan position, so it
            # does not break the curve; too few points or a noisy fit does, and
            # so does a radius jump the stem cannot make between 0.5 m slices.
            ok = (f is not None
                  and not ({"few_points", "high_residual"} & set(f["flags"]))
                  and 0.5 * r_prev <= f["radius"] <= 1.5 * r_prev)
            if f is not None:
                c = to_world(s, f["center"])
                stem_curve.append({
                    "tree_id": int(tree_id), "axial_m": s, "height_m": float(c[2] - zb),
                    "x": c[0], "y": c[1], "z": c[2], "diameter_m": 2 * f["radius"],
                    "rms_m": f["rms_m"], "arc_coverage": f["arc_coverage"],
                    "n_points": f["n_points"], "ok": bool(ok),
                })
            if ok:
                prev_uv, r_prev = f["center"], f["radius"]
                curve_radius.append((s, f["radius"]))
                failures = 0
            else:
                failures += 1
                if failures >= params.max_consecutive_failures and curve_radius:
                    break
            s = round(s + params.stem_curve_step_m, 9)

    # DBH: its own slice at breast height, windowed on the axis (or the tracked
    # stem next to it) and widened when sparse. Breast height is measured from
    # the UPHILL side of the stem (the highest ground at its perimeter) and
    # along the stem (Kershaw et al. 2016; West 2009): the reference is the
    # axis point level with that ground, and breast height is `bh` further
    # along the axis. On flat ground this is exactly `bh` above the base.
    dbh = None
    if seed is not None:
        r_ring = max(float(r_seed), 0.01)
        ring = [ground_at(base[0] + r_ring * math.cos(t), base[1] + r_ring * math.sin(t))[0]
                for t in np.linspace(0, 2 * math.pi, 16, endpoint=False)]
        uphill_z = max(max(ring), zb)
        row["breast_height_ref_z"] = uphill_z
        bh = (uphill_z - zb) / max(axis[2], 1e-6) + params.breast_height_m
        pred = np.zeros(2)
        r_pred = r_seed
        if curve_radius:
            nearest = min(stem_curve, key=lambda e: abs(e["axial_m"] - bh) if e["ok"] else 1e9)
            if nearest["ok"]:
                c_uv = (np.array([nearest["x"], nearest["y"], nearest["z"]]) - base)
                pred = np.array([c_uv @ u, c_uv @ v])
                r_pred = nearest["diameter_m"] / 2
        f, t_used = fit_at(bh, pred, r_pred, (params.slice_thickness_m, *params.slice_widen_m))
        if f is not None:
            c = to_world(bh, f["center"])
            dbh = {
                "diameter_m": 2 * f["radius"], "center": c, "rms_m": f["rms_m"],
                "arc_coverage": f["arc_coverage"], "max_gap_deg": f["max_gap_deg"],
                "n_points": f["n_points"], "n_inliers": f["n_inliers"],
                "slice_thickness_m": t_used, "method": params.fit_method,
                "axial_m": bh,
                "flags": list(f["flags"]),
            }
            if not curve_radius:
                curve_radius.append((bh, f["radius"]))
    if dbh is None:
        flags.append("no_stem")
    else:
        flags.extend(dbh["flags"])
    row["dbh_m"] = dbh["diameter_m"] if dbh else None
    row["dbh"] = dbh

    # ---- height ----
    height = zmax - zb
    row["height_m"] = height

    # ---- crown: points that are not stem ----
    if curve_radius:
        cr = np.asarray(sorted(curve_radius))
        r_at = np.interp(s_all, cr[:, 0], cr[:, 1])
        # Distance to the straight stem axis, as the spec defines the test.
        perp = np.linalg.norm(rel - np.outer(s_all, axis), axis=1)
        is_stem = perp <= r_at + np.maximum(0.10, 0.5 * r_at)
    else:
        is_stem = np.zeros(n, dtype=bool)
    crown = pts[~is_stem]
    # Each crown point's direction around the stem axis, for the crown-base
    # quadrant test.
    off = rel[~is_stem] - np.outer(s_all[~is_stem], axis)
    crown_az = np.degrees(np.arctan2(off[:, 0], off[:, 1]))
    row["n_crown_points"] = int(len(crown))
    row.update(_crown_metrics(crown, base, zb, params, azimuth_deg=crown_az))

    # ---- derived ----
    if dbh is not None:
        d = dbh["diameter_m"]
        row["basal_area_m2"] = math.pi / 4.0 * d * d
        row["slenderness"] = height / d if d > 0 else None
    else:
        row["basal_area_m2"] = None
        row["slenderness"] = None

    row["flags"] = sorted(set(flags))
    return {"tree": _plain(row), "stem_curve": _plain(stem_curve)}


def voxel_thin(points: np.ndarray, max_points: int) -> Tuple[np.ndarray, Optional[float]]:
    """Indices of at most `max_points` points, one per occupied voxel, with the
    voxel edge grown until the count fits. Returns (sorted indices, voxel edge
    or None when no thinning was needed).

    Voxels rather than a stride: a terrestrial scan's point spacing grows with
    range, and every-k-th decimation keeps that bias (the near side of a stem
    stays dense while the far side vanishes); a voxel keeps one point per unit
    of space wherever the scan put it."""
    p = np.asarray(points, dtype=np.float64)
    n = len(p)
    if n <= max_points:
        return np.arange(n), None
    lo = p.min(axis=0)
    ext = np.maximum(p.max(axis=0) - lo, 1e-6)
    v = max(1e-4, float(np.prod(ext) / max(1, max_points)) ** (1.0 / 3.0) * 0.25)
    for _ in range(200):
        k = np.floor((p - lo) / v).astype(np.int64)
        _u, first = np.unique(k, axis=0, return_index=True)
        if len(first) <= max_points:
            return np.sort(first), v
        v *= 1.15
    return np.sort(first[:max_points]), v


def crown_base_height(heights: np.ndarray, *, bin_m: float, gap_m: float,
                      occupancy_frac: float, azimuth_deg: Optional[np.ndarray] = None,
                      min_quadrants: int = 3) -> Optional[float]:
    """Base of the continuous crown: bin crown-point heights, mark bins holding
    at least `occupancy_frac` of the fullest bin, and walk down from the top
    occupied bin until an empty run of `gap_m` or more.

    With `azimuth_deg` (each point's direction around the stem axis), the base
    then climbs through that continuous run to the first bin whose points
    occupy at least `min_quadrants` of the 4 quadrants around the stem - the
    mensuration convention of the lowest whorl with live foliage in 3 of 4
    quadrants (Kershaw et al. 2016). A one-sided low branch is thus not the
    base. A quadrant counts when it holds at least 5% of the bin's points.

    Returns the bottom of the chosen bin (a height), or None."""
    h = np.asarray(heights, dtype=np.float64)
    finite = np.isfinite(h)
    h = h[finite]
    az = None if azimuth_deg is None else np.asarray(azimuth_deg, dtype=np.float64)[finite]
    if len(h) == 0:
        return None
    lo = min(0.0, float(h.min()))
    nbins = max(1, int(math.ceil((float(h.max()) - lo) / bin_m)) + 1)
    counts = np.bincount(np.clip(((h - lo) / bin_m).astype(int), 0, nbins - 1), minlength=nbins)
    occupied = counts >= max(1, occupancy_frac * counts.max())
    idx = np.flatnonzero(occupied)
    if len(idx) == 0:
        return None
    base_bin = idx[-1]
    run = [base_bin]
    for k in idx[::-1][1:]:
        gap = (base_bin - k - 1) * bin_m
        if gap >= gap_m - 1e-9:
            break
        base_bin = k
        run.append(k)
    if az is not None:
        bins = np.clip(((h - lo) / bin_m).astype(int), 0, nbins - 1)
        quad = (np.floor(np.mod(az, 360.0) / 90.0).astype(int)) % 4
        for k in sorted(run):
            q = quad[bins == k]
            qc = np.bincount(q, minlength=4)
            if int((qc >= max(1, 0.05 * len(q))).sum()) >= min_quadrants:
                return lo + k * bin_m
    return lo + base_bin * bin_m


def _polygon_moments(poly: np.ndarray) -> Tuple[float, np.ndarray, np.ndarray]:
    """(area, centroid (2,), central second-moment matrix (2, 2)) of a simple
    polygon given counter-clockwise, by the shoelace-type formulas."""
    off = poly.mean(axis=0)
    p = poly - off
    x, y = p[:, 0], p[:, 1]
    xn, yn = np.roll(x, -1), np.roll(y, -1)
    cr = x * yn - xn * y
    a = 0.5 * cr.sum()
    if abs(a) < 1e-15:
        return 0.0, poly.mean(axis=0), np.zeros((2, 2))
    cx = ((x + xn) * cr).sum() / (6 * a)
    cy = ((y + yn) * cr).sum() / (6 * a)
    ixx = ((x * x + x * xn + xn * xn) * cr).sum() / 12.0
    iyy = ((y * y + y * yn + yn * yn) * cr).sum() / 12.0
    ixy = ((x * yn + 2 * x * y + 2 * xn * yn + xn * y) * cr).sum() / 24.0
    sxx = ixx - a * cx * cx
    syy = iyy - a * cy * cy
    sxy = ixy - a * cx * cy
    if a < 0:  # clockwise input: every integral flips sign
        a, sxx, syy, sxy = -a, -sxx, -syy, -sxy
    return float(a), np.array([cx, cy]) + off, np.array([[sxx, sxy], [sxy, syy]])


def _crown_metrics(crown: np.ndarray, base: np.ndarray, zb: float,
                   params: InventoryParams, azimuth_deg: Optional[np.ndarray] = None) -> dict:
    out = {
        "crown_base_height_m": None, "crown_projected_area_m2": None,
        "crown_diameter_mean_m": None, "crown_diameter_equiv_m": None,
        "crown_max_width_m": None, "crown_perp_width_m": None,
        "crown_offset_m": None, "crown_offset_azimuth_deg": None,
        "crown_ellipse_eccentricity": None, "crown_volume_voxel_m3": None,
        "crown_hull_xy": None,
    }
    if len(crown) == 0:
        return out
    out["crown_base_height_m"] = crown_base_height(
        crown[:, 2] - zb, bin_m=params.crown_bin_m, gap_m=params.crown_gap_m,
        occupancy_frac=params.crown_occupancy_frac, azimuth_deg=azimuth_deg)

    # Voxel volume.
    v = params.voxel_size_m
    # A fixed world lattice (not one anchored on this crown's own minimum,
    # which would put the lowest points exactly on cube boundaries).
    k = np.floor(crown / v).astype(np.int64)
    out["crown_volume_voxel_m3"] = float(len(np.unique(k, axis=0)) * v ** 3)

    # Projected hull.
    xy = crown[:, :2]
    if len(xy) < 3:
        return out
    try:
        from scipy.spatial import ConvexHull
        hull = ConvexHull(xy - xy.mean(axis=0))
    except Exception:
        return out
    poly = xy[hull.vertices]  # counter-clockwise for 2-D hulls
    area, centroid, m2 = _polygon_moments(poly)
    if area <= 0:
        return out
    out["crown_projected_area_m2"] = area
    out["crown_diameter_equiv_m"] = 2.0 * math.sqrt(area / math.pi)
    # Widest width = the largest distance between hull vertices; the
    # perpendicular width is the hull's extent across that direction.
    d = np.linalg.norm(poly[:, None, :] - poly[None, :, :], axis=2)
    i, j = np.unravel_index(int(np.argmax(d)), d.shape)
    wmax = float(d[i, j])
    if wmax > 0:
        dirn = (poly[j] - poly[i]) / wmax
        perp = np.array([-dirn[1], dirn[0]])
        proj = poly @ perp
        wperp = float(proj.max() - proj.min())
    else:
        wperp = 0.0
    out["crown_max_width_m"] = wmax
    out["crown_perp_width_m"] = wperp
    out["crown_diameter_mean_m"] = 0.5 * (wmax + wperp)
    dx, dy = centroid[0] - base[0], centroid[1] - base[1]
    out["crown_offset_m"] = float(math.hypot(dx, dy))
    out["crown_offset_azimuth_deg"] = float(math.degrees(math.atan2(dx, dy)) % 360.0)
    lam = np.sort(np.linalg.eigvalsh(m2))[::-1]
    if lam[0] > 0:
        out["crown_ellipse_eccentricity"] = float(math.sqrt(max(0.0, 1.0 - max(lam[1], 0.0) / lam[0])))
    out["crown_hull_xy"] = poly
    return out
