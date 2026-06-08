"""Stage E: radius correction.

Phase D fits each cylinder's radius independently from its assigned points. That
is locally noisy (short, often one-sided point rings give swingy fits) and, where
a cylinder is occluded, systematically biased -- a one-sided arc looks locally
planar so least-squares prefers too-large OR, after the SurfCov gate, the fit is
distrusted and something else must fill in. Stage E turns the per-cylinder fits
into a coherent, botanically-sensible radius field.

The model has three principled ingredients (no GPL, no ML, deterministic):

  1. PER-SHOOT MONOTONE TAPER vs DISTANCE-FROM-BASE. A shoot is one continuous
     axis; its radius should shrink monotonically from base to tip. For each shoot
     we fit radius as a non-increasing function of path-length-from-the-tree-base,
     using isotonic regression (PAVA) WEIGHTED by SurfCov so the well-covered
     cylinders define the curve and the poorly-covered ones follow it.
     CRITICAL: the taper coordinate is DISTANCE, not GrowthLength. GrowthLength
     collapses at every fork (a big lateral leaving the trunk drops the trunk's
     GrowthLength sharply), which made the old global GrowthLength taper assign a
     still-thick trunk thin radii right after a fork -- the "slender middle" bug.
     Distance increases monotonically along the real axis, so the trunk stays a
     trunk.

  2. PIPE-MODEL (da Vinci) LOWER BOUND -- the occlusion backbone. A parent must be
     at least as fat as the wood it carries: r_parent >= (sum_children r_child^k)^(1/k)
     with k ~ 2.3 (area-ish, da Vinci/Leonardo's rule; k=2 is exact area
     conservation, slightly higher matches measured trees). Propagated tip->base,
     this makes the trunk thick BY CONSTRUCTION from the branches it supports, even
     when the trunk's own points are sparse/one-sided. This is what stops a heavily
     occluded trunk (typical of real single-side scans) from collapsing to the
     minimum radius. It only ever RAISES toward the structural minimum, so it can't
     manufacture the over-fat one-sided-arc bias.

  3. TWIG ANCHOR (tip boundary condition). Leaf cylinders are floored at a
     measured / per-species twig radius so tips don't taper to zero; this is a
     boundary condition on the taper, not a force applied along the whole branch.

Topology / shoot / rank / axes are never modified -- only radius. Deterministic:
PAVA is exact; all traversals are post-order / id-ordered; no RNG.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .model import NO_PARENT, QSM, Cylinder


@dataclass
class RadiusCorrectionOptions:
    # Measured twig radius leaf cylinders are floored to (meters). rTwig's example
    # is 4.23 mm; orchard cultivars are user-supplied.
    twig_radius: float = 0.00423
    # SurfCov at/above which a cylinder's fit is trusted to define the per-shoot
    # taper curve. Below this the fit is down-weighted (continuously) so the curve
    # is anchored by the well-seen cylinders, but a low-SurfCov fit still nudges it
    # rather than being thrown away.
    sc_full: float = 0.7
    # Floor weight for a zero-SurfCov cylinder in the taper fit (so it contributes
    # a little, not nothing -- avoids a shoot of all-low-SurfCov cylinders having no
    # signal at all).
    sc_floor_weight: float = 0.05
    # Pipe-model exponent k in r_parent >= (sum r_child^k)^(1/k). k=2 is exact CSA
    # conservation; real trees carry LESS than strict conservation implies (much
    # cross-section is "lost" to many small branches), so a strict k=2 summed up a
    # deep tree grossly over-inflates the trunk. A higher k weights the largest
    # child more and suppresses the long tail of small branches -- closer to how an
    # axis's radius actually relates to its dominant continuation. ~2.5 validated
    # well against the synthetic ground truth.
    pipe_exponent: float = 2.5
    # The pipe-model is applied ONLY to the extent a cylinder is poorly covered:
    # target = lerp(taper_value, pipe_min, 1 - trust), trust = clip(SurfCov/sc_full).
    # A WELL-covered cylinder keeps its measured taper (so well-scanned trunks --
    # e.g. the synthetic fixtures -- are NOT inflated); a poorly-covered / occluded
    # cylinder (typical real trunk) leans on the structural minimum so it stays
    # thick. This makes the pipe-model a rescue for occlusion, not a blanket bound.
    pipe_strength: float = 1.0
    # Branch occlusion-shrink. Phase D's cylinder fit over-estimates radius on
    # one-sided/occluded BRANCHES (a partial arc looks locally flatter, so least-
    # squares prefers a larger circle) -- the documented Demol +20% branch-volume
    # bias. We shrink a poorly-covered BRANCH (rank>=1) cylinder toward the taper
    # by up to branch_shrink_max * (1 - trust): a well-covered branch is untouched,
    # a fully-occluded one is shrunk most. Trunks (rank 0, well covered, and held
    # up by the pipe-model) are exempt so this never re-thins the trunk. Tuned so
    # synthetic total-volume error returns under the L2 bar without re-introducing
    # the real-tree thin-trunk / collapsed-branch failures.
    branch_shrink_max: float = 0.45
    # Absolute floor on any radius (meters).
    radius_min: float = 0.001
    # SurfCov assumed for a cylinder Phase D couldn't fit (None surf_cov).
    missing_surfcov: float = 0.0


# ---------------------------------------------------------------------------
# Topology helpers
# ---------------------------------------------------------------------------


def _children_of(qsm: QSM, by_id: dict | None = None) -> dict[int, list[int]]:
    by_id = by_id if by_id is not None else qsm.cylinder_by_id()
    kids: dict[int, list[int]] = {c.cyl_id: [] for c in qsm.cylinders}
    for c in qsm.cylinders:
        if c.parent_id in kids:
            kids[c.parent_id].append(c.cyl_id)
    for k in kids:
        kids[k].sort()
    return kids


def _topo_order(qsm: QSM, by_id: dict, kids: dict) -> list[int]:
    """Cylinder ids in root->descendant order (parents before children)."""
    roots = [c.cyl_id for c in qsm.cylinders if c.parent_id not in by_id]
    order: list[int] = []
    stack = list(sorted(roots, reverse=True))
    while stack:
        cid = stack.pop()
        order.append(cid)
        stack.extend(sorted(kids[cid], reverse=True))
    return order


def growth_length(
    qsm: QSM, by_id: dict | None = None, kids: dict | None = None
) -> dict[int, float]:
    """GrowthLength per cylinder = own length + GrowthLength of all children
    (cumulative distal length). Retained as a public helper (used by tests and
    callers); the radius taper no longer keys on it. ``by_id``/``kids`` optional."""
    by_id = by_id if by_id is not None else qsm.cylinder_by_id()
    kids = kids if kids is not None else _children_of(qsm, by_id)
    gl: dict[int, float] = {}
    order = _topo_order(qsm, by_id, kids)
    for cid in reversed(order):
        gl[cid] = by_id[cid].length + sum(gl[k] for k in kids[cid])
    return gl


def _distance_from_base(qsm: QSM, by_id: dict) -> dict[int, float]:
    """Path length from the tree base to the FAR end of each cylinder, summed
    along the parent chain. Monotonically increases along every shoot/axis (unlike
    GrowthLength, which drops at forks), so it is the right taper coordinate."""
    dist: dict[int, float] = {}
    # Resolve in root->child order so a parent's distance is known first.
    kids = _children_of(qsm, by_id)
    for cid in _topo_order(qsm, by_id, kids):
        p = by_id[cid].parent_id
        base = dist[p] if p in dist else 0.0
        dist[cid] = base + by_id[cid].length
    return dist


def root_to_tip_paths(
    qsm: QSM, by_id: dict | None = None, kids: dict | None = None
) -> list[list[int]]:
    """Every root->leaf path as an ordered list of cylinder ids (base->tip)."""
    by_id = by_id if by_id is not None else qsm.cylinder_by_id()
    kids = kids if kids is not None else _children_of(qsm, by_id)
    roots = [c.cyl_id for c in qsm.cylinders if c.parent_id not in by_id]
    paths: list[list[int]] = []
    for r in sorted(roots):
        stack: list[tuple[int, tuple[int, ...]]] = [(r, ())]
        while stack:
            cid, prefix = stack.pop()
            path = prefix + (cid,)
            if not kids[cid]:
                paths.append(list(path))
            else:
                for k in sorted(kids[cid], reverse=True):
                    stack.append((k, path))
    return paths


# ---------------------------------------------------------------------------
# Isotonic regression (PAVA) -- exact, deterministic
# ---------------------------------------------------------------------------


def _pava(y: np.ndarray, w: np.ndarray) -> np.ndarray:
    """Weighted isotonic regression: the NON-DECREASING sequence minimizing
    sum w_i (y_i - yhat_i)^2 (Pool-Adjacent-Violators). Caller orders y so the
    desired monotone direction is non-decreasing."""
    n = y.shape[0]
    if n == 0:
        return y.copy()
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
# Mechanism 1: per-shoot monotone taper vs distance-from-base
# ---------------------------------------------------------------------------


def _per_shoot_taper(
    qsm: QSM,
    dist: dict[int, float],
    surfcov: dict[int, float],
    by_id: dict,
    opts: RadiusCorrectionOptions,
) -> dict[int, float]:
    """For each shoot, fit radius as a NON-INCREASING function of distance-from-
    base via SurfCov-weighted isotonic regression over the shoot's own cylinders.
    The well-covered cylinders define the curve; poorly-covered ones are pulled
    onto it (rather than onto a global thin curve). Returns {cyl_id: r_taper}.

    A cylinder that belongs to no shoot (shouldn't happen) keeps its fitted radius.
    """
    r_taper: dict[int, float] = {c.cyl_id: c.radius for c in qsm.cylinders}

    for shoot in qsm.shoots:
        cids = [c for c in shoot.cylinder_ids if c in by_id]
        if not cids:
            continue
        # Order base->tip by distance-from-base.
        cids.sort(key=lambda c: dist[c])
        rs = np.array([by_id[c].radius for c in cids], dtype=np.float64)
        scs = np.array(
            [surfcov.get(c, opts.missing_surfcov) or 0.0 for c in cids],
            dtype=np.float64,
        )
        w = np.clip(scs / opts.sc_full, opts.sc_floor_weight, 1.0)

        # Radius must be NON-INCREASING base->tip. PAVA fits non-DECREASING, so we
        # isotonic-fit the REVERSED sequence (tip->base is non-decreasing) and flip
        # back. Weighted so well-covered cylinders dominate.
        r_iso = _pava(rs[::-1], w[::-1])[::-1]
        for i, c in enumerate(cids):
            r_taper[c] = float(max(opts.radius_min, r_iso[i]))
    return r_taper


def _apply_branch_occlusion_shrink(
    radius: dict[int, float],
    qsm: QSM,
    surfcov: dict[int, float],
    opts: RadiusCorrectionOptions,
) -> None:
    """In place: shrink poorly-covered BRANCH (rank>=1) cylinders to counter the
    one-sided-arc radius over-estimation (Demol's +20% branch-volume bias). The
    shrink is gated by coverage -- factor = 1 - branch_shrink_max*(1-trust),
    trust = clip(SurfCov/sc_full) -- so a well-covered branch is untouched and a
    fully-occluded one is shrunk most. Trunks (rank 0) are exempt: they are well
    covered and are the pipe-model's job to keep thick, so we never thin them."""
    if opts.branch_shrink_max <= 0:
        return
    for c in qsm.cylinders:
        if c.rank < 1:
            continue
        sc = surfcov.get(c.cyl_id, opts.missing_surfcov) or 0.0
        trust = float(np.clip(sc / opts.sc_full, 0.0, 1.0))
        factor = 1.0 - opts.branch_shrink_max * (1.0 - trust)
        radius[c.cyl_id] = max(opts.radius_min, radius[c.cyl_id] * factor)


# ---------------------------------------------------------------------------
# Mechanism 2: pipe-model (da Vinci) lower bound -- occlusion backbone
# ---------------------------------------------------------------------------


def _apply_pipe_model(
    radius: dict[int, float],
    qsm: QSM,
    by_id: dict,
    kids: dict,
    surfcov: dict[int, float],
    opts: RadiusCorrectionOptions,
) -> None:
    """In place: raise an UNDER-FED, POORLY-COVERED cylinder toward the pipe-model
    minimum r >= (sum_children r_child^k)^(1/k). Propagated tip->base (reverse topo
    order) so a parent sees its children's already-resolved radii.

    Gated by coverage: target = lerp(current, pipe_min, (1 - trust) * strength),
    trust = clip(SurfCov / sc_full, 0, 1), and only ever RAISES (never shrinks). So
    a well-covered cylinder keeps its measured taper radius (synthetic/well-scanned
    trunks are not inflated), while a poorly-covered / occluded cylinder leans on
    the structural minimum and stays thick -- the occlusion rescue. Because the
    raise propagates tip->base, a thick child correctly forces a thick parent."""
    order = _topo_order(qsm, by_id, kids)
    k = opts.pipe_exponent
    for cid in reversed(order):  # tip -> base
        ck = kids[cid]
        if not ck:
            continue
        csa_sum = sum(radius[c] ** k for c in ck)
        pipe_min = csa_sum ** (1.0 / k) if csa_sum > 0 else 0.0
        if pipe_min <= radius[cid]:
            continue
        sc = surfcov.get(cid, opts.missing_surfcov) or 0.0
        trust = float(np.clip(sc / opts.sc_full, 0.0, 1.0))
        frac = (1.0 - trust) * opts.pipe_strength
        target = radius[cid] + (pipe_min - radius[cid]) * frac
        radius[cid] = max(opts.radius_min, target)


def _enforce_shoot_monotonicity(
    radius: dict[int, float],
    qsm: QSM,
    dist: dict[int, float],
    surfcov: dict[int, float],
    by_id: dict,
    opts: RadiusCorrectionOptions,
) -> None:
    """In place: make each shoot's radius NON-INCREASING base->tip again. The taper
    guarantees this, but the coverage-gated pipe-model can leave small bumps. We
    restore monotonicity with a SurfCov-weighted isotonic projection (PAVA) -- the
    closest non-increasing sequence to the current radii -- rather than a tip->base
    cumulative max. PAVA distributes the adjustment (pooling violators to their
    weighted mean) so a single over-fat distal cylinder does NOT lift the whole
    proximal trunk; well-covered cylinders (high weight) anchor the result. Only the
    monotonicity is imposed; magnitudes stay close to the measured/structural input."""
    for shoot in qsm.shoots:
        cids = [c for c in shoot.cylinder_ids if c in by_id]
        if len(cids) < 2:
            continue
        cids.sort(key=lambda c: dist[c])  # base -> tip
        rs = np.array([radius[c] for c in cids], dtype=np.float64)
        scs = np.array(
            [surfcov.get(c, opts.missing_surfcov) or 0.0 for c in cids],
            dtype=np.float64,
        )
        w = np.clip(scs / opts.sc_full, opts.sc_floor_weight, 1.0)
        # Non-increasing base->tip == non-decreasing tip->base: fit reversed, flip.
        r_mono = _pava(rs[::-1], w[::-1])[::-1]
        for i, c in enumerate(cids):
            radius[c] = float(max(opts.radius_min, r_mono[i]))


# ---------------------------------------------------------------------------
# Mechanism 3: twig anchor (tip boundary condition)
# ---------------------------------------------------------------------------


def _apply_twig_anchor(
    radius: dict[int, float], qsm: QSM, kids: dict, opts: RadiusCorrectionOptions
) -> None:
    """Floor each LEAF cylinder (no children) at the twig radius so tips don't
    taper to ~zero. Boundary condition only -- interior cylinders are untouched."""
    if opts.twig_radius <= 0:
        return
    for c in qsm.cylinders:
        if not kids[c.cyl_id]:
            radius[c.cyl_id] = max(radius[c.cyl_id], opts.twig_radius)


# ---------------------------------------------------------------------------
# Top-level correction
# ---------------------------------------------------------------------------


def correct_radii(qsm: QSM, opts: RadiusCorrectionOptions | None = None) -> QSM:
    """Apply the Stage-E radius correction. Returns a NEW QSM with corrected radii;
    topology / shoot / rank / axes unchanged.

    Pipeline: (1) per-shoot monotone taper vs distance-from-base, anchored by the
    well-covered fits; (2) twig-radius floor at the leaves; (3) pipe-model lower
    bound propagated tip->base so trunks are thick from what they carry even under
    occlusion. Steps 2-3 only ever RAISE toward a structural minimum; the taper
    sets the measured shape."""
    opts = opts or RadiusCorrectionOptions()
    if not qsm.cylinders:
        return _rebuild(qsm, {}, opts)

    by_id = qsm.cylinder_by_id()
    kids = _children_of(qsm, by_id)
    surfcov = {c.cyl_id: c.surf_cov for c in qsm.cylinders}
    dist = _distance_from_base(qsm, by_id)

    # 1) Per-shoot monotone taper (the measured shape).
    corrected = _per_shoot_taper(qsm, dist, surfcov, by_id, opts)

    # 1b) Shrink poorly-covered branches to undo the one-sided-arc over-estimation
    #     (before the pipe-model, so trunk rescue uses the corrected branch radii).
    _apply_branch_occlusion_shrink(corrected, qsm, surfcov, opts)

    # 2) Twig anchor at the leaves (tip boundary condition).
    _apply_twig_anchor(corrected, qsm, kids, opts)

    # 3) Pipe-model lower bound (the occlusion backbone -- keeps trunks thick),
    #    gated by coverage so well-scanned cylinders keep their measured taper.
    _apply_pipe_model(corrected, qsm, by_id, kids, surfcov, opts)

    # 4) Restore per-shoot monotonicity (the gated pipe-model can leave bumps).
    _enforce_shoot_monotonicity(corrected, qsm, dist, surfcov, by_id, opts)

    # Final floor.
    for cid in corrected:
        corrected[cid] = max(corrected[cid], opts.radius_min)

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
        pipe_exponent=opts.pipe_exponent,
    )
    return QSM(cylinders=new_cyls, shoots=qsm.shoots, units=qsm.units, meta=meta)
