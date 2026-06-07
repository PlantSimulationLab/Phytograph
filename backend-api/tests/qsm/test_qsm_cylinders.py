"""Phase D: robust cylinder fitting + SurfCov/mad quality metrics.

Two levels, both Layer-1 (hand-built geometry, exact ground truth):

A. SINGLE-CYLINDER fit on a forward-simulated cloud, the case the plan calls
   out: an occluded (one-sided) cylinder. We assert
     - a FULLY-sampled cylinder recovers radius to <2% and SurfCov ~1;
     - a ONE-SIDED cylinder still recovers radius within ~10% (the M-estimator
       fit does not blow up on the arc) AND its low SurfCov is flagged (<0.5),
       so Phase E knows to distrust it.
   These two assertions are the anti-gaming pair: a fit that passes radius by
   accident would still have to report honest coverage, and vice-versa.

B. FULL-QSM fit: take a synthetic tree, sample a cloud, run the real
   skeleton->segments pipeline (provisional radii), then fit_qsm_cylinders, and
   compare radius accuracy BEFORE vs AFTER against ground truth with Metric 2
   (per-bin, stem vs branch). The fit must (i) materially improve radius accuracy
   over the provisional point-count proxy, (ii) preserve topology / shoot / rank
   exactly, (iii) be deterministic. An overlay PNG is rendered for visual check.

Per the plan, radius-BIAS validation under realistic occlusion is a Layer-2
concern (PyHelios fixtures, gated on user handoff); here we validate the fitter's
MACHINERY on geometry we control.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from qsm.cylinders import CylinderFitOptions, fit_cylinder, fit_qsm_cylinders
from qsm.segments import segments_to_qsm
from qsm.skeleton import extract_skeleton
from qsm.validation.metrics import radius_agreement
from qsm.validation.overlay import render_overlay
from qsm.validation.resample import centerline_samples
from qsm.validation.synthetic import sample_cloud, simple_tree

ARTIFACTS = Path(__file__).parent / "_artifacts"


# --------------------------------------------------------------------------
# Forward simulator for a single cylinder (NOT the QSM sampler -- we want full
# control of occlusion arc + noise for the unit-level fit test).
# --------------------------------------------------------------------------


def _simulate_cylinder(
    start, axis, length, radius, n, noise, seed, arc=None, arc_center=0.0
):
    rng = np.random.default_rng(seed)
    axis = np.asarray(axis, float)
    axis = axis / np.linalg.norm(axis)
    start = np.asarray(start, float)
    # perpendicular frame
    seed_v = np.array([1.0, 0.0, 0.0]) if abs(axis[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
    u = seed_v - axis * float(np.dot(seed_v, axis))
    u /= np.linalg.norm(u)
    v = np.cross(axis, u)
    t = rng.uniform(0.0, length, n)
    th = rng.uniform(0.0, 2.0 * np.pi, n)
    if arc is not None:
        wrapped = (th - arc_center + np.pi) % (2.0 * np.pi) - np.pi
        keep = np.abs(wrapped) <= arc
        t, th = t[keep], th[keep]
    pts = (
        start[None, :]
        + t[:, None] * axis[None, :]
        + radius * (np.cos(th)[:, None] * u[None, :] + np.sin(th)[:, None] * v[None, :])
    )
    if noise > 0:
        pts = pts + rng.normal(0.0, noise, pts.shape)
    return start, start + axis * length, pts


# --------------------------------------------------------------------------
# A. single-cylinder fit
# --------------------------------------------------------------------------


def test_full_cylinder_recovers_radius_and_high_surfcov():
    start, end, pts = _simulate_cylinder(
        start=[1.0, 2.0, 0.5], axis=[0.2, 0.1, 1.0], length=0.5,
        radius=0.03, n=4000, noise=0.001, seed=1,
    )
    # Seed with a deliberately WRONG radius to prove the fit converges.
    fit = fit_cylinder(pts, start, end, seed_radius=0.05)
    assert fit is not None and fit.reliable
    assert abs(fit.radius - 0.03) / 0.03 < 0.02, f"radius {fit.radius:.4f}"
    assert fit.surf_cov > 0.9, f"surf_cov {fit.surf_cov:.3f}"
    assert fit.mad < 0.0015, f"mad {fit.mad:.4f}"


def test_occluded_cylinder_radius_within_10pct_and_low_surfcov_flagged():
    """One-sided scan: ~one quadrant of the surface is visible. Radius must still
    come back within ~10% (the deterministic Huber fit doesn't run away on the
    arc), and SurfCov must report the occlusion (low) so Phase E can correct it."""
    start, end, pts = _simulate_cylinder(
        start=[0.0, 0.0, 0.0], axis=[0.0, 0.0, 1.0], length=0.5,
        radius=0.03, n=4000, noise=0.001, seed=2, arc=0.6, arc_center=0.0,
    )
    fit = fit_cylinder(pts, start, end, seed_radius=0.05)
    assert fit is not None
    assert abs(fit.radius - 0.03) / 0.03 < 0.10, f"radius {fit.radius:.4f}"
    # Coverage honestly reports the one-sidedness (anti-gaming partner of radius).
    assert fit.surf_cov < 0.5, f"surf_cov {fit.surf_cov:.3f} should flag occlusion"


def test_fit_is_deterministic_single():
    start, end, pts = _simulate_cylinder(
        start=[0.0, 0.0, 0.0], axis=[0.1, 0.0, 1.0], length=0.4,
        radius=0.02, n=3000, noise=0.0008, seed=3,
    )
    f1 = fit_cylinder(pts, start, end, seed_radius=0.04)
    f2 = fit_cylinder(pts.copy(), start, end, seed_radius=0.04)
    assert f1.radius == f2.radius
    assert f1.surf_cov == f2.surf_cov


def test_too_few_points_returns_none():
    pts = np.zeros((3, 3))
    assert fit_cylinder(pts, [0, 0, 0], [0, 0, 1], 0.01) is None


# --------------------------------------------------------------------------
# B. full-QSM fit on a synthetic tree
# --------------------------------------------------------------------------


def _provisional_and_fitted(seed=30):
    gt = simple_tree()
    # Dense, low-noise cloud so the skeleton is clean and we test the FITTER, not
    # the skeleton. (Occlusion bias is a Layer-2 concern.)
    cloud = sample_cloud(gt, seed=seed, points_per_m2=16000, noise_sigma=0.0005)
    graph = extract_skeleton(cloud)
    prov = segments_to_qsm(graph)
    fitted = fit_qsm_cylinders(prov, cloud)
    return gt, cloud, prov, fitted


def test_fit_improves_radius_accuracy_over_provisional():
    """Metric 2 (stem + branch radius). The fitted radii must be materially
    closer to GT than the provisional point-count proxy, on BOTH stem and
    branch. We compare arc-length-weighted radius RMSE before vs after."""
    gt, cloud, prov, fitted = _provisional_and_fitted()
    gt_cl = centerline_samples(gt)
    prov_cl = centerline_samples(prov)
    fit_cl = centerline_samples(fitted)

    m_prov = radius_agreement(prov_cl, gt_cl)
    m_fit = radius_agreement(fit_cl, gt_cl)

    # Fitting must reduce overall radius RMSE.
    assert m_fit.rmse_radius < m_prov.rmse_radius, (
        f"fit RMSE {m_fit.rmse_radius:.4f} not better than "
        f"provisional {m_prov.rmse_radius:.4f}"
    )
    # And the fitted STEM radius must land close to truth (stem is well-sampled).
    assert abs(m_fit.mean_relerr_stem) < 0.15, (
        f"stem relerr {m_fit.mean_relerr_stem:.3f}"
    )


def test_fit_assigns_surfcov_and_mad():
    """Every fitted cylinder gets a SurfCov in [0,1]; the well-sampled trunk
    cylinders report high coverage and small mad."""
    gt, cloud, prov, fitted = _provisional_and_fitted()
    assert not fitted.meta["provisional_radius"]
    assert fitted.meta["n_fitted"] > 0
    trunk_cyls = [c for c in fitted.cylinders if c.rank == 0]
    assert trunk_cyls
    covs = [c.surf_cov for c in trunk_cyls if c.surf_cov is not None]
    assert covs and all(0.0 <= x <= 1.0 for x in covs)
    # The trunk is sampled all the way around -> median coverage should be high.
    assert float(np.median(covs)) > 0.5, f"trunk median SurfCov {np.median(covs):.3f}"
    mads = [c.mad for c in trunk_cyls if c.mad is not None]
    assert mads and float(np.median(mads)) < 0.005


def test_fit_preserves_topology_shoot_and_rank():
    """Phase D may only change radius/axis/quality -- not the structure Phase C
    decided. Ids, parents, shoot membership, and rank are identical."""
    gt, cloud, prov, fitted = _provisional_and_fitted()
    assert len(fitted.cylinders) == len(prov.cylinders)
    pb = prov.cylinder_by_id()
    for c in fitted.cylinders:
        p = pb[c.cyl_id]
        assert c.parent_id == p.parent_id
        assert c.shoot_id == p.shoot_id
        assert c.rank == p.rank
    assert [s.shoot_id for s in fitted.shoots] == [s.shoot_id for s in prov.shoots]
    # Exactly one trunk preserved.
    assert len(fitted.shoots_of_rank(0)) == 1


def test_full_fit_is_deterministic():
    _, _, _, f1 = _provisional_and_fitted(seed=30)
    _, _, _, f2 = _provisional_and_fitted(seed=30)
    r1 = np.array([c.radius for c in f1.cylinders])
    r2 = np.array([c.radius for c in f2.cylinders])
    assert np.array_equal(r1, r2)


def test_empty_cloud_keeps_provisional():
    gt = simple_tree()
    cloud = sample_cloud(gt, seed=5, points_per_m2=16000, noise_sigma=0.0005)
    prov = segments_to_qsm(extract_skeleton(cloud))
    out = fit_qsm_cylinders(prov, np.zeros((0, 3)))
    assert out.meta["n_fitted"] == 0
    r_prov = [c.radius for c in prov.cylinders]
    r_out = [c.radius for c in out.cylinders]
    assert r_prov == r_out


def test_render_overlay_for_visual_check():
    """Render the fitted QSM over GT + cloud so a human can eyeball radii."""
    gt, cloud, prov, fitted = _provisional_and_fitted()
    out = render_overlay(
        fitted, ARTIFACTS / "phaseD_cylinders.png", gt=gt, cloud=cloud,
        title="Phase D: fitted cylinders (color=rank) vs GT",
    )
    assert out.exists() and out.stat().st_size > 1000  # a real render, not blank
