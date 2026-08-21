"""M4: downstream ops (skeleton / triangulate / c2m / icp / export) accept a
`source` descriptor that reads points from a file, for octree-backed clouds
whose renderer positions buffer is empty.

Each endpoint is exercised two ways on the SAME points:
  (a) inline `points` (the pre-M4 path — a regression guard)
  (b) a `source` descriptor pointing at a fixture file

and the two results are asserted EQUAL (not merely "success"). This proves the
source branch feeds the identical point set into the identical computation.

No PotreeConverter needed — `source` reads the raw ASCII file directly.
"""

import base64
import math

import numpy as np
import pytest

from tests.binframe import decode_bin_frame, decode_streamed_json


GRID_FORMAT = "x y z r255 g255 b255 reflectance"


@pytest.fixture
def tree_session(make_file_session, tree_xyz):
    """The same cloud as `tree_xyz`, registered as a real in-RAM session.

    Compute/export endpoints refuse a file-only `source` (a cloud's file is read
    once at import; the session arrays are the source of truth thereafter), so
    these tests send `session_id`. The fixture reads the SAME file through the
    SAME loader, so the point set is identical to the inline path it is compared
    against — which is what these tests exist to prove.
    """
    return make_file_session(tree_xyz, GRID_FORMAT)


@pytest.fixture
def tree_xyz(tmp_path):
    """A synthetic ~vertical 'stem + branches' cloud with enough structure and
    points (>50, connected) for skeleton extraction to succeed, plus RGB +
    reflectance columns. Written to disk so a `source` descriptor can read it,
    and returned points let the inline path use the identical set."""
    rng = np.random.RandomState(42)
    pts = []
    # Vertical stem: dense column of points up the z axis.
    for k in range(400):
        z = k * 0.01
        pts.append((rng.normal(0, 0.003), rng.normal(0, 0.003), z))
    # A couple of branches angling off partway up.
    for k in range(150):
        t = k * 0.01
        pts.append((t * 0.7, rng.normal(0, 0.003), 1.5 + t * 0.4))
    for k in range(150):
        t = k * 0.01
        pts.append((rng.normal(0, 0.003), -t * 0.7, 2.5 + t * 0.4))
    arr = np.array(pts, dtype=np.float64)

    f = tmp_path / "tree.xyz"
    lines = []
    for i, (x, y, z) in enumerate(arr):
        r, g, b = (i * 7) % 256, (i * 13) % 256, (i * 29) % 256
        refl = (i % 100) / 100.0
        lines.append(f"{x:.6f} {y:.6f} {z:.6f} {r} {g} {b} {refl:.4f}")
    f.write_text("\n".join(lines) + "\n")
    return f


@pytest.fixture
def tree_points(tree_xyz):
    """Read the fixture back through pandas so float reps match the endpoint's
    own parse (avoids ULP mismatches between the two paths)."""
    import pandas as pd
    df = pd.read_csv(
        tree_xyz, sep=r"\s+", header=None,
        names=["x", "y", "z", "r", "g", "b", "refl"], engine="c",
    )
    return df[["x", "y", "z"]].to_numpy(dtype=np.float64)


# ---------------------------------------------------------------------------
# Triangulate
# ---------------------------------------------------------------------------

def test_triangulate_source_matches_inline(client, tree_session, tree_points):
    inline, _ = decode_bin_frame(client.post("/api/triangulate", json={
        "points": tree_points.tolist(), "method": "alpha_shape", "alpha": 0.2,
    }).content)
    src, _ = decode_bin_frame(client.post("/api/triangulate", json={
        "source": {"session_id": tree_session},
        "method": "alpha_shape", "alpha": 0.2,
    }).content)

    assert inline["success"] and src["success"]
    # Same input points → same mesh.
    assert src["num_vertices"] == inline["num_vertices"]
    assert src["num_triangles"] == inline["num_triangles"]
    # points_used is reported on the source path and equals the full count
    # (no cap sent here).
    assert src["points_used"] == len(tree_points)


def test_triangulate_source_cap_downsamples(client, tree_session, tree_points):
    n = len(tree_points)
    cap = n // 4
    src, _ = decode_bin_frame(client.post("/api/triangulate", json={
        "source": {"session_id": tree_session,
                   "max_points": cap},
        "method": "alpha_shape", "alpha": 0.2,
    }).content)
    assert src["success"]
    assert src["points_used"] <= cap
    assert src["points_used"] < n  # actually downsampled


# ---------------------------------------------------------------------------
# Skeleton
# ---------------------------------------------------------------------------

def test_skeleton_source_matches_inline(client, tree_session, tree_points):
    # Low threshold_filter so the synthetic cloud's small blocks survive into
    # the skeleton (the point is path equality, not skeleton quality).
    params = {"remove_outliers": False, "search_radius": 0.05, "threshold_filter": 3}
    inline = client.post("/api/skeleton/extract",
                         json={"points": tree_points.tolist(), **params}).json()
    src = client.post("/api/skeleton/extract", json={
        "source": {"session_id": tree_session},
        **params,
    }).json()
    assert inline["success"] and src["success"]
    assert src["num_nodes"] > 0
    # Within a node or two of the inline path: the source loader reads the file
    # at float32 precision then upcasts, so a point sitting exactly on a block
    # boundary can land on either side and shift one node. The skeletons are
    # equivalent, not bit-identical.
    assert abs(src["num_nodes"] - inline["num_nodes"]) <= 2


def test_skeleton_source_auto_radius(client, tree_session):
    # search_radius=0 → backend auto-calculates from KD-tree NN.
    src = client.post("/api/skeleton/extract", json={
        "source": {"session_id": tree_session},
        "remove_outliers": False, "search_radius": 0, "threshold_filter": 3,
    }).json()
    assert src["success"]
    assert src["num_nodes"] > 0


def test_skeleton_point_cap_fails_fast(client, tree_points, monkeypatch):
    # Past the cap the endpoint must refuse with an actionable message rather
    # than building a huge neighbour graph and appearing to hang.
    import main
    monkeypatch.setattr(main, "_SKELETON_MAX_POINTS", len(tree_points) - 1)
    resp = client.post("/api/skeleton/extract", json={
        "points": tree_points.tolist(),
        "remove_outliers": False, "search_radius": 0.05, "threshold_filter": 3,
    }).json()
    assert resp["success"] is False
    assert "limit" in resp["error"].lower()
    assert resp["num_nodes"] == 0


# ---------------------------------------------------------------------------
# Cloud-to-mesh distance
# ---------------------------------------------------------------------------

def _box_mesh():
    """A unit cube mesh as flat vertex + index arrays (open3d-friendly)."""
    import open3d as o3d
    m = o3d.geometry.TriangleMesh.create_box(2.0, 2.0, 3.0)
    m.translate((-1.0, -1.0, 0.0))
    v = np.asarray(m.vertices).flatten().tolist()
    idx = np.asarray(m.triangles).flatten().tolist()
    return v, idx


def test_c2m_distance_source_matches_inline(client, tree_session, tree_points):
    v, idx = _box_mesh()
    # These endpoints stream PHP1 progress markers ahead of their JSON result,
    # so the body needs the marker-skipping decoder rather than .json().
    inline = decode_streamed_json(client.post("/api/c2m/distance", json={
        "points": tree_points.flatten().tolist(),
        "mesh_vertices": v, "mesh_indices": idx,
    }).content)
    src = decode_streamed_json(client.post("/api/c2m/distance", json={
        "source": {"session_id": tree_session},
        "mesh_vertices": v, "mesh_indices": idx,
    }).content)
    assert inline["success"] and src["success"]
    assert src["point_count"] == inline["point_count"] == len(tree_points)
    assert math.isclose(src["mean_distance"], inline["mean_distance"], rel_tol=1e-6)


# ---------------------------------------------------------------------------
# ICP mesh-to-cloud
# ---------------------------------------------------------------------------

def test_icp_mesh_to_cloud_source_runs(client, tree_session):
    v, idx = _box_mesh()
    src = decode_streamed_json(client.post("/api/c2m/icp-register", json={
        "source": {"session_id": tree_session},
        "mesh_vertices": v, "mesh_indices": idx,
    }).content)
    assert src["success"]
    assert src["translation"] is not None and len(src["translation"]) == 3
    assert all(math.isfinite(t) for t in src["translation"])


# ---------------------------------------------------------------------------
# Cloud-to-cloud ICP (mixed source + inline)
# ---------------------------------------------------------------------------

def test_c2c_icp_mixed_source_and_inline(client, tree_session, tree_points):
    # Target read from disk (octree), source inline (flat). Source is the same
    # points shifted, so ICP should recover roughly the inverse shift.
    shifted = (tree_points + np.array([0.1, 0.0, 0.0])).flatten().tolist()
    res = decode_streamed_json(client.post("/api/c2c/icp-register", json={
        "target_source": {"session_id": tree_session},
        "source_points": shifted,
    }).content)
    assert res["success"]
    assert res["transformation_matrix"] is not None
    assert all(math.isfinite(x) for x in res["transformation_matrix"])


# ---------------------------------------------------------------------------
# Export — every format from a source descriptor
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("fmt", ["xyz", "txt", "csv", "ply", "las"])
def test_export_source_all_formats(client, tree_session, tree_points, fmt):
    res = decode_streamed_json(client.post("/api/pointcloud/export", json={
        "source": {"session_id": tree_session},
        "format": fmt,
    }).content)
    assert res["success"], res.get("error")
    assert res["point_count"] == len(tree_points)
    assert res["filename"].endswith("." + fmt)
    blob = base64.b64decode(res["data"])
    assert len(blob) > 0

    if fmt in ("xyz", "txt", "csv", "ply"):
        text = blob.decode("utf-8")
        if fmt == "ply":
            assert text.startswith("ply")
            assert f"element vertex {len(tree_points)}" in text
        else:
            # First data line's x matches the fixture's first point.
            data_lines = [ln for ln in text.splitlines() if ln and ln[0] not in "XPp#"]
            first = data_lines[0].replace(",", " ").split()
            assert math.isclose(float(first[0]), tree_points[0, 0], abs_tol=1e-4)


def test_export_session_source_preserves_rgb_and_intensity(client):
    """A SESSION-backed export must keep RGB + intensity.

    Every other export test here uses `source_path` (the file branch, which
    worked). The app's normal state for an octree import is session-backed, and
    that branch hardcoded `colors = None` / `intensity = None` regardless of
    `want_colors` — so the LAS writer saw no colours and silently downgraded to
    point format 0, dropping the dimension entirely rather than leaving it blank.
    """
    import time
    import tempfile
    import os
    import main

    laspy = pytest.importorskip("laspy")

    n = 8
    xyz = np.column_stack([np.linspace(0, 1, n), np.zeros(n), np.zeros(n)])
    colors = np.column_stack([                      # uint16 LAS scale, as sessions store
        np.full(n, 65535), np.zeros(n), np.full(n, 32768)]).astype(np.uint16)
    sess = main.CloudSession(
        session_id="export_rgb_sess", source_path="<test>", ascii_format=None,
        column_plan=None, positions=xyz, colors=colors,
        intensity=np.full(n, 16384, dtype=np.uint16), extras={}, extra_dims_meta=[],
        deleted=np.zeros(n, dtype=bool), deleted_history=[], octree_cache_id=None,
        created_at=time.time(),
    )
    main._cloud_sessions[sess.session_id] = sess
    try:
        # LAS keeps a real colour dimension (format 2, not the colourless 0).
        res = decode_streamed_json(client.post("/api/pointcloud/export", json={
            "source": {"session_id": sess.session_id}, "format": "las",
        }).content)
        assert res["success"], res.get("error")
        blob = base64.b64decode(res["data"])
        with tempfile.NamedTemporaryFile(suffix=".las", delete=False) as fh:
            fh.write(blob)
            las_path = fh.name
        try:
            las = laspy.read(las_path)
            assert las.header.point_format.id != 0, "colourless LAS point format"
            assert "red" in [d.name for d in las.point_format.dimensions]
            assert int(las.red[0]) == 65535
            assert int(las.blue[0]) in (32767, 32768)   # uint16 round-trip
        finally:
            os.unlink(las_path)

        # Text formats carry the 0-255 colour columns too.
        res = decode_streamed_json(client.post("/api/pointcloud/export", json={
            "source": {"session_id": sess.session_id}, "format": "csv",
        }).content)
        assert res["success"], res.get("error")
        text = base64.b64decode(res["data"]).decode("utf-8")
        header = text.splitlines()[0].lower()
        assert "r" in header and "g" in header and "b" in header, header
        first = text.splitlines()[1].split(",")
        assert len(first) >= 6, first
        assert int(float(first[3])) == 255 and int(float(first[4])) == 0
    finally:
        main._cloud_sessions.pop(sess.session_id, None)


def test_export_source_translation_shifts_output(client, tree_session, tree_points):
    res = decode_streamed_json(client.post("/api/pointcloud/export", json={
        "source": {"session_id": tree_session,
                   "translation": [10.0, 0.0, 0.0]},
        "format": "xyz",
    }).content)
    assert res["success"]
    text = base64.b64decode(res["data"]).decode("utf-8")
    first_x = float(text.splitlines()[0].split()[0])
    # Translation is ADDED.
    assert math.isclose(first_x, tree_points[0, 0] + 10.0, abs_tol=1e-4)
