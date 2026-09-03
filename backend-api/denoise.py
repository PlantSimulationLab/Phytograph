"""Noise filtering for point clouds: index-preserving outlier masks + dispatch.

Canonical home for the three per-point noise criteria the Filter tool's "Noise"
section offers. ``qsm/preprocess.py`` re-imports the two it uses so there is
exactly one implementation of each; ``main._reject_sparse_voxels`` delegates its
voxel rule here for the same reason.

Every mask is a **keep**-mask (True = inlier, keep the point) aligned 1:1 with
the input rows, so a caller can scatter results back onto a session column
without losing the index correspondence. That is the whole reason these exist
rather than calling open3d's ``remove_statistical_outlier``, which returns a
filtered cloud and drops the mapping.

All distances in meters. Deterministic: no RNG anywhere, samples are taken on an
evenly-spaced index grid, so the same input always yields the same mask.

Why the default method is `ror` and not `sor`
---------------------------------------------
SOR thresholds each point's mean distance to its k nearest neighbours against
``mean + std_ratio * std`` taken over the WHOLE cloud. Both of those statistics
are set by whatever the most extreme population in the cloud happens to be, so
the threshold moves depending on what else is present. That makes SOR's effect
non-local and, worse, **non-idempotent in the dangerous direction**.

Measured on ``tests/noisy_tree_fixture.py`` (a dense 1 cm trunk, 360 twig points
at 5 cm — 10% of the cloud — 25 isolated flyers, and an 8-point self-supporting
clump):

    pass 1, flyers still present      flagged   trunk   twigs
      sor std_ratio=2.0                  33       0       0
      sor std_ratio=4.0                  33       0       0
      ror (defaults)                     25       0       0

    pass 2, on the SAME cloud after the flyers were removed
      sor std_ratio=2.0                 264       0     264   <-- 73% of the twigs
      sor std_ratio=4.0                  48       0      48
      sor std_ratio=6.0                   0       0       0
      ror (defaults)                      0       0       0

On pass 1 the flyers (mean_d of metres) inflate the std so much that the
threshold clears the twigs comfortably. Remove them — which is exactly what a
successful denoise does — and the threshold collapses onto the fine structure.
So running SOR twice destroys the twigs that the first run correctly kept, and
the "safe" std_ratio is a function of the noise that is still in the cloud,
which the user cannot know in advance. Its failure is silent (structure vanishes
and is reported as "noise removed") and asymmetric (it eats fine structure long
before it eats a dense trunk). That is not a safe default for a plant app, where
the fine peripheral structure IS the signal.

ROR asks a local, physical question instead — "does this point have at least N
other returns within r metres" — which is density- and translation-invariant,
independent of the rest of the cloud, idempotent, and reasonable about a radius
the user can check against their own scan resolution.

So: `ror` is the default, `sor` ships third and labelled advanced with
``DEFAULT_SOR_STD_RATIO = 4.0``. **Do not "restore the open3d default" of 2.0.**
``tests/test_denoise.py::test_sor_second_pass_eats_fine_structure`` pins the
table above.

SOR does have one genuine advantage worth keeping it for: it flags the
self-supporting 8-point clump that ROR and the voxel rule both miss, because
that clump's k-th neighbour is still metres away. Small-cluster removal is the
principled fix for that case; until it exists, SOR is the only method here that
catches it.

The voxel rule trades precision for speed and is coarser at the edges: on the
clean tree above it also clips 18 twig points whose branch end happens to fall
alone in a voxel. That is the documented cost of the O(N) method, which is why
it is offered for clouds too large for a KD-tree rather than as the default.
"""

from __future__ import annotations

import time
from typing import Any, Optional

import numpy as np
from scipy.spatial import cKDTree

# Session column written by the denoise endpoints. Two classes so the Filter
# panel's categorical checkbox UI stays trivial.
NOISE_CLASS_SLUG = "noise_class"
NOISE_CLASS_LABEL = "Noise Class"
NOISE_CLEAN = 1
NOISE_NOISE = 2

METHODS = ("ror", "voxel_count", "sor")

# --- auto-parameter multiples -------------------------------------------------
# Applied to the p95 nearest-neighbour distance (NOT the median -- see
# `nn_distance_percentile`). Clamped into [_AUTO_MIN_M, _AUTO_MAX_M] so a
# pathological spacing estimate can't produce a radius that swallows the plot or
# one so small every point is an outlier.
_ROR_RADIUS_MULTIPLE = 3.0
_VOXEL_SIZE_MULTIPLE = 5.0
_AUTO_MIN_M = 0.02
_AUTO_MAX_M = 0.50

DEFAULT_ROR_NB_POINTS = 2
DEFAULT_VOXEL_MIN_POINTS = 2
DEFAULT_SOR_NB_NEIGHBORS = 20
DEFAULT_SOR_STD_RATIO = 4.0  # NOT 2.0 -- see the module docstring.

# Fallbacks when spacing cannot be measured (too few points). These are
# `main._DENSITY_VOXEL_M` / `_DENSITY_MIN_PTS`, the values the registration
# density filter was swept for on real olive scans.
_FALLBACK_VOXEL_M = 0.10
_FALLBACK_RADIUS_M = 0.05

# Below this, a density estimate is not meaningful and every criterion degenerates.
MIN_POINTS = 1000
# Real TLS noise is 0.1-3% (this codebase measured 0.54% on an olive scan).
# Above this the parameters are almost certainly wrong, so the renderer makes the
# user confirm before the destructive commit. Detect itself never refuses.
OVER_REMOVAL_FRACTION = 0.20
# Past this, the KD-tree methods get slow enough to be worth a warning. Not a cap:
# the compute is cancellable and memory is O(N) once chunked.
LARGE_CLOUD_HINT = 30_000_000

_QUERY_CHUNK = 1_000_000


def _nn_distances(points: np.ndarray, sample: int = 200_000,
                  tree: "Optional[cKDTree]" = None) -> np.ndarray:
    """Nearest-neighbour distances over an evenly-spaced index sample of
    `points`, which must be finite. `tree` must have been built on exactly
    `points`; it is built here when not supplied.

    Deterministic: an evenly-spaced index sample, no RNG. Returns the positive
    finite distances only (possibly empty).

    Separate from `nn_distance_percentile` so that BOTH percentiles the panel
    reports come out of ONE query against ONE tree. They used to be two calls,
    i.e. two full cKDTree builds over the whole cloud plus a third for the
    criterion itself -- 3 x 16 s on a measured 45.7 M-point scan, two thirds of
    it pure duplication.
    """
    if len(points) < 100:
        return np.empty(0, dtype=np.float64)
    probe = points[np.linspace(0, len(points) - 1,
                               min(sample, len(points))).astype(np.int64)]
    if tree is None:
        tree = cKDTree(points)
    dist, _ = tree.query(probe, k=2, workers=-1)
    nn = dist[:, 1]
    return nn[np.isfinite(nn) & (nn > 0)]


def _percentile_or_none(nn: np.ndarray, q: float) -> Optional[float]:
    if nn.size == 0:
        return None
    value = float(np.percentile(nn, q))
    return value if np.isfinite(value) and value > 0 else None


def nn_distance_percentile(points: np.ndarray, q: float = 95.0,
                           sample: int = 200_000) -> Optional[float]:
    """Percentile of the nearest-neighbour distance, or None if unmeasurable.

    Deterministic: an evenly-spaced index sample, no RNG.

    `q=95` rather than the median on purpose. `qsm.preprocess._avg_nn_distance`
    takes the MEDIAN, which on a tree scan is set by the dense trunk -- exactly
    the wrong statistic for sizing a radius that must not eat twig tips. The
    sparse tail is the population the radius has to accommodate, so the radius is
    derived from the tail.

    Prefer `_nn_distances` + `_percentile_or_none` when you need more than one
    percentile: each call to THIS function builds its own tree.
    """
    finite = points[np.isfinite(points).all(axis=1)]
    return _percentile_or_none(_nn_distances(finite, sample), q)


def statistical_outlier_mask(points: np.ndarray, nb_neighbors: int = DEFAULT_SOR_NB_NEIGHBORS,
                             std_ratio: float = DEFAULT_SOR_STD_RATIO, *,
                             workers: int = -1, chunk: int = _QUERY_CHUNK,
                             tree: "Optional[cKDTree]" = None) -> np.ndarray:
    """Keep-mask for SOR: drop points whose mean distance to their `nb_neighbors`
    nearest neighbours exceeds ``mean + std_ratio * std`` over the whole cloud.

    Same criterion as open3d's ``remove_statistical_outlier``, but returns a mask.

    The query is CHUNKED. A one-shot ``tree.query(points, k=nb+1)`` materialises
    both the distances and the indices for every point: at 10 M points and k=21
    that is ~1.7 GB each, and only the per-row mean is ever used. Chunking keeps
    peak memory at O(chunk*k) while the accumulated `mean_d` stays O(N).
    """
    n = len(points)
    if n <= nb_neighbors:
        return np.ones(n, dtype=bool)
    if tree is None:
        tree = cKDTree(points)
    mean_d = np.empty(n, dtype=np.float64)
    step = max(1, int(chunk))
    for start in range(0, n, step):
        stop = min(start + step, n)
        d, _ = tree.query(points[start:stop], k=nb_neighbors + 1, workers=workers)
        mean_d[start:stop] = d[:, 1:].mean(axis=1)  # column 0 is the point itself
    thresh = mean_d.mean() + std_ratio * mean_d.std()
    return mean_d <= thresh


def radius_outlier_mask(points: np.ndarray, nb_points: int, radius: float, *,
                        workers: int = -1, chunk: int = _QUERY_CHUNK,
                        tree: "Optional[cKDTree]" = None) -> np.ndarray:
    """Keep-mask for ROR: keep points with at least `nb_points` OTHER returns
    within `radius`.

    `radius` is a physical length the user can reason about against their own
    scan resolution, which is why this is the default method: unlike SOR's
    ``std_ratio`` it is density- and translation-invariant, and it fails visibly.

    Asked as a BOUNDED k-NN query, not a neighbour count
    ------------------------------------------------------
    The criterion only needs to know whether the ``nb_points``-th other return
    falls inside `radius`, so it is answered by the distance to the
    ``nb_points + 1``-th nearest neighbour (column 0 is the point itself). The
    obvious spelling -- ``query_ball_point(..., return_length=True)`` -- instead
    COUNTS every neighbour in the ball, and that count is unbounded: the radius
    is derived from the SPARSE tail of the spacing distribution (3 x p95, see
    `nn_distance_percentile`) while the count is paid in the DENSEST region, so
    the cost of the query is set by exactly the population the radius is not
    sized for.

    Measured on a real TLS scan (`ScanPos003`, 1.31 M points): p50 spacing
    5.1 mm, p95 spacing 95.7 mm, auto radius 287 mm = 57x the median spacing,
    giving a MEDIAN of 1,051 neighbours per query and a max of 28,970 -- all
    enumerated to answer "are there at least 2". query_ball_point 6.9 s against
    0.2 s for the bounded k-NN form, a 32x speedup for a bit-identical mask; on
    a 45.7 M-point scan the same query extrapolated to ~147 s, which is what a
    user reported as a hang.

    The bound is a PRUNING hint only. ``distance_upper_bound`` is strict
    (``<``) whereas ``query_ball_point(r)`` is inclusive (``<=``), which flips
    every exactly-on-the-radius tie -- routine on lattice/voxel-quantised data,
    and in the dangerous direction (real structure reported as noise). So the
    bound is nudged one ulp outwards and the inclusive comparison is applied
    explicitly afterwards: nothing at distance <= radius can be pruned, and
    anything beyond it is rejected here.

    That leaves exactly one residual difference, and it is benign. The two
    scipy paths compute the same pair distance differently -- query_ball_point
    against a squared radius, `query` returning a correctly-rounded sqrt -- so
    a pair sitting at EXACTLY `radius` can land on opposite sides. Measured
    over 40 seeds x 3 cloud shapes x 5 radii x 7 nb_points values, every such
    disagreement is a point this form KEEPS and the count form drops, never the
    reverse: the residual errs toward preserving structure, which is the
    direction this whole module is biased. Pinned, in both halves, by
    `test_ror_matches_query_ball_point_except_on_exact_ties`.

    Nothing proportional to the neighbour lists is ever allocated: the chunked
    query holds O(chunk * nb_points) distances.

    `tree` may be a cKDTree already built on exactly `points`, to avoid a
    rebuild; it is built here when omitted.
    """
    n = len(points)
    if n == 0:
        return np.zeros(0, dtype=bool)
    if radius <= 0:
        return np.ones(n, dtype=bool)
    k = int(nb_points) + 1  # column 0 of the result is the point itself
    if tree is None:
        tree = cKDTree(points)
    # One ulp outwards: see the docstring. Anything at exactly `radius` must
    # survive the prune so the `<= radius` below can accept it.
    bound = float(np.nextafter(radius, np.inf))
    keep = np.empty(n, dtype=bool)
    step = max(1, int(chunk))
    for start in range(0, n, step):
        stop = min(start + step, n)
        d, _ = tree.query(points[start:stop], k=k,
                          distance_upper_bound=bound, workers=workers)
        # scipy returns (m,) for k == 1 and (m, k) otherwise; the k-th
        # neighbour is the last column, and is `inf` when it was pruned.
        kth = d if d.ndim == 1 else d[:, -1]
        keep[start:stop] = kth <= radius
    return keep


def voxel_count_mask(points: np.ndarray, voxel: float, min_points: int) -> np.ndarray:
    """Keep-mask: drop points whose voxel holds fewer than `min_points` returns.

    The O(N) method -- no KD-tree -- and so the one that stays usable on very
    large clouds. The discriminator is how many returns share a voxel: a canopy
    point sits in a voxel holding thousands, a flyer sits alone (measured
    medians on a real olive scan: 4685 against 2, with 90% of noise voxels
    holding a single point).

    NOT ``voxel_down_sample``, which keeps one point per occupied voxel and so
    PRESERVES sparse scatter while crushing dense canopy -- measured in this
    codebase at a 44:1 canopy collapse against 96.7% noise retention, turning a
    0.54% noise population into 18.9%. See `main._reject_sparse_voxels`.

    Unlike `_reject_sparse_voxels` this has no "cloud too small / removes too
    much" bail-out: that guard belongs to the registration caller, which needs a
    filter that can silently no-op. Labelling must report what the rule actually
    says and let the caller decide.
    """
    n = len(points)
    if n == 0:
        return np.zeros(0, dtype=bool)
    if voxel <= 0:
        return np.ones(n, dtype=bool)
    key = np.floor((points - points.min(axis=0)) / voxel).astype(np.int64)
    spans = [int(s) + 1 for s in key.max(axis=0)]
    # Pack the 3-D key into one int64 when the grid fits, which avoids
    # np.unique's slow structured-array path. Fall back to the row-wise unique
    # when the span product would overflow.
    if spans[0] * spans[1] * spans[2] < 2 ** 62:
        flat = (key[:, 0] * spans[1] + key[:, 1]) * spans[2] + key[:, 2]
        _, inverse, counts = np.unique(flat, return_inverse=True, return_counts=True)
    else:
        _, inverse, counts = np.unique(key, axis=0, return_inverse=True,
                                       return_counts=True)
    return counts[inverse] >= min_points


def needs_spacing(method: str, params: Optional[dict] = None) -> bool:
    """True when `resolve_params` would have to measure the cloud's spacing.

    False only when the user pinned every auto-fillable parameter for `method`,
    which is what lets `voxel_count` keep its promise of being the O(N) method
    with NO KD-tree: measuring spacing means building one over the whole cloud,
    so an auto-parameter voxel run was silently paying the very cost the method
    exists to avoid.
    """
    params = params or {}
    auto_keys = {
        "ror": ("radius",),
        "voxel_count": ("voxel",),
        "sor": (),  # SOR's defaults are absolute, not spacing-derived
    }.get(method, ())
    return any(params.get(k) is None for k in auto_keys)


def resolve_params(points: np.ndarray, method: str,
                   params: Optional[dict] = None,
                   tree: "Optional[cKDTree]" = None,
                   ) -> tuple[dict, Optional[float], Optional[float]]:
    """Fill any unset parameter for `method` from the cloud's own NN spacing.

    Returns ``(params_used, spacing_p50, spacing_p95)``. Only keys that are absent
    or None are filled, so an explicit user value always wins. Both spacings are
    reported: p50 is what the panel shows as "point spacing", p95 is what the
    auto radius/voxel are actually derived from.

    Both percentiles come out of ONE k-NN query against ONE tree (`tree`, built
    here when omitted, and reused by the criterion afterwards). They used to be
    two independent `nn_distance_percentile` calls, so a single ROR run built
    three full cKDTrees over the same cloud.

    Spacing is skipped entirely -- and returned as ``(None, None)`` -- only when
    no parameter depends on it AND no `tree` was handed in. Given a tree the
    measurement is one 200k-probe query, so it is always taken and reported.
    """
    params = dict(params or {})
    if tree is None and not needs_spacing(method, params):
        # No parameter depends on spacing and no tree exists to measure it for
        # free, so measuring would mean building one purely to fill in a number
        # the panel displays. Not worth a full-cloud tree build.
        return params, None, None
    nn = _nn_distances(points, tree=tree)
    p50 = _percentile_or_none(nn, 50.0)
    p95 = _percentile_or_none(nn, 95.0)

    def _auto(multiple: float, fallback: float) -> float:
        if p95 is None:
            return fallback
        return float(min(max(multiple * p95, _AUTO_MIN_M), _AUTO_MAX_M))

    if method == "ror":
        if params.get("radius") is None:
            params["radius"] = _auto(_ROR_RADIUS_MULTIPLE, _FALLBACK_RADIUS_M)
        if params.get("nb_points") is None:
            params["nb_points"] = DEFAULT_ROR_NB_POINTS
    elif method == "voxel_count":
        if params.get("voxel") is None:
            params["voxel"] = _auto(_VOXEL_SIZE_MULTIPLE, _FALLBACK_VOXEL_M)
        if params.get("min_points") is None:
            params["min_points"] = DEFAULT_VOXEL_MIN_POINTS
    elif method == "sor":
        if params.get("nb_neighbors") is None:
            params["nb_neighbors"] = DEFAULT_SOR_NB_NEIGHBORS
        if params.get("std_ratio") is None:
            params["std_ratio"] = DEFAULT_SOR_STD_RATIO
    return params, p50, p95


def denoise_mask(points: np.ndarray, method: str = "ror",
                 params: Optional[dict] = None,
                 previously_denoised: bool = False) -> tuple[np.ndarray, dict[str, Any]]:
    """Single dispatch point. Returns ``(keep_mask, stats)``, mask aligned 1:1
    with `points` (True = keep).

    Non-finite rows are flagged as noise and never reach the KD-tree: `cKDTree`
    RAISES on non-finite input, so an unguarded NaN is a crash, not a bad result.

    Raises ValueError for an unknown method or a cloud below `MIN_POINTS`; the
    endpoints turn those into 400s. It does NOT refuse on a high flagged
    fraction -- labelling is non-destructive, so an aggressive result is reported
    (`over_removal`) and the guard sits on the destructive commit instead.
    """
    if method not in METHODS:
        raise ValueError(f"unknown noise method {method!r}; expected one of {', '.join(METHODS)}")
    pts = np.asarray(points, dtype=np.float64)
    if pts.ndim != 2 or pts.shape[1] != 3:
        raise ValueError(f"expected an (N, 3) array, got {pts.shape}")
    total = len(pts)

    finite = np.isfinite(pts).all(axis=1)
    n_non_finite = int((~finite).sum())
    if total - n_non_finite < MIN_POINTS:
        raise ValueError(
            f"Need at least {MIN_POINTS} finite points to estimate density "
            f"reliably; got {total - n_non_finite}.")

    started = time.perf_counter()
    usable = pts[finite]

    # ONE tree for the whole run: the spacing percentiles and the criterion all
    # query the same points, and a build over a 45.7 M-point scan measured
    # 15.7 s. Built only when something actually needs it, so a fully-manual
    # `voxel_count` stays the KD-tree-free path it advertises.
    tree = None
    if method in ("ror", "sor") or needs_spacing(method, params):
        tree = cKDTree(usable)
    params_used, p50, p95 = resolve_params(usable, method, params, tree=tree)

    if method == "ror":
        sub = radius_outlier_mask(usable, int(params_used["nb_points"]),
                                  float(params_used["radius"]), tree=tree)
    elif method == "voxel_count":
        sub = voxel_count_mask(usable, float(params_used["voxel"]),
                               int(params_used["min_points"]))
    else:
        sub = statistical_outlier_mask(usable, int(params_used["nb_neighbors"]),
                                       float(params_used["std_ratio"]), tree=tree)
    # Drop the tree before the (cheap) accounting below: on a 45.7 M-point
    # cloud it is the largest allocation in the worker by a wide margin, and
    # this runs in a subprocess whose peak RSS is what the parent pays for.
    del tree

    keep = np.zeros(total, dtype=bool)  # non-finite rows stay False = noise
    keep[finite] = sub

    flagged = int((~keep).sum())
    fraction = flagged / total if total else 0.0
    warnings: list[str] = []
    if fraction > OVER_REMOVAL_FRACTION:
        warnings.append(
            f"{fraction * 100:.1f}% of points were flagged. Real scanner noise is "
            f"typically 0.1-3%, so these settings are probably too aggressive — "
            f"review the flagged points before removing them.")
    if total > LARGE_CLOUD_HINT and method in ("sor", "ror"):
        warnings.append(
            f"{total:,} points is large for a neighbour-search method; "
            f"'Sparse voxels' is much faster at this size.")
    if n_non_finite:
        warnings.append(f"{n_non_finite:,} point(s) had non-finite coordinates "
                        f"and were flagged as noise.")
    if previously_denoised and method == "sor":
        # SOR's threshold is set by the extremes still in the cloud, so a second
        # pass over an already-cleaned cloud collapses onto the fine structure —
        # measured at 73% of twig points destroyed. See the module docstring.
        warnings.append(
            "This cloud has already been denoised. Statistical (SOR) gets more "
            "aggressive on each pass — its threshold is set by the noise still "
            "present — so a second run tends to remove fine structure the first "
            "run correctly kept. Prefer 'Isolated points', or raise the "
            "std ratio.")

    stats = {
        "method": method,
        "params_used": params_used,
        "spacing_m": p50,
        "spacing_p95_m": p95,
        "total": total,
        "flagged": flagged,
        "kept": total - flagged,
        "fraction": fraction,
        "non_finite": n_non_finite,
        "over_removal": fraction > OVER_REMOVAL_FRACTION,
        "warnings": warnings,
        "elapsed_s": round(time.perf_counter() - started, 3),
    }
    return keep, stats


def denoise_labels(points: np.ndarray, method: str = "ror",
                   meta: Optional[dict] = None, **params) -> np.ndarray:
    """`denoise_mask` in the shape the killable segmentation worker expects:
    returns an int64 label array (NOISE_CLEAN / NOISE_NOISE) and writes the stats
    into `meta`. Mirrors `main.segment_ground(points, meta=..., **params)`.
    """
    # `previously_denoised` rides in with the params (the worker passes one flat
    # dict) but is a reporting flag, not a criterion parameter.
    previously_denoised = bool(params.pop("previously_denoised", False))
    keep, stats = denoise_mask(points, method, params, previously_denoised)
    if meta is not None:
        meta.update(stats)
    return np.where(keep, NOISE_CLEAN, NOISE_NOISE).astype(np.int64)
