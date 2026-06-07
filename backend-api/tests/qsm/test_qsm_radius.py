"""Phase E: radius correction (monotone taper + pipe-model caps + twig anchor).

The accuracy bug this stage fixes (Demol 2021, destructive over 65 trees): QSM
radii over-estimate total volume by ~+21%, almost ALL of it in <7cm branches,
while the STEM is barely affected (-2.5%). Phase D's independent per-cylinder
fits reproduce exactly that failure mode -- poorly-covered (one-sided) branch
cylinders come back too fat. Phase E must:

  1. PRESERVE THE STEM. Well-sampled rank-0 cylinders (high SurfCov) must come
     out essentially unchanged -- the correction is not allowed to "fix" wood
     that was already right. This is the -2.5% vs +21% asymmetry.
  2. CORRECT FAT BRANCHES. Injected over-fat, low-SurfCov branch cylinders must
     be pulled back toward truth, reducing branch radius error and total volume
     error.
  3. RESTORE MONOTONE TAPER. After correction, no cylinder is grossly fatter than
     its parent (radius shrinks base->tip); residual inversions are bounded by the
     well-covered margin, never the raw-fit blow-up.

We validate by INJECTING the documented failure mode (fat low-coverage branch
radii) into a clean Phase-D fit and checking the correction removes it without
touching the stem -- reported stem vs branch SEPARATELY, as the plan requires.
An overlay PNG is rendered for visual check.
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
    root_to_tip_paths,
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


def _max_relative_inversion(qsm) -> float:
    """Largest (child_r - parent_r)/parent_r over all parent->child edges (0 if
    perfectly monotone)."""
    by_id = qsm.cylinder_by_id()
    worst = 0.0
    for path in root_to_tip_paths(qsm):
        rs = [by_id[c].radius for c in path]
        for a, b in zip(rs[:-1], rs[1:]):
            if b > a:
                worst = max(worst, (b - a) / a)
    return worst


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


def test_correction_preserves_stem():
    """Stem (rank 0, well-covered) radius must be essentially unchanged by the
    correction -- the -2.5% vs +21% asymmetry. We compare stem relerr on the
    clean fit before and after; it must not degrade materially."""
    gt, _, fit = _fit()
    g = centerline_samples(gt)
    before = radius_agreement(centerline_samples(fit), g).mean_relerr_stem
    after = radius_agreement(
        centerline_samples(correct_radii(fit, RadiusCorrectionOptions(twig_radius=TWIG_R))), g
    ).mean_relerr_stem
    assert abs(after - before) < 0.03, f"stem moved {before:+.3f} -> {after:+.3f}"
    assert abs(after) < 0.06, f"corrected stem relerr {after:+.3f}"


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
    # Stem stays put even while branches are aggressively corrected.
    assert abs(m_corr.mean_relerr_stem) < 0.06, m_corr.mean_relerr_stem


def test_correction_restores_monotone_taper():
    """After correction, gross radius inversions (a child much fatter than its
    parent) are removed -- the worst relative inversion drops well below the raw
    fit's and is bounded by the well-covered margin."""
    _, _, fit = _fit()
    inj = _inject_fat_branches(fit)
    opts = RadiusCorrectionOptions(twig_radius=TWIG_R)
    corr = correct_radii(inj, opts)

    raw_worst = _max_relative_inversion(inj)
    corr_worst = _max_relative_inversion(corr)
    assert corr_worst < raw_worst, f"inversion {raw_worst:.3f} -> {corr_worst:.3f}"
    # No inversion exceeds the well-covered margin (gross inversions eliminated).
    assert corr_worst <= opts.well_covered_cap_frac - 1.0 + 1e-6, corr_worst


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
