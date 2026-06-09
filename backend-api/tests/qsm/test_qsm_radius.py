"""Phase E: radius correction.

Model (reworked 2026-06-08 after real-data feedback): per-shoot MONOTONE taper vs
DISTANCE-FROM-BASE (anchored by the well-covered fits), a coverage-gated BRANCH
occlusion-shrink (undo the one-sided-arc over-fattening), a TWIG anchor at the
leaves, and a coverage-gated PIPE-MODEL lower bound propagated tip->base (keeps a
heavily-occluded trunk thick from the wood it carries), followed by a PAVA
monotonicity projection. The earlier GrowthLength-keyed global taper made a still-
thick trunk go thin right after a fork (GrowthLength drops at every fork) and
collapsed occluded trunks to the floor; distance-from-base + pipe-model fix both.

Phase E must:
  1. PRESERVE THE STEM. Well-sampled rank-0 radius comes out essentially
     unchanged (the Demol -2.5% vs +21% stem/branch asymmetry).
  2. CORRECT FAT BRANCHES. Injected over-fat, low-SurfCov branch cylinders are
     pulled back toward truth (the branch occlusion-shrink).
  3. MONOTONE PER SHOOT. Each continuous shoot is non-increasing base->tip after
     correction (a radius increase ACROSS a fork, trunk-tip -> thick lateral, is
     legitimate and not penalized).

We validate by INJECTING the documented failure mode (fat low-coverage branches)
into a clean Phase-D fit and checking the correction removes it without touching
the stem -- stem vs branch reported SEPARATELY. An overlay PNG is rendered too.
"""

from __future__ import annotations

import copy
from pathlib import Path

import numpy as np
import pytest

from qsm.cylinders import fit_qsm_cylinders
from qsm.radius import (
    RadiusCorrectionOptions,
    correct_radii,
    growth_length,
    _pava,
)
from qsm.segments import segments_to_qsm
from qsm.skeleton import extract_skeleton
from qsm.validation.metrics import radius_agreement
from qsm.validation.overlay import render_overlay
from qsm.validation.resample import centerline_samples
from qsm.validation.synthetic import sample_cloud, simple_tree

ARTIFACTS = Path(__file__).parent / "_artifacts"
TWIG_R = 0.005  # per-species twig radius anchor (m) for the synthetic tree


def _fit(seed=30):
    gt = simple_tree()
    cloud = sample_cloud(gt, seed=seed, points_per_m2=16000, noise_sigma=0.0005)
    fit = fit_qsm_cylinders(segments_to_qsm(extract_skeleton(cloud)), cloud)
    return gt, cloud, fit


def _inject_fat_branches(qsm, factor=1.8, surfcov=0.2):
    """Reproduce the Demol failure mode: ALL branch (rank>=1) cylinders fit too
    fat with low surface coverage -- exactly what occlusion does to a one-sided
    scan of the crown (the +21% branch-volume bias). The stem (rank 0) is left
    well-covered and correct, so the correction must fix branches WITHOUT touching
    the stem."""
    out = copy.deepcopy(qsm)
    n = 0
    for c in out.cylinders:
        if c.rank >= 1:
            c.radius *= factor
            c.surf_cov = surfcov  # occlusion drops coverage too
            n += 1
    assert n > 0
    return out


# --------------------------------------------------------------------------
# PAVA isotonic primitive
# --------------------------------------------------------------------------


def test_pava_is_monotone_and_exact():
    # Classic PAVA example: [1,3,2,4] -> [1, 2.5, 2.5, 4].
    out = _pava(np.array([1.0, 3.0, 2.0, 4.0]), np.ones(4))
    assert np.allclose(out, [1.0, 2.5, 2.5, 4.0])
    # Already monotone -> unchanged.
    inc = np.array([0.1, 0.2, 0.3])
    assert np.allclose(_pava(inc, np.ones(3)), inc)
    # Weighted: a heavy point dominates the pooled mean.
    w = np.array([1.0, 9.0])
    out2 = _pava(np.array([10.0, 0.0]), w)  # must pool to weighted mean = 1.0
    assert np.allclose(out2, [1.0, 1.0])


def test_growth_length_decreases_toward_tip():
    _, _, fit = _fit()
    gl = growth_length(fit)
    by_id = fit.cylinder_by_id()
    # Every child's GrowthLength < its parent's (cumulative distal length).
    for c in fit.cylinders:
        if c.parent_id in by_id:
            assert gl[c.cyl_id] < gl[c.parent_id] + 1e-9


# --------------------------------------------------------------------------
# Headline: correct the Demol failure mode
# --------------------------------------------------------------------------


def test_correction_keeps_stem_accurate():
    """The CORRECTED stem (rank 0) radius must be accurate -- the Demol asymmetry
    (branches carry the volume bias, the stem is reliable). Phase E must not push
    the stem AWAY from truth; if the raw fit under-covered the stem (short slices,
    low SurfCov) the pipe-model may legitimately pull it back TOWARD truth. So we
    assert the corrected stem is accurate AND no worse than the raw fit -- not that
    Phase E leaves it untouched."""
    gt, _, fit = _fit()
    g = centerline_samples(gt)
    before = radius_agreement(centerline_samples(fit), g).mean_relerr_stem
    after = radius_agreement(
        centerline_samples(correct_radii(fit, RadiusCorrectionOptions(twig_radius=TWIG_R))), g
    ).mean_relerr_stem
    # Corrected stem is accurate (well within the stem radius tolerance band).
    assert abs(after) < 0.12, f"corrected stem relerr {after:+.3f}"
    # And Phase E did not make the stem worse than the raw fit.
    assert abs(after) <= abs(before) + 0.02, f"stem worsened {before:+.3f} -> {after:+.3f}"


def test_correction_fixes_fat_low_coverage_branches():
    """Inject the documented over-fat low-SurfCov branch fits; the correction must
    reduce BOTH branch radius error and total volume error back toward truth."""
    gt, _, fit = _fit()
    g = centerline_samples(gt)
    inj = _inject_fat_branches(fit)
    corr = correct_radii(inj, RadiusCorrectionOptions(twig_radius=TWIG_R))

    m_inj = radius_agreement(centerline_samples(inj), g)
    m_corr = radius_agreement(centerline_samples(corr), g)
    # Branch radius error magnitude must drop.
    assert abs(m_corr.mean_relerr_branch) < abs(m_inj.mean_relerr_branch), (
        f"branch relerr {m_inj.mean_relerr_branch:+.3f} -> {m_corr.mean_relerr_branch:+.3f}"
    )
    # Total volume error magnitude must drop (the +21% bias is mostly branches).
    assert abs(m_corr.volume_relerr_total) < abs(m_inj.volume_relerr_total), (
        f"volume relerr {m_inj.volume_relerr_total:+.3f} -> {m_corr.volume_relerr_total:+.3f}"
    )
    # And the corrected branch radius lands within the branch tolerance band.
    assert abs(m_corr.mean_relerr_branch) < 0.20, m_corr.mean_relerr_branch
    # The stem stays ACCURATE while branches are aggressively corrected -- the
    # branch fix must not pull the stem off (the stem is left near the value the
    # fit + pipe-model give it; it is not injected, so it should stay accurate).
    assert abs(m_corr.mean_relerr_stem) < 0.12, m_corr.mean_relerr_stem


def _max_within_shoot_inversion(qsm) -> float:
    """Largest (r[i+1]-r[i])/r[i] where i,i+1 are consecutive base->tip cylinders
    of the SAME shoot (0 if every shoot is perfectly non-increasing). Per-shoot is
    the new model's contract: across a fork (trunk-tip -> thick lateral base) a
    radius increase is legitimate, so we check WITHIN each continuous axis only."""
    from qsm.radius import _distance_from_base
    by_id = qsm.cylinder_by_id()
    dist = _distance_from_base(qsm, by_id)
    worst = 0.0
    for s in qsm.shoots:
        cids = [c for c in s.cylinder_ids if c in by_id]
        cids.sort(key=lambda c: dist[c])  # base -> tip
        rs = [by_id[c].radius for c in cids]
        for a, b in zip(rs[:-1], rs[1:]):
            if b > a:
                worst = max(worst, (b - a) / a)
    return worst


def test_correction_restores_monotone_taper():
    """The reworked model guarantees each SHOOT is non-increasing base->tip (the
    per-shoot monotone taper + the PAVA monotonicity pass). Even after injecting
    grossly fat branch cylinders, every shoot comes out monotone -- the within-shoot
    inversion is ~0, far below the injected fit's."""
    _, _, fit = _fit()
    inj = _inject_fat_branches(fit)
    corr = correct_radii(inj, RadiusCorrectionOptions(twig_radius=TWIG_R))

    raw_worst = _max_within_shoot_inversion(inj)
    corr_worst = _max_within_shoot_inversion(corr)
    assert corr_worst < raw_worst, f"inversion {raw_worst:.3f} -> {corr_worst:.3f}"
    # Each shoot is monotone non-increasing base->tip (allow float noise only).
    assert corr_worst <= 1e-6, f"within-shoot inversion {corr_worst:.4f} (not monotone)"


def _fork_qsm(parent_r, child_base_r, child_tip_r):
    """A minimal two-shoot fork: a 2-cylinder trunk (shoot 0) with a 2-cylinder
    lateral (shoot 1) branching off the trunk's FIRST cylinder. All cylinders are
    well-covered (surf_cov high) so the correction's coverage-gated mechanisms are
    inert and we isolate the cross-fork cap. Radii are passed in so a test can make
    the child base deliberately fatter than its parent."""
    from qsm.model import QSM, Cylinder, Shoot
    z = np.array([0.0, 0.0, 1.0])
    x = np.array([1.0, 0.0, 0.0])
    cyls = [
        # Trunk (shoot 0): cyl 0 base -> cyl 1 tip, along +z.
        Cylinder(cyl_id=0, start=np.zeros(3), end=z * 0.5, radius=parent_r,
                 parent_id=-1, shoot_id=0, rank=0, surf_cov=0.9, mad=0.001),
        Cylinder(cyl_id=1, start=z * 0.5, end=z * 1.0, radius=parent_r * 0.8,
                 parent_id=0, shoot_id=0, rank=0, surf_cov=0.9, mad=0.001),
        # Lateral (shoot 1) off trunk cyl 0, growing in +x: base cyl 2 -> tip cyl 3.
        Cylinder(cyl_id=2, start=z * 0.5, end=z * 0.5 + x * 0.4, radius=child_base_r,
                 parent_id=0, shoot_id=1, rank=1, surf_cov=0.9, mad=0.001),
        Cylinder(cyl_id=3, start=z * 0.5 + x * 0.4, end=z * 0.5 + x * 0.8,
                 radius=child_tip_r, parent_id=2, shoot_id=1, rank=1,
                 surf_cov=0.9, mad=0.001),
    ]
    shoots = [
        Shoot(shoot_id=0, rank=0, cylinder_ids=[0, 1], parent_shoot_id=-1),
        Shoot(shoot_id=1, rank=1, cylinder_ids=[2, 3], parent_shoot_id=0,
              parent_cyl_id=0, child_shoot_ids=[]),
    ]
    return QSM(cylinders=cyls, shoots=shoots)


def test_cross_fork_cap_lowers_fat_child_base_to_parent():
    """A child branch fit fatter than the parent it grows from is physically
    impossible. The cross-fork cap lowers the child base to the parent's radius and
    re-flows the cap down the child shoot -- WITHOUT touching the parent (one-
    directional). Parent r=40mm, child base injected at 90mm (>2x)."""
    qsm = _fork_qsm(parent_r=0.040, child_base_r=0.090, child_tip_r=0.030)
    corr = correct_radii(qsm, RadiusCorrectionOptions(twig_radius=0.001))
    r = corr.cylinder_by_id()
    parent_at_fork = r[0].radius  # trunk cyl 0, the actual parent of the lateral base
    # Child base no longer exceeds its parent.
    assert r[2].radius <= parent_at_fork + 1e-9, (
        f"child base {r[2].radius:.4f} still > parent {parent_at_fork:.4f}"
    )
    # The cap fired and is recorded.
    assert corr.meta["cross_fork_capped"] >= 1
    # The parent was NOT raised to accommodate the fat child (one-directional): its
    # radius stays at the well-covered fit value, ~40mm (pipe-model is coverage-gated
    # off for a surf_cov=0.9 trunk, so it neither inflates nor is touched).
    assert abs(parent_at_fork - 0.040) < 0.005, f"parent moved to {parent_at_fork:.4f}"
    # Child shoot stays monotone non-increasing after the cap.
    assert r[3].radius <= r[2].radius + 1e-9


def test_cross_fork_cap_leaves_thin_child_untouched():
    """A child base already thinner than its parent is a legitimate taper and must
    be left exactly as-is -- the cap is a one-sided ceiling, not a normalizer."""
    qsm = _fork_qsm(parent_r=0.040, child_base_r=0.020, child_tip_r=0.010)
    base_in = qsm.cylinder_by_id()[2].radius
    corr = correct_radii(qsm, RadiusCorrectionOptions(twig_radius=0.001))
    r = corr.cylinder_by_id()
    assert corr.meta["cross_fork_capped"] == 0, "no cap should fire on a thin child"
    assert abs(r[2].radius - base_in) < 1e-9, "thin child base was altered"


def test_cross_fork_cap_can_be_disabled():
    """With cross_fork_cap=False the violation survives -- proving the cap, not some
    other mechanism, is what removes it (anti-gaming: the fat child is otherwise
    well-covered so no coverage-gated step would touch it)."""
    qsm = _fork_qsm(parent_r=0.040, child_base_r=0.090, child_tip_r=0.030)
    corr = correct_radii(
        qsm, RadiusCorrectionOptions(twig_radius=0.001, cross_fork_cap=False)
    )
    r = corr.cylinder_by_id()
    assert r[2].radius > r[0].radius + 1e-9, (
        "child base should still exceed parent when the cap is disabled"
    )
    assert corr.meta["cross_fork_capped"] == 0


def test_cross_fork_cap_clears_all_violations_on_real_tree():
    """End-to-end on a real L1 tree: after the full default pipeline NO child-shoot
    base exceeds its parent cylinder at the fork. This is the user-reported defect
    (Tree_6/Tree_9) reduced to zero."""
    tree = (
        Path(__file__).parents[3] / "example-datasets" / "L1-Tree" / "Tree_9.txt"
    )
    if not tree.exists():
        pytest.skip(f"missing fixture {tree}")
    points = np.loadtxt(tree, usecols=(0, 1, 2), dtype=np.float64)
    fit = fit_qsm_cylinders(segments_to_qsm(extract_skeleton(points)), points)
    corr = correct_radii(fit, RadiusCorrectionOptions())
    by_id = corr.cylinder_by_id()
    violations = [
        c.cyl_id for c in corr.cylinders
        if (p := by_id.get(c.parent_id)) is not None
        and c.shoot_id != p.shoot_id
        and c.radius > p.radius + 1e-9
    ]
    assert not violations, f"{len(violations)} child>parent fork violations remain"
    assert corr.meta["cross_fork_capped"] >= 1  # the defect was present and fixed


def test_twig_anchor_pulls_low_coverage_tips_toward_twig_radius():
    """The taper is anchored to the twig radius as GrowthLength->0. For LOW-COVERAGE
    tip cylinders (which lean on the taper, not their own noisy fit), a larger twig
    anchor must yield larger tip radii -- a monotone response proving the anchor is
    wired in. (Well-covered tips correctly keep their measured radius and ignore the
    anchor; that is tested implicitly by the stem-preservation test.)"""
    _, _, fit = _fit()
    kids = {c.cyl_id: [] for c in fit.cylinders}
    for c in fit.cylinders:
        if c.parent_id in kids:
            kids[c.parent_id].append(c.cyl_id)
    leaves = [c.cyl_id for c in fit.cylinders if not kids[c.cyl_id]]
    assert leaves
    # Make the tips low-coverage so they depend on the taper/anchor.
    occluded = copy.deepcopy(fit)
    o_by = occluded.cylinder_by_id()
    for cid in leaves:
        o_by[cid].surf_cov = 0.1

    small = correct_radii(occluded, RadiusCorrectionOptions(twig_radius=0.003))
    large = correct_radii(occluded, RadiusCorrectionOptions(twig_radius=0.012))
    s_by, l_by = small.cylinder_by_id(), large.cylinder_by_id()
    mean_small = float(np.mean([s_by[c].radius for c in leaves]))
    mean_large = float(np.mean([l_by[c].radius for c in leaves]))
    assert mean_large > mean_small, (mean_small, mean_large)


def test_topology_shoot_rank_preserved():
    _, _, fit = _fit()
    corr = correct_radii(fit, RadiusCorrectionOptions(twig_radius=TWIG_R))
    assert corr.meta["radius_corrected"]
    assert len(corr.cylinders) == len(fit.cylinders)
    fb = fit.cylinder_by_id()
    for c in corr.cylinders:
        p = fb[c.cyl_id]
        assert c.parent_id == p.parent_id
        assert c.shoot_id == p.shoot_id
        assert c.rank == p.rank
        # Axis endpoints untouched (only radius changes).
        assert np.allclose(c.start, p.start) and np.allclose(c.end, p.end)
    assert len(corr.shoots_of_rank(0)) == 1


def test_correction_is_deterministic():
    _, _, fit = _fit()
    r1 = [c.radius for c in correct_radii(fit, RadiusCorrectionOptions(twig_radius=TWIG_R)).cylinders]
    r2 = [c.radius for c in correct_radii(fit, RadiusCorrectionOptions(twig_radius=TWIG_R)).cylinders]
    assert r1 == r2


def test_empty_qsm():
    from qsm.model import QSM
    out = correct_radii(QSM())
    assert out.cylinders == []


def test_render_overlay_for_visual_check():
    gt, cloud, fit = _fit()
    inj = _inject_fat_branches(fit)
    corr = correct_radii(inj, RadiusCorrectionOptions(twig_radius=TWIG_R))
    out = render_overlay(
        corr, ARTIFACTS / "phaseE_radius.png", gt=gt, cloud=cloud,
        title="Phase E: radius-corrected (linewidth=radius) vs GT after fat-branch injection",
    )
    assert out.exists() and out.stat().st_size > 1000  # a real render, not blank
