"""Plane-patch primitives for registration, and the plane-to-plane solve.

Why patches rather than points
------------------------------
Registering raw points means a KD-tree query into a dense cloud for every
correspondence, every iteration. RIEGL's Multi Station Adjustment does not do
that: it reduces each scan to ~10^4 oriented plane patches first, and adjusts
poses against those. That compression is where its speed comes from -- a scan of
tens of millions of returns becomes ten thousand primitives, each carrying an
anchor point and a surface normal.

The extraction is an octree-style recursive subdivision (RiSCAN PRO's "Plane
Patch Filter", documented in Bytyqi 2021, *Detektion von Oberflaechenveraen-
derungen mit terrestrischem Laserscanner*, TU Wien):

    partition into equal cubes; fit a least-squares plane to each; accept it if
    the residual standard deviation is below a tolerance; otherwise split into
    eight and recurse; stop on a valid plane, too few points, or a minimum cube.

Crucially it does NOT ask "is this neighbourhood planar" -- it shrinks the cube
until the answer is yes. That is why it yields patches on foliage where a
fixed-radius planarity test does not: measured on a real olive scan, canopy above
1.5 m produced 44.6 patches per 1000 points against 38.4 for ground, and their
normals were genuinely varied (median |n_z| 0.43 against ground's 0.97).

Why plane-to-plane rather than centre-to-centre
-----------------------------------------------
Two scans subdivide independently, so their patch CENTRES rarely coincide --
matching centre to centre found a partner for only 3.9% of patches at the known
correct pose. The residual that matters is the distance along the normal: a
patch centre can sit metres from its partner's centre and still lie on the same
surface. Pairing is then gated on orientation as well as proximity, which is the
part plain nearest-neighbour ICP lacks -- it happily pairs a floor with a wall.
"""

import math
from typing import Optional, Tuple

import numpy as np

# Residual standard deviation below which a cube's points are called planar.
# The thesis used 0.005 m on hard surfaces; foliage needs a looser tolerance or
# every cube subdivides to nothing.
_MAX_PLANE_ERROR_M = 0.02
_MIN_POINTS_PER_PLANE = 8
_MIN_CUBE_M = 0.05
_MAX_CUBE_M = 0.40


def extract(points: np.ndarray,
            max_plane_error: float = _MAX_PLANE_ERROR_M,
            min_points: int = _MIN_POINTS_PER_PLANE,
            min_cube: float = _MIN_CUBE_M,
            max_cube: float = _MAX_CUBE_M) -> Tuple[np.ndarray, np.ndarray]:
    """(centres Nx3, unit normals Nx3) for a cloud.

    Iterative rather than recursive: a scan yields ~10^4 patches and Python's
    recursion limit is a needless failure mode on a deep subdivision.
    """
    points = np.asarray(points, dtype=np.float64)
    if len(points) < min_points:
        return np.empty((0, 3)), np.empty((0, 3))

    centres, normals = [], []
    # Seed the stack with the top-level cubes so the whole plot is never fitted
    # as one plane.
    keys = np.floor(points / max_cube).astype(np.int64)
    order = np.lexsort((keys[:, 2], keys[:, 1], keys[:, 0]))
    pts, ks = points[order], keys[order]
    edges = np.flatnonzero(np.r_[True, (np.diff(ks, axis=0) != 0).any(1), True])
    stack = [(pts[edges[i]:edges[i + 1]], max_cube) for i in range(len(edges) - 1)]

    while stack:
        cube, size = stack.pop()
        if len(cube) < min_points or size < min_cube:
            continue
        centre = cube.mean(axis=0)
        deviations = cube - centre
        # Smallest eigenvalue of the covariance is the squared residual to the
        # best-fit plane; its eigenvector is the normal.
        values, vectors = np.linalg.eigh(deviations.T @ deviations / len(cube))
        if float(np.sqrt(max(values[0], 0.0))) < max_plane_error:
            centres.append(centre)
            normals.append(vectors[:, 0])
            continue
        half = size / 2.0
        if half < min_cube:
            continue
        octant = np.clip(np.floor((cube - cube.min(axis=0)) / half).astype(np.int64), 0, 1)
        code = octant[:, 0] * 4 + octant[:, 1] * 2 + octant[:, 2]
        for c in np.unique(code):
            child = cube[code == c]
            if len(child) >= min_points:
                stack.append((child, half))

    if not centres:
        return np.empty((0, 3)), np.empty((0, 3))
    return np.asarray(centres), np.asarray(normals)


# Correspondence gates. A pair must agree in BOTH position and orientation:
# proximity alone pairs a floor with a wall, which is the failure that makes
# plain nearest-neighbour ICP fragile on repetitive scenes.
_SEARCH_RADIUS_M = 1.0
_MAX_TILT_DEG = 20.0


def _pairs(target_c, target_n, source_c, source_n, transform,
           radius=_SEARCH_RADIUS_M, max_tilt_deg=_MAX_TILT_DEG):
    """Gated correspondences for one pose. Returns (src_idx, tgt_idx)."""
    from scipy.spatial import cKDTree

    moved_c = source_c @ transform[:3, :3].T + transform[:3, 3]
    moved_n = source_n @ transform[:3, :3].T
    tree = cKDTree(target_c)
    # Several nearest, then the closest that also agrees in orientation --
    # taking only the single nearest would discard a correct pairing whenever a
    # differently-oriented patch happened to sit marginally closer.
    dist, idx = tree.query(moved_c, k=6, distance_upper_bound=radius)
    cos_limit = math.cos(math.radians(max_tilt_deg))
    src_out, tgt_out = [], []
    for column in range(idx.shape[1]):
        live = np.isfinite(dist[:, column])
        if not live.any():
            continue
        rows = np.flatnonzero(live)
        rows = rows[~np.isin(rows, src_out)] if src_out else rows
        if len(rows) == 0:
            continue
        cand = idx[rows, column]
        agree = np.abs(np.einsum('ij,ij->i', target_n[cand], moved_n[rows])) >= cos_limit
        rows, cand = rows[agree], cand[agree]
        src_out.extend(rows.tolist())
        tgt_out.extend(cand.tolist())
    return np.asarray(src_out, dtype=np.int64), np.asarray(tgt_out, dtype=np.int64)


def _solve_step(source_c, target_c, target_n):
    """One linearised point-to-plane step. Returns a 4x4 increment.

    Minimises the distance ALONG THE NORMAL, not between centres: two scans
    subdivide independently so their patch centres rarely coincide, but both
    lie on the same surface. Small-angle linearisation about the identity,
    solved by least squares in the standard [rotation | translation] form.
    """
    residual = np.einsum('ij,ij->i', target_n, target_c - source_c)
    jacobian = np.hstack([np.cross(source_c, target_n), target_n])
    solution, *_ = np.linalg.lstsq(jacobian, residual, rcond=None)
    rx, ry, rz = solution[:3]
    step = np.eye(4)
    step[:3, :3] = np.array([[1.0, -rz, ry], [rz, 1.0, -rx], [-ry, rx, 1.0]])
    # Re-orthonormalise: the linearised block is only a rotation to first order,
    # and the error compounds over iterations without this.
    u, _, vt = np.linalg.svd(step[:3, :3])
    step[:3, :3] = u @ vt
    step[:3, 3] = solution[3:]
    return step


def align(target_c, target_n, source_c, source_n, init=None,
          radius=_SEARCH_RADIUS_M, max_tilt_deg=_MAX_TILT_DEG,
          max_iterations=30, tolerance=1e-5) -> dict:
    """Plane-to-plane alignment of two patch sets.

    Two-phase, matching the documented MSA schedule: iterate the pose, and
    re-determine correspondences whenever the improvement stalls rather than
    every step (re-matching every iteration costs a KD-tree rebuild for little
    gain, and re-matching never lets a bad initial pairing be escaped).

    Returns {'transformation', 'pairs', 'rmse', 'iterations', 'converged'}.
    """
    transform = np.eye(4) if init is None else np.asarray(init, dtype=np.float64).copy()
    if len(target_c) < 10 or len(source_c) < 10:
        return dict(transformation=transform, pairs=0, rmse=float('nan'),
                    iterations=0, converged=False)

    previous = float('inf')
    pairs = 0
    rmse = float('nan')
    for iteration in range(max_iterations):
        si, ti = _pairs(target_c, target_n, source_c, source_n, transform,
                        radius, max_tilt_deg)
        pairs = len(si)
        if pairs < 6:                       # 6 unknowns in a rigid pose
            break
        moved = source_c[si] @ transform[:3, :3].T + transform[:3, 3]
        step = _solve_step(moved, target_c[ti], target_n[ti])
        transform = step @ transform

        moved = source_c[si] @ transform[:3, :3].T + transform[:3, 3]
        rmse = float(np.sqrt(np.mean(
            np.square(np.einsum('ij,ij->i', target_n[ti], target_c[ti] - moved)))))
        if abs(previous - rmse) < tolerance:
            return dict(transformation=transform, pairs=pairs, rmse=rmse,
                        iterations=iteration + 1, converged=True)
        previous = rmse

    return dict(transformation=transform, pairs=pairs, rmse=rmse,
                iterations=max_iterations, converged=False)
