"""Adjust reconstructed leaf angles to match a measured per-cell leaf-angle
distribution, via optimal assignment (the "Hungarian" step).

This is a pure-Python/numpy port of Helios's
``PlantArchitecture::setPlantLeafAngleDistribution_private`` (full 2-D case). For
each voxel grid cell that has a fitted target distribution, we:

1. read each reconstructed leaf's current normal (basis column 2),
2. sample one target (inclination, azimuth) per leaf from the cell's fitted
   Beta(inclination) + ellipsoidal(azimuth) distribution,
3. build current/target **unit normal** vectors V0 / V1,
4. solve the optimal assignment minimizing total Euclidean displacement
   ``||V0[i] - V1[j]||`` (``scipy.optimize.linear_sum_assignment`` in place of
   Helios's Hungarian solver — the cost matrix is square so the result is a
   permutation), and
5. **rigidly rotate each leaf about its base** so its normal moves to the
   assigned target (Rodrigues rotation applied to the whole orthonormal basis,
   not just the normal — this rotates the planar blade as a rigid body with its
   base fixed).

Leaves in cells with no fitted target (or outside the grid) are left unchanged.

Angle conventions follow Helios exactly (see ``core/src/global.cpp``):
``cart2sphere`` returns ``elevation = asin(z/r)`` and ``azimuth = atan2(x, y)``
(note x/y swapped vs the standard ``atan2(y, x)``); the inclination ("zenith") is
``pi/2 - elevation``. The leaf-angle *fit* in :mod:`qsm.leaf_distribution` uses
the SAME azimuth convention so the fit and the match live in one frame.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import numpy as np
from scipy.optimize import linear_sum_assignment

from .grid import bin_points_to_cells
from .leaves import LeafPlacement

_TWO_PI = 2.0 * math.pi


@dataclass
class CellTarget:
    """A fitted per-cell leaf-angle target (Helios sampler parameters)."""

    beta_mu: float    # Beta "toward-horizontal" weight (Gamma shape for Y)
    beta_nu: float    # Beta "toward-vertical" weight (Gamma shape for X)
    ecc: float        # ellipsoidal azimuth eccentricity in [0, 1)
    phi0_deg: float   # ellipsoidal azimuth rotation offset (degrees)
    n_measured: int = 0  # how many triangles fed the fit (provenance only)


# ---------------------------------------------------------------------------
# Angle conversions (Helios convention)
# ---------------------------------------------------------------------------
def cart2sphere(v: np.ndarray) -> Tuple[float, float, float]:
    """Return ``(radius, elevation, azimuth)`` with Helios's convention.

    ``elevation = asin(z / r)``; ``azimuth = atan2(x, y)`` wrapped to ``[0, 2pi)``
    (x and y are swapped relative to the standard ``atan2(y, x)``). The
    ``|x|,|y| < 1e-7`` gimbal guard nudges y so the azimuth is well-defined.
    """
    x, y, z = float(v[0]), float(v[1]), float(v[2])
    radius = math.sqrt(x * x + y * y + z * z)
    if radius < 1e-12:
        return 0.0, 0.0, 0.0
    if abs(x) < 1e-7 and abs(y) < 1e-7:
        y = 1e-7
    elevation = math.asin(max(-1.0, min(1.0, z / radius)))
    azimuth = math.atan2(x, y)  # NOTE: (x, y), Helios convention
    if azimuth < 0.0:
        azimuth += _TWO_PI
    return radius, elevation, azimuth


def sphere2cart(radius: float, elevation: float, azimuth: float) -> np.ndarray:
    """Inverse of :func:`cart2sphere` (Helios convention)."""
    ce = math.cos(elevation)
    return np.array(
        [
            radius * ce * math.sin(azimuth),
            radius * ce * math.cos(azimuth),
            radius * math.sin(elevation),
        ]
    )


def leaf_inclination_azimuth(normal: np.ndarray) -> Tuple[float, float]:
    """Return ``(zenith, azimuth)`` of a leaf normal, folded to the upper
    hemisphere (``z = |z|``) so up/down faces read the same inclination -- the
    same convention the measured distribution uses (``|n.z|``)."""
    n = np.asarray(normal, dtype=np.float64)
    norm = float(np.linalg.norm(n))
    if not np.isfinite(norm) or norm < 1e-6:
        n = np.array([0.0, 0.0, 1.0])
    else:
        n = n / norm
    n = n.copy()
    n[2] = abs(n[2])
    _, elevation, azimuth = cart2sphere(n)
    zenith = math.pi * 0.5 - elevation
    return zenith, azimuth


# ---------------------------------------------------------------------------
# Distribution samplers (Helios convention)
# ---------------------------------------------------------------------------
def sample_beta_inclination(mu: float, nu: float, rng: np.random.Generator) -> float:
    """Sample a leaf inclination (zenith, radians in [0, pi/2]) from the Beta
    distribution used by Helios: ``X ~ Gamma(nu)``, ``Y ~ Gamma(mu)``,
    ``b = X/(X+Y)``, return ``0.5*pi*b``. Mean inclination fraction = nu/(nu+mu).
    """
    mu = max(1e-6, float(mu))
    nu = max(1e-6, float(nu))
    x = rng.gamma(nu, 1.0)
    y = rng.gamma(mu, 1.0)
    s = x + y
    b = 0.5 if s <= 0 else x / s
    return 0.5 * math.pi * b


def sample_ellipsoidal_azimuth(ecc: float, phi0_deg: float, rng: np.random.Generator) -> float:
    """Sample an azimuth (radians in [0, 2pi)) from the ellipsoidal distribution
    Helios uses: ``a=1, b=sqrt(1-e^2)``, ``t ~ U[0,2pi)``,
    ``phi = atan2(b*sin t, a*cos t) + phi0`` wrapped."""
    e = min(0.999999, max(0.0, float(ecc)))
    phi0 = math.radians(float(phi0_deg))
    a = 1.0
    b = math.sqrt(max(0.0, 1.0 - e * e))
    t = rng.uniform(0.0, _TWO_PI)
    phi = math.atan2(b * math.sin(t), a * math.cos(t)) + phi0
    phi = phi % _TWO_PI
    if phi < 0.0:
        phi += _TWO_PI
    return phi


# ---------------------------------------------------------------------------
# Rotation helpers
# ---------------------------------------------------------------------------
def _orthonormal_axis(v: np.ndarray) -> np.ndarray:
    """A unit vector perpendicular to ``v`` (cross with +x, fallback +y)."""
    ax = np.cross(v, np.array([1.0, 0.0, 0.0]))
    if float(np.linalg.norm(ax)) < 1e-6:
        ax = np.cross(v, np.array([0.0, 1.0, 0.0]))
    n = float(np.linalg.norm(ax))
    return ax / n if n > 1e-12 else np.array([1.0, 0.0, 0.0])


def _rodrigues_matrix(axis_unit: np.ndarray, angle: float) -> np.ndarray:
    """Rotation matrix about ``axis_unit`` (unit) by ``angle`` radians."""
    k = np.asarray(axis_unit, dtype=np.float64)
    c = math.cos(angle)
    s = math.sin(angle)
    kx, ky, kz = k[0], k[1], k[2]
    K = np.array([[0.0, -kz, ky], [kz, 0.0, -kx], [-ky, kx, 0.0]])
    return np.eye(3) * c + s * K + (1.0 - c) * np.outer(k, k)


def rotation_v_to_u(v: np.ndarray, u: np.ndarray) -> np.ndarray:
    """Proper rotation matrix taking unit vector ``v`` to unit vector ``u``.

    Handles v≈u (identity), v≈-u (180 deg about an in-plane axis), and the
    generic case (axis = cross(v, u)).
    """
    v = np.asarray(v, dtype=np.float64)
    u = np.asarray(u, dtype=np.float64)
    vn = float(np.linalg.norm(v))
    un = float(np.linalg.norm(u))
    v = v / vn if vn > 1e-12 else np.array([0.0, 0.0, 1.0])
    u = u / un if un > 1e-12 else np.array([0.0, 0.0, 1.0])
    dot = max(-1.0, min(1.0, float(np.dot(v, u))))
    ang = math.acos(dot)
    axis = np.cross(v, u)
    if float(np.linalg.norm(axis)) < 1e-6:
        if dot > 0.0:
            return np.eye(3)  # v ≈ u
        axis = _orthonormal_axis(v)  # v ≈ -u -> 180 deg about an in-plane axis
    else:
        axis = axis / float(np.linalg.norm(axis))
    return _rodrigues_matrix(axis, ang)


def _reorthonormalize(basis: np.ndarray) -> np.ndarray:
    """Re-orthonormalize a (3,3) basis (columns) via QR with a sign fix, killing
    accumulated floating drift while preserving a right-handed frame."""
    q, r = np.linalg.qr(basis)
    # QR sign convention: flip columns so the diagonal of r is positive.
    signs = np.sign(np.diag(r))
    signs[signs == 0] = 1.0
    q = q * signs
    if np.linalg.det(q) < 0:  # keep right-handed
        q[:, 2] = -q[:, 2]
    return q


# ---------------------------------------------------------------------------
# Per-cell assignment
# ---------------------------------------------------------------------------
def adjust_placements_to_distribution(
    placements: List[LeafPlacement],
    cell_targets: Dict[int, CellTarget],
    grid: Tuple[np.ndarray, np.ndarray, int, int, int],
    *,
    seed: int = 0,
    max_cell_leaves: Optional[int] = None,
) -> List[LeafPlacement]:
    """Rotate leaves so each voxel cell's leaf-angle distribution matches its
    fitted target. Returns a NEW list (same order); leaves in cells without a
    target are returned unchanged.

    ``grid`` is ``(center(3,), size(3,), nx, ny, nz)``.
    """
    if not placements:
        return []
    center, size, nx, ny, nz = grid

    # Bin every leaf BASE to a cell id (same row-major scheme as the triangulation).
    bases = np.array([p.position for p in placements], dtype=np.float64)
    cell_ids = bin_points_to_cells(bases, center, size, nx, ny, nz)

    # Start from copies so untouched leaves are returned verbatim.
    out: List[LeafPlacement] = [
        LeafPlacement(
            position=np.asarray(p.position, dtype=np.float64).copy(),
            basis=np.asarray(p.basis, dtype=np.float64).copy(),
            length=p.length,
            width=p.width,
        )
        for p in placements
    ]

    # Group leaf indices by cell.
    by_cell: Dict[int, List[int]] = {}
    for idx, cid in enumerate(cell_ids):
        cid = int(cid)
        if cid < 0:
            continue
        by_cell.setdefault(cid, []).append(idx)

    for cid, idxs in by_cell.items():
        target = cell_targets.get(cid)
        if target is None:
            continue
        if not (np.isfinite(target.beta_mu) and np.isfinite(target.beta_nu)
                and target.beta_mu > 0 and target.beta_nu > 0):
            continue  # degenerate fit -> leave the cell unchanged

        leaf_idxs = idxs
        if max_cell_leaves is not None and len(leaf_idxs) > max_cell_leaves:
            # Bound the O(N^3) assignment: adjust a deterministic subset, leave
            # the rest unchanged.
            sub_rng = np.random.default_rng(seed + cid)
            leaf_idxs = sorted(sub_rng.choice(leaf_idxs, size=max_cell_leaves, replace=False).tolist())

        n = len(leaf_idxs)
        rng = np.random.default_rng(seed + cid)

        # Current unit normals V0 (basis column 2, folded to upper hemisphere).
        V0 = np.zeros((n, 3))
        for r, li in enumerate(leaf_idxs):
            zen, az = leaf_inclination_azimuth(out[li].basis[:, 2])
            V0[r] = sphere2cart(1.0, math.pi * 0.5 - zen, az)

        # Sampled target unit normals V1.
        V1 = np.zeros((n, 3))
        for r in range(n):
            zen_t = sample_beta_inclination(target.beta_mu, target.beta_nu, rng)
            az_t = sample_ellipsoidal_azimuth(target.ecc, target.phi0_deg, rng)
            V1[r] = sphere2cart(1.0, math.pi * 0.5 - zen_t, az_t)

        # Cost = Euclidean distance between current and target unit normals.
        diff = V0[:, None, :] - V1[None, :, :]
        cost = np.linalg.norm(diff, axis=2)
        cost[~np.isfinite(cost)] = np.finfo(np.float64).max * 0.5
        row, col = linear_sum_assignment(cost)

        # Rotate each assigned leaf's whole basis about its base.
        for r, c in zip(row, col):
            li = leaf_idxs[int(r)]
            v = V0[int(r)]
            u = V1[int(c)]
            R = rotation_v_to_u(v, u)
            if not np.all(np.isfinite(R)):
                continue
            new_basis = R @ out[li].basis
            out[li].basis = _reorthonormalize(new_basis)

    return out
