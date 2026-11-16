"""/api/triangulate returns vertices relative to `vertex_origin`.

Vertices travel as float32, which resolves 0.0625 m at a UTM easting (~5e5 m)
and 0.5 m at a UTM northing (~4.2e6 m). Shipped in world coordinates, every
Open3D mesh of a georeferenced cloud was snapped onto that lattice: a leaf
mesh became stair-steps, and a Ball Pivot mesh reused for LAD fed G(theta)
quantized normals. The vertices now come back relative to an origin near the
data (`frame_origin` when the caller names one), and world = vertex + origin.
"""

import numpy as np

from tests.binframe import decode_bin_frame

UTM = np.array([512_345.0, 4_271_234.0, 87.0])


def _bumpy_patch(n_side=14):
    g = np.linspace(0.0, 1.0, n_side)
    xs, ys = np.meshgrid(g, g)
    zs = 0.05 * np.sin(6.0 * xs) * np.cos(6.0 * ys)
    return np.c_[xs.ravel(), ys.ravel(), zs.ravel()]


def _triangulate(client, points, **extra):
    res = client.post("/api/triangulate", json={
        "method": "ball_pivoting", "points": points.tolist(), **extra})
    assert res.status_code == 200
    body, buffers = decode_bin_frame(res.content)
    assert body["success"] is True, body.get("error")
    return body, buffers


def _world_vertices(body, buffers):
    local = np.asarray(buffers["vertices"], dtype=np.float64).reshape(-1, 3)
    return local + np.asarray(body["vertex_origin"], dtype=np.float64)


def test_a_utm_mesh_keeps_its_vertices_where_the_points_are(client):
    points = _bumpy_patch() + UTM
    body, buffers = _triangulate(client, points)
    world = _world_vertices(body, buffers)
    # Ball Pivoting keeps the input points as its vertices, so every vertex must
    # sit on one. Float32 world coordinates missed by up to 0.25 m.
    gap = np.min(np.linalg.norm(world[:, None, :] - points[None, :, :], axis=2), axis=1)
    assert gap.max() < 1e-3, f"vertices moved up to {gap.max():.3f} m"
    # The origin is near the data and in whole metres.
    origin = np.asarray(body["vertex_origin"])
    assert np.all(origin == np.floor(origin))
    assert np.abs(origin - UTM).max() < 2.0


def test_the_caller_names_the_frame(client):
    points = _bumpy_patch() + UTM
    body, buffers = _triangulate(client, points, frame_origin=UTM.tolist())
    assert body["vertex_origin"] == UTM.tolist()
    local = np.asarray(buffers["vertices"], dtype=np.float64).reshape(-1, 3)
    assert np.abs(local).max() < 2.0   # small numbers, which float32 holds exactly
    gap = np.min(np.linalg.norm((local + UTM)[:, None, :] - points[None, :, :], axis=2), axis=1)
    assert gap.max() < 1e-3


def test_small_coordinates_keep_a_zero_origin(client):
    body, buffers = _triangulate(client, _bumpy_patch())
    assert body["vertex_origin"] == [0.0, 0.0, 0.0]


def test_grid_pin_bins_in_the_same_frame_as_the_vertices(client):
    # The grid is world-frame and the centroids are local: binning one against
    # the other without the origin put every triangle outside the grid.
    grid = {"center": [0.5, 0.5, 0.0], "size": [2.0, 2.0, 1.0], "nx": 2, "ny": 2, "nz": 1}
    crop = [-0.5, -0.5, -0.5, 1.5, 1.5, 0.5]
    near_body, near_buf = _triangulate(client, _bumpy_patch(), grid=grid, crop_box=crop)
    far_grid = {**grid, "center": (np.array(grid["center"]) + UTM).tolist()}
    far_crop = (np.array(crop) + np.r_[UTM, UTM]).tolist()
    far_body, far_buf = _triangulate(client, _bumpy_patch() + UTM, grid=far_grid,
                                     crop_box=far_crop, frame_origin=UTM.tolist())
    assert far_body["num_triangles"] == near_body["num_triangles"] > 0
    np.testing.assert_array_equal(far_buf["triangle_cell_ids"], near_buf["triangle_cell_ids"])
