"""Crop-to-grid (`crop_box`) tests for /api/triangulate.

The "Crop to grid" toggle on the Ball Pivot path sends an axis-aligned box
[min_x,min_y,min_z, max_x,max_y,max_z]; the backend drops points outside it
(a numpy mask on the resolved point array) before meshing. These pin that the
mask actually subsets the input — `points_used` reflects only the in-box points,
not the full cloud — and the edge cases (no box = no crop, empty box errors).
"""

import numpy as np

from tests.binframe import decode_bin_frame


def _two_clusters() -> list[list[float]]:
    """Two dense bumpy grids: one inside the unit box near the origin, one
    translated far away (+10 in x). A crop box around the origin must keep only
    the first cluster. The z-bumps (a sine surface) keep the points off a single
    plane so ball-pivoting's Delaunay isn't degenerate (cocircular input)."""
    g = np.linspace(0.0, 1.0, 12)
    xs, ys = np.meshgrid(g, g)
    zs = 0.05 * np.sin(6.0 * xs) * np.cos(6.0 * ys)
    near = np.c_[xs.ravel(), ys.ravel(), zs.ravel()]
    far = near + np.array([10.0, 0.0, 0.0])
    return np.vstack([near, far]).tolist()


def test_crop_box_subsets_points_before_meshing(client):
    """With a box around the near cluster, points_used drops to that cluster's
    count — proof the mask ran on the resolved array, not the whole cloud."""
    points = _two_clusters()
    near_count = len(points) // 2
    res = client.post("/api/triangulate", json={
        "method": "ball_pivoting",
        "points": points,
        # A box that comfortably contains the near cluster ([0,1]^2 on z=0) and
        # excludes the far one (x≈10..11).
        "crop_box": [-0.5, -0.5, -0.5, 1.5, 1.5, 0.5],
    })
    assert res.status_code == 200
    body, _ = decode_bin_frame(res.content)
    assert body["success"] is True, body.get("error")
    # Only the near cluster survived the crop.
    assert body["points_used"] == near_count, body["points_used"]


def test_no_crop_box_uses_all_points(client):
    """Omitting crop_box meshes every point (baseline for the crop assertion)."""
    points = _two_clusters()
    res = client.post("/api/triangulate", json={
        "method": "ball_pivoting",
        "points": points,
    })
    assert res.status_code == 200
    body, _ = decode_bin_frame(res.content)
    assert body["success"] is True, body.get("error")
    assert body["points_used"] == len(points)


def test_crop_box_too_tight_reports_actionable_error(client):
    """A box that contains <3 points fails with a crop-specific message rather
    than a bare 'need 3 points', so the UI can tell the user to enlarge it."""
    points = _two_clusters()
    res = client.post("/api/triangulate", json={
        "method": "ball_pivoting",
        "points": points,
        # Far from any point — keeps nothing.
        "crop_box": [100.0, 100.0, 100.0, 101.0, 101.0, 101.0],
    })
    assert res.status_code == 200
    body, _ = decode_bin_frame(res.content)
    assert body["success"] is False
    assert body["points_used"] == 0
    assert "crop" in body["error"].lower()


def test_crop_box_wrong_length_is_rejected(client):
    """crop_box must be 6 numbers; a malformed one is a clear error, not a crash."""
    res = client.post("/api/triangulate", json={
        "method": "ball_pivoting",
        "points": _two_clusters(),
        "crop_box": [0.0, 0.0, 0.0, 1.0],  # only 4
    })
    assert res.status_code == 200
    body, _ = decode_bin_frame(res.content)
    assert body["success"] is False
    assert "crop_box" in body["error"]


def _box_corner_cluster() -> tuple[list[list[float]], list[float]]:
    """A dense central patch (always inside) plus a patch sitting in the +x,+y
    corner of a 4x4 axis-aligned box. The corner patch is INSIDE the AABB but
    OUTSIDE the same box rotated 61° about its center — so a rotated crop must
    drop it while an axis-aligned crop keeps it. Returns (points, crop_box)."""
    g = np.linspace(-0.15, 0.15, 8)
    xs, ys = np.meshgrid(g, g)
    zs = 0.03 * np.sin(8.0 * xs) * np.cos(8.0 * ys)
    central = np.c_[xs.ravel(), ys.ravel(), zs.ravel()]
    corner = central + np.array([1.7, 1.7, 0.0])
    pts = np.vstack([central, corner])
    crop_box = [-2.0, -2.0, -0.5, 2.0, 2.0, 0.5]  # 4x4 box centered at origin
    return pts.tolist(), crop_box


def test_rotated_crop_box_excludes_aabb_corner(client):
    """crop_box_rotation_deg crops the ROTATED box: a point in the AABB corner is
    kept with no rotation but dropped at 61° — the fix for rotated grids leaking
    branches past their walls. Matches Helios's own rotated grid-cell test."""
    points, crop_box = _box_corner_cluster()
    central_count = len(points) // 2

    # Axis-aligned crop keeps BOTH clusters (corner is inside the AABB).
    res = client.post("/api/triangulate", json={
        "method": "ball_pivoting", "points": points, "crop_box": crop_box,
    })
    body, _ = decode_bin_frame(res.content)
    assert body["success"] is True, body.get("error")
    assert body["points_used"] == len(points), body["points_used"]

    # Rotated 61° about the box center: the corner cluster falls outside the
    # rotated box, so only the central cluster survives.
    res = client.post("/api/triangulate", json={
        "method": "ball_pivoting", "points": points, "crop_box": crop_box,
        "crop_box_rotation_deg": 61.0,
    })
    body, _ = decode_bin_frame(res.content)
    assert body["success"] is True, body.get("error")
    assert body["points_used"] == central_count, body["points_used"]


def _dense_split(near_n: int, far_n: int) -> tuple[list[list[float]], list[float]]:
    """`near_n` bumpy points inside a unit box at the origin + `far_n` far away.
    Returns (points, crop_box) where the box contains only the near cluster."""
    def bumpy(n, offset):
        g = int(np.ceil(np.sqrt(n)))
        xs, ys = np.meshgrid(np.linspace(0, 1, g), np.linspace(0, 1, g))
        zs = 0.05 * np.sin(6 * xs) * np.cos(6 * ys)
        pts = np.c_[xs.ravel(), ys.ravel(), zs.ravel()][:n]
        return pts + np.array(offset)
    near = bumpy(near_n, [0, 0, 0])
    far = bumpy(far_n, [10, 0, 0])
    return np.vstack([near, far]).tolist(), [-0.5, -0.5, -0.5, 1.5, 1.5, 0.5]


def test_crop_runs_before_cap_no_spurious_downsample(client):
    """Crop-to-grid resolves UNCAPPED, crops, THEN caps. With the in-grid count
    under the cap, every in-grid point is kept and `downsampled` is False — even
    though the in-grid count is far below the whole cloud (a crop is not a
    downsample). Regression: the cap used to thin the whole cloud BEFORE the crop,
    discarding in-grid density and falsely flagging a downsample."""
    near_n = 900
    points, crop_box = _dense_split(near_n, far_n=900)
    res = client.post("/api/triangulate", json={
        "method": "ball_pivoting",
        "points": points,
        "crop_box": crop_box,
    })
    body, _ = decode_bin_frame(res.content)
    assert body["success"] is True, body.get("error")
    # NOTE: inline `points` carry no max_points cap, so the cap can't fire here;
    # this pins that cropping alone never sets the downsample flag.
    assert body["points_used"] == near_n, body["points_used"]
    assert body.get("downsampled") in (False, None)
