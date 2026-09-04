"""Stage F: AXIS TERMINATION -- let a shoot END at a true fork.

Stage C (``segments.py``) picks a continuation child at every fork by
``argmax(w_growthlength * GL + ...)``. An arg-max always has a winner, so under
that rule **an axis can never terminate**: the trunk is traced up one arm of
every fork, all the way to the crown. That is the SimpleForest v5 rule and it is
correct for a monopodial (central-leader) tree, but wrong for the two shapes this
module exists for:

  - a **central leader that ends in a symmetric 'Y'** (eastern redbud): rank 0
    should stop at the fork and BOTH arms become rank 1;
  - a **headed / open-centre orchard tree** (almond): a short thick trunk cut at
    ~0.5-0.9 m that splits into 3-5 co-dominant scaffolds. Rank 0 should end at
    the heading cut, not trace the trunk plus one scaffold as a single shoot.

Drenou (2000, J. Arboriculture 26:264) names the structure: a headed scaffold set
is an *accidental fork* deliberately induced and then managed into a *main fork*.

WHY THIS IS A SEPARATE STAGE AFTER RADIUS CORRECTION
----------------------------------------------------
The discriminator is aRchi's sibling-radius symmetry (Martin-Ducup et al. 2020):
at a fork, ``sym = r_2 / r_1`` over the two largest children. A sibling-to-sibling
comparison is RELATIVE, so skeleton smoothing largely cancels -- unlike an
absolute angle to the parent, which is what the earlier (abandoned)
``continuation_min_colinear`` gate in ``segments.py`` used, and why it failed.

But ``sym`` is only separable once radii are GOOD. Measured on the real redbud
cloud at the true 'Y' junction, versus every other fork on the rank-0 chain:

    provisional radius (Stage C, ~sqrt(point count))   sym = 0.50   NOT separable
    fitted radius      (Stage D, raw per-cylinder)     sym = 0.39   NOT separable
    corrected radius   (Stage E, taper + pipe model)   sym = 0.90   separable

(In the first two cases unrelated non-fork junctions reach sym 0.89-0.94, i.e. the
signal is buried.) So this pass runs AFTER ``correct_radii``. It changes only
``rank`` / ``shoot_id`` labels -- never geometry -- so Stage D's point assignment
and Stage E's per-shoot monotone taper still see the full physical axis, which is
what we want: a trunk-plus-scaffold really is one smooth taper even when it is
correctly labelled as two shoots.

THE TEST
--------
Symmetry alone is not enough: a short fat stub off the trunk can also be
near-symmetric in radius. The size test is what rejects it. At each fork, with
children ranked by radius and (independently) by GrowthLength::

    sym   = r_2   / r_1     over the 2 largest children BY RADIUS
    glrat = GL_2  / GL_1    over the 2 largest children BY GROWTHLENGTH

Terminate the parent axis when BOTH are high (a codominant fork: two real arms of
comparable thickness AND comparable subtree), or when NO child continues the
parent's direction (plantscan3d's 60-degree veto -- the axis bends away).
Otherwise the Stage-C continuation stands. On the redbud this fires uniquely at
the true 'Y' (sym 0.90, glrat 0.76); every other symmetric fork there has
glrat <= 0.04 (a stub) and every other large-glrat fork is asymmetric.

Published anchors for the defaults: aRchi's fork test is r2/r1 >= 0.75; the
corroborating codominance values disagree BY CRITERION -- 0.50 (ISA definition),
0.75 (Eisner et al. 2002, hydraulic), 0.83 (Dahle et al. 2022, mechanical) -- so
0.75 is a defensible default, not a law, which is why it is exposed as a control.
The 60-degree axis veto is plantscan3d's ``angle_between_trunk_and_lateral``.

Deterministic: post-order / BFS traversals, id-ordered tie-breaks, no RNG.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, replace

import numpy as np

from .model import NO_PARENT, QSM, Shoot


@dataclass
class ContinuationOptions:
    """Thresholds for the axis-termination test. Defaults are the published
    values (aRchi 0.75; plantscan3d 60 degrees) and are validated on the redbud +
    almond datasets -- see the module docstring."""

    # aRchi fork test: r_2 / r_1 over the two largest children BY RADIUS. At or
    # above this the two arms are codominant, so the parent axis is a fork rather
    # than a stem carrying a lateral. Higher = the trunk continues through more
    # forks; lower = the trunk ends more readily.
    fork_symmetry: float = 0.75
    # Size floor: GL_2 / GL_1 over the two largest children BY GROWTHLENGTH. This
    # is what stops a short fat STUB (near-symmetric in radius, but supporting
    # almost nothing) from ending the trunk. Measured: at the redbud's true 'Y'
    # this is 0.76, while every other near-symmetric fork there is <= 0.04.
    fork_min_size_ratio: float = 0.50
    # plantscan3d's veto (cos 60 deg = 0.5): if NO child continues the parent's
    # direction this well, the axis has bent away and terminates regardless of
    # symmetry.
    fork_min_colinear: float = 0.50
    # Axis direction is measured over this distance (m) rather than from a single
    # cylinder. Skeleton bin width auto-scales with point density, so cylinders
    # are short and individually noisy -- per-cylinder directions produced
    # degenerate values on real data. Windowing fixed a false positive on the
    # redbud.
    direction_window_m: float = 0.30
    # Absolute floor: both arms of a claimed fork must carry at least this much
    # distal length (m), so skeleton fragments can never terminate an axis. Same
    # scale as SegmentOptions.min_branch_growth_length.
    min_arm_length_m: float = 0.10
    # RELATIVE floor -- the one that actually matters, and the reason an absolute
    # floor is not enough. Deep in the crown, thin twigs routinely fork into two
    # near-equal arms, so the symmetry+size conjunction alone fires everywhere:
    # measured on the redbud it terminated 156 axes, 138 of them with a second arm
    # under 1 m and a median parent radius of 8.8 mm. Those are twigs, not
    # structural forks, and each one pushed every branch beyond it a rank deeper
    # (max rank 5 -> 9, scaffolds demoted to rank 2-3).
    #
    # A fork is STRUCTURAL only if both arms are substantial relative to the whole
    # tree, so the floor scales with the tree instead of being another constant.
    # At 1% of total tree GrowthLength this cuts the redbud from 173 spurious
    # terminations to 16 while the true 'Y' (a 13.6 m arm) still terminates.
    min_arm_fraction: float = 0.01
    # STRUCTURAL-THICKNESS gate, and the scale-free half of the pair. An axis may
    # only END where it is still a structural member of the tree, expressed as a
    # fraction of the trunk's own radius. This is what the length fractions cannot
    # do on a small tree: 1% of a 6.7 m sapling's GrowthLength is 6.7 cm, which a
    # crown twig clears, whereas "at least a third as thick as the trunk" means the
    # same thing at every tree size.
    #
    # On the redbud, of the 173 forks passing symmetry+size the TRUE 'Y' has the
    # LARGEST parent radius of all (0.587 of the trunk); the median candidate is
    # 0.228. So this is the sharpest single discriminator available here.
    min_parent_radius_fraction: float = 0.35
    # Master switch. False reproduces the pre-Stage-F behavior exactly.
    enabled: bool = True


def _children_map(qsm: QSM) -> dict[int, list[int]]:
    """cyl_id -> ordered list of child cyl_ids (ascending, for determinism)."""
    kids: dict[int, list[int]] = {}
    for c in qsm.cylinders:
        if c.parent_id != NO_PARENT:
            kids.setdefault(c.parent_id, []).append(c.cyl_id)
    for v in kids.values():
        v.sort()
    return kids


def _growth_length(qsm: QSM, kids: dict[int, list[int]]) -> dict[int, float]:
    """GrowthLength per cylinder = own length + sum over children (cumulative
    distal length). One post-order pass; iterative so deep trees can't overflow
    the recursion limit."""
    by_id = {c.cyl_id: c for c in qsm.cylinders}
    roots = [c.cyl_id for c in qsm.cylinders if c.parent_id == NO_PARENT]
    order: list[int] = []
    stack = list(roots)
    while stack:
        cid = stack.pop()
        order.append(cid)
        stack.extend(kids.get(cid, ()))
    gl: dict[int, float] = {}
    for cid in reversed(order):
        gl[cid] = by_id[cid].length + sum(gl[k] for k in kids.get(cid, ()))
    return gl


def _dir_back(cid: int, by_id: dict, parent_of: dict[int, int], window: float) -> np.ndarray:
    """Unit direction of the axis ARRIVING at cylinder ``cid``, measured over
    ``window`` metres walking up the parent chain (or as far as it goes)."""
    end = by_id[cid].end
    start = by_id[cid].start
    acc = 0.0
    cur = cid
    while acc < window:
        acc += by_id[cur].length
        start = by_id[cur].start
        p = parent_of.get(cur, NO_PARENT)
        if p == NO_PARENT:
            break
        cur = p
    v = end - start
    n = float(np.linalg.norm(v))
    return v / n if n > 0 else np.zeros(3)


def _dir_fwd(
    cid: int, by_id: dict, kids: dict[int, list[int]], gl: dict[int, float], window: float
) -> np.ndarray:
    """Unit direction of the subtree LEAVING cylinder ``cid``, measured over
    ``window`` metres following the largest-GrowthLength child at each step (the
    child's own axis, i.e. where that branch is actually heading)."""
    start = by_id[cid].start
    end = by_id[cid].end
    acc = 0.0
    cur = cid
    while acc < window:
        acc += by_id[cur].length
        end = by_id[cur].end
        ch = kids.get(cur)
        if not ch:
            break
        cur = max(ch, key=lambda k: (gl[k], -k))
    v = end - start
    n = float(np.linalg.norm(v))
    return v / n if n > 0 else np.zeros(3)


def _should_terminate(
    cid: int,
    ch: list[int],
    by_id: dict,
    kids: dict[int, list[int]],
    gl: dict[int, float],
    parent_of: dict[int, int],
    opts: ContinuationOptions,
    tree_growth_length: float,
    trunk_radius: float,
) -> tuple[bool, str]:
    """Decide whether the axis arriving at ``cid`` ENDS at this fork.

    Returns (terminate, reason). Reason is recorded in QSM.meta for diagnosis.
    """
    # Both arms must be real STRUCTURAL branches -- not skeleton fragments
    # (absolute floor) and not crown twigs (floor relative to the whole tree).
    by_gl = sorted(ch, key=lambda k: (-gl[k], k))
    second_arm = gl[by_gl[1]]
    if second_arm < opts.min_arm_length_m:
        return False, ""
    if second_arm < opts.min_arm_fraction * tree_growth_length:
        return False, ""
    # The axis must still be structurally significant where it ends.
    if by_id[cid].radius < opts.min_parent_radius_fraction * trunk_radius:
        return False, ""

    # aRchi fork test on the two largest children BY RADIUS.
    by_r = sorted(ch, key=lambda k: (-by_id[k].radius, k))
    r1 = by_id[by_r[0]].radius
    r2 = by_id[by_r[1]].radius
    sym = r2 / r1 if r1 > 0 else 0.0

    # Size test on the two largest children BY GROWTHLENGTH.
    gl1 = gl[by_gl[0]]
    glrat = gl[by_gl[1]] / gl1 if gl1 > 0 else 0.0

    if sym >= opts.fork_symmetry and glrat >= opts.fork_min_size_ratio:
        return True, "codominant"

    # plantscan3d veto: no child continues the parent's direction.
    pd = _dir_back(cid, by_id, parent_of, opts.direction_window_m)
    if np.any(pd):
        best = max(
            float(np.dot(pd, _dir_fwd(k, by_id, kids, gl, opts.direction_window_m)))
            for k in ch
        )
        if best < opts.fork_min_colinear:
            return True, "axis_bends_away"
    return False, ""


def _rebuild_shoots(qsm: QSM, kids: dict[int, list[int]]) -> list[Shoot]:
    """Rebuild Shoot records from the (already re-tagged) per-cylinder shoot_id /
    rank. Mirrors the assembly in segments.py so both paths agree on what a Shoot
    record means."""
    by_id = {c.cyl_id: c for c in qsm.cylinders}
    cyl_by_shoot: dict[int, list[int]] = {}
    for c in qsm.cylinders:
        cyl_by_shoot.setdefault(c.shoot_id, []).append(c.cyl_id)

    shoots: list[Shoot] = []
    for sid in sorted(cyl_by_shoot):
        cids = cyl_by_shoot[sid]
        rank = by_id[cids[0]].rank
        # The shoot's parent = the shoot of the parent cylinder of this shoot's
        # base cylinder (the one whose parent lies in a different shoot).
        parent_shoot = NO_PARENT
        parent_cyl = NO_PARENT
        for cid in cids:
            p = by_id[cid].parent_id
            if p != NO_PARENT and by_id[p].shoot_id != sid:
                parent_shoot = by_id[p].shoot_id
                parent_cyl = p
                break
        shoots.append(
            Shoot(
                shoot_id=sid,
                rank=rank,
                cylinder_ids=cids,
                parent_shoot_id=parent_shoot,
                parent_cyl_id=parent_cyl,
            )
        )
    by_shoot = {s.shoot_id: s for s in shoots}
    for s in shoots:
        if s.parent_shoot_id in by_shoot:
            by_shoot[s.parent_shoot_id].child_shoot_ids.append(s.shoot_id)
    return shoots


def retag_ranks(qsm: QSM, opts: ContinuationOptions | None = None) -> QSM:
    """Stage F: re-assign shoot ids + ranks, allowing an axis to TERMINATE at a
    codominant fork.

    Walks the cylinder tree from the root. At each fork the Stage-C continuation
    (the largest-GrowthLength child) normally keeps the parent's shoot and rank;
    when ``_should_terminate`` fires, EVERY child instead starts a new shoot at
    ``rank + 1``. Only ``shoot_id`` / ``rank`` change -- geometry, radii, parent
    links and cylinder ids are untouched.
    """
    opts = opts or ContinuationOptions()
    if not opts.enabled or not qsm.cylinders:
        return qsm

    # Work on COPIES: this function must never mutate the caller's QSM (it is
    # called with the Stage-E result, which tests and callers may reuse), and
    # in-place tagging would also make it non-idempotent.
    cyls = [replace(c) for c in qsm.cylinders]
    work = QSM(cylinders=cyls, shoots=qsm.shoots, units=qsm.units, meta=qsm.meta)
    by_id = {c.cyl_id: c for c in cyls}
    parent_of = {c.cyl_id: c.parent_id for c in cyls}
    kids = _children_map(work)
    gl = _growth_length(work, kids)

    # Size of the whole tree, for the relative arm floor. Sum over roots so a
    # multi-stem cloud is handled the same way.
    tree_gl = sum(gl[c.cyl_id] for c in cyls if c.parent_id == NO_PARENT)
    # Trunk radius = the thickest root cylinder (the tree's structural scale).
    trunk_r = max(
        (c.radius for c in cyls if c.parent_id == NO_PARENT), default=0.0
    )

    next_shoot = 0
    n_terminated = 0
    reasons: dict[str, int] = {}

    roots = sorted(c.cyl_id for c in cyls if c.parent_id == NO_PARENT)
    q: deque[int] = deque()
    for r in roots:
        by_id[r].shoot_id = next_shoot
        by_id[r].rank = 0
        next_shoot += 1
        q.append(r)

    while q:
        cid = q.popleft()
        cur = by_id[cid]
        ch = kids.get(cid, [])
        if not ch:
            continue
        if len(ch) == 1:
            k = ch[0]
            by_id[k].shoot_id = cur.shoot_id
            by_id[k].rank = cur.rank
            q.append(k)
            continue

        terminate, reason = _should_terminate(
            cid, ch, by_id, kids, gl, parent_of, opts, tree_gl, trunk_r
        )
        if terminate:
            n_terminated += 1
            reasons[reason] = reasons.get(reason, 0) + 1
            cont = None
        else:
            # Stage-C rule: largest GrowthLength continues (lowest id breaks ties).
            cont = max(ch, key=lambda k: (gl[k], -k))

        for k in ch:
            if k == cont:
                by_id[k].shoot_id = cur.shoot_id
                by_id[k].rank = cur.rank
            else:
                by_id[k].shoot_id = next_shoot
                by_id[k].rank = cur.rank + 1
                next_shoot += 1
            q.append(k)

    shoots = _rebuild_shoots(work, kids)
    meta = dict(qsm.meta)
    meta.update(
        {
            "axis_termination": True,
            "n_axes_terminated": n_terminated,
            "termination_reasons": reasons,
            "fork_symmetry": opts.fork_symmetry,
            "n_shoots": len(shoots),
            "max_rank": max((s.rank for s in shoots), default=0),
        }
    )
    return QSM(
        cylinders=cyls, shoots=shoots, units=qsm.units, meta=meta
    )
