"""Fit a per-voxel-cell leaf-angle target (Beta inclination + ellipsoidal
azimuth) from a leaf-on Helios triangulation.

Ports the area-weighted per-cell histogram + Goel-Strebel Beta fit from
``src/renderer/lib/leafAngleDistribution.ts`` / ``pointCloudHelpers.ts`` to Python
so the leaf-angle adjustment has a single, testable source of truth. The fitted
``CellTarget`` parameters feed Helios's samplers in :mod:`qsm.leaf_angles`.

Two conventions matter and are kept consistent with the matcher:

- **Inclination** is the zenith of the face normal folded to the upper
  hemisphere (``acos(|nz|/|n|)``), area-weighted, in [0, 90 deg]. Convention-free.
- **Azimuth** uses the SAME Helios ``cart2sphere`` bearing as the matcher
  (``atan2(x, y)``), not the renderer's ``atan2(y, x)`` -- so the fitted azimuth
  preference and the sampled targets live in one frame.

The ellipsoidal azimuth distribution Helios samples is **axial** (180-deg
periodic): for eccentricity ``e -> 1`` the azimuth concentrates around ``phi0``
AND ``phi0 + 180``. So the azimuth fit uses **doubled-angle (axial) circular
moments**: mean axis from ``atan2(<sin 2phi>, <cos 2phi>)/2`` and the axial
resultant ``R2`` mapped to eccentricity through a table calibrated against the
actual sampler.
"""

from __future__ import annotations

import math
from typing import Dict, List, Optional, Tuple

import numpy as np

from .leaf_angles import CellTarget, cart2sphere, sample_ellipsoidal_azimuth

_TWO_PI = 2.0 * math.pi
_OUTSIDE = 0xFFFFFFFF  # uint32 sentinel for "outside grid"


# ---------------------------------------------------------------------------
# Per-triangle geometry (port of triangleGeometry / outwardRefForMesh)
# ---------------------------------------------------------------------------
def triangle_geometry(
    verts: np.ndarray,
    tri: np.ndarray,
    outward_ref: Optional[np.ndarray] = None,
) -> Tuple[float, float, float]:
    """Return ``(inclination_deg, azimuth_deg, area)`` for one triangle.

    ``verts`` is ``(M,3)``; ``tri`` is the triangle's 3 vertex indices.
    Inclination = ``acos(|nz|/|n|)`` (folded). Azimuth is the Helios
    ``cart2sphere`` bearing of the *oriented* normal: oriented toward
    ``outward_ref`` (the scanner that saw the triangle) when given, else folded to
    the upper hemisphere. A near-horizontal face has azimuth NaN.
    """
    a = verts[tri[0]]
    b = verts[tri[1]]
    c = verts[tri[2]]
    n = np.cross(b - a, c - a)
    length = float(np.linalg.norm(n))
    area = 0.5 * length
    if length < 1e-20:
        return math.nan, math.nan, area

    inclination = math.degrees(math.acos(min(1.0, abs(n[2]) / length)))

    o = n.copy()
    if outward_ref is not None:
        g = (a + b + c) / 3.0
        r = outward_ref - g
        if float(np.dot(n, r)) < 0.0:
            o = -o
    elif o[2] < 0.0:
        o = -o

    # Azimuth via Helios cart2sphere convention (atan2(x, y)).
    h = math.hypot(o[0], o[1])
    if h < 1e-12:
        azimuth = math.nan
    else:
        _, _, az = cart2sphere(o)
        azimuth = math.degrees(az)
    return inclination, azimuth, area


def _outward_ref(
    t: int,
    triangle_scan_ids: Optional[np.ndarray],
    scan_origins: Optional[np.ndarray],
) -> Optional[np.ndarray]:
    """The scanner origin that saw triangle ``t`` (for azimuth orientation), or
    None when the mesh carries no scan provenance."""
    if triangle_scan_ids is None or scan_origins is None:
        return None
    n_scans = scan_origins.shape[0]
    s = int(triangle_scan_ids[t])
    if s < 0 or s >= n_scans:
        return None
    return scan_origins[s]


# ---------------------------------------------------------------------------
# Area-weighted histograms (per cell)
# ---------------------------------------------------------------------------
def _area_weighted_hist(
    angles: np.ndarray, areas: np.ndarray, lo: float, hi: float, bin_count: int
) -> Tuple[np.ndarray, np.ndarray, float]:
    """Return ``(bin_centers, density, total_area)`` for finite angles in
    ``[lo, hi]``, area-weighted, normalized so ``sum(density*bin_width) == 1``."""
    bin_width = (hi - lo) / bin_count
    centers = lo + (np.arange(bin_count) + 0.5) * bin_width
    finite = np.isfinite(angles) & (areas > 0)
    weights = np.zeros(bin_count)
    if np.any(finite):
        a = angles[finite]
        w = areas[finite]
        b = np.floor((a - lo) / bin_width).astype(int)
        b = np.clip(b, 0, bin_count - 1)
        np.add.at(weights, b, w)
    total_area = float(weights.sum())
    density = np.zeros(bin_count)
    if total_area > 0:
        density = weights / (total_area * bin_width)
    return centers, density, total_area


# ---------------------------------------------------------------------------
# Fits
# ---------------------------------------------------------------------------
def fit_beta(centers: np.ndarray, density: np.ndarray, bin_width: float) -> Optional[Tuple[float, float]]:
    """Goel-Strebel moment-match Beta -> Helios sampler ``(mu, nu)``.

    Returns ``(beta_mu, beta_nu)`` or None (empty / zero-variance / over-dispersed).
    The sampler's mean inclination fraction is ``nu/(nu+mu) = tbar``, so we set
    ``nu = alpha = tbar*nu_tot`` and ``mu = beta = (1-tbar)*nu_tot``.
    """
    if density.sum() <= 0:
        return None
    t = centers / 90.0
    tbar = float(np.sum(density * bin_width * t))
    var = float(np.sum(density * bin_width * (t - tbar) ** 2))
    if var <= 0:
        return None
    nu_tot = tbar * (1.0 - tbar) / var - 1.0
    if nu_tot <= 0:
        return None
    alpha = tbar * nu_tot          # toward-vertical weight -> Helios nu
    beta = (1.0 - tbar) * nu_tot   # toward-horizontal weight -> Helios mu
    if not (np.isfinite(alpha) and np.isfinite(beta) and alpha > 0 and beta > 0):
        return None
    return float(beta), float(alpha)  # (mu, nu)


# Calibrated axial-resultant -> eccentricity table, built once at import by
# Monte-Carlo sampling the SAME sampler the matcher uses (guarantees the fit
# inverts the sampler consistently). R2 grows monotonically with e.
def _build_ecc_table() -> Tuple[np.ndarray, np.ndarray]:
    es = np.linspace(0.0, 0.999, 60)
    r2s = np.zeros_like(es)
    rng = np.random.default_rng(12345)
    n = 20000
    for i, e in enumerate(es):
        ph = np.array([sample_ellipsoidal_azimuth(float(e), 0.0, rng) for _ in range(n)])
        c2 = float(np.cos(2.0 * ph).mean())
        s2 = float(np.sin(2.0 * ph).mean())
        r2s[i] = math.hypot(c2, s2)
    # Enforce monotonic increasing R2(e) for a clean inverse.
    r2s = np.maximum.accumulate(r2s)
    return r2s, es


_R2_TABLE, _ECC_TABLE = _build_ecc_table()


def _ecc_from_resultant(r2: float) -> float:
    """Invert the axial resultant ``R2`` to an eccentricity in [0, 0.999]."""
    if r2 <= 1e-3:
        return 0.0
    r2 = min(float(r2), float(_R2_TABLE[-1]))
    return float(np.clip(np.interp(r2, _R2_TABLE, _ECC_TABLE), 0.0, 0.999))


def fit_ellipsoidal(centers_deg: np.ndarray, density: np.ndarray, bin_width: float) -> Tuple[float, float]:
    """Fit ``(ecc, phi0_deg)`` to an area-weighted azimuth density over [0,360).

    The ellipsoidal azimuth model is axial, so we use doubled-angle circular
    moments: mean axis ``phi0 = atan2(<sin 2phi>, <cos 2phi>)/2`` and axial
    resultant ``R2`` -> eccentricity via the calibrated table.
    """
    if density.sum() <= 0:
        return 0.0, 0.0
    phi = np.radians(centers_deg)
    w = density * bin_width
    c2 = float(np.sum(w * np.cos(2.0 * phi)))
    s2 = float(np.sum(w * np.sin(2.0 * phi)))
    r2 = math.hypot(c2, s2)
    phi0 = 0.5 * math.atan2(s2, c2)
    phi0_deg = math.degrees(phi0) % 180.0
    return _ecc_from_resultant(r2), phi0_deg


# ---------------------------------------------------------------------------
# Per-cell target assembly
# ---------------------------------------------------------------------------
def compute_cell_targets(
    vertices: np.ndarray,
    triangles: np.ndarray,
    triangle_cell_ids: np.ndarray,
    grid: Tuple[np.ndarray, np.ndarray, int, int, int],
    *,
    triangle_scan_ids: Optional[np.ndarray] = None,
    scan_origins: Optional[np.ndarray] = None,
    incl_bins: int = 18,
    azim_bins: int = 36,
) -> Dict[int, CellTarget]:
    """Fit a :class:`~qsm.leaf_angles.CellTarget` for each grid cell that has
    triangulated leaf surface. Cells whose Beta fit is degenerate are skipped.

    ``vertices`` (M,3), ``triangles`` (T,3), ``triangle_cell_ids`` (T,).
    ``grid`` is unused for binning here (triangles already carry cell ids) but is
    accepted for symmetry / future use.
    """
    verts = np.asarray(vertices, dtype=np.float64)
    tris = np.asarray(triangles, dtype=np.int64)
    cell_ids = np.asarray(triangle_cell_ids, dtype=np.int64)
    n_tri = tris.shape[0]

    # Per-triangle inclination / azimuth / area (single pass).
    incl = np.full(n_tri, np.nan)
    azim = np.full(n_tri, np.nan)
    areas = np.zeros(n_tri)
    for t in range(n_tri):
        ref = _outward_ref(t, triangle_scan_ids, scan_origins)
        incl[t], azim[t], areas[t] = triangle_geometry(verts, tris[t], ref)

    targets: Dict[int, CellTarget] = {}
    # Distinct in-grid cell ids.
    unique = np.unique(cell_ids[(cell_ids >= 0) & (cell_ids != _OUTSIDE)])
    for cid in unique:
        mask = cell_ids == cid
        if not np.any(mask):
            continue
        ic, idens, _ = _area_weighted_hist(incl[mask], areas[mask], 0.0, 90.0, incl_bins)
        beta = fit_beta(ic, idens, 90.0 / incl_bins)
        if beta is None:
            continue
        ac, adens, _ = _area_weighted_hist(azim[mask], areas[mask], 0.0, 360.0, azim_bins)
        ecc, phi0 = fit_ellipsoidal(ac, adens, 360.0 / azim_bins)
        targets[int(cid)] = CellTarget(
            beta_mu=beta[0], beta_nu=beta[1], ecc=ecc, phi0_deg=phi0,
            n_measured=int(mask.sum()),
        )
    return targets
