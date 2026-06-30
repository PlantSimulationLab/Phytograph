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


def bin_points_to_cells_terrain(points, grid_center, grid_size, nx, ny, nz,
                                column_offsets, rotation_deg=0.0, kept_columns=None):
    """Offset-aware bin: assign each point to a TERRAIN-SNAPPED grid cell.

    A snapped grid shifts each (x,y) column's cells vertically by
    ``column_offsets[j*nx + i]`` (the same convention as ``HeliosGrid`` /
    ``LiDARcloud::addGrid``). Binning a point therefore can't use a single regular
    lattice in z. We recover the regular frame the way ``_count_points_per_cell``
    does: find each point's (i,j) column in the un-rotated frame, subtract that
    column's offset from the point's z, then bin into the base lattice. A point
    whose (i,j) lies outside the grid, or whose un-shifted z falls outside the
    column, gets ``-1`` (and so does a point in a dropped column when
    ``kept_columns`` is given). Returns the flat cell index ``i + nx*(j + ny*k)``.

    ``column_offsets`` empty/None -> defers to the regular :func:`bin_points_to_cells`.
    """
    offs = None if column_offsets is None else np.asarray(column_offsets, dtype=np.float64)
    if offs is None or offs.size == 0:
        return bin_points_to_cells(points, grid_center, grid_size, nx, ny, nz)

    pts = np.asarray(points, dtype=np.float64)
    n = pts.shape[0] if pts.ndim == 2 else 0
    if n == 0:
        return np.empty(0, dtype=np.int64)

    center = np.asarray(grid_center, dtype=np.float64)
    size = np.asarray(grid_size, dtype=np.float64)
    nx, ny, nz = max(1, int(nx)), max(1, int(ny)), max(1, int(nz))
    ndiv = np.array([nx, ny, nz], dtype=np.int64)
    lo = center - size / 2.0
    step = np.where(ndiv > 0, size / ndiv, 1.0)
    safe_step = np.where(step > 0, step, 1.0)

    # Inverse-rotate points into the grid's axis-aligned frame (rotation pivots on
    # the grid center, about +z), matching the crop / Helios containment test.
    q = pts
    if abs(float(rotation_deg)) > 1e-9:
        theta = -np.radians(float(rotation_deg))
        cos_t, sin_t = np.cos(theta), np.sin(theta)
        dx = pts[:, 0] - center[0]
        dy = pts[:, 1] - center[1]
        q = pts.copy()
        q[:, 0] = cos_t * dx - sin_t * dy + center[0]
        q[:, 1] = sin_t * dx + cos_t * dy + center[1]

    # Column (i,j) from x,y; clamp-test to grid bounds.
    ij = np.floor((q[:, :2] - lo[:2]) / safe_step[:2]).astype(np.int64)
    in_xy = np.all((ij >= 0) & (ij < ndiv[:2]), axis=1)

    flat = np.full(n, -1, dtype=np.int64)
    idx = np.nonzero(in_xy)[0]
    if idx.size == 0:
        return flat

    i = ij[idx, 0]
    j = ij[idx, 1]
    col = j * nx + i  # row-major [j*nx + i], matches column_offsets layout
    # Un-shift z by the point's column offset, then bin in the regular z lattice.
    z_unshift = q[idx, 2] - offs[col]
    k = np.floor((z_unshift - lo[2]) / safe_step[2]).astype(np.int64)
    in_z = (k >= 0) & (k < nz)

    keep = in_z
    if kept_columns is not None:
        kc = np.asarray(kept_columns, dtype=bool)
        keep = keep & kc[col]

    sel = idx[keep]
    flat[sel] = i[keep] + nx * (j[keep] + ny * k[keep])
    return flat
