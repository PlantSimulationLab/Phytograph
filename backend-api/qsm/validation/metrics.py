"""Statistical / geometric comparison metrics for QSM validation.

All metrics operate on arc-length-uniform resampled centerline samples (see
``resample``), never cylinder-to-cylinder, because the ground-truth tessellation
is arbitrary relative to the reconstruction.

Each metric returns a dataclass of *raw numbers* (never a bare pass/fail). Tests
print the full report then assert on bars defined in ``tests/qsm/tolerances.py``
-- mirroring the print-then-assert convention of ``test_ground_segment.py``.

The user's "statistics can lie" requirement is met by pairing every gameable
scalar with a guard:
- centerline mean/Hausdorff  <->  two-sided coverage (cov_gt AND cov_recon)
- radius RMSE                <->  per-bin, arc-length-weighted, stem/branch split
- distribution KS test       <->  AND-ed with mean-absolute-difference
- rank accuracy              <->  exact rank-0 count + per-rank precision/recall
                                  + per-rank arc length + unmatched fraction
- all GT comparisons         <->  a GT-independent cloud-anchored centerline check
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.spatial import cKDTree
from scipy.stats import ks_2samp

from ..model import QSM, Cylinder
from .resample import (
    DEFAULT_DS,
    CenterlineSamples,
    centerline_samples,
    surface_samples,
)


def point_to_cylinder_surface_distance(
    points: np.ndarray, qsm: QSM
) -> np.ndarray:
    """Unsigned distance from each point to the NEAREST cylinder surface in the
    QSM. Used by preprocessing validation ("retained points sit on real wood")
    and as a building block elsewhere.

    For each cylinder, distance to the finite cylinder surface = combination of
    axial overhang and radial offset (capsule-like: clamped to the segment).
    Returns (N,) min over all cylinders. O(N * C) -- fine for test-sized trees.
    """
    points = np.asarray(points, dtype=np.float64)
    n = points.shape[0]
    if n == 0 or not qsm.cylinders:
        return np.full(n, np.inf)

    best = np.full(n, np.inf)
    for c in qsm.cylinders:
        d = _dist_to_cylinder_surface(points, c)
        np.minimum(best, d, out=best)
    return best


def point_to_cylinder_axis_distance(points: np.ndarray, qsm: QSM) -> np.ndarray:
    """Unsigned distance from each point to the NEAREST cylinder AXIS (the
    centerline segment), not the surface. Used to check that a skeleton/QSM
    *centerline* sits inside the real wood -- a centerline point is ~0 from the
    axis but ~r from the surface, so surface distance is the wrong metric for
    centerlines. Returns (N,) min over all cylinders."""
    points = np.asarray(points, dtype=np.float64)
    n = points.shape[0]
    if n == 0 or not qsm.cylinders:
        return np.full(n, np.inf)
    best = np.full(n, np.inf)
    for c in qsm.cylinders:
        np.minimum(best, _dist_to_segment(points, c.start, c.end), out=best)
    return best


def _dist_to_segment(points: np.ndarray, a: np.ndarray, b: np.ndarray) -> np.ndarray:
    ab = b - a
    L2 = float(ab @ ab)
    if L2 == 0:
        return np.linalg.norm(points - a, axis=1)
    t = np.clip((points - a) @ ab / L2, 0.0, 1.0)
    proj = a[None, :] + t[:, None] * ab[None, :]
    return np.linalg.norm(points - proj, axis=1)


def _dist_to_cylinder_surface(points: np.ndarray, c: Cylinder) -> np.ndarray:
    ab = c.end - c.start
    L = float(np.linalg.norm(ab))
    if L == 0:
        # Degenerate: distance to a sphere of radius c.radius at the point.
        return np.abs(np.linalg.norm(points - c.start, axis=1) - c.radius)
    axis = ab / L
    ap = points - c.start[None, :]
    t = ap @ axis  # axial coordinate along the segment
    t_clamped = np.clip(t, 0.0, L)
    radial_vec = ap - t[:, None] * axis[None, :]
    radial = np.linalg.norm(radial_vec, axis=1)
    # Inside the axial extent: radial distance to the lateral surface.
    inside = (t >= 0) & (t <= L)
    d_lateral = np.abs(radial - c.radius)
    # Outside the caps: distance to the nearest cap rim/disk.
    overhang = np.maximum(0.0, np.maximum(-t, t - L))
    d_cap_radial = np.maximum(0.0, radial - c.radius)
    d_cap = np.sqrt(overhang**2 + d_cap_radial**2)
    return np.where(inside, d_lateral, d_cap)

# ---------------------------------------------------------------------------
# Metric 1: centerline agreement
# ---------------------------------------------------------------------------


@dataclass
class CenterlineMetrics:
    mean_sym: float  # symmetric mean nearest-neighbor distance (m)
    p95_sym: float  # symmetric 95th-percentile NN distance (m)
    hausdorff: float  # max of the two directed Hausdorff distances (m)
    cov_gt: float  # fraction of GT samples within tau of a recon sample (recall)
    cov_recon: float  # fraction of recon samples within tau of a GT sample (precision)
    tau: float  # coverage threshold used (m)


def centerline_agreement(
    recon: CenterlineSamples, gt: CenterlineSamples, tau: float
) -> CenterlineMetrics:
    """Symmetric nearest-neighbor distances + two-sided coverage.

    cov_gt = recall (did we cover the real wood?), cov_recon = precision (did we
    invent wood?). Requiring both high cannot be gamed by a dense blob.
    """
    if len(recon) == 0 or len(gt) == 0:
        return CenterlineMetrics(np.inf, np.inf, np.inf, 0.0, 0.0, tau)

    tree_gt = cKDTree(gt.xyz)
    tree_recon = cKDTree(recon.xyz)
    d_rg, _ = tree_gt.query(recon.xyz)  # recon -> nearest GT
    d_gr, _ = tree_recon.query(gt.xyz)  # GT -> nearest recon

    mean_sym = 0.5 * (float(np.mean(d_rg)) + float(np.mean(d_gr)))
    p95_sym = 0.5 * (float(np.percentile(d_rg, 95)) + float(np.percentile(d_gr, 95)))
    hausdorff = max(float(np.max(d_rg)), float(np.max(d_gr)))
    cov_gt = float(np.mean(d_gr < tau))
    cov_recon = float(np.mean(d_rg < tau))
    return CenterlineMetrics(mean_sym, p95_sym, hausdorff, cov_gt, cov_recon, tau)


@dataclass
class CloudAnchoredMetrics:
    """GT-independent: reconstruction surface vs the actual point cloud. Catches
    a buggy GT export (a QSM that floats off the real points fails even if it
    matches a wrong GT)."""

    mean: float
    p95: float


def cloud_anchored_agreement(
    qsm: QSM, cloud: np.ndarray, ds: float = DEFAULT_DS
) -> CloudAnchoredMetrics:
    surf = surface_samples(qsm, ds=ds)
    if surf.shape[0] == 0 or cloud.shape[0] == 0:
        return CloudAnchoredMetrics(np.inf, np.inf)
    tree = cKDTree(np.asarray(cloud, dtype=np.float64))
    d, _ = tree.query(surf)
    return CloudAnchoredMetrics(float(np.mean(d)), float(np.percentile(d, 95)))


# ---------------------------------------------------------------------------
# Metric 2: radius vs geodesic distance, stem vs branch
# ---------------------------------------------------------------------------


@dataclass
class RadiusBin:
    g_lo: float
    g_hi: float
    n_recon: int
    n_gt: int
    mean_r_recon: float
    mean_r_gt: float
    bias: float  # mean_r_recon - mean_r_gt
    relerr: float  # mean_r_recon / mean_r_gt - 1
    ks_p: float  # ks_2samp p-value of the two radius populations in the bin


@dataclass
class RadiusMetrics:
    bins_stem: list[RadiusBin] = field(default_factory=list)
    bins_branch: list[RadiusBin] = field(default_factory=list)
    mean_relerr_stem: float = 0.0
    mean_relerr_branch: float = 0.0
    rmse_radius: float = 0.0
    volume_relerr_total: float = 0.0
    volume_relerr_stem: float = 0.0


def _binned(samples: CenterlineSamples, mask: np.ndarray, edges: np.ndarray):
    g = samples.geodesic[mask]
    r = samples.radius[mask]
    idx = np.digitize(g, edges) - 1
    return g, r, idx


def radius_agreement(
    recon: CenterlineSamples,
    gt: CenterlineSamples,
    bin_width: float = 0.1,
) -> RadiusMetrics:
    """Per-bin (by geodesic base distance) radius comparison, stem (rank 0) and
    branch (rank >= 1) reported separately. Arc-length weighting is implicit:
    samples are arc-length-uniform, so per-bin means are length-weighted."""
    if len(recon) == 0 or len(gt) == 0:
        return RadiusMetrics()

    gmax = max(float(np.max(recon.geodesic)), float(np.max(gt.geodesic)))
    edges = np.arange(0.0, gmax + bin_width, bin_width)
    if edges.shape[0] < 2:
        edges = np.array([0.0, max(bin_width, gmax + bin_width)])

    out = RadiusMetrics()

    for is_stem in (True, False):
        rmask = (recon.rank == 0) if is_stem else (recon.rank >= 1)
        gmask = (gt.rank == 0) if is_stem else (gt.rank >= 1)
        _, r_recon, idx_recon = _binned(recon, rmask, edges)
        _, r_gt, idx_gt = _binned(gt, gmask, edges)

        bins: list[RadiusBin] = []
        relerrs: list[float] = []
        for b in range(edges.shape[0] - 1):
            rr = r_recon[idx_recon == b]
            rg = r_gt[idx_gt == b]
            if rr.size == 0 or rg.size == 0:
                continue
            mr, mg = float(np.mean(rr)), float(np.mean(rg))
            relerr = mr / mg - 1.0 if mg > 0 else np.inf
            try:
                ks_p = float(ks_2samp(rr, rg).pvalue)
            except ValueError:
                ks_p = 1.0
            bins.append(
                RadiusBin(float(edges[b]), float(edges[b + 1]), rr.size, rg.size,
                          mr, mg, mr - mg, relerr, ks_p)
            )
            if np.isfinite(relerr):
                relerrs.append(relerr)

        mean_relerr = float(np.mean(relerrs)) if relerrs else 0.0
        if is_stem:
            out.bins_stem = bins
            out.mean_relerr_stem = mean_relerr
        else:
            out.bins_branch = bins
            out.mean_relerr_branch = mean_relerr

    # Arc-length-weighted radius RMSE across all matched bins (stem + branch).
    sq = []
    for b in out.bins_stem + out.bins_branch:
        sq.append((b.mean_r_recon - b.mean_r_gt) ** 2 * b.n_recon)
    n = sum(b.n_recon for b in out.bins_stem + out.bins_branch)
    out.rmse_radius = float(np.sqrt(sum(sq) / n)) if n else 0.0

    # Volume relerr: integral of pi r^2 over arc length. Each sample owns its TRUE
    # cylinder-length share (weights = seg_len), NOT a uniform ds -- otherwise a
    # sub-ds cylinder (still 1 sample) would be counted as a full ds of wood and a
    # finely-tessellated GT would inflate vs a coarse recon of identical geometry.
    def vol(samples: CenterlineSamples, mask=None) -> float:
        r = samples.radius
        w = samples.weights
        if mask is not None:
            r, w = r[mask], w[mask]
        return float(np.pi * np.sum(r * r * w))

    v_recon, v_gt = vol(recon), vol(gt)
    out.volume_relerr_total = (v_recon / v_gt - 1.0) if v_gt > 0 else np.inf
    vs_recon = vol(recon, recon.rank == 0)
    vs_gt = vol(gt, gt.rank == 0)
    out.volume_relerr_stem = (vs_recon / vs_gt - 1.0) if vs_gt > 0 else np.inf
    return out


# ---------------------------------------------------------------------------
# Metric 3: topometric aggregates + distributions
# ---------------------------------------------------------------------------


@dataclass
class TopometricMetrics:
    total_length_relerr: float
    total_volume_relerr: float
    n_tips_recon: int
    n_tips_gt: int
    n_forks_recon: int
    n_forks_gt: int
    n_shoots_recon: int
    n_shoots_gt: int
    branch_len_ks_p: float
    branch_len_mad: float  # mean abs diff of branch-length distributions (m)
    branch_angle_mad: float  # mean abs diff of branch-angle distributions (deg)


def _branch_lengths(qsm: QSM) -> np.ndarray:
    """Length of each shoot (base->tip), one value per shoot."""
    by_id = qsm.cylinder_by_id()
    lens = []
    for s in qsm.shoots:
        lens.append(sum(by_id[c].length for c in s.cylinder_ids if c in by_id))
    return np.asarray(lens, dtype=np.float64)


def _branch_angles(qsm: QSM) -> np.ndarray:
    """Angle (deg) between each non-trunk shoot's initial axis and its parent
    shoot's axis at the fork."""
    by_id = qsm.cylinder_by_id()
    shoot_by_id = qsm.shoot_by_id()
    angles = []
    for s in qsm.shoots:
        if s.parent_shoot_id < 0 or not s.cylinder_ids:
            continue
        child0 = by_id.get(s.cylinder_ids[0])
        if child0 is None or child0.length == 0:
            continue
        parent = by_id.get(child0.parent_id)
        if parent is None or parent.length == 0:
            continue
        cosang = float(np.clip(np.dot(child0.axis, parent.axis), -1.0, 1.0))
        angles.append(np.degrees(np.arccos(cosang)))
    return np.asarray(angles, dtype=np.float64)


def _count_tips_forks(qsm: QSM) -> tuple[int, int]:
    """Tips = cylinders with no children; forks = cylinders with >=2 children."""
    child_count: dict[int, int] = {c.cyl_id: 0 for c in qsm.cylinders}
    for c in qsm.cylinders:
        if c.parent_id in child_count:
            child_count[c.parent_id] += 1
    tips = sum(1 for v in child_count.values() if v == 0)
    forks = sum(1 for v in child_count.values() if v >= 2)
    return tips, forks


def _dist_mad(a: np.ndarray, b: np.ndarray) -> float:
    """Mean absolute difference of two distributions compared via sorted
    quantiles (handles unequal lengths). Guards the KS test."""
    if a.size == 0 or b.size == 0:
        return np.inf
    q = np.linspace(0, 1, 50)
    return float(np.mean(np.abs(np.quantile(a, q) - np.quantile(b, q))))


def topometric_agreement(recon: QSM, gt: QSM) -> TopometricMetrics:
    tl_r, tl_g = recon.total_length, gt.total_length
    tv_r, tv_g = recon.total_volume, gt.total_volume
    tips_r, forks_r = _count_tips_forks(recon)
    tips_g, forks_g = _count_tips_forks(gt)

    bl_r, bl_g = _branch_lengths(recon), _branch_lengths(gt)
    ba_r, ba_g = _branch_angles(recon), _branch_angles(gt)

    try:
        bl_ks = float(ks_2samp(bl_r, bl_g).pvalue) if bl_r.size and bl_g.size else 0.0
    except ValueError:
        bl_ks = 0.0

    return TopometricMetrics(
        total_length_relerr=(tl_r / tl_g - 1.0) if tl_g > 0 else np.inf,
        total_volume_relerr=(tv_r / tv_g - 1.0) if tv_g > 0 else np.inf,
        n_tips_recon=tips_r,
        n_tips_gt=tips_g,
        n_forks_recon=forks_r,
        n_forks_gt=forks_g,
        n_shoots_recon=len(recon.shoots),
        n_shoots_gt=len(gt.shoots),
        branch_len_ks_p=bl_ks,
        branch_len_mad=_dist_mad(bl_r, bl_g),
        branch_angle_mad=_dist_mad(ba_r, ba_g),
    )


# ---------------------------------------------------------------------------
# Metric 4: shoot-rank agreement (the headline)
# ---------------------------------------------------------------------------


@dataclass
class RankMetrics:
    confusion: np.ndarray  # (R+1, R+1) arc-length-weighted; ranks capped at 3+
    overall_accuracy: float  # trace / total (matched only)
    precision: dict[int, float]  # per rank
    recall: dict[int, float]  # per rank
    unmatched_fraction: float
    n_rank0_shoots_recon: int
    n_rank0_shoots_gt: int
    arclen_per_rank_recon: dict[int, float]
    arclen_per_rank_gt: dict[int, float]
    arclen_relerr_per_rank: dict[int, float]


def _cap_rank(rank: np.ndarray, cap: int = 3) -> np.ndarray:
    return np.minimum(rank, cap)


def rank_agreement(
    recon: CenterlineSamples,
    gt: CenterlineSamples,
    tau_rank: float,
    rank_cap: int = 3,
    recon_qsm: QSM | None = None,
    gt_qsm: QSM | None = None,
) -> RankMetrics:
    """Arc-length-weighted confusion matrix of reconstructed vs GT shoot rank.

    Each reconstructed centerline sample is matched to the nearest GT sample
    (within ``tau_rank``); samples farther than that are 'unmatched' (a
    reconstruction floating in space earns no rank credit).

    ``recon_qsm`` / ``gt_qsm`` are used only to count rank-0 shoots (a hard
    "exactly one trunk" check that the sample arrays can't express).
    """
    R = rank_cap + 1
    conf = np.zeros((R, R), dtype=np.float64)
    if len(recon) == 0 or len(gt) == 0:
        return RankMetrics(conf, 0.0, {}, {}, 1.0, 0, 0, {}, {}, {})

    tree_gt = cKDTree(gt.xyz)
    d, j = tree_gt.query(recon.xyz)
    matched = d <= tau_rank
    unmatched_fraction = float(np.mean(~matched))

    # Junction-ambiguity handling: near a fork the GT trunk (rank r) and a child
    # branch (rank r+1) centerlines coincide within ~tau, so the single nearest
    # GT sample is ambiguous. For each matched recon sample, look at ALL GT
    # samples within tau and credit the GT rank in that neighborhood CLOSEST to
    # the recon's own rank. This removes the spurious off-diagonal that pure
    # nearest-neighbor matching produces at junctions, without letting a genuinely
    # mis-ranked sample (no GT of that rank nearby) off the hook.
    recon_rank_capped = _cap_rank(recon.rank, rank_cap)
    gt_rank_capped = _cap_rank(gt.rank, rank_cap)
    neigh = tree_gt.query_ball_point(recon.xyz, tau_rank)
    w = recon.weights  # per-sample TRUE arc-length weight (tessellation-invariant)
    matched_idx = np.where(matched)[0]
    for i in matched_idx:
        rr = int(recon_rank_capped[i])
        gts = gt_rank_capped[neigh[i]] if len(neigh[i]) else gt_rank_capped[j[i]][None]
        gset = set(int(x) for x in np.atleast_1d(gts))
        # Credit the neighborhood GT rank nearest to the recon rank (handles the
        # ambiguous shared-junction region); otherwise the single nearest rank.
        best_gt = min(gset, key=lambda gr: (abs(gr - rr), gr))
        conf[rr, best_gt] += float(w[i])

    total = conf.sum()
    overall = float(np.trace(conf) / total) if total > 0 else 0.0

    precision: dict[int, float] = {}
    recall: dict[int, float] = {}
    for k in range(R):
        col = conf[:, k].sum()  # GT rank k total (over recon predictions)
        row = conf[k, :].sum()  # recon predicted rank k total
        recall[k] = float(conf[k, k] / col) if col > 0 else 0.0
        precision[k] = float(conf[k, k] / row) if row > 0 else 0.0

    # Per-rank arc length (uncapped ranks collapsed at cap for comparability).
    # Sum each rank's samples' TRUE owned length, not count*ds (tessellation-inv).
    def arclen_per_rank(s: CenterlineSamples) -> dict[int, float]:
        capped = _cap_rank(s.rank, rank_cap)
        w = s.weights
        out: dict[int, float] = {}
        for k in range(R):
            out[k] = float(np.sum(w[capped == k]))
        return out

    al_r = arclen_per_rank(recon)
    al_g = arclen_per_rank(gt)
    al_relerr = {
        k: (al_r[k] / al_g[k] - 1.0) if al_g.get(k, 0) > 0 else (0.0 if al_r[k] == 0 else np.inf)
        for k in range(R)
    }

    n0_recon = len(recon_qsm.shoots_of_rank(0)) if recon_qsm is not None else 0
    n0_gt = len(gt_qsm.shoots_of_rank(0)) if gt_qsm is not None else 0
    return RankMetrics(
        confusion=conf,
        overall_accuracy=overall,
        precision=precision,
        recall=recall,
        unmatched_fraction=unmatched_fraction,
        n_rank0_shoots_recon=n0_recon,
        n_rank0_shoots_gt=n0_gt,
        arclen_per_rank_recon=al_r,
        arclen_per_rank_gt=al_g,
        arclen_relerr_per_rank=al_relerr,
    )
