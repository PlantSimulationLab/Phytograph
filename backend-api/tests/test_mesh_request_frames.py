"""Mesh requests travel as PHB1 binary frames and stay arrays on arrival.

Cloud-to-mesh distance and Snap to Fit took the mesh as JSON numbers: one past
~11.7 M triangles is a body V8 cannot build, so the renderer threw before the
request was sent. And every binary endpoint turned its buffers back into Python
lists for a `List[float]` field (two 2 M-triangle meshes, a 69 MB payload, took
10 s and an 847 MB peak to decode). These pin both halves.
"""

import tracemalloc

import numpy as np
import pytest

import main
from tests.binframe import decode_streamed_json

UTM = np.array([512_345.0, 4_271_234.0, 87.0])


def _box_mesh(center, half=1.0, n=30):
    """A closed box surface sampled as a grid of triangles on each face.
    `half` is a scalar (a cube) or per-axis half-sizes."""
    half = np.broadcast_to(np.asarray(half, dtype=float), (3,))
    g = np.linspace(-1.0, 1.0, n)
    xs, ys = np.meshgrid(g, g)
    verts, tris = [], []
    for axis in range(3):
        for sign in (-1.0, 1.0):
            base = len(verts)
            for x, y in zip(xs.ravel(), ys.ravel()):
                p = [0.0, 0.0, 0.0]
                p[axis] = sign
                p[(axis + 1) % 3], p[(axis + 2) % 3] = x, y
                verts.append(np.asarray(p) * half)
            for i in range(n - 1):
                for j in range(n - 1):
                    a = base + i * n + j
                    tris += [[a, a + 1, a + n], [a + 1, a + n + 1, a + n]]
    return np.asarray(verts) + center, np.asarray(tris)


def _cloud_on(verts, rng, n=4000, noise=0.01):
    idx = rng.integers(0, len(verts), n)
    return verts[idx] + rng.normal(0, noise, (n, 3))


def _frame(meta, mesh_rel, tris, origin, points=None):
    buffers = [("mesh_vertices", mesh_rel.astype(np.float32).ravel(), "f32"),
               ("mesh_indices", tris.astype(np.uint32).ravel(), "u32")]
    if points is not None:
        buffers.append(("points", points.astype(np.float32).ravel(), "f32"))
    return main._bin_frame_bytes({**meta, "mesh_vertex_origin": list(origin)}, buffers)


@pytest.mark.parametrize("route", ["/api/c2m/distance", "/api/c2m/icp-register"])
def test_a_framed_utm_mesh_gives_the_answer_json_gives(client, route):
    """The frame carries the mesh relative to its origin in float32; float32
    WORLD coordinates at this northing would be quantized to 0.5 m."""
    rng = np.random.default_rng(0)
    verts, tris = _box_mesh(UTM)
    pts = _cloud_on(verts, rng)
    # Points stay inline JSON here (a flat cloud at UTM is float64 in the test).
    as_json = client.post(route, json={"points": pts.ravel().tolist(),
                                       "mesh_vertices": verts.ravel().tolist(),
                                       "mesh_indices": tris.ravel().tolist()})
    framed = client.post(route, content=_frame({"points": pts.ravel().tolist()},
                                               verts - UTM, tris, UTM),
                         headers={"content-type": "application/octet-stream"})
    a, b = decode_streamed_json(as_json.content), decode_streamed_json(framed.content)
    assert a["success"] and b["success"], (a.get("error"), b.get("error"))
    # Distance raycasts every point, so the two transports agree to float32
    # rounding. ICP samples the mesh with Open3D's unseeded
    # sample_points_uniformly, so two identical calls already differ by a few
    # tenths of a percent; only a sampling-sized tolerance is meaningful there.
    rel = 1e-3 if route.endswith("/distance") else 0.05
    for key in ("rmse", "mean_distance", "fitness"):
        if key in a:
            assert b[key] == pytest.approx(a[key], rel=rel, abs=1e-5), key
    # ICP pre-aligns centroids, so its RMSE is blind to where the mesh started.
    # Where the snapped mesh LANDS is not: the mesh already lies on its cloud, so
    # both transports must leave it there. (Not the raw translation: at this
    # northing a 1e-3 rad rotation about the world origin is kilometers of
    # translation term while moving the mesh by a millimeter.) This is also the
    # local-frame fix in _do_c2m_icp: in world coordinates both came back
    # fitness 0 and moved the mesh 6-70 m.
    if "transformation_matrix" in a:
        for name, body in (("json", a), ("frame", b)):
            assert body["fitness"] > 0.9, name
            assert np.abs(_moved(verts, body) - verts).max() < 0.02, name


def _moved(verts, body):
    M = np.array(body["transformation_matrix"]).reshape(4, 4)
    return verts @ M[:3, :3].T + M[:3, 3]


def test_mesh_to_mesh_icp_recovers_a_shift_at_utm(client):
    """Same local-frame fix in _do_m2m_icp, for a caller sending world UTM
    coordinates as JSON (the app sends render-frame ones)."""
    verts, tris = _box_mesh(UTM, half=np.array([1.0, 0.6, 0.4]))
    shift = np.array([0.04, -0.03, 0.02])
    body = decode_streamed_json(client.post("/api/m2m/icp-register", json={
        "target_vertices": verts.ravel().tolist(), "target_indices": tris.ravel().tolist(),
        "source_vertices": (verts + shift).ravel().tolist(),
        "source_indices": tris.ravel().tolist()}).content)
    assert body["success"], body.get("error")
    assert np.abs(_moved(verts + shift, body) - verts).max() < 0.01


def test_inline_points_can_ride_the_frame(client):
    rng = np.random.default_rng(1)
    verts, tris = _box_mesh(np.zeros(3))
    pts = _cloud_on(verts, rng)
    framed = client.post("/api/c2m/distance",
                         content=_frame({}, verts, tris, (0, 0, 0), points=pts),
                         headers={"content-type": "application/octet-stream"})
    body = decode_streamed_json(framed.content)
    assert body["success"], body.get("error")
    assert body["point_count"] == len(pts)
    assert body["mean_distance"] < 0.02     # the points lie on the mesh


def test_a_bad_json_body_is_a_422(client):
    r = client.post("/api/c2m/distance", json={"mesh_indices": [0, 1, 2]})
    assert r.status_code == 422


def test_mesh_frames_decode_to_arrays_without_a_list_blowup():
    t = 600_000
    rng = np.random.default_rng(2)
    v = rng.uniform(-5, 5, t // 2 * 3).astype(np.float32)
    i = rng.integers(0, t // 2, t * 3).astype(np.uint32)
    frame = main._bin_frame_bytes({"max_iterations": 30}, [
        ("target_vertices", v, "f32"), ("target_indices", i, "u32"),
        ("source_vertices", v, "f32"), ("source_indices", i, "u32")])
    payload = 2 * (v.nbytes + i.nbytes)
    tracemalloc.start()
    req = main._m2m_request_from_frame(frame)
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    assert isinstance(req.target_vertices, np.ndarray)
    assert req.max_iterations == 30
    np.testing.assert_array_equal(req.source_indices, i)
    # float64 / int64 copies of the buffers (~2x the f32/u32 payload) plus the
    # parser's copies. As lists this was ~12x.
    assert peak < 5 * payload, f"{peak / payload:.1f}x the payload"
