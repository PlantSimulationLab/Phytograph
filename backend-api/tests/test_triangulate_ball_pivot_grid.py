"""Grid-pinning tests for /api/triangulate (Ball Pivot LAD reuse).

When the Ball Pivot request carries a `grid`, the backend bins each output
triangle's centroid into that grid and returns a per-triangle cell id
(`triangle_cell_ids`), so the leaf-area (LAD) reuse path can keep only the
triangles that actually lie inside the grid. These pin:

  - the cell ids are present, aligned 1:1 with the triangles, and in range
    (`[0, nx*ny*nz)` or the uint32 "outside" sentinel 0xffffffff),
  - a multi-cell grid splits the mesh across more than one cell,
  - a triangle whose centroid falls outside the grid is marked outside,
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


def test_triangle_outside_grid_is_marked_outside(client):
    """A patch placed beyond the grid (but NOT cropped away — no crop_box here)
    produces triangles whose centroids fall outside every cell, marked with the
    outside sentinel so the reuse path drops them."""
    # A small grid hugging the origin patch; a second patch sits well outside it.
    near = _bumpy_grid(12, offset=(0.0, 0.0, 0.0))
    far = _bumpy_grid(12, offset=(5.0, 0.0, 0.0))
    points = np.vstack([near, far]).tolist()
    res = client.post("/api/triangulate", json={
        "method": "ball_pivoting",
        "points": points,
        # No crop: keep the far patch so it produces out-of-grid triangles.
        "grid": _grid_around_unit_patch(),  # box only covers the near patch
    })
    assert res.status_code == 200
    body, buffers = decode_bin_frame(res.content)
    assert body["success"] is True, body.get("error")
    cell_ids = buffers["triangle_cell_ids"]
    # Some triangles are inside (cell 0), some outside (sentinel).
    assert (cell_ids == 0).any(), "expected some in-grid triangles"
    assert (cell_ids == CELL_OUTSIDE).any(), "expected some out-of-grid triangles"


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
