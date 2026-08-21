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


def _seed_open3d(seed: int) -> None:
    """Pin Open3D's global RNG so mesh-surface sampling is reproducible.
    A no-op on builds without the seed API (the test then keeps its old,
    slightly flaky behaviour rather than erroring)."""
    try:
        import open3d as o3d
        o3d.utility.random.seed(seed)
    except Exception:
        pass


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
    # Seed Open3D's RNG: the m2m worker samples the mesh surface with
    # `sample_points_uniformly`, and on this deliberately coarse 8-vertex box it
    # draws only 80 points (10x the vertex count). An unseeded draw that clumps
    # leaves ICP a genuinely ambiguous correspondence, so this test failed ~30%
    # of runs independent of any production change. Seeding pins the sample so a
    # failure here means a real registration regression.
    _seed_open3d(0)
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


def test_c2m_worker_recovers_known_offset_from_a_sparse_cloud():
    """Cloud→mesh ICP pulls an offset mesh back onto a SPARSE target cloud.

    The sparse target is the point: the mesh-surface sample count is driven by
    the mesh's own complexity, not by `len(points)`. When it was tied to the
    cloud, a 60-point target sampled the mesh with only 60 points and ICP
    converged to a different pose on every run (residuals wandering ~20-190 mm
    on identical inputs) — the random draw, not the geometry, chose the
    correspondence. This is the c2m analogue of the c2c/m2m recovery tests,
    which the suite previously had no equivalent of.

    Deliberately NOT seeded: the whole contract is that the result no longer
    depends on the sampling draw, so a seed would hide a regression here.
    """
    # The same structured cylinder as tests/e2e/fixtures/tiny.xyz: 5 rings of 12
    # points, r=0.3, h=1.5. Regular rings (not a random draw) are what lets ball
    # pivoting mesh a 60-point cloud cleanly, so this exercises the real path.
    ring = np.arange(12) * (2 * np.pi / 12)
    cloud = np.array([
        [0.3 * np.cos(t), 0.3 * np.sin(t), z]
        for z in np.linspace(0.0, 1.5, 5)
        for t in ring
    ])

    # Mesh the cloud, then rigidly offset that mesh by a known 0.15 m along X.
    tri = main._do_open3d_triangulation(
        main.TriangulationRequest(method="ball_pivoting", points=cloud.tolist())
    )
    verts = np.asarray(tri["vertices"], dtype=np.float64).reshape(-1, 3)
    tris = np.asarray(tri["triangles"], dtype=np.int32).reshape(-1, 3)
    offset = np.array([0.15, 0.0, 0.0])

    result = main._do_c2m_icp(
        main.ICPRegistrationRequest(
            points=cloud.ravel().tolist(),
            mesh_vertices=(verts + offset).ravel().tolist(),
            mesh_indices=tris.ravel().tolist(),
        ),
        progress=None,
    )
    assert result["success"] is True, result.get("error")

    # Reproduce what the renderer does with the matrix: newPos = R*currentPos + t.
    m = np.array(result["transformation_matrix"], dtype=np.float64).reshape(4, 4)
    new_pos = m[:3, :3] @ offset + m[:3, 3]
    residual = float(np.linalg.norm(new_pos))
    # The 150 mm offset must be largely removed. Observed ~8-21 mm across runs;
    # 80 mm is decisively below the offset while leaving margin for the draw.
    assert residual < 0.08, f"residual {residual:.4f} m vs 0.15 m offset"


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


# --------------------------------------------------------------------------
# Correspondence window is scaled from point spacing, not cloud extent
# --------------------------------------------------------------------------

def test_correspondence_distance_tracks_spacing_not_extent():
    """Denser points must get a TIGHTER window, at unchanged extent.

    The old rule was `robust_diagonal * 0.05`, which ignores density entirely:
    two clouds filling the same box got the same window whether points sat 2 cm
    or 20 cm apart. On every real scan measured that resolved to ~100x the point
    spacing -- wide enough on a repetitive planting to pair a point with the
    wrong plant row.

    The fixture is scan-SHAPED (clustered plants over a wide plot) rather than a
    uniform cube. That matters: for uniformly filled volumes 20x the spacing
    always exceeds the extent cap, so a cube would measure the cap instead of
    the rule. Real scans are dense relative to their footprint -- measured on
    three orchards, the spacing term wins (0.22-0.41 m against caps of
    1.3-2.0 m).
    """
    def planting(per_plant, seed):
        rng = np.random.default_rng(seed)
        return np.vstack([
            np.array([i * 4.0, j * 4.0, 1.5]) + rng.normal(0, 0.5, size=(per_plant, 3))
            for i in range(7) for j in range(7)
        ])

    sparse, dense = planting(300, 5), planting(6000, 5)

    diag_sparse = main._robust_cloud_diagonal(sparse)
    diag_dense = main._robust_cloud_diagonal(dense)
    assert diag_sparse == pytest.approx(diag_dense, rel=0.1)

    w_sparse = main._auto_correspondence_distance(sparse, diag_sparse)
    w_dense = main._auto_correspondence_distance(dense, diag_dense)

    assert w_dense < w_sparse, (
        f"denser cloud got a window of {w_dense:.3f} m against the sparse "
        f"cloud's {w_sparse:.3f} m at the same extent -- the rule is still "
        "ignoring point density"
    )


def test_correspondence_distance_never_exceeds_the_old_extent_rule():
    """A sparse cloud must not get a window wider than the plot itself."""
    rng = np.random.default_rng(7)
    sparse = rng.uniform(0, 4, size=(200, 3))       # very few points, wide gaps
    diagonal = main._robust_cloud_diagonal(sparse)
    assert (main._auto_correspondence_distance(sparse, diagonal)
            <= diagonal * 0.05 + 1e-9)


def test_correspondence_distance_falls_back_when_spacing_is_unmeasurable():
    """Too few points to measure spacing => the previous rule, not a guess."""
    tiny = np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
    assert main._median_point_spacing(tiny) is None
    assert main._auto_correspondence_distance(tiny, 20.0) == pytest.approx(1.0)


# The row-hop failure itself is NOT reproduced here. A synthetic planting was
# tried and the fix made no difference to it -- the bug needs real scan
# characteristics (a ~100:1 near-to-far density gradient over a 150 m plot, with
# 5.2 m rows) that a generated fixture did not capture, and a test that passes
# with the fix reverted proves nothing. It is covered instead by
# `test_raster_correlation.py::test_second_orchard_is_not_regressed_by_peach_tuning`
# and the GrapeX benchmark, which run against real scans. The unit tests above
# pin the RULE (window follows spacing, capped by extent); the real-data tests
# pin the OUTCOME.
