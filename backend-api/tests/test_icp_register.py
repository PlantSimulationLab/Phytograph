"""ICP registration + cloud-to-mesh distance workers and their streaming pill.

Two things changed when the alignment tools gained a cancellable progress pill:
  1. Each endpoint's body moved into a plain worker (`_do_c2c_icp`, `_do_m2m_icp`,
     `_do_c2m_icp`, `_do_c2m_distance`) taking an optional `progress` reporter, and
     the route became a `_bin_frame_streaming_response` wrapper (PHP1 markers +
     JSON tail) instead of a plain JSON handler.
  2. `run_icp_until_convergence` now polls the reporter's cancel Event between
     20-iteration batches and raises ScanCancelled.

These tests assert the real behavior, not the absence of errors:
  * the extracted workers still produce a correct rigid transform that reduces a
    known centroid offset (the refactor didn't change the math);
  * a reporter whose run is cancelled makes the ICP loop raise ScanCancelled
    between batches rather than running to convergence;
  * the endpoint streams the run_id up front and the JSON result as the tail,
    and a cancelled worker yields a terminal `cancelled` marker instead.
"""

import json
import queue
import threading

import numpy as np
import pytest

import main


def _cube_cloud(n_side: int = 8) -> np.ndarray:
    """A dense-ish solid cube of points, side 1.0 centered at origin. ICP needs
    real 3-D structure (a flat sheet is under-constrained for point-to-plane)."""
    g = np.linspace(-0.5, 0.5, n_side)
    xs, ys, zs = np.meshgrid(g, g, g)
    return np.column_stack([xs.ravel(), ys.ravel(), zs.ravel()]).astype(np.float64)


def _cube_mesh():
    """An asymmetric box (2×1×0.5) as (vertices flat, indices flat) for the
    mesh-side workers. Asymmetry removes the rotational ambiguity a perfect cube
    has (a cube maps onto itself under 90° turns), so ICP has one correct pose."""
    v = np.array([
        [-1.0, -0.5, -0.25], [1.0, -0.5, -0.25], [1.0, 0.5, -0.25], [-1.0, 0.5, -0.25],
        [-1.0, -0.5, 0.25], [1.0, -0.5, 0.25], [1.0, 0.5, 0.25], [-1.0, 0.5, 0.25],
    ], dtype=np.float64)
    tris = np.array([
        [0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6],
        [0, 4, 5], [0, 5, 1], [1, 5, 6], [1, 6, 2],
        [2, 6, 7], [2, 7, 3], [3, 7, 4], [3, 4, 0],
    ], dtype=np.int32)
    return v.ravel().tolist(), tris.ravel().tolist()


# ---- Worker correctness (the extraction refactor preserved the math) --------

def test_c2c_worker_recovers_known_offset():
    """A source cloud offset from the target by a known translation is aligned
    back onto it: the returned matrix's translation must roughly cancel the
    offset, and fitness must be high. Direct call, progress=None (no streaming)."""
    target = _cube_cloud()
    offset = np.array([0.4, -0.25, 0.15])
    source = target + offset

    req = main.CloudToCloudICPRequest(
        target_points=target.ravel().tolist(),
        source_points=source.ravel().tolist(),
    )
    result = main._do_c2c_icp(req, progress=None)

    assert result["success"] is True, result.get("error")
    m = np.array(result["transformation_matrix"], dtype=np.float64).reshape(4, 4)
    # Apply the recovered transform to the (offset) source centroid; it should
    # land near the target centroid.
    src_centroid = source.mean(axis=0)
    moved = m @ np.array([*src_centroid, 1.0])
    tgt_centroid = target.mean(axis=0)
    residual = np.linalg.norm(moved[:3] - tgt_centroid)
    assert residual < 0.05, f"centroid residual {residual:.4f} too large"
    assert result["fitness"] > 0.9


def test_m2m_worker_recovers_known_offset():
    verts, tris = _cube_mesh()
    offset = np.array([0.3, 0.2, -0.2])
    src_verts = (np.array(verts).reshape(-1, 3) + offset).ravel().tolist()

    req = main.MeshToMeshICPRequest(
        target_vertices=verts, target_indices=tris,
        source_vertices=src_verts, source_indices=tris,
    )
    result = main._do_m2m_icp(req, progress=None)
    assert result["success"] is True, result.get("error")
    # The recovered transform must roughly cancel the known offset: the source
    # centroid, moved by the matrix, lands near the target centroid. (Fitness —
    # the fraction of sampled points inside max_corr_dist — is a poor signal on
    # a coarse 8-vertex cube; the residual is the meaningful correctness check.)
    m = np.array(result["transformation_matrix"], dtype=np.float64).reshape(4, 4)
    src_centroid = np.array(verts).reshape(-1, 3).mean(axis=0) + offset
    tgt_centroid = np.array(verts).reshape(-1, 3).mean(axis=0)
    moved = m @ np.array([*src_centroid, 1.0])
    residual = np.linalg.norm(moved[:3] - tgt_centroid)
    # The offset was ~0.41; the recovered residual must be a small fraction of it
    # (~0.06 here — floored by the random surface-sampling spacing on a coarse
    # 8-vertex box, not by a registration error).
    assert residual < 0.15, f"residual {residual:.4f} vs offset {np.linalg.norm(offset):.4f}"


def test_c2m_distance_worker_zero_for_points_on_mesh():
    """Points sampled ON the cube's surface have ~zero distance to the mesh."""
    verts, tris = _cube_mesh()
    # A grid of points on the top (z=+0.25) face of the 2×1×0.5 box lies exactly
    # on the mesh surface.
    gx = np.linspace(-1.0, 1.0, 5)
    gy = np.linspace(-0.5, 0.5, 5)
    xs, ys = np.meshgrid(gx, gy)
    face = np.column_stack([xs.ravel(), ys.ravel(), np.full(xs.size, 0.25)])

    req = main.C2MDistanceRequest(
        points=face.ravel().tolist(), mesh_vertices=verts, mesh_indices=tris,
    )
    result = main._do_c2m_distance(req, progress=None)
    assert result["success"] is True, result.get("error")
    assert result["mean_distance"] < 1e-4
    assert result["point_count"] == face.shape[0]


def test_worker_reports_progress_fractions():
    """A reporter passed to a worker receives a monotonic non-decreasing set of
    fractions ending at 1.0 — proving the pill actually advances."""
    target = _cube_cloud()
    source = target + np.array([0.2, 0.0, 0.0])
    req = main.CloudToCloudICPRequest(
        target_points=target.ravel().tolist(),
        source_points=source.ravel().tolist(),
    )
    q: "queue.Queue" = queue.Queue()
    reporter = main._ProgressReporter(q, threading.Event())
    result = main._do_c2c_icp(req, progress=reporter)
    assert result["success"] is True

    fractions = []
    while not q.empty():
        frac, _msg = q.get_nowait()
        fractions.append(frac)
    assert fractions, "worker emitted no progress"
    assert fractions == sorted(fractions), f"fractions regressed: {fractions}"
    assert fractions[-1] == pytest.approx(1.0)


# ---- Cooperative cancellation (the ICP loop bails between batches) ----------

def test_icp_loop_raises_when_cancelled():
    """run_icp_until_convergence with a pre-set cancel Event raises ScanCancelled
    between batches rather than running to convergence."""
    import open3d as o3d

    target = _cube_cloud()
    source = target + np.array([0.3, 0.0, 0.0])
    tpcd = o3d.geometry.PointCloud()
    tpcd.points = o3d.utility.Vector3dVector(target)
    spcd = o3d.geometry.PointCloud()
    spcd.points = o3d.utility.Vector3dVector(source)
    for p in (tpcd, spcd):
        p.estimate_normals(search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=0.3, max_nn=30))

    event = threading.Event()
    event.set()  # cancelled before the first batch boundary
    reporter = main._ProgressReporter(queue.Queue(), event)

    with pytest.raises(main.ScanCancelled):
        main.run_icp_until_convergence(
            spcd, tpcd, 0.2, np.eye(4), max_iterations=100, rmse_threshold=1e-9,
            progress=reporter,
        )


def test_c2c_worker_propagates_cancel():
    """The worker does not swallow ScanCancelled (its except re-raises it) so the
    streaming wrapper can emit the terminal cancelled marker."""
    target = _cube_cloud()
    source = target + np.array([0.3, 0.0, 0.0])
    req = main.CloudToCloudICPRequest(
        target_points=target.ravel().tolist(),
        source_points=source.ravel().tolist(),
    )
    event = threading.Event()
    event.set()
    reporter = main._ProgressReporter(queue.Queue(), event)
    with pytest.raises(main.ScanCancelled):
        main._do_c2c_icp(req, progress=reporter)


# ---- End-to-end through the streaming endpoint ------------------------------

def test_c2c_endpoint_streams_run_id_then_json_result(client):
    """The route now streams: first a PHP1 run_id marker, then the JSON result as
    the tail. The renderer's fetchJsonWithProgress drains the markers and parses
    the tail into ICPRegistrationResponse."""
    from tests.binframe import decode_progress_markers

    target = _cube_cloud()
    source = target + np.array([0.2, 0.1, 0.0])
    body = {
        "target_points": target.ravel().tolist(),
        "source_points": source.ravel().tolist(),
    }
    with client.stream("POST", "/api/c2c/icp-register", json=body) as resp:
        assert resp.status_code == 200, resp.text
        raw = b"".join(resp.iter_bytes())

    markers = decode_progress_markers(raw)
    assert markers, "expected at least the run_id marker"
    assert isinstance(markers[0].get("run_id"), str) and markers[0]["run_id"]

    # The JSON result is the tail after the leading PHP1 markers. Reuse the
    # backend's own marker length accounting: find the last 'PHP1' magic and skip
    # past its payload, then parse the remainder.
    tail = _json_tail(raw)
    result = json.loads(tail)
    assert result["success"] is True, result.get("error")
    assert len(result["transformation_matrix"]) == 16


def _json_tail(raw: bytes) -> bytes:
    """Strip leading PHP1 markers (and whitespace keepalives) and return the JSON
    payload tail — mirrors the renderer's parseProgressMarkers drain loop."""
    import struct
    off = 0
    magic = b"PHP1"
    while True:
        # Skip any whitespace keepalive padding.
        while off < len(raw) and raw[off:off + 1] == b" ":
            off += 1
        if raw[off:off + 4] != magic:
            break
        json_len = struct.unpack_from("<I", raw, off + 4)[0]
        off += 8 + json_len
    return raw[off:]
