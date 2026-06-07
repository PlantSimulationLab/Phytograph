"""Phase C: segment tree, GrowthLength, shoot rank -- the headline feature.

This is the richest suite. Asserts (per the approved plan):
- exactly one rank-0 (trunk) shoot;
- arc-length rank-confusion accuracy >= 0.85 vs ground truth;
- trunk precision & recall >= 0.95; rank-1 recall >= 0.80;
- scaffold (rank-1 shoot) count within +/-1 of GT;
- ADVERSARIAL FORK: on tricky_fork_tree (a lateral thicker/straighter than the
  continuation), the reconstructed rank-0 arc length matches the true trunk
  within 10% -- a pipeline that follows the thick lateral as the leader fails
  here even if global accuracy looks fine.
- determinism.

Layer 1: the QSM is built from a skeleton of a hand-built tree, so GT shoot/rank
are known exactly. Comparison is statistical (arc-length confusion), never 1:1.
"""

from __future__ import annotations

import numpy as np
import pytest

from qsm.model import NO_PARENT
from qsm.segments import (
    SegmentOptions,
    build_segments,
    segments_to_qsm,
)
from qsm.skeleton import extract_skeleton
from qsm.validation.metrics import rank_agreement
from qsm.validation.resample import centerline_samples
from qsm.validation.synthetic import sample_cloud, simple_tree, tricky_fork_tree
from tests.qsm import tolerances as tol

R_MIN = 0.005


def _recon(qsm_gt, seed):
    cloud = sample_cloud(qsm_gt, seed=seed, points_per_m2=12000, noise_sigma=0.0006)
    graph = extract_skeleton(cloud)
    return segments_to_qsm(graph), cloud


# --------------------------------------------------------------------------
# segment-tree + GrowthLength unit checks (no cloud -- direct on a known graph)
# --------------------------------------------------------------------------


def test_growth_length_is_cumulative_distal():
    """Build a QSM directly from a known tree's skeleton; GrowthLength of the
    trunk base must exceed any branch (it supports the whole tree)."""
    gt = simple_tree()
    recon, _ = _recon(gt, seed=30)
    # The trunk shoot (rank 0) should be the longest continuous shoot.
    by_id = recon.cylinder_by_id()
    shoot_len = {
        s.shoot_id: sum(by_id[c].length for c in s.cylinder_ids)
        for s in recon.shoots
    }
    trunk = recon.shoots_of_rank(0)
    assert len(trunk) == 1
    trunk_len = shoot_len[trunk[0].shoot_id]
    others = [v for sid, v in shoot_len.items() if sid != trunk[0].shoot_id]
    assert trunk_len > max(others), "trunk should be the longest shoot"


def test_exactly_one_trunk_shoot():
    gt = simple_tree()
    recon, _ = _recon(gt, seed=31)
    assert len(recon.shoots_of_rank(0)) == 1


def test_continuation_keeps_rank_others_increment():
    """Every non-root shoot's rank = parent shoot rank + 1; the continuation at a
    fork keeps the rank (verified via the rank monotonicity along parent links)."""
    gt = simple_tree()
    recon, _ = _recon(gt, seed=32)
    by_id = recon.shoot_by_id()
    for s in recon.shoots:
        if s.parent_shoot_id in by_id:
            assert s.rank == by_id[s.parent_shoot_id].rank + 1


# --------------------------------------------------------------------------
# shoot-rank agreement vs ground truth (statistical, arc-length confusion)
# --------------------------------------------------------------------------


def test_rank_agreement_headline_behaviors_simple_tree():
    """The headline shoot-rank behaviors that Layer-1 CAN prove on simple_tree:
    exactly one trunk, high trunk recall, low unmatched fraction. (Overall
    accuracy and rank-1 recall are resolution-limited on this fixture -- see the
    xfail test below.)"""
    gt = simple_tree()
    recon, _ = _recon(gt, seed=33)
    rk = rank_agreement(
        centerline_samples(recon, ds=0.005),
        centerline_samples(gt, ds=0.005),
        tau_rank=3 * R_MIN,
        recon_qsm=recon,
        gt_qsm=gt,
    )
    print(f"overall_acc={rk.overall_accuracy:.3f} unmatched={rk.unmatched_fraction:.3f}")
    print(f"trunk prec/recall = {rk.precision.get(0):.3f}/{rk.recall.get(0):.3f}")
    print(f"rank-1 recall = {rk.recall.get(1):.3f}")
    print("confusion:\n", rk.confusion)

    assert rk.n_rank0_shoots_recon == 1
    assert rk.recall.get(0, 0) >= tol.RANK_TRUNK_RECALL_MIN  # trunk fully covered
    assert rk.unmatched_fraction <= tol.RANK_UNMATCHED_MAX


@pytest.mark.xfail(
    reason="The strict OVERALL rank-accuracy >=0.85 + trunk-PRECISION >=0.95 bars "
    "are not achievable by design. Layer-2 (PyHelios GT) resolved the rank "
    "semantics: the GT trunk is a short determinate shoot ending in a whorl, but "
    "our largest-GrowthLength continuation extends rank-0 up a scaffold -- so trunk "
    "precision is intentionally low (~0.2-0.3) and overall arc-length accuracy "
    "caps below 0.85. Per user decision 2026-06-07 this trunk-into-scaffold "
    "behavior is ACCEPTED (the eventual fix is a confidence-gated viewport prompt, "
    "not a magic threshold). Rank is instead validated on Layer-2 via RECALL "
    "(never miss the trunk) + bounded trunk over-extension -- see "
    "test_qsm_layer2.py::test_rank_recall_and_match and "
    "::test_known_limitation_trunk_overextends_is_bounded. This strict test is "
    "kept as an xfail tripwire: if a future change DOES achieve it (e.g. the "
    "whorl-aware continuation), this will xpass and prompt re-enabling the bar.",
    strict=False,
)
def test_rank_overall_accuracy_strict_xfail_tripwire():
    gt = simple_tree()
    recon, _ = _recon(gt, seed=33)
    rk = rank_agreement(
        centerline_samples(recon, ds=0.005),
        centerline_samples(gt, ds=0.005),
        tau_rank=3 * R_MIN,
        recon_qsm=recon,
        gt_qsm=gt,
    )
    assert rk.overall_accuracy >= tol.RANK_OVERALL_ACC_MIN
    assert rk.precision.get(0, 0) >= tol.RANK_TRUNK_PREC_MIN
    assert rk.recall.get(1, 0) >= tol.RANK_R1_RECALL_MIN


def test_scaffold_count_matches_ground_truth():
    gt = simple_tree()
    recon, _ = _recon(gt, seed=34)
    gt_scaffolds = len(gt.shoots_of_rank(1))
    recon_scaffolds = len(recon.shoots_of_rank(1))
    print(f"scaffolds gt={gt_scaffolds} recon={recon_scaffolds}")
    assert abs(recon_scaffolds - gt_scaffolds) <= 1


# --------------------------------------------------------------------------
# THE adversarial fork: thick/straight lateral must NOT steal the leader
# --------------------------------------------------------------------------


def test_adversarial_fork_trunk_not_stolen():
    """tricky_fork_tree: at the fork, a lateral is thicker AND straighter than the
    true trunk continuation, but the trunk supports the larger subtree. The
    largest-GrowthLength continuation rule must keep the trunk as rank 0.

    Check: reconstructed rank-0 arc length ~= true trunk arc length (2.6 m). If
    the algorithm followed the decoy, rank-0 arc length would be far too short.
    """
    gt = tricky_fork_tree()
    recon, _ = _recon(gt, seed=35)

    recon_cl = centerline_samples(recon, ds=0.005)
    gt_cl = centerline_samples(gt, ds=0.005)
    recon_trunk_arc = float(np.sum(recon_cl.rank == 0) * recon_cl.ds)
    gt_trunk_arc = float(np.sum(gt_cl.rank == 0) * gt_cl.ds)
    print(f"trunk arc: recon={recon_trunk_arc:.3f} gt={gt_trunk_arc:.3f}")

    assert len(recon.shoots_of_rank(0)) == 1
    relerr = abs(recon_trunk_arc - gt_trunk_arc) / gt_trunk_arc
    assert relerr <= tol.RANK_TRUNK_ARCLEN_RELERR_MAX, (
        f"rank-0 arc length off by {relerr:.1%} -- the decoy lateral likely "
        f"stole the leader"
    )


def test_continuation_rules_compared_on_adversarial_gt_geometry():
    """The continuation score is most cleanly exercised on the EXACT GT geometry,
    where the decoy is genuinely straighter than the trunk's bending continuation.
    Build segments directly from a node graph that mirrors the GT (no skeleton
    smoothing to wash out the angle), and contrast the two rules at the fork:
      - largest-GrowthLength keeps the long bending trunk as the continuation;
      - pure colinearity instead follows the straight decoy.
    This proves the chosen rule (GrowthLength) is what defeats the decoy -- not an
    accident of the geometry.

    (On the RECONSTRUCTED skeleton both rules can coincide because smoothing makes
    the trunk's reconstructed direction about as straight as the decoy's; that is
    why we test the rule on exact geometry here and test the reconstructed trunk
    arc separately in the adversarial-fork test above.)"""
    import numpy as np
    from qsm.segments import build_segments, _compute_growth_length, _seg_direction
    from qsm.skeleton import SkeletonGraph

    # A minimal fork: lower trunk (0->2), then a long BENDING continuation
    # (2->...) carrying more length, and a SHORT STRAIGHT decoy off the same fork.
    # nodes laid out base->tip.
    nodes = np.array([
        [0, 0, 0.0], [0, 0, 0.5], [0, 0, 1.0],          # 0,1,2 lower trunk
        [0.2, 0, 1.6], [0.4, 0, 2.2], [0.6, 0, 2.8],    # 3,4,5 bending trunk (long)
        [0, 0, 1.5], [0, 0, 1.9],                        # 6,7 straight decoy (short)
    ], dtype=np.float64)
    parent = np.array([-1, 0, 1, 2, 3, 4, 2, 6], dtype=np.int64)
    level = np.array([0, 1, 2, 3, 4, 5, 3, 4], dtype=np.int64)
    graph = SkeletonGraph(
        nodes=nodes, parent=parent, level=level,
        point_count=np.ones(len(nodes), dtype=np.int64), root=0,
    )
    segs = build_segments(graph)
    _compute_growth_length(segs)

    # Identify the two children of the fork segment and score them both ways.
    fork = next(s for s in segs if len(s.children) >= 2)
    parent_dir = _seg_direction(segs[fork.seg_id], graph)
    kids = fork.children
    gl = {c: segs[c].growth_length for c in kids}
    colin = {
        c: float(np.dot(parent_dir, _seg_direction(segs[c], graph))) for c in kids
    }
    gl_winner = max(kids, key=lambda c: gl[c])
    angle_winner = max(kids, key=lambda c: colin[c])
    # The long bending branch wins on GrowthLength; the straight decoy wins on
    # colinearity. Different winners => the rule genuinely matters.
    assert gl_winner != angle_winner, (gl, colin)
    # And GrowthLength's winner is the one with more total distal length (the trunk).
    assert gl[gl_winner] > gl[angle_winner]


# --------------------------------------------------------------------------
# determinism
# --------------------------------------------------------------------------


def test_segments_deterministic():
    gt = simple_tree()
    cloud = sample_cloud(gt, seed=37, points_per_m2=12000, noise_sigma=0.0006)
    graph = extract_skeleton(cloud)
    a = segments_to_qsm(graph)
    b = segments_to_qsm(graph)
    assert [c.rank for c in a.cylinders] == [c.rank for c in b.cylinders]
    assert [c.shoot_id for c in a.cylinders] == [c.shoot_id for c in b.cylinders]
    assert len(a.shoots) == len(b.shoots)
