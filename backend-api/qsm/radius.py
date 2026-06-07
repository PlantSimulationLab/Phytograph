"""Stage E: radius correction -- the #1 orchard accuracy fix.

Phase D fits each cylinder's radius independently from its assigned points. That
is locally optimal but globally noisy: poorly-covered cylinders (low SurfCov,
the one-sided-arc case) come back too FAT, which is exactly the +21%-total-volume
bias Demol 2021 measured destructively -- almost all of it in <7cm branches, with
the stem barely affected (-2.5%). Raw fitted radii would mislead a user reading
branch volume.

Stage E corrects this with three clean-room mechanisms (findings.md Phase 6,
reimplemented from permissive primitives -- NO GPL, NO pygam, deterministic):

  1. MONOTONE PATH-TAPER (rTwig flavor). Along each root->tip path, radius should
     shrink monotonically from base to tip. We fit a monotone taper of radius vs
     GrowthLength (the rTwig predictor) with isotonic regression (PAVA, pure
     numpy), WEIGHTED by SurfCov so well-covered cylinders anchor the curve and
     one-sided fits are pulled toward it. The tip is ANCHORED to a measured /
     per-species twig radius (configurable; orchard cultivars are absent from
     rTwig's DB, so the default is user-supplied).

  2. SURFCOV-GATED REPLACEMENT (TreeQSM blend). A cylinder's corrected radius is
     r = r_taper + (r_fit - r_taper) * SurfCov / sc_full, clamped to [0, r_fit-ish]:
     well-covered fits (SurfCov >= sc_full) keep their measured radius; one-sided
     fits collapse onto the taper prediction. Continuous, not a hard switch.

  3. PARENT (PIPE-MODEL) CAP. Top-down, hold each child radius to its parent's
     (the da Vinci principle that cross-section flows DOWN the tree): a poorly-
     covered child is capped at 0.95 * parent (the TreeQSM cap); a well-covered
     child is allowed a small 1.05 * parent margin so genuine fork-region wood
     isn't tightened. We deliberately do NOT *raise* an under-fed parent to
     sqrt(sum child^2): real trees don't obey strict CSA conservation, so raising
     would inflate a well-measured trunk and break the monotone taper. The cap
     therefore only ever TIGHTENS (modulo the 5% well-covered margin), so it can't
     reintroduce the over-estimation bias.

Stem (rank 0) cylinders are well-sampled all the way around, so their SurfCov is
high and mechanisms 1-2 leave them essentially untouched -- matching the measured
stem/branch error asymmetry. Topology / shoot / rank are never modified.

Deterministic: PAVA is an exact algorithm; all traversals are post-order with
id-ordered tie-breaks; no RNG.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .model import QSM, Cylinder


@dataclass
class RadiusCorrectionOptions:
    # Measured twig radius the taper is anchored to as GrowthLength -> 0 (meters).
    # rTwig default example is 4.23 mm; orchard cultivars are user-supplied.
    twig_radius: float = 0.00423
    # SurfCov at/above which a fit is "fully trusted" (keeps its measured radius).
    # TreeQSM uses 0.7 for stems; we use it as the blend denominator (the coverage
    # at/above which a fit is fully trusted). The blend is continuous down to 0 --
    # we intentionally do NOT apply TreeQSM's hard SC<0.2 reject (see correct_radii
    # step 2 for why our taper makes that over-correct).
    sc_full: float = 0.7
    # TreeQSM parent cap: a POORLY-COVERED child radius may not exceed this
    # fraction of its parent's radius (only applied to caps that TIGHTEN).
    parent_cap_frac: float = 0.95
    # A WELL-covered child may sit slightly above its parent (measurement noise at
    # a fork makes a near-base child read marginally fatter); this small margin
    # avoids tightening genuine wood while still removing gross inversions.
    well_covered_cap_frac: float = 1.05
    # Absolute floor on any radius (meters) so caps/taper can't produce 0.
    radius_min: float = 0.001
    # If a cylinder has no measured SurfCov (Phase D couldn't fit it), treat it as
    # this coverage -- i.e. distrust it and lean on the taper.
    missing_surfcov: float = 0.0


# ---------------------------------------------------------------------------
# GrowthLength + paths
# ---------------------------------------------------------------------------


def _children_of(qsm: QSM, by_id: dict | None = None) -> dict[int, list[int]]:
    by_id = by_id if by_id is not None else qsm.cylinder_by_id()
    kids: dict[int, list[int]] = {c.cyl_id: [] for c in qsm.cylinders}
    for c in qsm.cylinders:
        if c.parent_id in kids:
            kids[c.parent_id].append(c.cyl_id)
    # Deterministic child order.
    for k in kids:
        kids[k].sort()
    return kids


def growth_length(
    qsm: QSM, by_id: dict | None = None, kids: dict | None = None
) -> dict[int, float]:
    """GrowthLength per cylinder = own length + GrowthLength of all children
    (cumulative distal length; the rTwig taper predictor). Post-order, iterative.
    ``by_id``/``kids`` may be passed in to avoid recomputing them."""
    by_id = by_id if by_id is not None else qsm.cylinder_by_id()
    kids = kids if kids is not None else _children_of(qsm, by_id)
    gl: dict[int, float] = {}
    # Reverse topological order (children before parents). Roots = no parent.
    roots = [c.cyl_id for c in qsm.cylinders if c.parent_id not in by_id]
    order: list[int] = []
    stack = list(roots)
    while stack:
        cid = stack.pop()
        order.append(cid)
        stack.extend(kids[cid])
    for cid in reversed(order):
        gl[cid] = by_id[cid].length + sum(gl[k] for k in kids[cid])
    return gl


def root_to_tip_paths(
    qsm: QSM, by_id: dict | None = None, kids: dict | None = None
) -> list[list[int]]:
    """Every root->leaf path as an ordered list of cylinder ids (base->tip).
    Deterministic (children visited in id order). ``by_id``/``kids`` may be passed
    in to avoid recomputing them."""
    by_id = by_id if by_id is not None else qsm.cylinder_by_id()
    kids = kids if kids is not None else _children_of(qsm, by_id)
    roots = [c.cyl_id for c in qsm.cylinders if c.parent_id not in by_id]
    paths: list[list[int]] = []
    # DFS carrying the path; emit at leaves.
    for r in sorted(roots):
        stack: list[tuple[int, tuple[int, ...]]] = [(r, ())]
        while stack:
            cid, prefix = stack.pop()
            path = prefix + (cid,)
            if not kids[cid]:
                paths.append(list(path))
            else:
                for k in sorted(kids[cid], reverse=True):  # reverse: pop in order
                    stack.append((k, path))
    return paths


# ---------------------------------------------------------------------------
# Isotonic regression (PAVA) -- pure numpy, exact, deterministic
# ---------------------------------------------------------------------------


def _pava(y: np.ndarray, w: np.ndarray) -> np.ndarray:
    """Weighted isotonic regression: the non-decreasing sequence minimizing
    sum w_i (y_i - yhat_i)^2. Pool-Adjacent-Violators. y must be ordered so the
    desired monotone direction is non-decreasing (caller arranges this)."""
    n = y.shape[0]
    if n == 0:
        return y.copy()
    # Stack of pooled blocks, each carrying (weighted-mean value, total weight,
    # element count). Merge backwards whenever the previous block violates the
    # non-decreasing constraint.
    bval: list[float] = []
    bw: list[float] = []
    bcount: list[int] = []
    for i in range(n):
        bval.append(float(y[i]))
        bw.append(float(w[i]) if w[i] > 0 else 1e-9)
        bcount.append(1)
        while len(bval) >= 2 and bval[-2] > bval[-1]:
            tw = bw[-1] + bw[-2]
            tv = (bval[-1] * bw[-1] + bval[-2] * bw[-2]) / tw
            tc = bcount[-1] + bcount[-2]
            bval.pop(); bw.pop(); bcount.pop()
            bval[-1] = tv; bw[-1] = tw; bcount[-1] = tc
    out = np.empty(n, dtype=np.float64)
    pos = 0
    for v, c in zip(bval, bcount):
        out[pos:pos + c] = v
        pos += c
    return out


# ---------------------------------------------------------------------------
# Global monotone taper (radius vs GrowthLength)
# ---------------------------------------------------------------------------


def _global_taper(
    qsm: QSM,
    gl: dict[int, float],
    surfcov: dict[int, float],
    opts: RadiusCorrectionOptions,
    by_id: dict | None = None,
) -> dict[int, float]:
    """Monotone taper radius for EVERY cylinder from one global isotonic fit of
    radius vs GrowthLength, weighted by SurfCov and anchored to the twig radius.

    Why global, not per-path: GrowthLength STRICTLY increases base->tip along
    every root->tip path (a parent's GL = its length + all its descendants'). So a
    single fit that is non-decreasing in GL is automatically non-increasing toward
    every tip on every path at once -- a true monotone taper everywhere, with no
    cross-path averaging bumps. The taper is the rTwig "radius is a smooth
    function of growth length" model, made exact and deterministic via PAVA.

    Returns {cyl_id: r_taper}. (The blend in ``correct_radii`` decides how much of
    this to actually use per cylinder, based on SurfCov.)"""
    ids = [c.cyl_id for c in qsm.cylinders]
    by_id = by_id if by_id is not None else qsm.cylinder_by_id()
    gls = np.array([gl[c] for c in ids], dtype=np.float64)
    rs = np.array([by_id[c].radius for c in ids], dtype=np.float64)
    scs = np.array([surfcov.get(c) or 0.0 for c in ids], dtype=np.float64)

    # Sort by GL ascending (tip..base); stable + id tiebreak for determinism.
    order = np.lexsort((np.array(ids), gls))
    ids_s = [ids[i] for i in order]
    rs_s, scs_s, gls_s = rs[order], scs[order], gls[order]

    # Twig anchor at GL=0 pins the tip end of the taper toward the measured /
    # per-species twig radius (rTwig: intercept fixed at twig radius).
    r = np.concatenate([[opts.twig_radius], rs_s])
    w = np.concatenate([[2.0], np.clip(scs_s, 0.05, None)])  # firm anchor weight

    r_iso = _pava(r, w)[1:]  # drop the anchor
    return {cid: float(max(opts.radius_min, r_iso[i])) for i, cid in enumerate(ids_s)}


# ---------------------------------------------------------------------------
# Pipe-model CSA caps
# ---------------------------------------------------------------------------


def _apply_pipe_model_caps(
    radius: dict[int, float],
    qsm: QSM,
    surfcov: dict[int, float],
    opts: RadiusCorrectionOptions,
    by_id: dict | None = None,
    kids: dict | None = None,
) -> None:
    """In place: enforce the da Vinci / pipe-model relationship that a child may
    not be fatter than its parent (CSA flows DOWN the tree), and the TreeQSM
    parent cap. Both directions only TIGHTEN radii -- they never inflate -- so
    they can't reintroduce the +21% over-estimation bias, and because every cap
    pulls a child no larger than its parent, they preserve the monotone taper.

    We deliberately do NOT *raise* an under-fed parent to sqrt(sum child^2): real
    and synthetic trees don't obey strict pipe-model conservation (a trunk is not
    literally the quadratic sum of its branches), so raising would inflate a
    well-measured parent and break monotonicity. The taper blend already gives
    parents a sensible radius; here we only ensure no child overshoots it."""
    by_id = by_id if by_id is not None else qsm.cylinder_by_id()
    kids = kids if kids is not None else _children_of(qsm, by_id)

    roots = [c.cyl_id for c in qsm.cylinders if c.parent_id not in by_id]
    order: list[int] = []
    stack = list(roots)
    while stack:
        cid = stack.pop()
        order.append(cid)
        stack.extend(kids[cid])

    # Top-down so a tightened parent propagates its cap to its own children.
    for cid in order:
        p = by_id[cid].parent_id
        if p not in radius:
            continue
        sc = surfcov.get(cid, opts.missing_surfcov) or 0.0
        # HARD physical bound: a child cannot be fatter than its parent (CSA flows
        # down). This holds regardless of coverage -- a well-covered child that
        # measured fatter than its parent is a fork-region artifact, not real wood.
        # A poorly-covered child is held to the stricter TreeQSM 0.95*parent cap;
        # a well-covered one may sit right at the parent radius (cap_frac = 1).
        cap_frac = (
            opts.parent_cap_frac if sc < opts.sc_full else opts.well_covered_cap_frac
        )
        cap = cap_frac * radius[p]
        if radius[cid] > cap:
            radius[cid] = max(opts.radius_min, cap)


# ---------------------------------------------------------------------------
# Top-level correction
# ---------------------------------------------------------------------------


def correct_radii(
    qsm: QSM, opts: RadiusCorrectionOptions | None = None
) -> QSM:
    """Apply the full Stage-E radius correction. Returns a NEW QSM with corrected
    radii; topology / shoot / rank / axes are unchanged. Uses each cylinder's
    ``surf_cov`` (from Phase D) to decide how much to trust its fitted radius vs
    the path taper. Cylinders missing SurfCov are treated as low-coverage."""
    opts = opts or RadiusCorrectionOptions()
    if not qsm.cylinders:
        return _rebuild(qsm, {}, opts)

    surfcov = {c.cyl_id: c.surf_cov for c in qsm.cylinders}
    # Compute the id map + child map ONCE and thread them through every helper
    # (growth_length, taper, caps) so they aren't rebuilt 5-6x per correction.
    by_id = qsm.cylinder_by_id()
    kids = _children_of(qsm, by_id)
    gl = growth_length(qsm, by_id, kids)

    # 1) Global monotone taper prediction (radius vs GrowthLength). Monotone along
    #    every root->tip path by construction (GL increases base->tip).
    r_taper = _global_taper(qsm, gl, surfcov, opts, by_id)

    # 2) SurfCov-gated blend between the measured fit and the taper prediction.
    #    trust = clip(SurfCov / sc_full, 0, 1): a well-covered fit (SurfCov >=
    #    sc_full) keeps its measured radius in full; coverage ramps the weight down
    #    to the taper continuously as the fit becomes one-sided. We use a CONTINUOUS
    #    ramp rather than TreeQSM's hard SC<0.2 reject because our taper (a global
    #    isotonic curve anchored at the twig radius) slightly UNDER-estimates
    #    mid-branch radii, so collapsing a marginal fit fully onto it over-corrects;
    #    the soft ramp keeps a little of the measurement and validates better
    #    (branch relerr -0.07 vs -0.26 under a hard reject on the injection test).
    corrected: dict[int, float] = {}
    for c in qsm.cylinders:
        r_fit = c.radius
        rt = r_taper[c.cyl_id]
        sc = surfcov.get(c.cyl_id)
        sc = (sc if sc is not None else opts.missing_surfcov)
        trust = float(np.clip(sc / opts.sc_full, 0.0, 1.0))
        r = rt + (r_fit - rt) * trust
        corrected[c.cyl_id] = float(max(opts.radius_min, r))

    # 3) Parent (pipe-model) cap: hold each child to its parent's radius. Only
    #    tightens (modulo the well-covered margin); never raises a parent.
    _apply_pipe_model_caps(corrected, qsm, surfcov, opts, by_id, kids)

    return _rebuild(qsm, corrected, opts)


def _rebuild(qsm: QSM, corrected: dict[int, float], opts: RadiusCorrectionOptions) -> QSM:
    new_cyls: list[Cylinder] = []
    for c in qsm.cylinders:
        new_cyls.append(
            Cylinder(
                cyl_id=c.cyl_id, start=c.start.copy(), end=c.end.copy(),
                radius=corrected.get(c.cyl_id, c.radius),
                parent_id=c.parent_id, shoot_id=c.shoot_id, rank=c.rank,
                surf_cov=c.surf_cov, mad=c.mad,
            )
        )
    meta = dict(qsm.meta)
    meta.update(
        stage="radius_corrected",
        radius_corrected=True,
        twig_radius=opts.twig_radius,
    )
    return QSM(cylinders=new_cyls, shoots=qsm.shoots, units=qsm.units, meta=meta)
