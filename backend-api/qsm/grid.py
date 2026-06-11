"""Voxel-grid binning shared between the LAD/triangulation pipeline and the QSM
leaf-angle adjustment.

The grid is the explicit request grid (center/size are full extents, nx/ny/nz the
per-axis subdivisions) — a regular axis-aligned lattice, so a point's cell is a
direct floor-divide. Cell ids are **row-major** ``i + nx*(j + ny*k)``, which is
the convention the frontend reconstructs cells with and the same one the
per-triangle cell assignment uses. Keeping one implementation here means the QSM
leaf placer bins leaf bases into exactly the cells the triangulation binned its
triangles into.
"""

from __future__ import annotations

import numpy as np


def bin_points_to_cells(points, grid_center, grid_size, nx: int, ny: int, nz: int):
    """Assign each point to a grid cell, returning a flat ``(N,)`` int array of
    cell indices (row-major ``i + nx*(j + ny*k)``); points outside the grid get
    ``-1``.
    """
    pts = np.asarray(points, dtype=np.float64)
    n = pts.shape[0] if pts.ndim == 2 else 0
    if n == 0:
        return np.empty(0, dtype=np.int64)

    center = np.asarray(grid_center, dtype=np.float64)
    size = np.asarray(grid_size, dtype=np.float64)
    ndiv = np.array([max(1, int(nx)), max(1, int(ny)), max(1, int(nz))], dtype=np.int64)

    lo = center - size / 2.0
    step = np.where(ndiv > 0, size / ndiv, 1.0)
    safe_step = np.where(step > 0, step, 1.0)

    ijk = np.floor((pts - lo) / safe_step).astype(np.int64)
    inside = np.all((ijk >= 0) & (ijk < ndiv), axis=1)
    flat = np.full(n, -1, dtype=np.int64)
    ii = ijk[inside]
    flat[inside] = ii[:, 0] + ndiv[0] * (ii[:, 1] + ndiv[1] * ii[:, 2])
    return flat
