"""Grid-pinning tests for /api/triangulate (Ball Pivot LAD reuse).

When the Ball Pivot request carries a `grid`, the backend bins each output
triangle's centroid into that grid and DROPS any triangle whose centroid falls
outside every cell, so "crop to grid" yields a mesh of only in-grid triangles
(the per-triangle `triangle_cell_ids` ride back for the LAD reuse path). These pin:

  - the cell ids are present, aligned 1:1 with the (surviving) triangles, and in
    range `[0, nx*ny*nz)` — every returned triangle is in-grid (no -1 sentinel),
  - a multi-cell grid splits the mesh across more than one cell,
  - a triangle whose centroid falls outside the grid is DROPPED from the result,
  - a terrain-snapped grid bins against the SHIFTED cells: ground under the lifted
    columns triangulates inside the flat crop box but OUTSIDE the voxels, and must
    be dropped (the bug that left clear-cut lines + out-of-grid ground triangles),
  - no `grid` ⇒ no cell ids (the legacy path is untouched).

Miss exclusion (the third LAD gotcha) is covered separately in
test_triangulate_excludes_misses.py — ball pivot reads through the same
`_read_points_from_source` chokepoint with `include_misses=False`, so it drops
sky/miss points with or without a grid.
"""

import numpy as np

from tests.binframe import decode_bin_frame


CELL_OUTSIDE = 0xFFFFFFFF


def _bumpy_grid(n_side: int, offset=(0.0, 0.0, 0.0)) -> np.ndarray:
    """A dense bumpy patch on z≈0 spanning [0,1]^2 (+offset). The sine z-bumps
    keep the points off a single plane so ball pivoting isn't degenerate."""
    g = np.linspace(0.0, 1.0, n_side)
    xs, ys = np.meshgrid(g, g)
    zs = 0.05 * np.sin(6.0 * xs) * np.cos(6.0 * ys)
    pts = np.c_[xs.ravel(), ys.ravel(), zs.ravel()]
    return pts + np.array(offset)


def _grid_around_unit_patch(nx=1, ny=1, nz=1) -> dict:
    """A voxel grid centered on the [0,1]^2 z≈0 patch, comfortably enclosing it."""
    return {"center": [0.5, 0.5, 0.0], "size": [2.0, 2.0, 1.0],
            "nx": nx, "ny": ny, "nz": nz}


def test_grid_pin_returns_per_triangle_cell_ids(client):
    """A single-cell grid: every triangle lands in cell 0, and the cell-id buffer
    is aligned 1:1 with the triangles."""
    points = _bumpy_grid(14).tolist()
    res = client.post("/api/triangulate", json={
        "method": "ball_pivoting",
        "points": points,
        "crop_box": [-0.5, -0.5, -0.5, 1.5, 1.5, 0.5],
        "grid": _grid_around_unit_patch(),
    })
    assert res.status_code == 200
    body, buffers = decode_bin_frame(res.content)
    assert body["success"] is True, body.get("error")
    cell_ids = buffers.get("triangle_cell_ids")
    assert cell_ids is not None, "grid pin should return triangle_cell_ids"
    assert len(cell_ids) == body["num_triangles"]
    # Single-cell grid ⇒ in-grid triangles all land in cell 0 (none outside, since
    # the crop already confined the points to the box).
    assert set(np.unique(cell_ids).tolist()) <= {0}


def test_multi_cell_grid_splits_triangles_across_cells(client):
    """A 2x2x1 grid over the patch assigns triangles to more than one cell, so the
    LAD reuse path can resolve per-cell geometry."""
    points = _bumpy_grid(20).tolist()
    res = client.post("/api/triangulate", json={
        "method": "ball_pivoting",
        "points": points,
        "crop_box": [-0.5, -0.5, -0.5, 1.5, 1.5, 0.5],
        "grid": _grid_around_unit_patch(nx=2, ny=2, nz=1),
    })
    assert res.status_code == 200
    body, buffers = decode_bin_frame(res.content)
    assert body["success"] is True, body.get("error")
    cell_ids = buffers["triangle_cell_ids"]
    n_cells = 2 * 2 * 1
    in_grid = cell_ids[cell_ids != CELL_OUTSIDE]
    # Every in-grid id is a valid cell index, and the mesh spans multiple cells.
    assert in_grid.min() >= 0 and in_grid.max() < n_cells
    assert len(np.unique(in_grid)) >= 2, np.unique(in_grid)


def test_triangle_outside_grid_is_dropped(client):
    """A patch placed beyond the grid (but NOT cropped away — no crop_box here)
    produces triangles whose centroids fall outside every cell. The backend DROPS
    them, so the returned mesh contains only in-grid triangles (every cell id is a
    valid in-range cell, none is the outside sentinel)."""
    # A small grid hugging the origin patch; a second patch sits well outside it.
    near = _bumpy_grid(12, offset=(0.0, 0.0, 0.0))
    far = _bumpy_grid(12, offset=(5.0, 0.0, 0.0))
    points = np.vstack([near, far]).tolist()
    res = client.post("/api/triangulate", json={
        "method": "ball_pivoting",
        "points": points,
        # No crop: the far patch's triangles must be dropped by the grid bin (not
        # the crop_box), proving the bin itself enforces "only in-grid triangles".
        "grid": _grid_around_unit_patch(),  # box only covers the near patch
    })
    assert res.status_code == 200
    body, buffers = decode_bin_frame(res.content)
    assert body["success"] is True, body.get("error")
    cell_ids = buffers["triangle_cell_ids"]
    assert len(cell_ids) > 0, "expected some surviving in-grid triangles"
    # Every returned triangle is in-grid — the far patch was dropped, not marked.
    assert (cell_ids == 0).all(), f"out-of-grid triangles leaked: {np.unique(cell_ids)}"
    assert (cell_ids == CELL_OUTSIDE).sum() == 0


def test_terrain_snapped_grid_drops_ground_under_lifted_columns(client):
    """The regression: a snapped grid lifts its voxel column ABOVE a ground patch.
    The flat crop box still admits the ground (it's within the displaced z-extent),
    so the ground triangulates — but it sits BELOW the lifted cell and must be
    dropped by the offset-aware bin. Without column_offsets the ground would be
    (wrongly) binned into the cell as if the grid were flat."""
    # Ground patch at z≈0. A 1×1×1 grid whose column is lifted by +2 so the cell
    # spans z∈[1.5, 2.5] — entirely above the ground.
    points = _bumpy_grid(16).tolist()
    grid = {"center": [0.5, 0.5, 1.0], "size": [2.0, 2.0, 1.0],
            "nx": 1, "ny": 1, "nz": 1, "column_offsets": [2.0]}
    res = client.post("/api/triangulate", json={
        "method": "ball_pivoting", "points": points, "grid": grid,
    })
    assert res.status_code == 200
    body, buffers = decode_bin_frame(res.content)
    assert body["success"] is True, body.get("error")
    # The single lifted cell is far above the ground, so NO triangle is in-grid →
    # all dropped → zero triangles returned (not ground triangles mislabeled cell 0).
    assert body["num_triangles"] == 0, \
        "ground under a lifted column must be dropped, not binned into the cell"
    assert len(buffers.get("triangle_cell_ids", [])) == 0


def test_no_grid_omits_cell_ids(client):
    """Without a `grid` the response carries no triangle_cell_ids — the legacy
    ball-pivot path is unchanged."""
    res = client.post("/api/triangulate", json={
        "method": "ball_pivoting",
        "points": _bumpy_grid(12).tolist(),
    })
    assert res.status_code == 200
    body, buffers = decode_bin_frame(res.content)
    assert body["success"] is True, body.get("error")
    assert "triangle_cell_ids" not in buffers
