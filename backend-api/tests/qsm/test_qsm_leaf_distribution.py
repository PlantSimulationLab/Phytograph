"""Unit tests for the per-cell leaf-angle fitting (Beta + ellipsoidal).

Covers the Goel-Strebel Beta moment-match and its mapping to Helios sampler
params, the axial ellipsoidal azimuth fit + its monotone R2(e) inverse, and the
end-to-end per-cell target assembly from a synthetic triangulation.
"""

from __future__ import annotations

import math

import numpy as np

from qsm import leaf_distribution as D
from qsm import leaf_angles as A


# ---------------------------------------------------------------------------
# Beta fit
# ---------------------------------------------------------------------------
def test_fit_beta_recovers_mean_via_sampler():
    # A histogram concentrated near 80 deg should fit a Beta whose SAMPLER mean
    # (nu/(nu+mu)*90) is ~80 -- i.e. the (mu, nu) mapping is consistent.
    bins = 18
    bw = 90.0 / bins
    centers = (np.arange(bins) + 0.5) * bw
    # Gaussian-ish bump around 80 deg.
    dens = np.exp(-0.5 * ((centers - 80.0) / 6.0) ** 2)
    dens /= dens.sum() * bw
    res = D.fit_beta(centers, dens, bw)
    assert res is not None
    mu, nu = res
    sampler_mean = 90.0 * nu / (nu + mu)
    assert abs(sampler_mean - 80.0) < 3.0


def test_fit_beta_degenerate_returns_none():
    bins = 18
    bw = 90.0 / bins
    centers = (np.arange(bins) + 0.5) * bw
    # All mass in one bin -> zero variance -> no valid Beta.
    dens = np.zeros(bins)
    dens[9] = 1.0 / bw
    assert D.fit_beta(centers, dens, bw) is None
    # Empty.
    assert D.fit_beta(centers, np.zeros(bins), bw) is None


# ---------------------------------------------------------------------------
# Ellipsoidal azimuth fit
# ---------------------------------------------------------------------------
def test_r2_table_monotonic():
    assert np.all(np.diff(D._R2_TABLE) >= 0)


def test_fit_ellipsoidal_uniform_and_axial():
    bins = 36
    bw = 360.0 / bins
    centers = (np.arange(bins) + 0.5) * bw
    # Uniform azimuth -> ecc ~ 0.
    uni = np.ones(bins) / (bins * bw)
    ecc_u, _ = D.fit_ellipsoidal(centers, uni, bw)
    assert ecc_u < 0.05
    # Axial concentration around 45 deg -> high ecc, phi0 ~ 45.
    dens = np.array([math.exp(2.5 * math.cos(2 * (math.radians(c) - math.radians(45))))
                     for c in centers])
    dens /= dens.sum() * bw
    ecc_a, phi0 = D.fit_ellipsoidal(centers, dens, bw)
    assert ecc_a > 0.7
    assert abs(((phi0 - 45.0 + 90) % 180) - 90) < 5.0  # phi0 ~ 45 (mod 180)


def test_ecc_from_resultant_monotonic():
    r2s = np.linspace(0.0, float(D._R2_TABLE[-1]), 20)
    eccs = [D._ecc_from_resultant(r) for r in r2s]
    assert all(eccs[i] <= eccs[i + 1] + 1e-9 for i in range(len(eccs) - 1))


# ---------------------------------------------------------------------------
# Per-cell target assembly from a synthetic triangulation
# ---------------------------------------------------------------------------
def _erectophile_mesh(n: int, mean_zen: float, center, seed: int = 0):
    """Build small triangles whose normals are near-vertical (erectophile), all
    in cell 0."""
    rng = np.random.default_rng(seed)
    verts = []
    tris = []
    cids = []
    for _ in range(n):
        zen = float(np.clip(rng.normal(mean_zen, 5.0), 0, 90))
        az = rng.uniform(0, 360)
        nrm = A.sphere2cart(1.0, math.pi / 2 - math.radians(zen), math.radians(az))
        t1 = A._orthonormal_axis(nrm)
        t2 = np.cross(nrm, t1)
        base = np.asarray(center, dtype=np.float64)
        i0 = len(verts)
        verts += [base.tolist(), (base + 0.01 * t1).tolist(), (base + 0.01 * t2).tolist()]
        tris.append([i0, i0 + 1, i0 + 2])
        cids.append(0)
    return np.array(verts), np.array(tris), np.array(cids)


def test_compute_cell_targets_erectophile():
    center = np.array([0.5, 0.5, 0.5])
    grid = (center, np.array([2.0, 2.0, 2.0]), 1, 1, 1)
    verts, tris, cids = _erectophile_mesh(400, mean_zen=80.0, center=center)
    targets = D.compute_cell_targets(verts, tris, cids, grid)
    assert 0 in targets
    ct = targets[0]
    sampler_mean = 90.0 * ct.beta_nu / (ct.beta_nu + ct.beta_mu)
    assert abs(sampler_mean - 80.0) < 5.0
    assert ct.n_measured == 400


def test_fit_then_adjust_reproduces_distribution():
    """End-to-end: fit a target from a near-vertical mesh, then adjust horizontal
    leaves to it -> their mean inclination should track the measured mean."""
    center = np.array([0.5, 0.5, 0.5])
    grid = (center, np.array([2.0, 2.0, 2.0]), 1, 1, 1)
    verts, tris, cids = _erectophile_mesh(400, mean_zen=78.0, center=center)
    targets = D.compute_cell_targets(verts, tris, cids, grid)

    from qsm.leaves import LeafPlacement
    placements = [
        LeafPlacement(position=np.array([0.1 * (i % 5), 0.1 * (i // 5), 0.5]),
                      basis=np.eye(3), length=0.05, width=0.03)
        for i in range(80)
    ]
    adj = A.adjust_placements_to_distribution(placements, targets, grid, seed=1)
    zs = np.array([math.degrees(A.leaf_inclination_azimuth(p.basis[:, 2])[0]) for p in adj])
    assert abs(zs.mean() - 78.0) < 6.0
