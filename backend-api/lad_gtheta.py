"""Derive the mean leaf-projection coefficient G(theta) from a prescribed
leaf-angle distribution, for the LAD inversion's "supply G(theta) directly" path.

Background
----------
The leaf-area-density (LAD) inversion converts beam attenuation into leaf area via
Beer's law, in which G(theta) is the mean fraction of leaf area projected onto the
plane perpendicular to a beam travelling at zenith angle ``theta``. Normally G(theta)
is estimated per voxel from a triangulated leaf surface. This module instead computes
G(theta) analytically from a *prescribed* leaf-inclination distribution g_L(theta_L)
(de Wit classical families, or a Goel-Strebel Beta), so a user with a known or assumed
canopy structure can skip triangulation entirely.

The math
--------
For a leaf-inclination distribution g_L(theta_L) with a uniform (random) azimuth, the
Ross G-function at beam zenith ``theta`` is the azimuthally-averaged projection

    G(theta) = integral_0^{pi/2} A(theta, theta_L) g_L(theta_L) dtheta_L

with the standard Warren-Wilson / Lemeur kernel (e.g. Wang et al. 2007, Eq. 4):

    x = cot(theta) * cot(theta_L)
    if |x| > 1:  A = |cos(theta) cos(theta_L)|
    else:        psi = arccos(x)
                 A = cos(theta) cos(theta_L) * (1 + (2/pi) * (tan(psi) - psi))

The spherical (random) distribution g_L = sin(theta_L) yields G == 0.5 at every beam
zenith, which is the canonical correctness check.

Beam zenith
-----------
G(theta) depends on the beam zenith. A LiDAR acquisition fires beams over a range of
zenith angles, so we integrate G over the *actual* distribution of beam zeniths in the
contributing scan(s): G_eff = mean over the fired beams of G(theta_beam). The inversion
pipeline already reconstructs a per-beam direction for every scan (static and moving
alike), so the beam zeniths are taken straight from those directions.

Beta convention
---------------
Matches the QSM leaf-angle convention (``qsm.leaf_angles.sample_beta_inclination``):
zenith = (pi/2) * b with b ~ Beta(alpha=nu, beta=mu), so the mean inclination fraction
is nu/(nu+mu) (nu = toward-vertical weight, mu = toward-horizontal weight). A Beta fit
produced by ``qsm.leaf_distribution.fit_beta`` therefore round-trips through here.
"""

from __future__ import annotations

import math
from typing import Sequence

import numpy as np
from scipy.stats import beta as _beta_dist

# Canonical de Wit leaf-inclination distributions (Bunnik 1978 / de Wit 1965 forms).
# Names are the user-facing menu values.
DEWIT_NAMES = (
    "spherical",
    "planophile",
    "erectophile",
    "plagiophile",
    "extremophile",
    "uniform",
)

# Number of inclination samples used for the numerical integral over theta_L. The
# integrand is smooth, so a modest grid is accurate to well under 1e-3.
_N_THETA_L = 2048


def _theta_L_grid() -> np.ndarray:
    """Midpoint inclination grid over (0, pi/2), avoiding the cot() singularities at
    the endpoints (theta_L = 0 and pi/2)."""
    edges = np.linspace(0.0, 0.5 * math.pi, _N_THETA_L + 1)
    return 0.5 * (edges[:-1] + edges[1:])


def dewit_density(name: str, theta_L: np.ndarray) -> np.ndarray:
    """Leaf-inclination density g_L(theta_L) for a named de Wit distribution,
    evaluated on ``theta_L`` (radians in [0, pi/2]). Not assumed pre-normalized;
    callers normalize numerically over the integration grid."""
    name = name.lower()
    t = np.asarray(theta_L, dtype=float)
    two_over_pi = 2.0 / math.pi
    if name == "spherical":
        # The spherical (random) distribution: density proportional to sin(theta_L).
        return np.sin(t)
    if name == "planophile":  # mostly horizontal leaves
        return two_over_pi * (1.0 + np.cos(2.0 * t))
    if name == "erectophile":  # mostly vertical leaves
        return two_over_pi * (1.0 - np.cos(2.0 * t))
    if name == "plagiophile":  # mostly oblique (~45 deg) leaves
        return two_over_pi * (1.0 - np.cos(4.0 * t))
    if name == "extremophile":  # bimodal: horizontal + vertical
        return two_over_pi * (1.0 + np.cos(4.0 * t))
    if name == "uniform":  # flat density across all inclinations
        return np.full_like(t, two_over_pi)
    raise ValueError(
        f"Unknown de Wit distribution '{name}'. Expected one of {DEWIT_NAMES}.")


def beta_density(mu: float, nu: float, theta_L: np.ndarray) -> np.ndarray:
    """Leaf-inclination density g_L(theta_L) for a Goel-Strebel Beta(mu, nu),
    in the Helios convention zenith = (pi/2) * b, b ~ Beta(alpha=nu, beta=mu).

    Change of variables b = theta_L / (pi/2): g_L(theta_L) = (2/pi) * Beta_pdf(b; nu, mu).
    """
    mu = max(1e-6, float(mu))
    nu = max(1e-6, float(nu))
    t = np.asarray(theta_L, dtype=float)
    b = t / (0.5 * math.pi)
    b = np.clip(b, 1e-9, 1.0 - 1e-9)
    return (2.0 / math.pi) * _beta_dist.pdf(b, a=nu, b=mu)


def _A_kernel(theta_beam: np.ndarray, theta_L: np.ndarray) -> np.ndarray:
    """Warren-Wilson / Lemeur projection kernel A(theta_beam, theta_L).

    ``theta_beam`` and ``theta_L`` broadcast against each other. Beam zeniths are
    expected in (0, pi/2]; fold > pi/2 to the supplement before calling.
    """
    tb = np.asarray(theta_beam, dtype=float)
    tl = np.asarray(theta_L, dtype=float)
    cos_b, cos_l = np.cos(tb), np.cos(tl)
    # cot = cos/sin; the midpoint grids keep sin away from zero.
    cot_b = cos_b / np.sin(tb)
    cot_l = cos_l / np.sin(tl)
    x = cot_b * cot_l
    # |x| > 1: beam and leaf-normal cones don't overlap -> A = |cos*cos|.
    simple = np.abs(cos_b * cos_l)
    # |x| <= 1: partial overlap.
    x_clipped = np.clip(x, -1.0, 1.0)
    psi = np.arccos(x_clipped)
    overlap = cos_b * cos_l * (1.0 + (2.0 / math.pi) * (np.tan(psi) - psi))
    return np.where(np.abs(x) > 1.0, simple, overlap)


def _fold_beam_zenith(theta_beam: np.ndarray) -> np.ndarray:
    """Fold beam zeniths into (0, pi/2] (the kernel is defined on the hemisphere;
    a downward-looking beam at theta and an upward one at pi-theta project leaves
    identically). Clamp away from the exact 0 / pi/2 singularities."""
    tb = np.asarray(theta_beam, dtype=float)
    tb = np.where(tb > 0.5 * math.pi, math.pi - tb, tb)
    return np.clip(tb, 1e-4, 0.5 * math.pi - 1e-4)


def g_of_theta(g_L_density: np.ndarray, theta_L: np.ndarray,
               theta_beam: np.ndarray) -> np.ndarray:
    """G(theta) for each beam zenith in ``theta_beam``, given a leaf-inclination
    density sampled on ``theta_L``. The density is normalized over the grid first."""
    tl = np.asarray(theta_L, dtype=float)
    dens = np.asarray(g_L_density, dtype=float)
    dtheta = math.pi / (2.0 * len(tl))  # uniform grid spacing
    norm = float(np.sum(dens) * dtheta)
    if norm <= 0:
        raise ValueError("Leaf-inclination density integrates to zero; cannot derive G(theta).")
    dens = dens / norm
    tb = _fold_beam_zenith(theta_beam)
    # A: (n_beam, n_theta_L); integrate over theta_L.
    A = _A_kernel(tb[:, None], tl[None, :])
    return np.sum(A * dens[None, :], axis=1) * dtheta


def _gtheta_eff(g_L_density: np.ndarray, beam_zenith_samples: np.ndarray) -> float:
    """Mean G over the fired beams: G_eff = mean_b G(theta_beam_b). Falls back to the
    nadir-ish single angle when no beam zeniths are available."""
    tl = _theta_L_grid()
    samples = np.asarray(beam_zenith_samples, dtype=float)
    samples = samples[np.isfinite(samples)]
    if samples.size == 0:
        # No beam directions: evaluate at a representative oblique zenith (57.3 deg,
        # the angle where G is least sensitive to leaf inclination).
        samples = np.array([math.radians(57.3)])
    g = g_of_theta(g_L_density, tl, samples)
    val = float(np.mean(g))
    # Numerical guard: keep strictly within (0, 1] so the native inversion accepts it.
    return float(min(1.0, max(1e-4, val)))


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
def beam_zenith_samples(dirs: np.ndarray) -> np.ndarray:
    """Beam zenith angles (radians) from per-beam ray directions.

    ``dirs`` is an (N, 3) array of (not necessarily normalized) beam directions, as the
    LAD pipeline reconstructs for every scan via ``cart2sphere(xyz - origin)``. The
    zenith is ``arccos(|dz| / |d|)`` — the absolute z keeps up/down beams together,
    consistent with the hemispheric kernel.
    """
    d = np.asarray(dirs, dtype=float)
    if d.ndim != 2 or d.shape[1] != 3:
        raise ValueError("dirs must be an (N, 3) array of beam directions")
    norm = np.linalg.norm(d, axis=1)
    good = norm > 0
    cosz = np.zeros(d.shape[0])
    cosz[good] = np.abs(d[good, 2]) / norm[good]
    cosz = np.clip(cosz, -1.0, 1.0)
    return np.arccos(cosz)[good]


def gtheta_constant(value: float) -> float:
    """Validate and pass through a constant G(theta) in (0, 1]."""
    v = float(value)
    if not (0.0 < v <= 1.0):
        raise ValueError(
            f"G(theta) must be in (0, 1] (0.5 = spherical), but {v} was given.")
    return v


def gtheta_from_dewit(name: str, beam_zenith: Sequence[float] | np.ndarray) -> float:
    """Effective G(theta) for a named de Wit distribution, integrated over the supplied
    beam zenith angles (radians)."""
    tl = _theta_L_grid()
    dens = dewit_density(name, tl)
    return _gtheta_eff(dens, np.asarray(beam_zenith, dtype=float))


def gtheta_from_beta(mu: float, nu: float,
                     beam_zenith: Sequence[float] | np.ndarray) -> float:
    """Effective G(theta) for a Goel-Strebel Beta(mu, nu), integrated over the supplied
    beam zenith angles (radians)."""
    if not (math.isfinite(mu) and math.isfinite(nu)) or mu <= 0 or nu <= 0:
        raise ValueError(f"Beta parameters must be finite and > 0, got mu={mu}, nu={nu}.")
    tl = _theta_L_grid()
    dens = beta_density(mu, nu, tl)
    return _gtheta_eff(dens, np.asarray(beam_zenith, dtype=float))
