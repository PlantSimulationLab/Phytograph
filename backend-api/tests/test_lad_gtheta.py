"""Tests for the analytic G(theta) derivation (backend-api/lad_gtheta.py).

These are correctness tests, not plumbing checks: each asserts a known property
of the Ross G-function for a prescribed leaf-angle distribution.

Key oracles:
  - The spherical (random) distribution yields G == 0.5 at every beam zenith.
  - de Wit families have known angular signatures (planophile high near nadir and
    falling with zenith; erectophile the reverse).
  - A Beta fit of a de Wit shape (via the existing QSM fitter) reproduces the same
    G(theta), proving the Beta convention is consistent end to end.
"""

import math

import numpy as np
import pytest

import lad_gtheta as L


# A spread of beam zeniths (radians) spanning the canopy-relevant range.
BEAM_ZEN = np.radians(np.arange(5, 86, 5))


def _theta_grid():
    return L._theta_L_grid()


# ---------------------------------------------------------------------------
# Spherical => G == 0.5 everywhere (the canonical analytic check).
# ---------------------------------------------------------------------------
def test_spherical_gives_half_at_all_zeniths():
    tl = _theta_grid()
    g = L.g_of_theta(L.dewit_density("spherical", tl), tl, BEAM_ZEN)
    assert np.max(np.abs(g - 0.5)) < 1e-2, f"spherical G not ~0.5: {g}"


def test_spherical_effective_is_half():
    assert L.gtheta_from_dewit("spherical", BEAM_ZEN) == pytest.approx(0.5, abs=1e-2)


# ---------------------------------------------------------------------------
# de Wit angular signatures.
# ---------------------------------------------------------------------------
def test_planophile_decreases_with_zenith():
    tl = _theta_grid()
    g = L.g_of_theta(L.dewit_density("planophile", tl), tl, BEAM_ZEN)
    # Mostly-horizontal leaves project strongly onto a near-nadir beam and weakly
    # onto a grazing one: G falls monotonically (allow tiny numerical wiggle).
    assert g[0] > g[-1]
    assert np.all(np.diff(g) < 1e-3)


def test_erectophile_increases_with_zenith():
    tl = _theta_grid()
    g = L.g_of_theta(L.dewit_density("erectophile", tl), tl, BEAM_ZEN)
    # Mostly-vertical leaves: the opposite trend.
    assert g[-1] > g[0]
    assert np.all(np.diff(g) > -1e-3)


def test_planophile_exceeds_erectophile_near_nadir():
    g_plan = L.g_of_theta(L.dewit_density("planophile", _theta_grid()), _theta_grid(), BEAM_ZEN)
    g_erec = L.g_of_theta(L.dewit_density("erectophile", _theta_grid()), _theta_grid(), BEAM_ZEN)
    assert g_plan[0] > g_erec[0]


def test_all_dewit_in_unit_interval():
    tl = _theta_grid()
    for name in L.DEWIT_NAMES:
        g = L.g_of_theta(L.dewit_density(name, tl), tl, BEAM_ZEN)
        assert np.all(g > 0.0) and np.all(g <= 1.0), f"{name} G out of (0,1]: {g}"


def test_unknown_dewit_rejected():
    with pytest.raises(ValueError):
        L.dewit_density("bananaphile", _theta_grid())


# ---------------------------------------------------------------------------
# Beta convention round-trips against the QSM fitter.
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("name", ["planophile", "erectophile", "plagiophile"])
def test_beta_fit_of_dewit_reproduces_gtheta(name):
    """Fit a Beta to a de Wit shape with the QSM moment-matcher, then derive G via
    the Beta path; it must match the de Wit path. Closes the convention loop."""
    from qsm.leaf_distribution import fit_beta

    nb = 90
    edges = np.linspace(0.0, 90.0, nb + 1)
    centers = 0.5 * (edges[:-1] + edges[1:])  # degrees
    bw = 90.0 / nb
    dens = L.dewit_density(name, np.radians(centers))
    dens = dens / (dens.sum() * bw)  # normalize in degrees

    fit = fit_beta(centers, dens, bw)
    assert fit is not None, f"fit_beta failed for {name}"
    mu, nu = fit

    g_dewit = L.gtheta_from_dewit(name, BEAM_ZEN)
    g_beta = L.gtheta_from_beta(mu, nu, BEAM_ZEN)
    assert g_beta == pytest.approx(g_dewit, abs=5e-3)


def test_beta_toward_vertical_lowers_gtheta_relative_to_horizontal():
    # nu>mu => toward vertical (more erectophile); mu>nu => toward horizontal.
    g_vertical = L.gtheta_from_beta(mu=1.0, nu=3.0, beam_zenith=BEAM_ZEN)
    g_horizontal = L.gtheta_from_beta(mu=3.0, nu=1.0, beam_zenith=BEAM_ZEN)
    # Averaged over a wide zenith spread, a more-horizontal canopy has the larger
    # mean G (it projects strongly near nadir where most of the range sits below).
    assert g_horizontal > g_vertical


def test_beta_rejects_nonpositive_params():
    with pytest.raises(ValueError):
        L.gtheta_from_beta(0.0, 1.0, BEAM_ZEN)
    with pytest.raises(ValueError):
        L.gtheta_from_beta(1.0, -2.0, BEAM_ZEN)


# ---------------------------------------------------------------------------
# Beam-zenith integration reflects the acquisition geometry.
# ---------------------------------------------------------------------------
def test_beam_zenith_window_changes_nonspherical_gtheta():
    # A narrow near-nadir window vs. a wide window give different effective G for a
    # non-spherical distribution; for planophile, near-nadir beams see a higher G.
    narrow = np.radians(np.array([5.0, 10.0, 15.0]))
    wide = np.radians(np.arange(5, 86, 5))
    g_narrow = L.gtheta_from_dewit("planophile", narrow)
    g_wide = L.gtheta_from_dewit("planophile", wide)
    assert g_narrow > g_wide
    # Spherical is invariant to the window (G == 0.5 either way).
    assert L.gtheta_from_dewit("spherical", narrow) == pytest.approx(
        L.gtheta_from_dewit("spherical", wide), abs=1e-2)


def test_beam_zenith_samples_from_dirs():
    # Straight-down beams -> zenith 0; horizontal -> pi/2; 45 deg -> pi/4.
    dirs = np.array([[0, 0, -1.0], [1.0, 0, 0], [1.0, 0, -1.0]])
    z = L.beam_zenith_samples(dirs)
    assert z[0] == pytest.approx(0.0, abs=1e-6)
    assert z[1] == pytest.approx(math.pi / 2, abs=1e-6)
    assert z[2] == pytest.approx(math.pi / 4, abs=1e-6)


def test_empty_beam_zenith_falls_back_not_crashes():
    # No beam directions -> a representative oblique angle is used, G still finite.
    g = L.gtheta_from_dewit("erectophile", np.array([]))
    assert 0.0 < g <= 1.0


# ---------------------------------------------------------------------------
# Constant passthrough.
# ---------------------------------------------------------------------------
def test_constant_passthrough_and_validation():
    assert L.gtheta_constant(0.42) == 0.42
    for bad in (0.0, -0.1, 1.5):
        with pytest.raises(ValueError):
            L.gtheta_constant(bad)
