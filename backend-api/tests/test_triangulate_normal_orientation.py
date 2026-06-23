"""Normal-orientation strategy tests for /api/triangulate.

Ball Pivoting only needs LOCALLY consistent normals, so it orients them toward
the cloud centroid in O(N) instead of the O(N log N) MST-based
`orient_normals_consistent_tangent_plane` (minutes on a few-million-point
cloud). Poisson keeps the MST because its watertight solve needs a globally
consistent inside/outside field. Alpha-shape and Delaunay read no point normals
at all, so the estimate step is skipped entirely for them.

These pin the observable consequences:
  - Ball Pivot still meshes a curved surface correctly (cheap orientation is
    adequate — it doesn't collapse the mesh).
  - The cheap path completes fast on a cloud big enough that the MST would have
    dominated — a loose ceiling, not a microbenchmark, so it isn't flaky.
  - Alpha-shape and Delaunay succeed with estimate_normals defaulted on, proving
    the now-skipped estimate doesn't break them.
"""

import time

import numpy as np

from tests.binframe import decode_bin_frame


def _bumpy_grid(n_side: int, *, offset=(0.0, 0.0, 0.0)) -> np.ndarray:
    """An n_side x n_side sine-bumped grid over the unit square. The z-bumps keep
    the points off a single plane so ball-pivoting / Delaunay aren't degenerate."""
    g = np.linspace(0.0, 1.0, n_side)
    xs, ys = np.meshgrid(g, g)
    zs = 0.08 * np.sin(6.0 * xs) * np.cos(6.0 * ys)
    pts = np.c_[xs.ravel(), ys.ravel(), zs.ravel()]
    return pts + np.array(offset)


def test_ball_pivoting_meshes_curved_surface_with_cheap_orientation(client):
    """Centroid-facing orientation is adequate for BPA: a curved (non-planar)
    surface still produces a substantial triangle count, not a near-empty mesh.
    If the cheap orientation flipped normals to the wrong side wholesale, BPA
    would roll on the back face and produce far fewer/zero triangles."""
    points = _bumpy_grid(40).tolist()  # 1600 points, clearly curved
    res = client.post("/api/triangulate", json={
        "method": "ball_pivoting",
        "points": points,
    })
    assert res.status_code == 200
    body, _ = decode_bin_frame(res.content)
    assert body["success"] is True, body.get("error")
    # A 40x40 bumpy grid triangulates to thousands of faces; assert it's well
    # above a trivially-broken floor rather than pinning an exact count.
    assert body["num_triangles"] > 1000, body["num_triangles"]
    assert body["points_used"] == len(points)


def test_ball_pivoting_fast_on_large_cloud(client):
    """The whole point of the fix: a cloud big enough that the MST orientation
    used to dominate now finishes quickly. This is a LOOSE ceiling (the MST took
    minutes on millions of points; the cheap path is sub-second on this size) so
    it flags a regression back to the MST without being a flaky microbenchmark."""
    # ~40k points — large enough that MST orientation is clearly measurable,
    # small enough to keep the test fast under the cheap path.
    points = _bumpy_grid(200).tolist()
    t = time.time()
    res = client.post("/api/triangulate", json={
        "method": "ball_pivoting",
        "points": points,
    })
    elapsed = time.time() - t
    assert res.status_code == 200
    body, _ = decode_bin_frame(res.content)
    assert body["success"] is True, body.get("error")
    assert body["num_triangles"] > 1000, body["num_triangles"]
    # Generous ceiling: the cheap path handles 40k points in well under this;
    # the MST path would be far slower. CI headroom guards against flakiness.
    assert elapsed < 30.0, f"triangulation took {elapsed:.1f}s — MST regression?"


def test_alpha_shape_succeeds_without_point_normals(client):
    """Alpha-shape reads no point normals, so the estimate step is skipped for it.
    Pin that it still meshes correctly with estimate_normals defaulted on."""
    points = _bumpy_grid(30).tolist()
    res = client.post("/api/triangulate", json={
        "method": "alpha_shape",
        "points": points,
    })
    assert res.status_code == 200
    body, _ = decode_bin_frame(res.content)
    assert body["success"] is True, body.get("error")
    assert body["num_triangles"] > 0, body["num_triangles"]


def test_delaunay_succeeds_without_point_normals(client):
    """Delaunay projects to XY and reads no point normals; the estimate step is
    skipped. Pin that it still meshes with estimate_normals defaulted on."""
    points = _bumpy_grid(30).tolist()
    res = client.post("/api/triangulate", json={
        "method": "delaunay",
        "points": points,
    })
    assert res.status_code == 200
    body, _ = decode_bin_frame(res.content)
    assert body["success"] is True, body.get("error")
    assert body["num_triangles"] > 0, body["num_triangles"]
