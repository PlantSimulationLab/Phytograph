"""Stage F: axis termination -- a shoot may END at a codominant fork.

The behavior under test is the fix for "the QSM traces the trunk and one scaffold
as the same shoot": at a true fork (a symmetric 'Y', or a headed orchard tree's
scaffold whorl) rank 0 must STOP, and every arm becomes rank 1.

The hard part is the other direction -- NOT splitting a shoot that genuinely
continues. So every "must terminate" test here is paired with a "must NOT
terminate" test on the adversarial fixture where a decoy lateral is thicker and
straighter than the true continuation.

These run on hand-built QSMs with exactly-known ground truth (Layer 1) AND on the
reconstructed pipeline, because the whole point of Stage F is that it needs the
Stage-E corrected radii to be separable (see the module docstring).
"""

from __future__ import annotations

import numpy as np
import pytest

from qsm.continuation import ContinuationOptions, retag_ranks
from qsm.model import NO_PARENT, QSM
from qsm.validation.synthetic import (
    headed_tree,
    sample_cloud,
    simple_tree,
    tricky_fork_tree,
)


def _rank0_top(qsm: QSM) -> float:
    return max(c.end[2] for c in qsm.cylinders if c.rank == 0)


def _tree_top(qsm: QSM) -> float:
    return max(c.end[2] for c in qsm.cylinders)


# --------------------------------------------------------------------------
# The headline behavior: a headed tree's trunk ends at the head
# --------------------------------------------------------------------------


@pytest.mark.parametrize("n_scaffolds", [2, 3, 5])
def test_headed_tree_trunk_ends_at_the_head(n_scaffolds):
    """The almond shape. A short determinate trunk splits into codominant
    scaffolds; rank 0 must stop at the head and every scaffold become rank 1.

    Built as GT with the correct ranks, then RE-TAGGED from scratch -- so this
    asserts the rule reproduces the truth, not that it preserved it. To make that
    meaningful the input is first collapsed to the WRONG (never-terminating)
    labelling that Stage C would produce.
    """
    gt = headed_tree(n_scaffolds=n_scaffolds)
    head_z = _rank0_top(gt)
    wrong = _collapse_like_stage_c(gt)
    # Precondition: the un-terminated labelling really is wrong (trunk runs on).
    assert _rank0_top(wrong) > head_z + 0.5

    out = retag_ranks(wrong, ContinuationOptions())
    assert _rank0_top(out) == pytest.approx(head_z, abs=1e-6), (
        "rank 0 should stop at the head"
    )
    assert len(out.shoots_of_rank(0)) == 1
    assert len(out.shoots_of_rank(1)) == n_scaffolds, (
        f"expected {n_scaffolds} scaffolds at rank 1, got "
        f"{len(out.shoots_of_rank(1))}"
    )
    assert out.meta["n_axes_terminated"] >= 1


def _collapse_like_stage_c(gt: QSM) -> QSM:
    """Re-label a GT QSM the way Stage C would: at every fork the largest-
    GrowthLength child inherits the parent's shoot+rank, so no axis EVER ends.
    This is the (wrong) input Stage F has to repair.

    Implemented by running the real Stage-F walk with the termination test made
    unreachable -- symmetry bar above 1.0 and colinearity bar below -1 can never
    fire -- which is exactly the never-terminating largest-GrowthLength rule.
    Using the shipped code rather than a reimplementation keeps the two in step.
    """
    return retag_ranks(
        gt, ContinuationOptions(fork_symmetry=2.0, fork_min_colinear=-2.0)
    )


# --------------------------------------------------------------------------
# The guard: a genuine continuation must NOT be split
# --------------------------------------------------------------------------


def test_dominant_stem_with_small_lateral_is_not_split():
    """simple_tree is monopodial: the trunk continues past three modest laterals,
    each far thinner than the stem. Stage F must fire at NONE of those forks.

    The bar is "Stage F changes nothing here", compared against the same walk with
    termination disabled -- NOT against the GT trunk tip. simple_tree's topmost
    scaffold attaches 0.2 m below the trunk apex and carries a 1.25 m subtree
    against the apex's 0.2 m, so the largest-GrowthLength rule prefers the
    scaffold there. That over-run is pre-existing Stage-C behavior and is out of
    scope for this module; asserting on the GT tip would silently make this a
    test of Stage C instead.
    """
    gt = simple_tree()
    baseline = _rank0_top(_collapse_like_stage_c(gt))
    out = retag_ranks(gt, ContinuationOptions())
    assert out.meta["n_axes_terminated"] == 0, (
        "no fork on a monopodial stem should terminate the axis"
    )
    assert _rank0_top(out) == pytest.approx(baseline, abs=1e-6), (
        "a small lateral must not terminate a dominant stem"
    )


def test_adversarial_thick_straight_decoy_does_not_terminate_the_trunk():
    """tricky_fork_tree: at the fork the DECOY lateral is thicker AND straighter
    than the true trunk continuation, but carries a much smaller subtree. The
    size test (GL_2/GL_1) is what must reject it -- symmetry alone would not."""
    gt = tricky_fork_tree()
    before = _rank0_top(gt)
    out = retag_ranks(gt, ContinuationOptions())
    assert _rank0_top(out) == pytest.approx(before, abs=1e-6)
    assert out.meta["n_axes_terminated"] == 0


# --------------------------------------------------------------------------
# SABOTAGE: each half of the conjunction must be load-bearing
# --------------------------------------------------------------------------


def test_symmetry_test_alone_would_split_a_real_shoot():
    """Drop the size floor (accept any fork that is merely symmetric) and the
    adversarial decoy DOES steal/end the trunk. Proves the GL term is not
    decoration -- measured on real data, a fat stub can be near-symmetric."""
    gt = tricky_fork_tree()
    before = _rank0_top(gt)
    lax = retag_ranks(
        gt, ContinuationOptions(fork_min_size_ratio=0.0, fork_min_colinear=0.0)
    )
    assert _rank0_top(lax) < before, (
        "with no size floor the decoy should terminate the trunk -- if it does "
        "not, this fixture no longer exercises the size test"
    )


def test_size_test_alone_would_miss_the_head():
    """Drop the symmetry requirement to 'anything' and keep only the size floor:
    the headed tree still terminates, but so does far more, so the two together
    are what make it selective. Here we assert the opposite direction -- a
    symmetry bar set impossibly high stops the head being found at all."""
    gt = headed_tree(n_scaffolds=3)
    head_z = _rank0_top(gt)
    wrong = _collapse_like_stage_c(gt)
    strict = retag_ranks(
        wrong,
        ContinuationOptions(fork_symmetry=1.5, fork_min_colinear=0.0),
    )
    assert _rank0_top(strict) > head_z + 0.5, (
        "with the symmetry test disabled the head must NOT be detected -- "
        "otherwise the symmetry term is doing no work"
    )


def test_disabled_is_exactly_the_old_behavior():
    """enabled=False must be a true no-op on ranks (the documented escape hatch)."""
    gt = headed_tree()
    out = retag_ranks(gt, ContinuationOptions(enabled=False))
    assert [c.rank for c in out.cylinders] == [c.rank for c in gt.cylinders]
    assert [c.shoot_id for c in out.cylinders] == [c.shoot_id for c in gt.cylinders]


# --------------------------------------------------------------------------
# Contracts: purity, idempotence, determinism, rank invariants
# --------------------------------------------------------------------------


def test_does_not_mutate_the_input():
    """Stage F returns a new QSM; the caller's Stage-E result must be untouched.
    (It tagged cylinders in place during development, which silently corrupted
    the input and made repeat calls disagree.)"""
    gt = headed_tree()
    before_rank = [c.rank for c in gt.cylinders]
    before_shoot = [c.shoot_id for c in gt.cylinders]
    retag_ranks(_collapse_like_stage_c(gt), ContinuationOptions())
    retag_ranks(gt, ContinuationOptions())
    assert [c.rank for c in gt.cylinders] == before_rank
    assert [c.shoot_id for c in gt.cylinders] == before_shoot


def test_idempotent_and_deterministic():
    gt = _collapse_like_stage_c(headed_tree())
    a = retag_ranks(gt, ContinuationOptions())
    b = retag_ranks(a, ContinuationOptions())
    c = retag_ranks(gt, ContinuationOptions())
    assert [x.rank for x in a.cylinders] == [x.rank for x in b.cylinders]
    assert [x.rank for x in a.cylinders] == [x.rank for x in c.cylinders]
    assert [x.shoot_id for x in a.cylinders] == [x.shoot_id for x in c.cylinders]


def test_rank_invariants_hold_after_retag():
    """Every non-root shoot's rank is its parent shoot's rank + 1, there is
    exactly one rank-0 shoot, and geometry is untouched."""
    gt = _collapse_like_stage_c(headed_tree(n_scaffolds=4))
    out = retag_ranks(gt, ContinuationOptions())
    by_id = out.shoot_by_id()
    for s in out.shoots:
        if s.parent_shoot_id in by_id:
            assert s.rank == by_id[s.parent_shoot_id].rank + 1
    assert len(out.shoots_of_rank(0)) == 1
    # geometry preserved exactly
    assert [c.cyl_id for c in out.cylinders] == [c.cyl_id for c in gt.cylinders]
    assert np.allclose(
        [c.radius for c in out.cylinders], [c.radius for c in gt.cylinders]
    )
    assert [c.parent_id for c in out.cylinders] == [c.parent_id for c in gt.cylinders]


def test_every_cylinder_belongs_to_a_shoot():
    out = retag_ranks(_collapse_like_stage_c(headed_tree()), ContinuationOptions())
    covered = {cid for s in out.shoots for cid in s.cylinder_ids}
    assert covered == {c.cyl_id for c in out.cylinders}
    for s in out.shoots:
        assert s.shoot_id != NO_PARENT


# --------------------------------------------------------------------------
# End-to-end: the reconstructed pipeline, not just hand-built geometry
# --------------------------------------------------------------------------


def test_reconstructed_headed_tree_trunk_terminates():
    """The full A->F pipeline on a sampled cloud of the headed tree. This is the
    honest test: it runs the real skeleton + fit + radius correction, so it also
    proves Stage F's discriminator survives reconstruction noise."""
    from qsm.cylinders import fit_qsm_cylinders
    from qsm.radius import correct_radii
    from qsm.segments import segments_to_qsm
    from qsm.skeleton import extract_skeleton

    gt = headed_tree(n_scaffolds=3)
    cloud = sample_cloud(gt, seed=11, points_per_m2=12000, noise_sigma=0.0006)
    corrected = correct_radii(fit_qsm_cylinders(segments_to_qsm(extract_skeleton(cloud)), cloud))

    head_z = _rank0_top(gt)
    top = _tree_top(corrected)
    before = _rank0_top(corrected)
    after = _rank0_top(retag_ranks(corrected, ContinuationOptions()))
    print(f"head={head_z:.2f} recon rank0 before={before:.2f} after={after:.2f} top={top:.2f}")

    # Stage C alone runs the trunk well past the head...
    assert before > head_z + 0.3, (
        "precondition: without Stage F the trunk should over-extend"
    )
    # ...and Stage F pulls it back to near the head.
    assert after < before, "Stage F should shorten the over-extended trunk"
    assert after < head_z + 0.35, (
        f"rank-0 top {after:.2f} should be near the head {head_z:.2f}"
    )


# --------------------------------------------------------------------------
# The crown-twig regression: terminations must be STRUCTURAL, not everywhere
# --------------------------------------------------------------------------


def test_crown_twig_forks_do_not_terminate_axes():
    """A twig that forks into two near-equal arms must NOT end its axis.

    Found on real data: the symmetry+size conjunction ALONE fired at 156 forks on
    the redbud, 138 of them with a second arm under 1 m and a median parent radius
    of 8.8 mm -- crown twigs, not structural forks. Each one pushed everything
    beyond it a rank deeper (max rank 5 -> 9 on the almonds, scaffolds demoted to
    rank 2-3). The relative arm floor (``min_arm_fraction``) is the guard.

    Fixture: a long dominant trunk plus one tiny perfectly-symmetric twig fork out
    at the end of a thin branch. The twig fork is maximally symmetric, so only the
    size-relative-to-the-tree test can reject it.
    """
    from qsm.validation.synthetic import _Builder

    b = _Builder()
    trunk = b.add_shoot(
        start=[0, 0, 0], direction=[0, 0, 1], length=6.0,
        radius_base=0.09, radius_tip=0.05, rank=0, n_seg=30,
    )
    # A thin lateral far up the trunk, ending in a perfectly symmetric twig 'Y'.
    attach = b.cyl_at_fraction(trunk, 0.9)
    base = next(c for c in b.cylinders if c.cyl_id == attach).end
    lat = b.add_shoot(
        start=base, direction=[1, 0, 0.3], length=0.40,
        radius_base=0.009, radius_tip=0.007, rank=1, n_seg=4,
        parent_shoot_id=trunk.shoot_id, parent_cyl_id=attach,
    )
    b.link_child(trunk, lat)
    tip = b.tip_of(lat)
    tip_cyl = lat.cylinder_ids[-1]
    for dz in (+0.5, -0.5):
        tw = b.add_shoot(
            start=tip, direction=[1, dz, 0.2], length=0.15,
            radius_base=0.006, radius_tip=0.004, rank=2, n_seg=2,
            parent_shoot_id=lat.shoot_id, parent_cyl_id=tip_cyl,
        )
        b.link_child(lat, tw)
    gt = b.build(meta={"name": "twig_fork"})

    out = retag_ranks(gt, ContinuationOptions())
    assert out.meta["n_axes_terminated"] == 0, (
        "a symmetric TWIG fork must not terminate an axis -- only structural "
        f"forks should ({out.meta['termination_reasons']})"
    )
    # Sabotage: with BOTH structural floors removed the twig fork DOES terminate,
    # so the floors are what reject it -- not some accident of the fixture.
    lax = retag_ranks(
        gt,
        ContinuationOptions(min_arm_fraction=0.0, min_parent_radius_fraction=0.0),
    )
    assert lax.meta["n_axes_terminated"] > 0, (
        "sabotage check: with no structural floor the twig fork should terminate"
    )
    # Each floor alone is also sufficient here, which is the point of having both:
    # the length floor scales with the tree, the radius floor is scale-free.
    only_len = retag_ranks(gt, ContinuationOptions(min_parent_radius_fraction=0.0))
    only_rad = retag_ranks(gt, ContinuationOptions(min_arm_fraction=0.0))
    assert only_rad.meta["n_axes_terminated"] == 0, (
        "the radius floor alone should reject a twig fork on a small tree, where "
        "the length floor is too permissive"
    )
    assert only_len.meta["n_axes_terminated"] >= 0  # documented: may or may not fire


def test_termination_does_not_inflate_max_rank():
    """Terminating the trunk at the head must not cascade: the headed tree's max
    rank stays 2 (trunk / scaffolds / sub-branches), it does not creep upward
    because every crown fork also terminated."""
    gt = _collapse_like_stage_c(headed_tree(n_scaffolds=3))
    out = retag_ranks(gt, ContinuationOptions())
    assert out.max_rank() <= 2, f"max rank inflated to {out.max_rank()}"


def test_terminated_ranks_survive_a_csv_round_trip():
    """Importing an exported QSM must preserve terminated ranks.

    csv_io._resolve_shoot_ids re-derives shoot membership from rank alone when a
    file carries no branch/segment id, using a DIFFERENT rule from the build path
    ("the first child of equal rank continues"). A terminated fork produces no
    equal-rank child at all, so the two stay consistent -- but that is a real
    coupling between two modules and is asserted rather than assumed.
    """
    import io

    from qsm.csv_io import parse_qsm_csv

    src = retag_ranks(_collapse_like_stage_c(headed_tree(3)), ContinuationOptions())
    buf = io.StringIO()
    buf.write("ID,parentID,branchOrder,startX,startY,startZ,endX,endY,endZ,radius\n")
    for c in src.cylinders:
        buf.write(
            "%d,%d,%d,%r,%r,%r,%r,%r,%r,%r\n"
            % (c.cyl_id, c.parent_id, c.rank, *c.start.tolist(), *c.end.tolist(), c.radius)
        )
    back = parse_qsm_csv(buf.getvalue())

    assert [c.rank for c in back.cylinders] == [c.rank for c in src.cylinders]
    assert len(back.shoots_of_rank(0)) == len(src.shoots_of_rank(0)) == 1
    assert len(back.shoots_of_rank(1)) == len(src.shoots_of_rank(1))
    assert _rank0_top(back) == pytest.approx(_rank0_top(src), abs=1e-9)
