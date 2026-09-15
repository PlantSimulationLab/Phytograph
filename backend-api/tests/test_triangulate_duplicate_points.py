"""Duplicate-coordinate handling for Ball Pivoting in /api/triangulate.

Open3D's BPA rejects any radius <= 0 and reports it as "got an invalid, negative
radius as parameter" — naming the wrong value, since the radius it received was
0. The radius reaches 0 through the AUTO ladder: it is [median, 2x, 4x] of the
nearest-neighbour spacing, `compute_nearest_neighbor_distance` returns 0.0 for
every point coincident with another, so once MORE THAN HALF the cloud is exact
duplicates the median collapses to 0 and every rung of the ladder is 0. Open3D
validates each rung, so one zero fails the whole call.

That is reachable from ordinary use — merged overlapping scans, a re-imported
export, a quantizing decimation — and it surfaced as a raw Open3D error with no
route to a fix.

These pin the three behaviours that close it:
  - duplicates are removed before BPA and REPORTED (`duplicates_dropped`), and
    the surviving mesh is identical to the same cloud without duplicates, so
    dedup provably costs no surface;
  - a cloud that is entirely coincident fails with a diagnosis naming the real
    cause, not Open3D's "negative radius";
  - an explicit non-positive radius from a direct API caller is rejected by name.

The 2x/3x-duplicated cases are the actual reported failure: before the fix they
raised the Open3D error above.
"""

import numpy as np

from tests.binframe import decode_bin_frame


def _bumpy_grid(n_side: int) -> np.ndarray:
    """An n_side x n_side sine-bumped grid over the unit square — a real surface
    BPA can roll a ball over (the z-bumps keep it off a single plane)."""
    g = np.linspace(0.0, 1.0, n_side)
    xs, ys = np.meshgrid(g, g)
    zs = 0.08 * np.sin(6.0 * xs) * np.cos(6.0 * ys)
    return np.c_[xs.ravel(), ys.ravel(), zs.ravel()]


def _triangulate(client, points, **extra):
    res = client.post("/api/triangulate", json={
        "method": "ball_pivoting",
        "points": np.asarray(points).tolist(),
        **extra,
    })
    assert res.status_code == 200
    body, _ = decode_bin_frame(res.content)
    return body


def test_majority_duplicate_cloud_still_meshes(client):
    """The reported failure: every point duplicated once, so >50% of the NN
    distances are 0 and the auto radius ladder collapses to [0, 0, 0]. Must
    mesh, not raise Open3D's "invalid, negative radius"."""
    base = _bumpy_grid(40)
    body = _triangulate(client, np.vstack([base, base]))

    assert body["success"] is True, body.get("error")
    assert body["num_triangles"] > 1000, body["num_triangles"]
    # The duplicates are removed and accounted for, and points_used is net of them.
    assert body["duplicates_dropped"] == len(base)
    assert body["points_used"] == len(base)


def test_dedup_does_not_change_the_mesh(client):
    """Dedup must be free: coincident points add no surface, so the mesh built
    from a duplicated cloud is the SAME mesh as from the clean one. Guards
    against "fixing" the radius by dropping real geometry."""
    base = _bumpy_grid(40)
    clean = _triangulate(client, base)
    doubled = _triangulate(client, np.vstack([base, base]))
    tripled = _triangulate(client, np.vstack([base, base, base]))

    assert clean["success"] and doubled["success"] and tripled["success"]
    assert clean["duplicates_dropped"] == 0
    assert doubled["num_triangles"] == clean["num_triangles"]
    assert tripled["num_triangles"] == clean["num_triangles"]
    assert tripled["duplicates_dropped"] == 2 * len(base)
    # Surface area is the physical quantity downstream tools read; it must not
    # move either.
    assert doubled["surface_area"] == clean["surface_area"]


def test_shuffled_duplicates_are_not_position_dependent(client):
    """The duplicates in a real merged scan are interleaved, not appended in a
    block. Same result either way."""
    base = _bumpy_grid(30)
    stacked = np.vstack([base, base])
    rng = np.random.default_rng(0)
    rng.shuffle(stacked)

    body = _triangulate(client, stacked)
    assert body["success"] is True, body.get("error")
    assert body["duplicates_dropped"] == len(base)
    assert body["points_used"] == len(base)


def test_fully_coincident_cloud_reports_the_real_cause(client):
    """Every point identical: there is genuinely no spacing to size a ball from.
    Fail with a message naming that, rather than Open3D's misleading
    "negative radius"."""
    body = _triangulate(client, np.zeros((500, 3)))

    assert body["success"] is False
    assert "negative radius" not in (body.get("error") or "")
    assert "duplicate" in body["error"].lower()
    assert body["duplicates_dropped"] == 499
    assert body["points_used"] == 1


def test_explicit_non_positive_radius_is_rejected_by_name(client):
    """A direct API caller passing radii=[0] or [-1] gets a message naming the
    offending value. The UI already guards r > 0, so this is the API surface."""
    base = _bumpy_grid(20)
    for bad in ([0.0], [-1.0], [0.05, 0.0]):
        body = _triangulate(client, base, radii=bad)
        assert body["success"] is False, bad
        assert "positive" in body["error"], body["error"]
        assert "negative radius" not in body["error"], body["error"]


def test_explicit_positive_radius_still_works(client):
    """The guard must not block the legitimate explicit-radius path."""
    base = _bumpy_grid(30)
    body = _triangulate(client, base, radii=[0.08])
    assert body["success"] is True, body.get("error")
    assert body["num_triangles"] > 100, body["num_triangles"]


def test_non_ball_pivot_methods_do_not_dedup(client):
    """Dedup is BPA-only: Poisson solves a weighted field and alpha/delaunay
    build a tetrahedralization, where duplicates are harmless. Dropping them
    there would silently change long-standing output."""
    base = _bumpy_grid(20)
    res = client.post("/api/triangulate", json={
        "method": "alpha_shape",
        "points": np.vstack([base, base]).tolist(),
    })
    assert res.status_code == 200
    body, _ = decode_bin_frame(res.content)
    assert body["success"] is True, body.get("error")
    assert body["duplicates_dropped"] == 0
    assert body["points_used"] == 2 * len(base)
