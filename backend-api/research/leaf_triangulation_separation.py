#!/usr/bin/env python3
"""Validate scan-statistic thresholds for Helios leaf triangulation.

WHY THIS EXISTS
---------------
The Helios triangulation (``/api/triangulate/helios``) meshes returned LiDAR points
with a spherical Delaunay pass, then discards triangles whose longest edge exceeds
``Lmax``. The premise: *valid* triangles connect adjacent points on the **same leaf
surface** (edge ~ surface point spacing), while *erroneous* triangles bridge **different
leaves** (edge ~ inter-leaf gap). If those two scales are well separated, the result is
insensitive to ``Lmax`` within a band; if leaves are close relative to scan resolution,
they overlap and no ``Lmax`` cleanly separates them.

We want to eventually suggest ``Lmax`` from scan statistics and report a *confidence*
reflecting how cleanly the scales separate. Before building that into the product, this
harness answers: **can a label-free statistic predict the achievable separation?**

HOW IT WORKS (no C++ changes, no product UI)
--------------------------------------------
1. Build a PlantArchitecture plant. Each leaf/internode is a distinct Helios compound
   object, so we stamp a unique ``organ_id`` on every primitive grouped by parent object
   -> per-leaf GROUND TRUTH.
2. Synthetic-scan the plant with ``column_format=["organ_id"]`` so every returned hit
   carries the id of the organ it struck.
3. Triangulate the returned points through the SAME product path
   (``main._do_helios_computation``) with ``Lmax = inf`` so ALL candidate triangles
   survive. Delaunay reuses hit points as mesh vertices, so each triangle vertex maps
   back to its ``organ_id`` (nearest-neighbour lookup against the labelled hits).
4. Label each candidate triangle valid (all-same organ) vs erroneous (spans >=2 organs)
   and record its longest edge -- the variable the ``Lmax`` filter actually thresholds.
5. Compute the GROUND-TRUTH separability (how separable the valid/erroneous longest-edge
   populations are) and several LABEL-FREE statistics that try to predict it + suggest
   ``Lmax`` from the pooled, unlabelled longest edges. Compare.

Sweeping plant model / age / scanner count / scan resolution, we check whether a
label-free confidence tracks ground truth and whether the suggested ``Lmax`` lands near
the label-optimal one. Outputs: ``out/results.csv`` + per-run histogram PNGs + summary
scatter. Nothing here ships in the bundle.

Run from ``backend-api/`` with the venv active:
    python research/leaf_triangulation_separation.py            # default sweep
    python research/leaf_triangulation_separation.py --quick    # fast subset
    python research/leaf_triangulation_separation.py --models bean,almond --resolutions 400,900
"""

from __future__ import annotations

import argparse
import csv
import math
import os
import sys
from dataclasses import dataclass, asdict
from typing import List, Optional, Tuple

import numpy as np

# Make backend-api importable so we triangulate through the real product path,
# and let main.py put the vendored pyhelios submodule on sys.path at import time.
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_BACKEND_DIR = os.path.dirname(_THIS_DIR)
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

OUT_DIR = os.path.join(_THIS_DIR, "out")

# Default sweep -- chosen to span the separation regimes hard -> easy so the sweep
# exercises the full range the confidence value must distinguish. Fully overridable
# via CLI flags; any bundled PlantArchitecture model is valid (validated at runtime).
DEFAULT_MODELS = ["cherrytomato", "tomato", "bean", "cowpea", "almond"]
DEFAULT_AGES = [25.0, 45.0]
DEFAULT_SCANNERS = [1, 3]
DEFAULT_RESOLUTIONS = [200, 400, 800]  # per-axis samples (Ntheta == Nphi == value)
# Along-beam range-noise stddevs in METERS. 0 = clean (trivially separable at high res);
# the rest span realistic terrestrial-LiDAR noise, which is what actually stresses the
# threshold/confidence by broadening the intra-leaf edge mode.
DEFAULT_NOISES = [0.0, 0.005, 0.015]


# ----------------------------------------------------------------------------------
# Scene construction + per-organ ground-truth labelling
# ----------------------------------------------------------------------------------

def close_context(ctx) -> None:
    """Free a Context's native resources. Context exposes cleanup via the context-manager
    protocol (``__exit__``) / destructor rather than a ``close()`` method; we build it
    outside a ``with`` block (it must outlive labelling to be scanned), so release it
    explicitly here."""
    if ctx is not None:
        ctx.__exit__(None, None, None)


def label_organs(ctx, plant_uuids: List[int]) -> int:
    """Stamp a dense ``organ_id`` (0..N-1) on every plant primitive, grouped by the
    Helios compound object it belongs to. Returns the organ count.

    GRANULARITY NOTE (important for ground-truth correctness): the grouping is per
    *compound object*, which in PlantArchitecture is one per individual organ surface --
    and crucially, one per LEAFLET, not one per compound leaf. A trifoliate leaf (e.g.
    bean) is built as three separate leaflet objects: the leaf prototype function is
    invoked once per leaflet (PlantArchitecture.cpp ~2017/2044, ind_from_tip =
    tip/left/right), each returning its own objID. So the three leaflets receive three
    distinct organ_ids, and a triangle bridging two leaflets of the same compound leaf is
    correctly labelled erroneous -- which is exactly the case that matters most, since
    leaflets sit closer together than separate leaves. (Verified: bean yields ~one
    leaflet-sized object per leaflet, each a single contiguous patch.)"""
    objs = ctx.getUniquePrimitiveParentObjectIDs(list(plant_uuids), include_zero=False)
    covered = set()
    next_id = 0
    for obj in objs:
        uu = ctx.getObjectPrimitiveUUIDs(int(obj))
        if not uu:
            continue
        ctx.setPrimitiveDataInt(list(uu), "organ_id", next_id)
        covered.update(int(u) for u in uu)
        next_id += 1
    # Any primitive with no parent object (sentinel object 0) gets its own id so the
    # scene is fully labelled and no hit comes back without an organ_id.
    for u in plant_uuids:
        if int(u) not in covered:
            ctx.setPrimitiveDataInt(int(u), "organ_id", next_id)
            next_id += 1
    return next_id


@dataclass
class Scanner:
    origin: Tuple[float, float, float]
    theta_min: float  # radians, zenith from +z
    theta_max: float
    phi_min: float    # radians, azimuth in xy-plane from +x
    phi_max: float


def _helios_spherical(origin: np.ndarray, target: np.ndarray) -> Tuple[float, float]:
    """(zenith, azimuth) of ``target`` seen from ``origin`` in Helios's convention.
    From sphere2cart (global.cpp): x = sin(zenith)·sin(azimuth), y = sin(zenith)·cos(azimuth),
    z = cos(zenith) -- so zenith = acos(dz/r) and azimuth = atan2(dx, dy) (NOT atan2(dy, dx))."""
    d = target - origin
    r = float(np.linalg.norm(d))
    zenith = math.acos(max(-1.0, min(1.0, d[2] / r)))
    azimuth = math.atan2(d[0], d[1])
    return zenith, azimuth


def plan_scanners(lo: np.ndarray, hi: np.ndarray, n_scanners: int,
                  distance_factor: float = 2.0, margin_deg: float = 6.0) -> List[Scanner]:
    """Place ``n_scanners`` evenly on a horizontal ring around the plant at mid-height,
    each aimed so its (zenith, azimuth) field of view just encloses the plant AABB (plus a
    margin). The FOV is derived by projecting the 8 AABB corners into Helios spherical
    coordinates, which sidesteps the engine's azimuth convention (atan2(x, y)) and its
    negative-phiMin truncation. A tight FOV means modest Ntheta/Nphi already gives good
    leaf coverage, so resolution is a clean knob to sweep."""
    c = (lo + hi) / 2.0
    s = hi - lo
    R = distance_factor * max(0.5 * math.hypot(s[0], s[1]), 0.5 * s[2], 1e-3)
    m = math.radians(margin_deg)
    corners = np.array([[x, y, z] for x in (lo[0], hi[0])
                        for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])
    scanners: List[Scanner] = []
    for k in range(n_scanners):
        ang = 2.0 * math.pi * k / max(n_scanners, 1)
        o = np.array([c[0] + R * math.cos(ang), c[1] + R * math.sin(ang), c[2]])
        _, center_az = _helios_spherical(o, c)
        zeniths, azimuths = [], []
        for cor in corners:
            z_, a_ = _helios_spherical(o, cor)
            zeniths.append(z_)
            # Unwrap each corner's azimuth to within pi of the centre so min/max don't
            # straddle the 0/2pi seam.
            azimuths.append(center_az + ((a_ - center_az + math.pi) % (2.0 * math.pi) - math.pi))
        zeniths = np.array(zeniths)
        azimuths = np.array(azimuths)
        phi_lo, phi_hi = azimuths.min() - m, azimuths.max() + m
        # Helios truncates a negative phiMin to 0 (wrecking the aim); azimuth is periodic,
        # and phiMax up to 4pi is accepted, so shift the whole window positive if needed.
        if phi_lo < 0:
            phi_lo += 2.0 * math.pi
            phi_hi += 2.0 * math.pi
        scanners.append(Scanner(
            origin=(float(o[0]), float(o[1]), float(o[2])),
            theta_min=max(float(zeniths.min()) - m, 1e-3),
            theta_max=min(float(zeniths.max()) + m, math.pi - 1e-3),
            phi_min=phi_lo,
            phi_max=phi_hi,
        ))
    return scanners


def build_labeled_plant(model: str, age: float, seed: Optional[int] = None):
    """Build + label a plant. Returns (ctx, plant_uuids, n_organs, (lo, hi)).

    Pass ``seed`` to make the (otherwise stochastic) build reproducible -- useful for
    deterministic tests and comparable sweep re-runs. The Context is returned OPEN; the
    caller is responsible for closing it (it owns the geometry the synthetic scan
    ray-traces)."""
    from pyhelios import Context, PlantArchitecture
    from pyhelios.types import vec3

    ctx = Context()
    if seed is not None:
        ctx.seedRandomGenerator(int(seed))
    pa = PlantArchitecture(ctx)
    pa.loadPlantModelFromLibrary(model)
    pid = pa.buildPlantInstanceFromLibrary(vec3(0.0, 0.0, 0.0), float(age))
    uuids = [int(u) for u in pa.getAllPlantUUIDs(pid)]
    if not uuids:
        close_context(ctx)
        raise RuntimeError(f"Plant '{model}' (age {age}) produced no geometry")
    n_org = label_organs(ctx, uuids)
    lo_v, hi_v = ctx.getPrimitiveBoundingBox(uuids)
    lo = np.array([lo_v.x, lo_v.y, lo_v.z])
    hi = np.array([hi_v.x, hi_v.y, hi_v.z])
    return ctx, uuids, n_org, (lo, hi)


def scan_plant(ctx, scanners: List[Scanner], n_theta: int, n_phi: int,
               range_noise: float = 0.0, angle_noise: float = 0.0):
    """Synthetic-scan the labelled scene. Returns (xyz (M,3), organ (M,), scan_id (M,))
    where ``organ`` is the per-hit organ_id (NaN if the struck primitive had none).

    ``range_noise`` (m) is Gaussian along-beam range jitter and ``angle_noise`` (rad) is
    beam-pointing jitter. Range noise is the realism that matters here: it pushes hits off
    the true leaf surface, broadening the intra-leaf edge-length mode and eroding its
    separation from the inter-leaf mode -- i.e. it makes the threshold genuinely hard to
    find, unlike a clean high-res scan. Angular topology is preserved, so the triangulation
    connectivity is unchanged; only the 3-D edge lengths get noisier."""
    from pyhelios import LiDARCloud

    with LiDARCloud() as lidar:
        lidar.disableMessages()
        for sc in scanners:
            lidar.addScan(
                origin=list(sc.origin),
                Ntheta=int(n_theta), theta_range=(sc.theta_min, sc.theta_max),
                Nphi=int(n_phi), phi_range=(sc.phi_min, sc.phi_max),
                exit_diameter=0.0, beam_divergence=0.0,
                column_format=["organ_id"],
                range_noise_stddev=float(range_noise),
                angle_noise_stddev=float(angle_noise),
            )
        lidar.syntheticScan(ctx)
        n = lidar.getHitCount()
        if n == 0:
            return np.empty((0, 3)), np.empty((0,)), np.empty((0,), dtype=np.int64)
        organ = np.asarray(lidar.getHitDataAll("organ_id"), dtype=np.float64)
        xyz = np.empty((n, 3), dtype=np.float64)
        sid = np.empty(n, dtype=np.int64)
        for i in range(n):
            p = lidar.getHitXYZ(i)
            xyz[i] = (p.x, p.y, p.z)
            sid[i] = lidar.getHitScanID(i)
    return xyz, organ, sid


# ----------------------------------------------------------------------------------
# Triangulation through the product path + ground-truth triangle classification
# ----------------------------------------------------------------------------------

# Big finite Lmax / aspect: keep every candidate triangle (only degenerate/NaN are
# dropped) so we recover the full unfiltered candidate distribution.
_KEEP_ALL = 1.0e9


def triangulate_candidates(xyz: np.ndarray, organ: np.ndarray, sid: np.ndarray,
                           scanners: List[Scanner], n_theta: int, n_phi: int):
    """Triangulate the scanned points via the shipping ``_do_helios_computation`` with
    no edge/aspect filter. Returns (max_edge (T,), erroneous (T, bool), n_unlabelled).

    ``max_edge`` is each candidate triangle's longest edge -- exactly the quantity the
    product's ``Lmax`` filter thresholds. ``erroneous`` is the ground-truth label
    (triangle spans >=2 organs). Triangles touching an unlabelled vertex are excluded
    from both arrays and counted in ``n_unlabelled``."""
    from main import _do_helios_computation, HeliosTriangulationRequest, HeliosScanEntry
    from scipy.spatial import cKDTree

    entries = []
    for k, sc in enumerate(scanners):
        pts = xyz[sid == k]
        if len(pts) < 3:
            continue
        entries.append(HeliosScanEntry(
            points=pts.tolist(),
            origin=list(sc.origin),
            n_theta=int(n_theta), n_phi=int(n_phi),
            theta_min=math.degrees(sc.theta_min), theta_max=math.degrees(sc.theta_max),
            phi_min=math.degrees(sc.phi_min), phi_max=math.degrees(sc.phi_max),
        ))
    if not entries:
        return np.empty((0,)), np.empty((0,), dtype=bool), 0

    res = _do_helios_computation(HeliosTriangulationRequest(
        scans=entries, lmax=_KEEP_ALL, max_aspect_ratio=_KEEP_ALL))
    if not res.get("success") or not res.get("triangles"):
        return np.empty((0,)), np.empty((0,), dtype=bool), 0

    V = np.asarray(res["vertices"], dtype=np.float64)
    T = np.asarray(res["triangles"], dtype=np.int64)

    # Map each output vertex back to the organ of its source hit. Delaunay reuses hit
    # points as vertices, so the nearest labelled hit is the same point (distance ~0,
    # robust to the %.6g temp-file round-trip _do_helios_computation does internally).
    tree = cKDTree(xyz)
    _, idx = tree.query(V, k=1)
    vert_organ = organ[idx]

    a, b, c = V[T[:, 0]], V[T[:, 1]], V[T[:, 2]]
    e = np.maximum.reduce([
        np.linalg.norm(a - b, axis=1),
        np.linalg.norm(b - c, axis=1),
        np.linalg.norm(c - a, axis=1),
    ])
    oa, ob, oc = vert_organ[T[:, 0]], vert_organ[T[:, 1]], vert_organ[T[:, 2]]

    labelled = np.isfinite(oa) & np.isfinite(ob) & np.isfinite(oc)
    n_unlabelled = int((~labelled).sum())
    e = e[labelled]
    oa, ob, oc = oa[labelled], ob[labelled], oc[labelled]
    erroneous = ~((oa == ob) & (ob == oc))
    return e, erroneous, n_unlabelled


# ----------------------------------------------------------------------------------
# Ground-truth separability (uses labels) -- the thing we wish we could measure on
# real data, and the target the label-free statistics are scored against.
# ----------------------------------------------------------------------------------

def rank_auc(scores: np.ndarray, positive: np.ndarray) -> float:
    """AUC of ``scores`` predicting the boolean ``positive`` (tie-averaged ranks). Here:
    P(longest edge of an erroneous triangle > that of a valid one)."""
    n_pos = int(positive.sum())
    n_neg = int((~positive).sum())
    if n_pos == 0 or n_neg == 0:
        return float("nan")
    order = np.argsort(scores, kind="mergesort")
    ranks = np.empty(len(scores), dtype=np.float64)
    ranks[order] = np.arange(1, len(scores) + 1, dtype=np.float64)
    # Average ranks within tied groups.
    s_sorted = scores[order]
    i = 0
    while i < len(s_sorted):
        j = i + 1
        while j < len(s_sorted) and s_sorted[j] == s_sorted[i]:
            j += 1
        if j - i > 1:
            ranks[order[i:j]] = (i + 1 + j) / 2.0
        i = j
    return (ranks[positive].sum() - n_pos * (n_pos + 1) / 2.0) / (n_pos * n_neg)


def optimal_threshold(edges: np.ndarray, erroneous: np.ndarray) -> Tuple[float, float, float, float]:
    """Label-optimal Lmax* = longest-edge threshold minimising balanced error (mean of
    valid-drop rate and erroneous-keep rate). Returns
    (Lmax*, balanced_error, valid_recall, erroneous_contamination) at Lmax*."""
    valid = ~erroneous
    n_valid, n_err = int(valid.sum()), int(erroneous.sum())
    if n_valid == 0 or n_err == 0:
        return float("nan"), float("nan"), float("nan"), float("nan")
    cand = np.unique(edges)
    if len(cand) > 512:
        cand = np.quantile(edges, np.linspace(0, 1, 512))
    best = (float("nan"), 1.0, float("nan"), float("nan"))
    for t in cand:
        kept = edges <= t
        valid_recall = float((kept & valid).sum()) / n_valid          # kept valid
        err_keep = float((kept & erroneous).sum()) / n_err            # kept erroneous (bad)
        bal_err = 0.5 * ((1.0 - valid_recall) + err_keep)
        if bal_err < best[1]:
            best = (float(t), bal_err, valid_recall, err_keep)
    return best


# ----------------------------------------------------------------------------------
# Label-free statistics -- computed from the pooled, UNLABELLED longest edges. These
# are the candidates we are validating; "decide empirically" means scoring each below.
# ----------------------------------------------------------------------------------

def _log_edges(edges: np.ndarray) -> np.ndarray:
    return np.log(edges[edges > 0])


def stat_otsu(edges: np.ndarray, nbins: int = 256) -> Tuple[float, float]:
    """Otsu's threshold on log(longest edge). Returns (suggested_Lmax, confidence).
    The threshold maximises the between-class variance of the two implied populations;
    the confidence is the separability eta = max between-class / total variance, in
    [0, 1] (1 = perfectly separated two modes, 0 = unimodal). Hand-rolled from a numpy
    histogram so the harness has no scikit-image dependency."""
    x = _log_edges(edges)
    if len(x) < 8 or np.allclose(x, x[0]):
        return float("nan"), 0.0
    hist, bin_edges = np.histogram(x, bins=nbins)
    centers = 0.5 * (bin_edges[:-1] + bin_edges[1:])
    p = hist.astype(np.float64) / hist.sum()
    omega = np.cumsum(p)                      # class-0 weight for each split
    mu = np.cumsum(p * centers)
    mu_t = mu[-1]
    denom = omega * (1.0 - omega)
    with np.errstate(divide="ignore", invalid="ignore"):
        sigma_b2 = np.where(denom > 1e-12, (mu_t * omega - mu) ** 2 / denom, 0.0)
    idx = int(np.argmax(sigma_b2))
    total_var = float((p * (centers - mu_t) ** 2).sum())
    eta = float(sigma_b2[idx] / (total_var + 1e-12))
    return float(np.exp(centers[idx])), max(0.0, min(1.0, eta))


def _norm_pdf(x, mu, sd):
    return np.exp(-0.5 * ((x - mu) / sd) ** 2) / (sd * math.sqrt(2 * math.pi))


def stat_gmm(edges: np.ndarray, iters: int = 200) -> Tuple[float, float]:
    """Two-component Gaussian mixture (1-D EM) on log(longest edge). Returns
    (suggested_Lmax = component crossover, confidence = 1 - Bhattacharyya overlap)."""
    x = _log_edges(edges)
    if len(x) < 16 or np.allclose(x, x[0]):
        return float("nan"), 0.0
    mu = np.array([np.percentile(x, 25), np.percentile(x, 75)], dtype=np.float64)
    sd = np.array([x.std(), x.std()], dtype=np.float64) / 2.0 + 1e-6
    w = np.array([0.5, 0.5])
    for _ in range(iters):
        p0 = w[0] * _norm_pdf(x, mu[0], sd[0])
        p1 = w[1] * _norm_pdf(x, mu[1], sd[1])
        tot = p0 + p1 + 1e-300
        r0, r1 = p0 / tot, p1 / tot
        n0, n1 = r0.sum(), r1.sum()
        if n0 < 1e-6 or n1 < 1e-6:
            break
        mu = np.array([(r0 * x).sum() / n0, (r1 * x).sum() / n1])
        sd = np.array([
            math.sqrt((r0 * (x - mu[0]) ** 2).sum() / n0) + 1e-6,
            math.sqrt((r1 * (x - mu[1]) ** 2).sum() / n1) + 1e-6,
        ])
        w = np.array([n0, n1]) / len(x)
    lo_i, hi_i = (0, 1) if mu[0] <= mu[1] else (1, 0)
    m0, s0, m1, s1 = mu[lo_i], sd[lo_i], mu[hi_i], sd[hi_i]
    # Crossover: numerically, the point in (m0, m1) where the two weighted Gaussians
    # are equal (decision boundary between intra- and inter-leaf modes).
    grid = np.linspace(m0, m1, 512)
    diff = w[lo_i] * _norm_pdf(grid, m0, s0) - w[hi_i] * _norm_pdf(grid, m1, s1)
    sign = np.where(np.diff(np.sign(diff)) != 0)[0]
    thr = float(grid[sign[0]]) if len(sign) else float(0.5 * (m0 + m1))
    bc = math.sqrt(2 * s0 * s1 / (s0 ** 2 + s1 ** 2)) * \
        math.exp(-0.25 * (m0 - m1) ** 2 / (s0 ** 2 + s1 ** 2))
    return float(np.exp(thr)), max(0.0, min(1.0, 1.0 - bc))


def stat_nn_spacing(xyz: np.ndarray, k_mult: float = 4.0) -> Tuple[float, float]:
    """Baseline: Lmax = k * median nearest-neighbour spacing. No confidence (returns nan)."""
    from scipy.spatial import cKDTree

    if len(xyz) < 2:
        return float("nan"), float("nan")
    tree = cKDTree(xyz)
    d, _ = tree.query(xyz, k=2)
    return float(k_mult * np.median(d[:, 1])), float("nan")


# ----------------------------------------------------------------------------------
# One run + the sweep
# ----------------------------------------------------------------------------------

@dataclass
class RunResult:
    model: str
    age: float
    n_scanners: int
    resolution: int
    range_noise: float
    n_organs: int
    n_hits: int
    n_candidates: int
    erroneous_frac: float
    n_unlabelled: int
    # Ground truth
    gt_auc: float
    lmax_optimal: float
    gt_balanced_error: float
    gt_valid_recall: float
    gt_contamination: float
    # Label-free statistics: suggested Lmax + confidence, and what that Lmax achieves.
    otsu_lmax: float
    otsu_confidence: float
    otsu_valid_recall: float
    otsu_contamination: float
    gmm_lmax: float
    gmm_confidence: float
    gmm_valid_recall: float
    gmm_contamination: float
    nn_lmax: float
    nn_valid_recall: float
    nn_contamination: float


def _achieved(edges: np.ndarray, erroneous: np.ndarray, lmax: float) -> Tuple[float, float]:
    """valid_recall, erroneous_contamination if the product kept triangles at this Lmax."""
    valid = ~erroneous
    n_valid, n_err = int(valid.sum()), int(erroneous.sum())
    if not np.isfinite(lmax) or n_valid == 0 or n_err == 0:
        return float("nan"), float("nan")
    kept = edges <= lmax
    return (float((kept & valid).sum()) / n_valid,
            float((kept & erroneous).sum()) / n_err)


def run_one(model: str, age: float, n_scanners: int, resolution: int,
            make_plots: bool, range_noise: float = 0.0,
            seed: Optional[int] = None) -> Optional[RunResult]:
    tag = (f"{model} age={age:g} scan={n_scanners} res={resolution} "
           f"noise={range_noise*100:g}cm")
    ctx = None
    try:
        ctx, uuids, n_org, (lo, hi) = build_labeled_plant(model, age, seed=seed)
        scanners = plan_scanners(lo, hi, n_scanners)
        xyz, organ, sid = scan_plant(ctx, scanners, resolution, resolution,
                                     range_noise=range_noise)
    finally:
        close_context(ctx)

    if len(xyz) < 16:
        print(f"  [skip] {tag}: only {len(xyz)} hits")
        return None

    edges, erroneous, n_unlabelled = triangulate_candidates(
        xyz, organ, sid, scanners, resolution, resolution)
    if len(edges) < 16 or erroneous.all() or (~erroneous).all():
        print(f"  [skip] {tag}: {len(edges)} candidates, "
              f"erroneous_frac={erroneous.mean() if len(edges) else float('nan'):.2f}")
        return None

    gt_auc = rank_auc(edges, erroneous)
    lmax_opt, gt_bal_err, gt_recall, gt_contam = optimal_threshold(edges, erroneous)

    otsu_lmax, otsu_conf = stat_otsu(edges)
    gmm_lmax, gmm_conf = stat_gmm(edges)
    nn_lmax, _ = stat_nn_spacing(xyz)

    otsu_r, otsu_c = _achieved(edges, erroneous, otsu_lmax)
    gmm_r, gmm_c = _achieved(edges, erroneous, gmm_lmax)
    nn_r, nn_c = _achieved(edges, erroneous, nn_lmax)

    if make_plots:
        _plot_run(model, age, n_scanners, resolution, range_noise, edges, erroneous,
                  lmax_opt, otsu_lmax, gmm_lmax, gt_auc, otsu_conf, gmm_conf)

    return RunResult(
        model=model, age=age, n_scanners=n_scanners, resolution=resolution,
        range_noise=range_noise,
        n_organs=n_org, n_hits=len(xyz), n_candidates=len(edges),
        erroneous_frac=float(erroneous.mean()), n_unlabelled=n_unlabelled,
        gt_auc=gt_auc, lmax_optimal=lmax_opt, gt_balanced_error=gt_bal_err,
        gt_valid_recall=gt_recall, gt_contamination=gt_contam,
        otsu_lmax=otsu_lmax, otsu_confidence=otsu_conf,
        otsu_valid_recall=otsu_r, otsu_contamination=otsu_c,
        gmm_lmax=gmm_lmax, gmm_confidence=gmm_conf,
        gmm_valid_recall=gmm_r, gmm_contamination=gmm_c,
        nn_lmax=nn_lmax, nn_valid_recall=nn_r, nn_contamination=nn_c,
    )


def _plot_run(model, age, n_scanners, resolution, range_noise, edges, erroneous,
              lmax_opt, otsu_lmax, gmm_lmax, gt_auc, otsu_conf, gmm_conf):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    x = np.log10(edges[edges > 0])
    xe = np.log10(edges[(edges > 0) & erroneous])
    xv = np.log10(edges[(edges > 0) & ~erroneous])
    bins = np.linspace(x.min(), x.max(), 60)
    fig, ax = plt.subplots(figsize=(8, 4.5))
    ax.hist(xv, bins=bins, alpha=0.6, label=f"valid (intra-organ, n={len(xv)})", color="#2e7d32")
    ax.hist(xe, bins=bins, alpha=0.6, label=f"erroneous (inter-organ, n={len(xe)})", color="#c62828")
    for val, name, style in [(lmax_opt, "Lmax* (label-optimal)", "k-"),
                             (otsu_lmax, "Otsu", "b--"),
                             (gmm_lmax, "GMM", "m:")]:
        if np.isfinite(val) and val > 0:
            ax.axvline(np.log10(val), linestyle=style[1:], color=style[0],
                       label=f"{name} = {val*100:.2f} cm")
    ax.set_xlabel("log10(longest triangle edge / m)")
    ax.set_ylabel("count")
    ax.set_title(f"{model} age={age:g} scanners={n_scanners} res={resolution} "
                 f"noise={range_noise*100:g}cm\n"
                 f"GT AUC={gt_auc:.3f}  Otsu conf={otsu_conf:.2f}  GMM conf={gmm_conf:.2f}")
    ax.legend(fontsize=8)
    fig.tight_layout()
    os.makedirs(OUT_DIR, exist_ok=True)
    fname = f"hist_{model}_age{age:g}_sc{n_scanners}_res{resolution}_n{range_noise*100:g}.png"
    fig.savefig(os.path.join(OUT_DIR, fname), dpi=110)
    plt.close(fig)


def _plot_summary(results: List[RunResult]):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(1, 2, figsize=(12, 5))
    for ax, (conf_attr, title) in zip(axes, [("otsu_confidence", "Otsu"),
                                             ("gmm_confidence", "GMM")]):
        conf = np.array([getattr(r, conf_attr) for r in results])
        auc = np.array([r.gt_auc for r in results])
        ax.scatter(conf, auc, c="#2e7d32", alpha=0.8)
        ok = np.isfinite(conf) & np.isfinite(auc)
        if ok.sum() >= 2:
            rho = np.corrcoef(conf[ok], auc[ok])[0, 1]
            ax.set_title(f"{title} confidence vs ground-truth separability\nPearson r = {rho:.3f}")
        else:
            ax.set_title(f"{title} confidence vs ground-truth separability")
        ax.set_xlabel(f"{title} confidence (label-free)")
        ax.set_ylabel("ground-truth AUC (edge predicts inter-organ)")
        ax.set_xlim(0, 1)
        ax.set_ylim(0.5, 1.0)
    fig.tight_layout()
    os.makedirs(OUT_DIR, exist_ok=True)
    fig.savefig(os.path.join(OUT_DIR, "summary_confidence_vs_truth.png"), dpi=110)
    plt.close(fig)


def validate_models(requested: List[str]) -> List[str]:
    """Fail fast on a typo: validate requested model names against the library."""
    from pyhelios import Context, PlantArchitecture
    with Context() as ctx:
        available = set(PlantArchitecture(ctx).getAvailablePlantModels())
    bad = [m for m in requested if m not in available]
    if bad:
        raise SystemExit(
            f"Unknown plant model(s): {', '.join(bad)}\n"
            f"Available: {', '.join(sorted(available))}")
    return requested


def main():
    global OUT_DIR
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--models", type=str, default=None,
                    help="comma-separated PlantArchitecture model names")
    ap.add_argument("--ages", type=str, default=None, help="comma-separated ages (days)")
    ap.add_argument("--scanners", type=str, default=None,
                    help="comma-separated scanner counts")
    ap.add_argument("--resolutions", type=str, default=None,
                    help="comma-separated per-axis sample counts (Ntheta==Nphi)")
    ap.add_argument("--noise", type=str, default=None,
                    help="comma-separated range-noise stddevs in METERS (along-beam). "
                         "0 = clean. Realistic terrestrial LiDAR ~ 0.002-0.02 m.")
    ap.add_argument("--quick", action="store_true",
                    help="fast subset: 2 models, 1 age, 1 scanner, 2 resolutions, 2 noise")
    ap.add_argument("--no-plots", action="store_true", help="skip PNG generation")
    ap.add_argument("--out", type=str, default=OUT_DIR, help="output directory")
    args = ap.parse_args()

    def parse(s, cast, default):
        return [cast(x) for x in s.split(",")] if s else default

    if args.quick:
        models = parse(args.models, str, ["cherrytomato", "almond"])
        ages = parse(args.ages, float, [35.0])
        scanners = parse(args.scanners, int, [1])
        resolutions = parse(args.resolutions, int, [200, 600])
        noises = parse(args.noise, float, [0.0, 0.01])
    else:
        models = parse(args.models, str, DEFAULT_MODELS)
        ages = parse(args.ages, float, DEFAULT_AGES)
        scanners = parse(args.scanners, int, DEFAULT_SCANNERS)
        resolutions = parse(args.resolutions, int, DEFAULT_RESOLUTIONS)
        noises = parse(args.noise, float, DEFAULT_NOISES)

    OUT_DIR = os.path.abspath(args.out)
    os.makedirs(OUT_DIR, exist_ok=True)

    models = validate_models(models)
    print(f"Sweep: models={models} ages={ages} scanners={scanners} "
          f"resolutions={resolutions} noises(m)={noises}")
    print(f"Output -> {OUT_DIR}")

    results: List[RunResult] = []
    for model in models:
        for age in ages:
            # One seed per (model, age) so the SAME plant is scanned across every
            # resolution/noise combo -- isolating those effects from plant-to-plant
            # variance. crc32 is stable across processes (unlike hash()).
            import zlib
            seed = zlib.crc32(f"{model}:{age}".encode()) & 0x7FFFFFFF
            for nsc in scanners:
                for res in resolutions:
                    for noise in noises:
                        print(f"[run] {model} age={age:g} scanners={nsc} res={res} "
                              f"noise={noise*100:g}cm")
                        try:
                            r = run_one(model, age, nsc, res,
                                        make_plots=not args.no_plots,
                                        range_noise=noise, seed=seed)
                        except Exception as exc:  # research harness: keep the sweep going
                            import traceback
                            traceback.print_exc()
                            print(f"  [error] {exc}")
                            continue
                        if r is None:
                            continue
                        results.append(r)
                        print(f"  hits={r.n_hits} cand={r.n_candidates} "
                              f"err_frac={r.erroneous_frac:.2f} | GT AUC={r.gt_auc:.3f} "
                              f"Lmax*={r.lmax_optimal*100:.2f}cm | "
                              f"Otsu={r.otsu_lmax*100:.2f}cm(conf {r.otsu_confidence:.2f}) "
                              f"GMM={r.gmm_lmax*100:.2f}cm(conf {r.gmm_confidence:.2f})")

    if not results:
        print("No successful runs.")
        return

    csv_path = os.path.join(OUT_DIR, "results.csv")
    with open(csv_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(asdict(results[0]).keys()))
        w.writeheader()
        for r in results:
            w.writerow(asdict(r))
    print(f"\nWrote {len(results)} rows -> {csv_path}")

    if not args.no_plots:
        _plot_summary(results)
        print(f"Wrote summary plot -> {os.path.join(OUT_DIR, 'summary_confidence_vs_truth.png')}")

    # Which label-free confidence best tracks ground-truth separability?
    for attr, name in [("otsu_confidence", "Otsu"), ("gmm_confidence", "GMM")]:
        conf = np.array([getattr(r, attr) for r in results])
        auc = np.array([r.gt_auc for r in results])
        ok = np.isfinite(conf) & np.isfinite(auc)
        if ok.sum() >= 2:
            print(f"  {name}: Pearson(confidence, GT AUC) = "
                  f"{np.corrcoef(conf[ok], auc[ok])[0, 1]:.3f}")


if __name__ == "__main__":
    main()
