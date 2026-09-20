"""Wood area density (WAD): the projection coefficient for woody elements, and
the split of a voxel's inverted area density into leaf and wood parts.

Background
----------
The Beer's-law inversion in ``_do_lad_computation`` recovers a *projected* area
density ``a`` per voxel -- the area that intercepts a beam, per unit volume. It
makes no assumption about what the intercepting elements are; "leaf" in the
Helios API is naming only. Converting ``a`` into a physical area therefore
depends entirely on the projection coefficient G(theta) supplied for the medium:

    physical area density = a / G

For FLAT leaves the convention is one-sided area, and a spherical (random) leaf
normal distribution gives G == 0.5 at every beam zenith. Wood is not flat, so it
needs its own coefficient and its own convention -- which is what this module
provides.

The wood convention: TOTAL SURFACE AREA
---------------------------------------
A leaf's "two-sided" area is twice its one-sided area. A branch has no such
doubling: its two-sided area IS its surface area (the outside of the cylinder).
So WAD here is the true woody surface area per m^3, which is what the wood area
index (WAI) in the literature means, and which makes LAI + WAI = PAI hold.

For a cylinder of radius r and length L >> r (end caps neglected):

    total surface area   S      = 2*pi*r*L
    projected silhouette A_proj = 2*r*L*sin(alpha)

where ``alpha`` is the angle between the beam and the cylinder AXIS. Hence

    G_cyl(alpha) = A_proj / S = sin(alpha) / pi                           (1)

Averaged over a uniform relative azimuth (the standard assumption, matching the
leaf kernel in ``lad_gtheta``), G becomes a function of the beam zenith
``theta_B`` and the axis inclination ``theta_A``. That azimuthal average has no
elementary closed form -- it is an elliptic integral -- so it is integrated
numerically here, exactly as ``lad_gtheta`` integrates over theta_L.

Three limits pin the implementation, and all three are asserted by the tests:

  * axis vertical (theta_A = 0):  G = sin(theta_B) / pi, exactly.
  * spherical (random) axes:      G == 0.25 at EVERY beam zenith.
  * Cauchy / Lambert convex-body: mean projected area = S/4, i.e. the same 1/4.

Note 1/4, not 1/pi: 1/pi is the value at a single perpendicular beam, and it is
the natural wrong answer to reach for.

Why the default G is good enough surprisingly often
---------------------------------------------------
Measured by direct integration at a realistic terrestrial beam-zenith spread
(mean 66 deg), G_wood across EVERY axis distribution spans only:

    spherical axes            0.2500      ALL vertical (trunk)      0.2818
    erectophile (upright)     0.2461      ALL horizontal (branch)   0.2359
    plagiophile (~45 deg)     0.2574      planophile (horizontal)   0.2696

i.e. 0.236 - 0.282, a span of +-13% about 0.25 -- against +-29% for the LEAF G
across the de Wit families. The reason is structural: a cylinder is azimuthally
symmetric about its axis, so orientation largely averages out, whereas a flat
leaf has a distinguished normal and no such symmetry.

Two consequences, both of which shaped this module:

  * The fixed default sits in the MIDDLE of the achievable range, so a voxel
    that falls back to it is wrong by at most ~13% and is close to optimal under
    ignorance. This is a much weaker failure than the leaf analogue.
  * Precision in the wood angle distribution is NOT where the error budget is.
    The wood/leaf classification and the partition-by-count assumption are both
    larger terms. Do not spend heavy machinery here before checking it against
    this bound.

Why the axis distribution is POOLED, not per-voxel
--------------------------------------------------
Estimating a branch axis per voxel by local PCA has a silent catastrophic
failure. For a short, fat segment (length/radius <~ 2) the dominant spread is
AROUND the circumference, so PCA returns a direction roughly PERPENDICULAR to
the true axis -- measured 85-89 deg wrong. Worse, that wrong direction is itself
well defined, so the usual confidence proxies endorse it: linearity reads 0.70
at L/r = 1.3 (failing) versus 0.34 at L/r = 3.0 (working). A linearity gate
therefore accepts the worst case most confidently, and no aspect-ratio threshold
separates the two regimes cleanly either.

And the flip is worse than not estimating at all: a 90-degree axis error costs up
to 18.8% in G, against the default's bounded 11%.

Pooling one distribution over the whole cloud removes the failure, because flips
partially cancel in aggregate. Measured, contaminating a realistic canopy's axis
distribution with flipped segments:

    0% flipped  +0.0%     30% flipped  +1.1%
   10% flipped  +0.4%     50% flipped  +1.8%

So a pooled estimate stays within ~2% even when half the inputs are wrong, which
is why ``gtheta_wood_from_axes`` takes every trusted axis in the cloud and
returns ONE coefficient.

Testing trap (inherited exactly from the leaf kernel)
-----------------------------------------------------
A spherical AXIS distribution gives G == 0.25 at every beam zenith. Like
``spherical`` for leaves, it is therefore mathematically incapable of revealing a
beam-geometry bug. Any test of beam handling here must use a non-spherical axis
distribution (erectophile / planophile).
"""

from __future__ import annotations

import math

import numpy as np

# Mean projection coefficient of randomly-oriented cylinders, per unit TOTAL
# surface area (Cauchy: a convex body's mean projected area is S/4). Used when
# no trustworthy branch axis could be measured. Worst-case error across all
# achievable axis distributions is ~13% (see the module docstring), and this
# value sits in the middle of that range.
WOOD_G_DEFAULT = 0.25

# Azimuth samples for the numerical average in `cylinder_G`. The integrand is a
# smooth periodic function of phi, so the midpoint rule converges fast; 512
# matches Monte Carlo to ~1e-5, which is far below the +-13% physical spread.
_N_PHI = 512

# Inclination samples when integrating a prescribed axis density. Mirrors
# `lad_gtheta._N_THETA_L`'s reasoning: the integrand is smooth.
_N_THETA_A = 512

# Beam x inclination elements evaluated at once, so a scan with millions of
# beams does not materialise one huge kernel. Mirrors
# `lad_gtheta._KERNEL_BLOCK_ELEMENTS`, scaled down because this kernel carries
# an extra azimuth axis: one block is _KERNEL_BLOCK_ELEMENTS * _N_PHI floats.
_KERNEL_BLOCK_ELEMENTS = 1 << 14


def cylinder_G(theta_beam, theta_axis) -> np.ndarray:
    """Cylinder projection coefficient per unit TOTAL surface area.

    ``theta_beam`` (N,) beam zenith angles and ``theta_axis`` (M,) cylinder-axis
    inclinations from the zenith, both in radians. Returns an (N, M) array of
    G values, averaged over a uniform relative azimuth.

    From Eq. (1) in the module docstring, ``G = mean_phi sin(alpha) / pi`` with

        cos(alpha) = sin(tB) sin(tA) cos(phi) + cos(tB) cos(tA)

    Both angles are folded into [0, pi/2]: the kernel is hemispheric, since a
    cylinder has no head/tail and a beam projects it identically from either
    side.
    """
    tb = np.atleast_1d(np.asarray(theta_beam, dtype=float))
    ta = np.atleast_1d(np.asarray(theta_axis, dtype=float))
    if tb.ndim != 1 or ta.ndim != 1:
        raise ValueError("theta_beam and theta_axis must be 1-D arrays of angles")
    tb = _fold_to_hemisphere(tb)
    ta = _fold_to_hemisphere(ta)

    phi = np.linspace(0.0, 2.0 * math.pi, _N_PHI, endpoint=False)
    sin_tb, cos_tb = np.sin(tb), np.cos(tb)
    sin_ta, cos_ta = np.sin(ta), np.cos(ta)
    cos_phi = np.cos(phi)

    out = np.empty((tb.shape[0], ta.shape[0]), dtype=float)
    # Block over beams: the temporary is (rows, M, _N_PHI), so a whole-scan
    # kernel would be gigabytes on a multi-million-beam cloud.
    rows = max(1, _KERNEL_BLOCK_ELEMENTS // max(ta.shape[0], 1))
    for start in range(0, tb.shape[0], rows):
        stop = min(start + rows, tb.shape[0])
        cos_alpha = (
            sin_tb[start:stop, None, None] * sin_ta[None, :, None] * cos_phi[None, None, :]
            + cos_tb[start:stop, None, None] * cos_ta[None, :, None]
        )
        sin_alpha = np.sqrt(np.clip(1.0 - cos_alpha * cos_alpha, 0.0, 1.0))
        out[start:stop] = sin_alpha.mean(axis=2) / math.pi
    return out


def _fold_to_hemisphere(theta: np.ndarray) -> np.ndarray:
    """Fold angles into [0, pi/2]. Both the beam and the cylinder axis are
    direction-less for projection purposes, so theta and pi-theta are the same."""
    t = np.abs(np.asarray(theta, dtype=float)) % math.pi
    return np.where(t > 0.5 * math.pi, math.pi - t, t)


def axis_inclination(axes: np.ndarray) -> np.ndarray:
    """Inclination from the zenith (radians, in [0, pi/2]) of each CARTESIAN
    axis direction in the (N, 3) array ``axes``.

    An axis is a line, not an arrow, so the sign of z is irrelevant:
    ``arccos(|z| / |a|)``. Zero-length rows are dropped.
    """
    a = np.asarray(axes, dtype=float)
    if a.ndim != 2 or a.shape[1] != 3:
        raise ValueError("axes must be an (N, 3) array of direction vectors")
    norm = np.linalg.norm(a, axis=1)
    good = norm > 0
    cosz = np.abs(a[good, 2]) / norm[good]
    return np.arccos(np.clip(cosz, 0.0, 1.0))


def gtheta_wood_from_axes(axis_inclinations, beam_zenith) -> float:
    """Pooled G_wood: the mean cylinder projection coefficient over the measured
    branch axes and the fired beams.

    ``axis_inclinations`` (radians, from the zenith) are the TRUSTED branch axes
    of the whole cloud -- see the module docstring for why this is pooled rather
    than estimated per voxel. ``beam_zenith`` (radians) are the beam zeniths of
    the contributing scans.

    Returns `WOOD_G_DEFAULT` when either sample is empty, so a caller that could
    measure nothing degrades to the random-cylinder value rather than raising.
    The result is clamped to (0, 1] so the native inversion accepts it.
    """
    ta = np.asarray(axis_inclinations, dtype=float)
    ta = ta[np.isfinite(ta)]
    tb = np.asarray(beam_zenith, dtype=float)
    tb = tb[np.isfinite(tb)]
    if ta.size == 0 or tb.size == 0:
        return WOOD_G_DEFAULT
    # Subsample beams: G varies smoothly and slowly with zenith, so the mean over
    # a large random subset is indistinguishable from the mean over all of them,
    # while the kernel cost is linear in the beam count.
    if tb.size > 20_000:
        tb = np.random.default_rng(0).choice(tb, 20_000, replace=False)
    g = cylinder_G(tb, ta)          # (n_beam, n_axis)
    val = float(g.mean())
    return float(min(1.0, max(1e-4, val)))


def gtheta_wood_from_density(axis_density, theta_axis, beam_zenith) -> float:
    """Pooled G_wood from a PRESCRIBED axis-inclination density rather than
    measured axes, for a caller that wants to supply a distribution (and for the
    analytic tests). ``axis_density`` is sampled on ``theta_axis``; it is
    normalized over that grid first."""
    ta = np.asarray(theta_axis, dtype=float)
    dens = np.asarray(axis_density, dtype=float)
    tb = np.asarray(beam_zenith, dtype=float)
    tb = tb[np.isfinite(tb)]
    if ta.size == 0 or dens.size != ta.size:
        raise ValueError("axis_density must be sampled on theta_axis")
    if tb.size == 0:
        # No beam geometry: evaluate at the angle where G is least sensitive to
        # inclination, mirroring `lad_gtheta._gtheta_eff`.
        tb = np.array([math.radians(57.3)])
    area = float(np.trapezoid(dens, ta))
    if not (area > 0):
        raise ValueError("Axis-inclination density integrates to zero; cannot derive G.")
    if tb.size > 20_000:
        tb = np.random.default_rng(0).choice(tb, 20_000, replace=False)
    g = cylinder_G(tb, ta)                              # (n_beam, n_theta_A)
    per_beam = np.trapezoid(g * (dens / area)[None, :], ta, axis=1)
    return float(min(1.0, max(1e-4, float(per_beam.mean()))))


def theta_axis_grid() -> np.ndarray:
    """Midpoint inclination grid over (0, pi/2) for prescribed-density work.
    Midpoints, not edges, so a density with an endpoint singularity stays finite
    (same reasoning as `lad_gtheta._theta_L_grid`)."""
    edges = np.linspace(0.0, 0.5 * math.pi, _N_THETA_A + 1)
    return 0.5 * (edges[:-1] + edges[1:])
