"""Coarse registration by correlating top-down rasters.

Why this replaced landmark matching
-----------------------------------
The previous coarse stage reduced each cloud to one landmark per plant and
matched landmark TRIANGLES. It failed on real data, and the reason is
structural rather than a tuning problem.

Landmark repeatability between two scan positions is about 50%: measured 25 of
46 on a real vineyard, and the forest-registration literature reports the same
(Liang & Hyyppa: "the common trees between two scans account for approximately
50% of all trees in a scan"; Kelbe et al.: stem-based pairwise registration
connected 51% of scans on average, as low as 8%). Occlusion means each scanner
simply sees a different subset of plants.

Triangle congruence then CUBES that penalty. At 54% per-landmark repeatability
only 0.54^3 = 16% of triangles have all three corners shared, so the matcher was
starved of usable evidence by construction.

Correlation avoids the exponent entirely: it never picks landmarks, so it never
has to pick the SAME ones twice. The whole cloud contributes.

How it works
------------
Both clouds are gravity-aligned (the scanner is levelled), so the unknown is
yaw + horizontal translation + a height offset -- 4 degrees of freedom, not 6.
That reduction is what makes an exhaustive search cheap:

1. Rasterise each cloud to a top-down grid.
2. Sweep yaw. For each candidate, correlate the two rasters with an FFT, which
   evaluates EVERY translation at once (the correlation theorem) rather than
   searching over them.
3. Take the best (yaw, shift) pair; recover the height offset from the median
   height difference.
4. Hand the result to point-to-plane ICP for refinement.

Raster choice
-------------
Occupancy (is anything in this cell) is the default. Mean height was
recommended on the strength of synthetic tests, but measured on three real
datasets -- a trellised vineyard, an almond orchard and a peach orchard -- both
rasters scored 24/24 on known-yaw recovery with 70% partial overlap, so the
distinction did not survive contact with real data. Occupancy is cheaper and
does not depend on canopy height variation, which a trellised vineyard barely
has. `mode="height"` is kept for scenes where height genuinely carries more
signal than presence.
"""

import math
from typing import Optional, Tuple

import numpy as np

# How many correlation peaks to refine before choosing. On a uniform planting
# the correlation surface has no decisive winner and the true translation is
# often NOT the tallest peak: measured with ground stripped, it ranked 1st on
# the peach orchard but 14th and 29th on two olive pairs, so a shortlist that
# covered peach alone (K=8) left those olive pairs ~3.8 m out. K=32 covers every
# pair in both datasets.
#
# Raising K costs time, not accuracy -- peach scores identically at K=8, 16 and
# 32, because a wrong candidate loses on RMSE rather than crowding out the right
# one. Each extra candidate is one more short ICP run, so this is the
# accuracy/latency dial.
#
# Lowered 32 -> 8 after measuring the whole graph: on the olive set K=8 took
# 42.8 s with 1 bad pair of 10, against K=32 at 114.4 s with 2 bad. GrapeX
# scored identically at every K. Per-pair loop selection now recovers what a
# longer shortlist used to, so the extra candidates were paying for nothing.
_REFINE_TOP_K = 8

# Two candidate poses closer than this in XY are the same answer, not rivals.
# The shortlist's top entries usually converge to the same place, so without
# this the "best rival" is the winner itself and the margin is ~0 for correct
# and incorrect results alike.
_SAME_POSE_M = 1.0

# Minimum relative RMSE lead the winner must hold over a genuinely different
# pose to be called unambiguous. Measured over 35 runs spanning the peach and
# olive orchards and shortlist sizes 2-32: every CORRECT result scored >= 0.0627
# and every WRONG one <= 0.0305, so this sits mid-gap. (An earlier 0.03 was
# fitted to K=8/K=32 alone and landed exactly ON the wrong-side maximum, passing
# a 3.8 m error as confident at K=4.)
_MIN_RMSE_MARGIN = 0.045

# How many candidates must have been refined before "they all agree" counts as
# evidence. With a 2-candidate shortlist on the olive orchard, both candidates
# converged to the same WRONG pose 4.2 m out -- unanimity among two is not
# agreement, it is a coin landing the same way twice. The shipped shortlist is
# far larger than this; the floor only guards deliberately small ones.
_MIN_RIVAL_CANDIDATES = 6

# The sweep is coarse-then-fine: a full circle at 5 degrees, then a local
# refinement. Measured recovery error on real data was 0-2 degrees, i.e. within
# the coarse step, so the refinement mainly buys sub-step precision for ICP.
_COARSE_STEP_DEG = 5.0
_FINE_HALFWIDTH_DEG = 5.0
_FINE_STEP_DEG = 0.5

# Iterations the shortlist-ranking ICP in `_best_by_icp` may spend per
# candidate. It only has to RANK candidates -- the fine stage recomputes the
# winner -- so this is not the accuracy of the final pose.
#
# Kept at 60 after an attempt to halve it produced no measurable saving worth
# the risk. Lowering it DOES change which candidate is ranked first: on the UC
# Davis set, 60 and 30 agree while 20 and below pick a different index on two
# of three pairs, because the leading candidates' RMSEs sit within 0.001 of
# each other (0.3786 against 0.3778). But the index is not the answer -- those
# near-tied candidates converge to EQUIVALENT poses, and measured against
# RiSCAN the coarse pose lands at 0.07-0.13 m on every pair at every budget
# from 60 down to 5, sometimes marginally better at the low end.
#
# So the ranking is not the fragile thing it looks like, and there is no
# accuracy floor here to defend. There is also little to win: this ICP is ~59%
# of a 2.9 s coarse call, and the coarse stage's real cost is that a 4-scan set
# makes 24 such calls (6 graph edges x 4 variants), not that any one is slow.
# Cutting the call count is the lever; cutting these iterations is noise.
#
# If you do revisit it, measure POSE ERROR against ground truth, not which
# candidate index wins -- that was the trap the first time round.
_RANK_ITERATIONS = 60

# Grid side in cells. 180 keeps the FFT small (~32k cells) while resolving
# plant-scale structure on plots from a few metres to a few hundred.
_TARGET_CELLS = 180

# Radial percentile defining "the plot". High enough to keep the real survey
# area, low enough to exclude the sparse far-field tail that a raw bounding box
# is dominated by. Measured on a vineyard scan: p99 = 96 m against a 930 m
# footprint, and sizing the grid on the footprint made the true peak unreachable.
_EXTENT_PERCENTILE = 99.0


def auto_cell_size(points: np.ndarray, extent: Optional[float] = None) -> Tuple[float, float]:
    """(cell_size, extent) chosen from the cloud itself.

    Parameter fragility has been the recurring bug in this feature -- values
    derived from one scene's extent broke on another. Here the rule is tied to
    the cloud's own footprint and clamped to a range that is physically sensible
    for vegetation (0.2 m resolves individual vines; 2 m is coarse enough for a
    large block), and measured accuracy was insensitive across a wide band of
    cell sizes, so the exact value is not load-bearing.
    """
    if extent is None:
        # Size the grid from where the points ACTUALLY are, not from the
        # outermost few. `ptp` is set by the single most distant return, and a
        # terrestrial scan has a long sparse tail: measured on a real vineyard,
        # 99% of returns sat within 96 m while the raw footprint spanned 930 m.
        # Sizing on the footprint put the whole plot in one corner of the grid
        # at the coarsest allowed cell, and the correlation was then dominated
        # by empty space -- the true translation peak was unreachable. Using a
        # robust radial percentile instead brought it to rank 0.
        centre = np.median(points[:, :2], axis=0)
        radius = float(np.percentile(np.linalg.norm(points[:, :2] - centre, axis=1),
                                     _EXTENT_PERCENTILE))
        robust = 2.6 * radius          # diameter, with the same 1.3 margin
        raw = 1.3 * float(max(np.ptp(points[:, 0]), np.ptp(points[:, 1])))
        # Take the robust size only when it is a genuine REDUCTION -- i.e. when a
        # sparse far-field tail was inflating the footprint. Never let it shrink
        # the grid below the bulk of the cloud: on a compact scene the two agree,
        # and forcing the smaller one there tightens the window enough to make a
        # 180-degree alias outscore the truth (measured: a symmetric lattice
        # fixture went 179.99 deg wrong, and reported confident).
        extent = raw if raw <= robust * 1.5 else robust
    extent = max(extent, 1e-6)
    cell = float(np.clip(extent / _TARGET_CELLS, 0.2, 2.0))
    return cell, extent


def rasterise(points: np.ndarray, cell: float, extent: float,
              centre: np.ndarray, mode: str = "occupancy") -> np.ndarray:
    """Top-down grid: occupancy, or mean height per cell.

    Centred on the cloud's own XY median rather than its bounding-box centre --
    a terrestrial scan's bbox is dominated by sparse far-field returns, so its
    centre can sit hundreds of metres from the actual plot.
    """
    n = max(int(round(extent / cell)), 4)
    ij = np.floor((points[:, :2] - centre + extent / 2.0) / cell).astype(np.int64)
    inside = (ij[:, 0] >= 0) & (ij[:, 0] < n) & (ij[:, 1] >= 0) & (ij[:, 1] < n)
    ij = ij[inside]
    if len(ij) == 0:
        return np.zeros((n, n))
    flat = ij[:, 0] * n + ij[:, 1]
    counts = np.bincount(flat, minlength=n * n).astype(np.float64)
    if mode == "occupancy":
        return (counts > 0).astype(np.float64).reshape(n, n)
    sums = np.bincount(flat, weights=points[inside, 2], minlength=n * n)
    out = np.zeros(n * n)
    filled = counts > 0
    out[filled] = sums[filled] / counts[filled]
    return out.reshape(n, n)


def _correlate(target_fft: np.ndarray, target_shape, target_norm: float,
               raster: np.ndarray) -> Tuple[float, Tuple[int, int]]:
    """Peak normalised cross-correlation and the shift that produces it.

    One FFT multiply evaluates every possible translation simultaneously -- the
    reason this is fast enough to wrap in a yaw sweep.
    """
    r = raster - raster.mean()
    norm = np.linalg.norm(r)
    if norm <= 0 or target_norm <= 0:
        return -1.0, (0, 0)
    cc = np.fft.irfft2(target_fft * np.conj(np.fft.rfft2(r)), target_shape)
    idx = int(np.argmax(cc))
    peak = float(cc.flat[idx]) / (target_norm * norm)
    return peak, np.unravel_index(idx, target_shape)


def _top_shifts(target_fft: np.ndarray, target_shape, target_norm: float,
                raster: np.ndarray, k: int):
    """The k best translations for one yaw, best first.

    Same single FFT as `_correlate`, but keeping a shortlist instead of only the
    argmax. A regular planting produces many near-equal peaks (one per row/plant
    spacing), so the highest is frequently not the true pose -- see
    `_REFINE_TOP_K`. Returning candidates lets ICP arbitrate on geometry rather
    than trusting a correlation score that cannot tell rows apart.
    """
    r = raster - raster.mean()
    norm = np.linalg.norm(r)
    if norm <= 0 or target_norm <= 0:
        return []
    cc = np.fft.irfft2(target_fft * np.conj(np.fft.rfft2(r)), target_shape)
    flat = cc.ravel()
    k = max(1, min(int(k), flat.size))
    # argpartition: only the top k matter, so don't sort the whole surface.
    top = np.argpartition(-flat, k - 1)[:k]
    top = top[np.argsort(-flat[top])]
    denom = target_norm * norm
    return [(float(flat[i]) / denom, np.unravel_index(int(i), target_shape))
            for i in top]


def _has_ground(points: np.ndarray, min_floor_fraction: float = 0.35) -> bool:
    """Is there actually a ground surface to remove?

    Stripping ground from a cloud that has none is not a no-op -- it is
    destructive. `_drop_ground` cuts a fixed height above the local low
    percentile, so on a canopy-only cloud (already-segmented vegetation, or a
    synthetic scene built from crowns alone) it shaves the bottom off every
    plant instead. Measured on the trellised-planting fixture: crowns spanning
    z -0.08..2.3 m lost their lowest 25%, which reshaped them asymmetrically and
    turned a recoverable 140-degree rotation into a 180-degree flip.

    The discriminator is DENSITY at the floor, not flatness. Flatness does not
    work: a synthetic planting on a perfect lattice has a low surface varying by
    0.04 m, flatter than real terrain, so a flatness test calls it ground and
    destroys it. But a ground plane is a dense sheet -- a large share of all
    returns sit within a metre of the floor -- whereas a canopy-only cloud is
    hollow underneath. Measured: 0.22 of points in the floor+1 m band for the
    canopy-only fixture against 0.54 for a real peach scan and 0.67 for the same
    fixture with a ground plane added.
    """
    if len(points) < 100:
        return False
    z = points[:, 2]
    if float(np.ptp(z)) <= 0.5:
        return False        # essentially a sheet; nothing to separate
    floor = float(np.percentile(z, 2))
    return bool(np.mean((z >= floor) & (z < floor + 1.0)) >= min_floor_fraction)


def _shift_to_matrix(shift, n, cell, angle_deg, tgt_centre, src_centre,
                     target, source) -> np.ndarray:
    """Build the 4x4 for one (yaw, FFT shift) candidate.

    Kept separate so every candidate in the shortlist is composed by exactly the
    same rule as the single-peak path -- the translation composition here is the
    bug that once left rotation exact and translation metres out, so it must not
    be duplicated by hand per call site.
    """
    dx = (shift[0] - n if shift[0] > n // 2 else shift[0]) * cell
    dy = (shift[1] - n if shift[1] > n // 2 else shift[1]) * cell
    th = math.radians(angle_deg)
    c, si = math.cos(th), math.sin(th)
    R = np.array([[c, -si, 0.0], [si, c, 0.0], [0.0, 0.0, 1.0]])
    M = np.eye(4)
    M[:3, :3] = R
    # Each raster is centred on its OWN XY median, so the FFT shift is measured
    # between grids with DIFFERENT origins and excludes the offset between them.
    src_pivot = np.array([src_centre[0], src_centre[1], 0.0])
    tgt_pivot = np.array([tgt_centre[0], tgt_centre[1], 0.0])
    M[:3, 3] = tgt_pivot - R @ src_pivot + np.array([dx, dy, 0.0])
    M[2, 3] = float(np.median(target[:, 2]) - np.median(source[:, 2]))
    return M


def _best_by_icp(candidates, target: np.ndarray, source: np.ndarray):
    """Pick the candidate pose that ICP fits best.

    Returns (index, inlier_rmse, refined_transform, rmse_margin).

    The correlation score cannot rank these -- that is the whole reason there is
    a shortlist. ICP can, because a wrong-row pose leaves systematically worse
    correspondences even though the rasters looked alike.

    Ranked on inlier RMSE, NOT fitness. Fitness is the FRACTION of source points
    that found a correspondence within the threshold, so on a dense planting it
    saturates: a pose shifted a whole row still pairs nearly every point with
    SOME leaf, just a wrong one. Measured on a real olive orchard, the true pose
    scored fitness 0.9721 while a pose 4.3 m out scored 0.9738 -- a 0.0017 lead
    for the wrong answer, and selecting on fitness took it. Their RMSE separated
    cleanly (0.1956 against 0.2346), because RMSE measures how well the paired
    points actually line up rather than how many paired at all.

    Checked both ways round: RMSE selection is better than or equal to fitness
    selection on every pair of both the peach and olive datasets.

    Returns (0, None, None, 0.0) if Open3D is unavailable, i.e. keep the top
    peak, which is exactly the previous behaviour.
    """
    try:
        import open3d as o3d
    except ImportError:
        return 0, None, None, 0.0

    # 0.40 m, not the 0.15 m used for a final pose. This ICP only has to RANK
    # candidates -- the fine stage recomputes the winner at full resolution --
    # and ranking survives coarse geometry while cost scales with point count:
    # measured 0.330 s per candidate at 0.15 m against 0.089 s at 0.50 m, so a
    # 32-candidate shortlist went from ~10.6 s to ~2.8 s per pair.
    def _pc(a, voxel=0.40):
        p = o3d.geometry.PointCloud()
        p.points = o3d.utility.Vector3dVector(np.asarray(a, dtype=np.float64))
        p = p.voxel_down_sample(voxel)
        p.estimate_normals(
            search_param=o3d.geometry.KDTreeSearchParamHybrid(
                radius=max(0.6, voxel * 6), max_nn=30))
        return p

    try:
        tgt, src = _pc(target), _pc(source)
    except (RuntimeError, ValueError):
        return 0, None, None, 0.0
    if len(tgt.points) < 10 or len(src.points) < 10:
        return 0, None, None, 0.0

    scored = []
    for i, M in enumerate(candidates):
        try:
            r = o3d.pipelines.registration.registration_icp(
                src, tgt, 1.0, M,
                o3d.pipelines.registration.TransformationEstimationPointToPlane(),
                o3d.pipelines.registration.ICPConvergenceCriteria(
                    max_iteration=_RANK_ITERATIONS))
        except (RuntimeError, ValueError):
            continue
        # A zero-fitness result found NO correspondences, and its rmse is 0 --
        # the same false-success trap `_icp_quality` guards against. It must not
        # win by having the smallest residual.
        if r.fitness <= 0.0:
            continue
        scored.append((float(r.inlier_rmse), i,
                       np.asarray(r.transformation, dtype=np.float64).copy()))

    if not scored:
        return 0, None, None, 0.0
    scored.sort(key=lambda t: t[0])
    best_rmse, best_i, best_M = scored[0]

    # CONFIDENCE. The winner is only trustworthy if it is clearly better than a
    # GENUINELY DIFFERENT pose. Comparing against the runner-up outright does
    # not work -- the top candidates usually converge to the same place, so the
    # gap is ~0 for good and bad results alike. Rivals within `_SAME_POSE_M` are
    # therefore treated as the same answer and skipped.
    #
    # The margin is RELATIVE because the absolute residual is set by canopy
    # density, not by correctness: a correct peach pair sits at 0.315 m RMSE
    # while a WRONG olive pair sits at 0.215 m, so no absolute threshold can
    # separate them. Measured across both datasets, every correct result scored
    # >= 0.063 and every wrong one <= 0.014.
    rival = None
    for rmse, _, M2 in scored[1:]:
        if np.linalg.norm(M2[:2, 3] - best_M[:2, 3]) > _SAME_POSE_M:
            rival = rmse
            break
    if rival is None:
        # Every candidate converged to the SAME pose. That is agreement, not
        # absence of evidence: independent starting points all landing together
        # is the strongest outcome the shortlist can produce, and on the peach
        # orchard it is what correct results do. Report it as unambiguous.
        #
        # The one dangerous version of this is a shortlist too short to contain
        # a rival at all, which is why `_MIN_RIVAL_CANDIDATES` requires that
        # enough distinct poses were actually tried before trusting agreement.
        margin = float("inf") if len(scored) >= _MIN_RIVAL_CANDIDATES else 0.0
    else:
        margin = (rival - best_rmse) / best_rmse if best_rmse > 0 else 0.0
    return best_i, best_rmse, best_M, float(margin)


def _rotate_xy(points: np.ndarray, degrees: float, centre: np.ndarray) -> np.ndarray:
    th = math.radians(degrees)
    c, s = math.cos(th), math.sin(th)
    out = points.copy()
    out[:, :2] = (points[:, :2] - centre) @ np.array([[c, -s], [s, c]]).T + centre
    return out


def register_by_correlation(target: np.ndarray, source: np.ndarray,
                            mode: str = "occupancy",
                            cell: Optional[float] = None,
                            yaw_prior_deg: Optional[float] = None,
                            yaw_search_deg: float = 30.0,
                            strip_ground: bool = True,
                            extent: Optional[float] = None,
                            refine_top_k: int = _REFINE_TOP_K) -> dict:
    """Coarse-align `source` onto `target`.

    Returns {'transformation' 4x4, 'score', 'margin', 'ambiguous', 'yaw_deg'}.

    `margin` and `ambiguous` matter because a regular planting is close to
    symmetric, so a wrong pose can score nearly as well as the right one. A
    residual-based check cannot see that -- a row-flipped orchard genuinely
    lands plant-on-plant -- but the gap between the best and second-best
    correlation peak can.

    **`yaw_prior_deg` is the single most valuable input this function takes.**
    A terrestrial scanner records its own heading (GNSS/IMU/compass), typically
    good to a few degrees, and searching the whole circle throws that away.
    Measured on a real peach orchard against RiSCAN PRO: an unconstrained sweep
    found poses with LOWER point-to-point residual than RiSCAN's (0.06 m vs
    0.53 m) that were nevertheless 17-149 degrees wrong, because an orchard
    scanned from within is nearly self-similar under rotation and several poses
    land canopy-on-canopy. Lower residual does not mean correct. Restricting the
    sweep to +/-`yaw_search_deg` around the recorded heading removes those
    aliases from consideration entirely rather than trying to score them away.

    Pass None only when no heading is available; then the full circle is
    searched and the result should be treated with more suspicion.
    """
    target = np.asarray(target, dtype=np.float64)
    source = np.asarray(source, dtype=np.float64)
    empty = dict(transformation=np.eye(4), score=0.0, margin=0.0,
                 ambiguous=True, pose_margin=None, yaw_deg=0.0)
    if len(target) < 100 or len(source) < 100:
        return empty

    # Correlate the CANOPY, not the ground. Ground is one large near-featureless
    # surface: it contributes bulk to every candidate translation equally, so it
    # raises the correlation floor without adding any signal that distinguishes
    # one shift from another. Measured on the real peach orchard, leaving it in
    # buried the true translation at rank 165 of the correlation surface; taking
    # it out lifts it to rank 0 on four of five scans and rank 1 on the fifth.
    #
    # This is a per-cell height cut (~230 ms on 900k points), NOT a terrain
    # model -- see `anchor_extraction._drop_ground`, where CSF measured 396 s
    # against 0.08 s for the same job. The full clouds are still what ICP and
    # the height offset use; only the rasters see the canopy.
    tgt_grid, src_grid = target, source
    if strip_ground and _has_ground(target) and _has_ground(source):
        try:
            from anchor_extraction import _drop_ground
            t_hi, s_hi = _drop_ground(target), _drop_ground(source)
            # _drop_ground returns the input unchanged when it would empty the
            # cloud; only adopt a result that actually kept a usable canopy.
            if len(t_hi) >= 100 and len(s_hi) >= 100:
                tgt_grid, src_grid = t_hi, s_hi
        except (ImportError, ValueError, MemoryError):
            pass          # correlate the raw clouds rather than fail outright

    tgt_centre = np.median(tgt_grid[:, :2], axis=0)
    src_centre = np.median(src_grid[:, :2], axis=0)
    # An explicit `extent` lets the caller pin the grid to a footprint measured
    # BEFORE density filtering. Without that, filtering out sparse far-field
    # returns shrinks the measured spread and silently refines the raster past
    # the scale plant pattern lives at.
    if cell is None:
        cell, extent = auto_cell_size(target, extent)
    else:
        _, extent = auto_cell_size(target, extent)

    tgt_raster = rasterise(tgt_grid, cell, extent, tgt_centre, mode)
    tgt_raster = tgt_raster - tgt_raster.mean()
    tgt_norm = float(np.linalg.norm(tgt_raster))
    if tgt_norm <= 0:
        return empty
    tgt_fft = np.fft.rfft2(tgt_raster)
    shape = tgt_raster.shape

    def best_over(angles):
        out = []
        for a in angles:
            rot = _rotate_xy(src_grid, a, src_centre)
            peak, shift = _correlate(tgt_fft, shape, tgt_norm,
                                     rasterise(rot, cell, extent, src_centre, mode))
            out.append((peak, a, shift))
        return sorted(out, key=lambda t: -t[0])

    if yaw_prior_deg is None:
        sweep = np.arange(-180.0, 180.0, _COARSE_STEP_DEG)
    else:
        # Only the neighbourhood of the recorded heading is physically
        # plausible; everything else is an alias waiting to be picked.
        sweep = np.arange(yaw_prior_deg - yaw_search_deg,
                          yaw_prior_deg + yaw_search_deg + 1e-9,
                          _COARSE_STEP_DEG)
    coarse = best_over(sweep)
    best_peak, best_angle, best_shift = coarse[0]

    # Runner-up must be a genuinely DIFFERENT pose, not a neighbouring step of
    # the same peak, or every result would look ambiguous.
    # Runner-up must be a genuinely DIFFERENT pose, not a neighbouring step of
    # the same peak, or every result would look ambiguous. With a yaw prior the
    # sweep may be narrower than 20 degrees on one side, in which case there may
    # legitimately be no rival to compare against -- that is a CONSTRAINED
    # search, not an unambiguous one, so leave `second` at zero and let the
    # margin reflect the prior having done the disambiguating.
    second = 0.0
    for peak, a, _ in coarse[1:]:
        if abs((a - best_angle + 180) % 360 - 180) > 20.0:
            second = peak
            break

    fine = best_over(np.arange(best_angle - _FINE_HALFWIDTH_DEG,
                               best_angle + _FINE_HALFWIDTH_DEG + 1e-9,
                               _FINE_STEP_DEG))
    best_peak, best_angle, best_shift = fine[0]

    n = shape[0]

    # SHORTLIST, don't commit. At the winning yaw the correlation surface of a
    # regular planting has many near-equal peaks -- one per row spacing -- and
    # the tallest is often a neighbouring row rather than the true pose. Build
    # the top few as candidate matrices and let ICP arbitrate on geometry.
    rot_best = _rotate_xy(src_grid, best_angle, src_centre)
    shortlist = _top_shifts(tgt_fft, shape, tgt_norm,
                            rasterise(rot_best, cell, extent, src_centre, mode),
                            max(1, int(refine_top_k)))
    if not shortlist:
        shortlist = [(best_peak, best_shift)]

    candidates = [_shift_to_matrix(sh, n, cell, best_angle, tgt_centre,
                                   src_centre, target, source)
                  for _, sh in shortlist]

    chosen = 0
    M = candidates[0]
    pose_margin = None
    if len(candidates) > 1:
        chosen, _, refined, pose_margin = _best_by_icp(candidates, target, source)
        M = candidates[chosen]
        # Return the REFINED pose, not the raw grid candidate. Choosing already
        # cost a full ICP run per candidate, so the aligned result is in hand --
        # discarding it and handing back the cell-quantised matrix threw away
        # roughly a metre of accuracy for nothing (measured: 0.02 m refined
        # against 1.1 m raw on the same candidate).
        if refined is not None:
            M = refined
    chosen_peak = float(shortlist[chosen][0])

    # AMBIGUITY is about the YAW, so it must be judged on the best peak at the
    # winning yaw against the best peak at a rival yaw -- both "how well can this
    # orientation match at all" quantities. `chosen_peak` is not that: with a
    # shortlist the selected candidate may be the 20th-tallest translation, and
    # scoring a 20th-place translation against a rival ORIENTATION's first-place
    # one makes every result look ambiguous. (It did: this flagged a scene whose
    # rotation the same call had just recovered to within 5 degrees.)
    margin = (best_peak - second) / best_peak if best_peak > 0 else 0.0

    # Two independent ways to be ambiguous, and BOTH must be clear.
    #  * yaw: a rival ORIENTATION scores nearly as well on the raster.
    #  * pose: a rival TRANSLATION fits nearly as well after ICP. This is the
    #    one that matters on a uniform planting, where a row-shifted answer is
    #    not a poor fit at all -- it lands plant on plant. Measured on the olive
    #    orchard, results 3.8 m out reported fitness 0.989 and rmse_ratio 0.008,
    #    inside every quality gate, and were returned as confident. Their RMSE
    #    lead over a distinct rival was 0.005-0.014 against >= 0.063 for every
    #    correct result, so this is the signal that catches them.
    ambiguous = bool(second >= 0.85 * best_peak)
    if pose_margin is not None and pose_margin < _MIN_RMSE_MARGIN:
        ambiguous = True

    return dict(transformation=M, score=float(chosen_peak), margin=float(margin),
                ambiguous=ambiguous,
                pose_margin=(None if pose_margin is None else float(pose_margin)),
                yaw_deg=float(best_angle))
