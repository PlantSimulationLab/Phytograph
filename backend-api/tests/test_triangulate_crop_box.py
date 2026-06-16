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
