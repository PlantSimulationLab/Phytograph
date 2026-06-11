"""Unit tests for the QSM leaf-angle adjustment (Helios Hungarian port).

Covers: angle-conversion convention correctness, the Beta + ellipsoidal samplers,
the v->u rotation, and the per-cell optimal-assignment adjustment (distribution
match, base-fixed + orthonormal-basis invariants, empty/degenerate-cell pass-
through, and determinism).
"""

from __future__ import annotations

import math

import numpy as np

from qsm import leaf_angles as A
from qsm.leaves import LeafPlacement


# ---------------------------------------------------------------------------
# Angle conversions (Helios convention)
# ---------------------------------------------------------------------------
def test_cart_sphere_round_trip():
    for v in [np.array([1.0, 0, 0.3]), np.array([0, 1.0, 0.5]),
              np.array([0.3, -0.4, 0.9]), np.array([-0.2, 0.1, -0.7])]:
        r, e, a = A.cart2sphere(v)
        back = A.sphere2cart(r, e, a)
        assert np.allclose(back, v, atol=1e-9)


def test_azimuth_convention_x_y_swapped():
    # Helios cart2sphere uses atan2(x, y): +x -> pi/2, +y -> 0.
    _, _, ax = A.cart2sphere(np.array([1.0, 0.0, 0.0]))
    _, _, ay = A.cart2sphere(np.array([0.0, 1.0, 0.0]))
    assert abs(ax - math.pi / 2) < 1e-6
    assert abs(ay) < 1e-6


def test_inclination_folds_to_upper_hemisphere():
    up = A.leaf_inclination_azimuth(np.array([0.0, 0.0, 1.0]))[0]
    down = A.leaf_inclination_azimuth(np.array([0.0, 0.0, -1.0]))[0]
    assert abs(up) < 1e-6 and abs(down) < 1e-6          # both read horizontal-leaf zenith 0
    horiz = A.leaf_inclination_azimuth(np.array([1.0, 0.0, 0.0]))[0]
    assert abs(horiz - math.pi / 2) < 1e-6              # vertical leaf -> zenith 90


# ---------------------------------------------------------------------------
# Samplers
# ---------------------------------------------------------------------------
def test_beta_sampler_mean():
    rng = np.random.default_rng(0)
    mu, nu = 2.0, 6.0  # mean inclination fraction nu/(nu+mu) = 0.75 -> 67.5 deg
    zs = np.degrees([A.sample_beta_inclination(mu, nu, rng) for _ in range(20000)])
    assert abs(zs.mean() - 67.5) < 1.5


def test_ellipsoidal_axial_concentration_grows_with_ecc():
    # The distribution is AXIAL (180-deg periodic), so use the doubled-angle
    # resultant R2 to measure concentration.
    def axial_R(e):
        rng = np.random.default_rng(1)
        ph = np.array([A.sample_ellipsoidal_azimuth(e, 0.0, rng) for _ in range(20000)])
        return float(np.hypot(np.cos(2 * ph).mean(), np.sin(2 * ph).mean()))
    r0, r_mid, r_hi = axial_R(0.0), axial_R(0.7), axial_R(0.95)
    assert r0 < r_mid < r_hi
    assert r0 < 0.05  # ~uniform at e=0


# ---------------------------------------------------------------------------
# Rotation
# ---------------------------------------------------------------------------
def test_rotation_v_to_u_generic_identity_antipodal():
    v = np.array([0.0, 0.0, 1.0])
    u = np.array([1.0, 0.0, 1.0]) / math.sqrt(2)
    R = A.rotation_v_to_u(v, u)
    assert np.allclose(R @ v, u, atol=1e-9)
    assert abs(np.linalg.det(R) - 1.0) < 1e-9
    # identity
    Ri = A.rotation_v_to_u(v, v)
    assert np.allclose(Ri, np.eye(3), atol=1e-9)
    # antipodal -> 180 deg, still proper rotation
    Ra = A.rotation_v_to_u(v, -v)
    assert np.allclose(Ra @ v, -v, atol=1e-6)
    assert abs(np.linalg.det(Ra) - 1.0) < 1e-6


# ---------------------------------------------------------------------------
# Per-cell adjustment
# ---------------------------------------------------------------------------
def _horizontal_leaves(n: int, z: float = 0.5) -> list[LeafPlacement]:
    return [
        LeafPlacement(position=np.array([0.1 * (i % 5), 0.1 * (i // 5), z]),
                      basis=np.eye(3), length=0.05, width=0.03)
        for i in range(n)
    ]


_GRID = (np.array([0.5, 0.5, 0.5]), np.array([2.0, 2.0, 2.0]), 1, 1, 1)  # single cell 0


def test_adjustment_matches_erectophile_target():
    placements = _horizontal_leaves(60)
    # erectophile: mean inclination fraction nu/(nu+mu) high -> near-vertical.
    target = A.CellTarget(beta_mu=1.0, beta_nu=8.0, ecc=0.0, phi0_deg=0.0, n_measured=100)
    expected = math.degrees(0.5 * math.pi * 8.0 / 9.0)  # ~80 deg
    adj = A.adjust_placements_to_distribution(placements, {0: target}, _GRID, seed=3)
    zs = np.array([math.degrees(A.leaf_inclination_azimuth(p.basis[:, 2])[0]) for p in adj])
    assert abs(zs.mean() - expected) < 5.0  # started at 0, now tracks the target


def test_adjustment_preserves_base_and_orthonormal_basis():
    placements = _horizontal_leaves(30)
    target = A.CellTarget(beta_mu=2.0, beta_nu=4.0, ecc=0.3, phi0_deg=20.0, n_measured=100)
    adj = A.adjust_placements_to_distribution(placements, {0: target}, _GRID, seed=5)
    for a, b in zip(adj, placements):
        assert np.allclose(a.position, b.position)                 # base unchanged
        assert np.allclose(a.basis.T @ a.basis, np.eye(3), atol=1e-6)  # orthonormal
        assert np.linalg.det(a.basis) > 0                          # right-handed


def test_empty_or_no_target_cell_unchanged():
    placements = _horizontal_leaves(20)
    target = A.CellTarget(beta_mu=1.0, beta_nu=4.0, ecc=0.0, phi0_deg=0.0)
    # Target keyed to a cell that contains no leaves -> all leaves untouched.
    adj = A.adjust_placements_to_distribution(placements, {99: target}, _GRID, seed=1)
    for a, b in zip(adj, placements):
        assert np.allclose(a.basis, b.basis)


def test_degenerate_target_skipped():
    placements = _horizontal_leaves(15)
    bad = A.CellTarget(beta_mu=0.0, beta_nu=-1.0, ecc=0.0, phi0_deg=0.0)  # invalid
    adj = A.adjust_placements_to_distribution(placements, {0: bad}, _GRID, seed=1)
    for a, b in zip(adj, placements):
        assert np.allclose(a.basis, b.basis)


def test_adjustment_is_deterministic():
    placements = _horizontal_leaves(40)
    target = A.CellTarget(beta_mu=1.5, beta_nu=5.0, ecc=0.2, phi0_deg=10.0)
    a1 = A.adjust_placements_to_distribution(placements, {0: target}, _GRID, seed=7)
    a2 = A.adjust_placements_to_distribution(placements, {0: target}, _GRID, seed=7)
    a3 = A.adjust_placements_to_distribution(placements, {0: target}, _GRID, seed=8)
    assert all(np.allclose(x.basis, y.basis) for x, y in zip(a1, a2))   # same seed -> same
    assert any(not np.allclose(x.basis, y.basis) for x, y in zip(a1, a3))  # different seed


def test_single_leaf_cell():
    placements = _horizontal_leaves(1)
    target = A.CellTarget(beta_mu=1.0, beta_nu=6.0, ecc=0.0, phi0_deg=0.0)
    adj = A.adjust_placements_to_distribution(placements, {0: target}, _GRID, seed=0)
    assert np.allclose(adj[0].position, placements[0].position)
    assert np.allclose(adj[0].basis.T @ adj[0].basis, np.eye(3), atol=1e-6)
