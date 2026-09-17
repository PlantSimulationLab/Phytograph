"""Point-cloud normal estimation: oriented normals + the shape scalars that
fall out of the same eigendecomposition.

Canonical home for the Compute Normals tool. Before this existed, normals were
estimated in nine places (triangulation, point-to-plane ICP x2, FPFH, GICP,
raster correlation, plane patches, scene classify) and discarded every time, so
a user who triangulated twice paid for them twice -- and Poisson's
`orient_normals_consistent_tangent_plane` alone measured ~270 s on a 2 M-point
cloud. Here the result is computed once and stored on the session as columns,
and the consumers above read it back.

Output is ONE (N, 5) float32 block, in `COLUMNS` order: the three normal
components, then curvature and verticality. The two scalars are free -- they are
functions of the same local covariance eigenvalues -- so they are computed in
the same pass rather than made a second tool.

Why open3d and not a hand-rolled scipy kernel
---------------------------------------------
Measured on a 12-core M-series, 3 M points, k=20:

    open3d estimate_normals, KNN (OpenMP)              0.83 M pts/s
    open3d estimate_normals, Hybrid (radius + max_nn)  0.80 M pts/s
    scipy cKDTree(workers=-1) + batched eigh           0.26 M pts/s

open3d is 3.2x faster and the two agree to `mean |dot| = 1.0` -- identical
answers, so there is no accuracy argument for the slow one.

Why this tiles, and why the collar is 1.5x the k-th NN distance
---------------------------------------------------------------
Two effects, both measured, and they are NOT independent:

  * Cache locality. The SAME 8 M points, single process: one 8 M call took
    15.40 s; sixteen 0.5 M calls took 9.23 s. 1.67x for identical work. Tiling
    is worth doing even on one core.
  * Parallelism. 12 M points: whole-cloud with OMP=12 took 18.06 s; 4 processes
    x OMP=3 took 13.28 s. open3d's own OpenMP scales sub-linearly (1->12 threads
    is only 3.9x), so splitting into PROCESSES beats giving one call every
    thread. 6x2 was slower than 4x3 -- more processes is not monotonically
    better.

**End-to-end this is ~0.45 M pts/s on 12 cores**, not the product of the two
figures above: they are largely the same win measured two ways (a tile that
fits in cache is also the tile a worker runs), so multiplying them overstates
the result by ~5x. Measured at 10 M points: 20.8 s in-process, and 38.7 s
through the HTTP endpoint including the ~4.5 s worker start-up, the staging of
`input.npy`, and the scatter back into five session columns. A 1/r^2 terrestrial
cloud and a flat uniform sheet come out within 10% of each other, so the figure
is not fixture-specific. Budget roughly 4 minutes for 100 M points.

A tiled normal is only correct if the tile sees the whole neighbourhood the
untiled one would. Measured against the untiled result, on a uniform cloud and
on a TLS-like 1/r^2 density cloud:

    collar = 0.5x p99 k-th-NN    max err 0.89 deg,  6 sign flips
    collar = 1.0x                max err 0.21 deg,  0 sign flips
    collar = 1.5x                max err 0.00 deg,  0 sign flips

So `_COLLAR_MULTIPLE = 1.5` reproduces the untiled answer exactly.
`tests/test_normals_tiled.py` pins that, and shrinking the multiple fails it.

Orientation is origin-based, NOT an MST
---------------------------------------
PCA gives a normal only up to sign. open3d's
`orient_normals_consistent_tangent_plane` resolves that by propagating along an
MST, which is globally coupled: two tiles cannot agree on a sign without talking
to each other, so a tiled MST produces visible seams, and the pass is O(N log N)
with a large constant on top.

Flipping toward the sensor instead is O(N), exact for a terrestrial scan, and --
the property that makes the whole tiled design work -- depends only on the point
and the origin, never on which tile the point landed in. It measured ZERO sign
flips across tiles at every collar width above. For a scan the sensor position
is known (`CloudSession.beam_origins` per point, or the scan origin); when it
is not, the caller supplies a viewpoint and we fall back to the cloud centroid.
"""

from __future__ import annotations

import os
from typing import Any, Optional, Sequence, Tuple

import numpy as np
from scipy.spatial import cKDTree

# Session columns written by the compute_normals endpoint, in output order.
# The slugs are the renderer's buffer keys and the LAS/PLY extra-dim names, so
# they are a contract with `main._PLY_PROPERTY_TYPES` and `_ply_role_for`:
# `nx`/`ny`/`nz` are the canonical PLY spellings and let an exported cloud
# re-import as normals rather than three unrelated scalars.
NORMAL_X_SLUG = "nx"
NORMAL_Y_SLUG = "ny"
NORMAL_Z_SLUG = "nz"
CURVATURE_SLUG = "curvature"
VERTICALITY_SLUG = "verticality"

COLUMNS: Tuple[Tuple[str, str], ...] = (
    (NORMAL_X_SLUG, "Normal X"),
    (NORMAL_Y_SLUG, "Normal Y"),
    (NORMAL_Z_SLUG, "Normal Z"),
    (CURVATURE_SLUG, "Curvature"),
    (VERTICALITY_SLUG, "Verticality"),
)
N_COLUMNS = len(COLUMNS)

ORIENTATIONS = ("origin", "viewpoint", "up", "none")
DEFAULT_ORIENTATION = "origin"

DEFAULT_K = 30
MIN_K = 4          # a plane needs 3; 4 keeps the covariance non-degenerate
MAX_K = 200        # past this the cost is quadratic-ish for no accuracy gain

# Below this a neighbourhood statistic is meaningless and every heuristic
# degenerates. Matches `denoise.MIN_POINTS` for consistency across tools.
MIN_POINTS = 100

# Tile collar as a multiple of the p99 k-th nearest-neighbour distance. 1.5
# reproduces the untiled result exactly; see the module docstring.
_COLLAR_MULTIPLE = 1.5

TILE_MIN_POINTS = 4_000_000
# Points per tile. Deliberately far smaller than `tiled.DEFAULT_TARGET_POINTS`
# (3 M), for two measured reasons at 10 M points on 12 cores:
#
#   target    tiles   wall     throughput
#   500 k       24    30.1 s   0.33 M pts/s
#   125 k       77    25.7 s   0.39 M pts/s
#   60 k       149    23.4 s   0.43 M pts/s
#   30 k       298    26.4 s   0.38 M pts/s   <- per-tile fixed costs win
#
# (1) LOAD BALANCE: 24 tiles over 12 workers is two waves, and the pool is only
#     as fast as its slowest tile in the last wave — a 1/r^2 scan's tiles differ
#     several-fold in point count, so coarse tiles strand cores. (2) CACHE: the
#     k-NN search is memory-bound, and a smaller tree stays resident.
# 100 k sits on the plateau with fewer per-tile fixed costs than 60 k. The
# collar stays ~2% of the tile edge here, so the buffered overhead is noise.
TILE_TARGET_POINTS = 100_000

# Points per `estimate_normals` call in the UNTILED path. The cache-locality
# measurement above says a big cloud is faster in chunks even on one core, and
# a small cloud below `TILE_MIN_POINTS` never reaches the tiling path at all --
# so the single-call path chunks too, spatially, via the tile plan.
_SPACING_SAMPLE = 200_000


def tile_min_points() -> int:
    """Points above which the compute tiles. Env-overridable so the seam test
    can force tiling on a cloud small enough to also run untiled."""
    raw = os.environ.get("PHYTOGRAPH_NORMALS_TILE_MIN_POINTS")
    if raw is not None:
        try:
            return max(0, int(raw))
        except ValueError:
            pass
    return TILE_MIN_POINTS


def _tile_target_points() -> int:
    raw = os.environ.get("PHYTOGRAPH_NORMALS_TILE_TARGET_POINTS")
    if raw is not None:
        try:
            return max(1000, int(raw))
        except ValueError:
            pass
    return TILE_TARGET_POINTS


def knn_distance_percentile(points: np.ndarray, k: int, q: float = 99.0,
                            sample: int = _SPACING_SAMPLE,
                            tree: "Optional[cKDTree]" = None) -> Optional[float]:
    """Percentile of the distance to the k-th nearest neighbour, or None.

    Deterministic: an evenly-spaced index sample, no RNG -- same discipline as
    `denoise._nn_distances`, and for the same reason (a stride sample of a
    SURFACE widens its apparent spacing by ~sqrt(stride), so the sample must be
    of whole neighbourhoods, not of thinned ones).

    This is the k-TH neighbour, not the first: the collar has to contain the
    entire neighbourhood the estimator will look at, and that is set by the k-th.
    """
    finite = points[np.isfinite(points).all(axis=1)]
    if len(finite) < MIN_POINTS:
        return None
    kk = int(min(max(2, k + 1), len(finite)))
    probe = finite[np.linspace(0, len(finite) - 1,
                               min(sample, len(finite))).astype(np.int64)]
    if tree is None:
        tree = cKDTree(finite, leafsize=64, compact_nodes=False, balanced_tree=False)
    dist, _ = tree.query(probe, k=kk, workers=-1)
    far = dist[:, -1]
    far = far[np.isfinite(far) & (far > 0)]
    if far.size == 0:
        return None
    value = float(np.percentile(far, q))
    return value if np.isfinite(value) and value > 0 else None


def _eigen_normals(points: np.ndarray, k: int,
                   radius: Optional[float] = None) -> np.ndarray:
    """(M, 5) float32 of [nx, ny, nz, curvature, verticality] for `points`.

    Unoriented -- the sign is whatever the eigensolver produced. `orient()`
    fixes that, separately, because orientation is the part that must stay
    independent of tiling.
    """
    import open3d as o3d

    n = len(points)
    out = np.zeros((n, N_COLUMNS), dtype=np.float32)
    if n == 0:
        return out

    # open3d refuses a non-writeable buffer ("array is not writeable"), which a
    # memmap slice is, so copy rather than `ascontiguousarray`.
    xyz = np.array(points, dtype=np.float64, order="C")
    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(xyz)

    kk = int(min(max(MIN_K, k), max(MIN_K, n)))
    if radius is not None and radius > 0:
        search = o3d.geometry.KDTreeSearchParamHybrid(radius=float(radius), max_nn=kk)
    else:
        search = o3d.geometry.KDTreeSearchParamKNN(kk)

    # ONE neighbourhood search, not two.
    #
    # The obvious shape - `estimate_normals` for the directions, then
    # `estimate_covariances` for the eigenvalues curvature needs - runs the
    # whole KD-tree build and k-NN search TWICE (measured 0.72 s + 0.65 s on
    # 600 k points; the search, not the algebra, is the cost). But a normal IS
    # the smallest eigenvector of that same covariance, so asking for the
    # covariances alone and taking a full `eigh` gives both from one search:
    # measured 1.31x faster end to end, and identical to the two-call version
    # (mean |dot| = 1.000000, min 1.0000 over 600 k points).
    pcd.estimate_covariances(search_param=search)
    cov = np.asarray(pcd.covariances, dtype=np.float64)
    evals, evecs = np.linalg.eigh(cov)        # ascending, (M, 3) / (M, 3, 3)
    normals = evecs[:, :, 0]                  # smallest eigenvector
    total = evals.sum(axis=1)
    with np.errstate(divide="ignore", invalid="ignore"):
        curvature = np.where(total > 0, evals[:, 0] / total, 0.0)

    # Angle of the normal from vertical, in degrees, folded to [0, 90]: a
    # surface's dip does not depend on which way the normal happens to point,
    # and folding here keeps the column meaningful even when orientation is
    # 'none'.
    nz = np.clip(np.abs(normals[:, 2]), 0.0, 1.0)
    verticality = np.degrees(np.arccos(nz))

    out[:, 0:3] = normals.astype(np.float32)
    out[:, 3] = np.nan_to_num(curvature, nan=0.0, posinf=0.0, neginf=0.0).astype(np.float32)
    out[:, 4] = np.nan_to_num(verticality, nan=0.0, posinf=0.0, neginf=0.0).astype(np.float32)

    # Zero out points whose neighbourhood could not define a plane.
    #
    # `eigh` of a rank-deficient (or all-zero) covariance returns an ARBITRARY
    # orthonormal basis, and the code above then emits a unit-length normal with
    # nothing to mark it meaningless. Measured: a set of duplicate points yields
    # (1,0,0) with verticality 90 deg, and an isolated point under a pinned
    # radius yields curvature 0.3333 -- the theoretical MAXIMUM -- so a sparse
    # far-field region renders as a confident bright band of vertical,
    # high-curvature surface that does not exist.
    #
    # A zero vector is the honest answer and is already the convention here: the
    # tiling fill, deleted rows and misses all carry it, `orient()` leaves it
    # alone (flipping a zero is a no-op) and `test_tiling_covers_every_point`
    # reads |n| as the validity signal.
    #
    # Two signatures, both verified against open3d 0.19:
    #
    #   * `total` (the covariance trace, i.e. the neighbourhood's total spread)
    #     is 0 exactly when every neighbour coincides with the point.
    #   * open3d returns the IDENTITY matrix when it cannot compute a covariance
    #     at all -- a point with no neighbours inside a pinned radius. That is a
    #     sentinel, not a measurement, and it is why the isolated-point case
    #     scored curvature 1/3: it is literally 1/(1+1+1). Detect it as three
    #     equal unit eigenvalues, which a real neighbourhood does not produce
    #     (it would have to be perfectly isotropic AND scaled to exactly 1.0).
    identity_sentinel = np.all(np.abs(evals - 1.0) < 1e-9, axis=1)
    degenerate = ~np.isfinite(total) | (total <= 0) | identity_sentinel
    if degenerate.any():
        out[degenerate, :] = 0.0
    return out


def orient(result: np.ndarray, points: np.ndarray, *,
           orientation: str = DEFAULT_ORIENTATION,
           origin: Optional[np.ndarray] = None) -> np.ndarray:
    """Flip normals in place so they face the sensor (or +Z), and return them.

    `origin` is either a single (3,) viewpoint or a per-point (M, 3) array of
    beam origins. Every rule here is a per-point decision -- no neighbourhood,
    no propagation -- which is exactly why a tiled run has no seams.
    """
    if orientation == "none" or len(result) == 0:
        return result
    normals = result[:, 0:3]
    if orientation == "up":
        flip = normals[:, 2] < 0
    else:
        if origin is None:
            return result
        o = np.asarray(origin, dtype=np.float64)
        view = (o - points) if o.ndim == 2 else (o.reshape(1, 3) - points)
        flip = np.einsum("ij,ij->i", normals.astype(np.float64), view) < 0
    np.negative(normals, out=normals, where=flip[:, None])
    return result


# --- tiling -------------------------------------------------------------------
# Module-level so a spawn child can resolve it by name (`tiled._resolve_job`),
# same contract as `denoise._ror_tile_job`.

def _normals_tile_job(chunk, core, *, k, radius, orientation, origin, omp_threads=None):
    if omp_threads:
        # Each pool child otherwise starts open3d with a full complement of
        # OpenMP threads: 4 children x 12 threads on a 12-core box is 48-way
        # oversubscription, which measured SLOWER than running untiled. Nothing
        # else in this codebase pins OMP, so it is set here, per child, rather
        # than globally where it would also throttle the parent's other work.
        os.environ["OMP_NUM_THREADS"] = str(int(omp_threads))
    res = _eigen_normals(chunk, k, radius)
    if orientation == "origin" and origin is not None:
        o = np.asarray(origin, dtype=np.float64)
        # A per-point origin array is indexed by the CALLER's rows; the pool
        # passes only this tile's slice, so a (M,3) origin arrives already
        # gathered. A single viewpoint broadcasts.
        return orient(res, chunk, orientation="origin", origin=o)
    return orient(res, chunk, orientation=orientation, origin=origin)


def _resolve_local_job(name):
    return {"_normals_tile_job": _normals_tile_job}[name]


def _omp_per_worker(workers: int) -> int:
    cpu = os.cpu_count() or 1
    return max(1, cpu // max(1, int(workers)))


def compute_normals(points: np.ndarray, *, k: int = DEFAULT_K,
                    radius: Optional[float] = None,
                    orientation: str = DEFAULT_ORIENTATION,
                    origin: Optional[Sequence[float]] = None,
                    meta: Optional[dict] = None,
                    progress: Optional[Any] = None) -> np.ndarray:
    """(N, 5) float32 normals + shape scalars for `points`, in `COLUMNS` order.

    Tiles above `tile_min_points()`, fanning the tiles out to a spawn pool when
    running inside the killable worker (`tiled.worker_count` returns 1
    anywhere else -- see its comment; a fork of a process holding open3d or
    libhelios dies). Below that it runs as one call.

    `origin` may be a (3,) viewpoint or a per-point (N, 3) array of beam
    origins; it is carried through the tiling unchanged, gathered per tile.
    """
    import tiled

    pts = np.asarray(points, dtype=np.float64)
    n = len(pts)
    meta = meta if meta is not None else {}

    k = int(min(max(MIN_K, int(k)), MAX_K))
    if orientation not in ORIENTATIONS:
        raise ValueError(f"unknown orientation {orientation!r}")

    origin_arr: Optional[np.ndarray] = None
    if origin is not None:
        origin_arr = np.asarray(origin, dtype=np.float64)
        if origin_arr.ndim == 2 and len(origin_arr) != n:
            raise ValueError(
                f"per-point origin has {len(origin_arr)} rows for {n} points")

    meta["k"] = k
    meta["radius"] = float(radius) if radius else None
    meta["orientation"] = orientation
    meta["point_count"] = int(n)

    if n < MIN_POINTS:
        meta["warning"] = (
            f"Too few points ({n}) to estimate normals; need at least {MIN_POINTS}.")
        meta["tiled"] = False
        return np.zeros((n, N_COLUMNS), dtype=np.float32)

    if n < tile_min_points():
        meta["tiled"] = False
        meta["workers"] = 1
        res = _eigen_normals(pts, k, radius)
        return orient(res, pts, orientation=orientation, origin=origin_arr)

    # Collar from the cloud's OWN k-th-neighbour distance, measured once on a
    # deterministic sample so every tile applies the same one. A per-tile
    # measurement would let tiles disagree about how much context they need.
    spacing = knn_distance_percentile(pts, k, 99.0)
    if spacing is None:
        meta["tiled"] = False
        meta["workers"] = 1
        res = _eigen_normals(pts, k, radius)
        return orient(res, pts, orientation=orientation, origin=origin_arr)

    collar = float(spacing) * _COLLAR_MULTIPLE
    if radius is not None and radius > 0:
        # A pinned radius caps how far the estimator can look, so the collar
        # never needs to exceed it -- but must not be shorter than it either.
        collar = max(collar, float(radius))

    # Clamp the collar so a tile can always contain it.
    #
    # `auto_tile_size` normally guarantees tile >= 4*collar, but its last line
    # clamps the tile to the cloud's own XY extent -- so a user-set radius
    # larger than the cloud (the panel accepts up to 100 m) makes the collar
    # exceed the tile and `TilePlan.__init__` raises "buffer_m must not exceed
    # tile_m", surfacing as an opaque 500 naming two internal concepts. A collar
    # that wide is also meaningless: it already spans the whole cloud, so every
    # tile sees every point and the run is untiled in all but name.
    ext = pts[:, :2].max(axis=0) - pts[:, :2].min(axis=0)
    max_collar = 0.25 * float(max(ext.max(), 1e-9))
    if collar > max_collar:
        meta["collar_clamped_from"] = collar
        collar = max_collar
    if not (collar > 0):
        meta["tiled"] = False
        meta["workers"] = 1
        res = _eigen_normals(pts, k, radius)
        return orient(res, pts, orientation=orientation, origin=origin_arr)
    meta["knn_spacing_p99"] = float(spacing)
    meta["collar_m"] = collar

    plan = tiled.TilePlan.build(pts[:, :2], buffer_m=collar,
                                target_points=_tile_target_points())

    import memory_budget
    # Per point in a buffered tile: the float64 chunk (24 B), open3d's own copy
    # plus its KD-tree, the (M,3) normals and the (M,3,3) covariances (72 B).
    per_point = 200
    workers = tiled.worker_count(len(plan.tiles()),
                                 per_worker_bytes=_tile_target_points() * per_point,
                                 budget_bytes=memory_budget.budget_bytes())

    job_kwargs = {"k": k, "radius": radius, "orientation": orientation,
                  "origin": None if origin_arr is None or origin_arr.ndim == 2
                            else origin_arr.tolist()}

    meta["tiled"] = True
    meta["workers"] = int(workers)
    meta.update(plan.describe())

    should_cancel = None
    if progress is not None and getattr(progress, "should_cancel", None):
        should_cancel = progress.should_cancel

    per_point_origin = origin_arr is not None and origin_arr.ndim == 2
    if workers > 1 and not per_point_origin:
        job_kwargs["omp_threads"] = _omp_per_worker(workers)
        with tiled.staged_points(pts) as (path, rows):
            return tiled.run_tiled_parallel(
                plan, path, ("normals", "_normals_tile_job"), workers=workers,
                job_kwargs=job_kwargs, file_rows=rows,
                out_dtype=np.float32, fill=0.0, ncols=N_COLUMNS,
                progress=_tile_progress(progress), should_cancel=should_cancel)

    # In-process: either a single worker, or a per-point origin array, which the
    # pool would have to gather per tile. `run_tiled` hands us the chunk but not
    # its row indices, so the per-point case uses `iter_tiles` directly.
    if per_point_origin:
        out = np.zeros((n, N_COLUMNS), dtype=np.float32)
        tiles = plan.tiles()
        for i, (tile, idx, core, chunk) in enumerate(tiled.iter_tiles(plan, pts)):
            if should_cancel is not None and should_cancel():
                raise tiled.TiledCancelled()
            res = _eigen_normals(chunk, k, radius)
            res = orient(res, chunk, orientation=orientation,
                         origin=origin_arr[idx])
            out[idx[core]] = res[core]
            if progress is not None:
                progress(( i + 1) / max(1, len(tiles)), f"Tile {i + 1} of {len(tiles)}")
        return out

    return tiled.run_tiled(
        plan, pts,
        lambda chunk, core: _normals_tile_job(chunk, core, **job_kwargs),
        out_dtype=np.float32, fill=0.0, ncols=N_COLUMNS,
        progress=_tile_progress(progress), should_cancel=should_cancel)


def _tile_progress(progress):
    """Adapt a `_ProgressReporter` to `tiled`'s (fraction, message) callback.

    Returns None when there is nothing to report to, so `tiled` skips the call
    entirely rather than invoking a no-op per tile.
    """
    if progress is None:
        return None

    def report(fraction: float, message: str) -> None:
        progress(fraction, message)

    return report
