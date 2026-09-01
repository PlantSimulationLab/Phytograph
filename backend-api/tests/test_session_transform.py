"""Tests for POST /api/cloud/session/{id}/transform — the rigid-transform op that
moves an octree-backed cloud (cloud-to-cloud ICP's SOURCE) by baking a 4x4
world-frame matrix into the session and rebuilding the octree.

The matrix acts in WORLD coordinates. The session stores points with world_shift
SUBTRACTED, so the endpoint must conjugate by the shift:
    stored_new = R·(stored + shift) + t − shift
The rebuilt octree's tight_bounds (world coords) must therefore span
M · original_world — that's the core assertion.

These tests drive a REAL uvicorn server subprocess (the way the app actually
runs), not Starlette's TestClient: on macOS, spawning PotreeConverter from
TestClient's anyio worker thread intermittently SIGSEGVs the child — a harness
quirk, not app behavior. A real server has no such issue. Needs a real
PotreeConverter (the transform rebuilds the octree).
"""

import socket
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import pytest
import requests

import main
from tests.binframe import _create_session_direct, decode_streamed_json


def _converter_available() -> bool:
    try:
        main._resolve_potree_converter_path()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(
    not _converter_available(),
    reason="PotreeConverter binary not found; build it via npm run build:potree-converter",
)

GRID_FORMAT = "x y z r255 g255 b255 reflectance"
BACKEND_DIR = Path(__file__).resolve().parent.parent


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture
def server(tmp_path):
    """A real uvicorn server bound to a free port, with an isolated octree cache.
    Yields the base URL. Torn down on exit."""
    port = _free_port()
    env = {
        **__import__("os").environ,
        "PHYTOGRAPH_OCTREE_CACHE_ROOT": str(tmp_path / "octree_cache"),
    }
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "main:app", "--port", str(port), "--log-level", "warning"],
        cwd=str(BACKEND_DIR), env=env,
    )
    base = f"http://127.0.0.1:{port}"
    try:
        deadline = time.time() + 45
        while time.time() < deadline:
            try:
                if requests.get(f"{base}/version", timeout=1).status_code == 200:
                    break
            except requests.RequestException:
                time.sleep(0.3)
        else:
            raise RuntimeError("backend did not become ready")
        yield base
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


@pytest.fixture
def grid_xyz(tmp_path) -> Path:
    """10×10×10 grid over [0, 0.9]^3 (1000 points) with the columns GRID_FORMAT
    expects, so ascii import parses cleanly."""
    f = tmp_path / "grid.xyz"
    lines = []
    for i in range(10):
        for j in range(10):
            for k in range(10):
                r, g, b = (i * 17) % 256, (j * 23) % 256, (k * 31) % 256
                refl = ((i + j + k) * 0.01) % 1.0
                lines.append(f"{i*0.1:.4f} {j*0.1:.4f} {k*0.1:.4f} {r} {g} {b} {refl:.4f}")
    f.write_text("\n".join(lines) + "\n")
    return f


def _matrix(R: np.ndarray, t: np.ndarray) -> list:
    """Row-major flat 4x4 from a 3x3 rotation and 3-vector translation."""
    M = np.eye(4)
    M[:3, :3] = R
    M[:3, 3] = t
    return M.reshape(-1).tolist()


def _rot_z(deg: float) -> np.ndarray:
    a = np.deg2rad(deg)
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])


def _rot_x(deg: float) -> np.ndarray:
    a = np.deg2rad(deg)
    c, s = np.cos(a), np.sin(a)
    return np.array([[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]])


def _rot_y(deg: float) -> np.ndarray:
    a = np.deg2rad(deg)
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])


def _euler_xyz(rx: float, ry: float, rz: float) -> np.ndarray:
    """Composed rotation about world X then Y then Z (degrees). This is the exact
    convention the frontend Transformation tool emits: it builds a THREE.Euler in
    'XYZ' order and applies it as a world-frame rotation, i.e. R = Rz·Ry·Rx."""
    return _rot_z(rz) @ _rot_y(ry) @ _rot_x(rx)


def _pivot_matrix(R: np.ndarray, pivot: np.ndarray, t: np.ndarray) -> list:
    """Row-major flat 4x4 for 'rotate about world pivot P, then translate by t':
        world_new = R·(world − P) + P + t
    Expanded to the endpoint's `world_new = R·world + t_eff` form, the effective
    translation folded into the last column is  t_eff = P − R·P + t. This is the
    matrix the renderer's bakeCloudTransform must POST; these tests pin it so a
    convention drift on either side fails here first."""
    t_eff = pivot - R @ pivot + t
    return _matrix(R, t_eff)


def _create(base: str, grid_xyz: Path, world_shift=None) -> tuple[str, dict]:
    body = {"source_path": str(grid_xyz), "ascii_format": GRID_FORMAT}
    if world_shift is not None:
        body["world_shift"] = list(world_shift)
    r = requests.post(f"{base}/api/cloud/session/create", json=body, timeout=60)
    assert r.status_code == 200, r.text
    created = decode_streamed_json(r.content)
    return created["session_id"], created


def _transform(base: str, sid: str, matrix: list) -> requests.Response:
    return requests.post(f"{base}/api/cloud/session/{sid}/transform", json={"matrix": matrix}, timeout=120)


# The octree's world-frame extent. The grid spans [0, 0.9]^3, so the rigid image
# of that box's corners bounds the transformed cloud. For an axis-aligned box under
# a rotation the min/max corner mapping is not trivial, so tests compare tight_bounds
# against the transformed corner cloud.
def _grid_corners() -> np.ndarray:
    lo, hi = 0.0, 0.9
    return np.array([[x, y, z] for x in (lo, hi) for y in (lo, hi) for z in (lo, hi)], dtype=np.float64)


def _expected_bounds(corners_world: np.ndarray, R: np.ndarray, t: np.ndarray):
    moved = corners_world @ R.T + t
    return moved.min(axis=0), moved.max(axis=0)


def test_transform_translation_shifts_octree_bounds(server, grid_xyz):
    sid, created = _create(server, grid_xyz)
    cache0 = created["cache_id"]

    t = np.array([1.5, -2.0, 0.25])
    r = _transform(server, sid, _matrix(np.eye(3), t))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["point_count"] == 1000
    assert body["cache_id"] and body["cache_id"] != cache0  # octree rebuilt

    tb = body["tight_bounds"]
    exp_min, exp_max = _expected_bounds(_grid_corners(), np.eye(3), t)
    np.testing.assert_allclose(tb["min"], exp_min, atol=1e-3)
    np.testing.assert_allclose(tb["max"], exp_max, atol=1e-3)


def test_transform_rotation_rotates_octree_bounds(server, grid_xyz):
    sid, _ = _create(server, grid_xyz)
    R = _rot_z(90.0)
    r = _transform(server, sid, _matrix(R, np.zeros(3)))
    assert r.status_code == 200, r.text
    tb = r.json()["tight_bounds"]
    exp_min, exp_max = _expected_bounds(_grid_corners(), R, np.zeros(3))
    np.testing.assert_allclose(tb["min"], exp_min, atol=1e-3)
    np.testing.assert_allclose(tb["max"], exp_max, atol=1e-3)


def test_transform_rotation_about_pivot_bounds(server, grid_xyz):
    """Rotate the grid about a NON-origin pivot (its own center 0.45^3) and assert
    the octree bounds match rotating the corners about that pivot — not about the
    world origin. This is the exact matrix the Transformation tool sends when a
    scene origin (or the cloud's bbox center) is the rotation pivot."""
    sid, _ = _create(server, grid_xyz)
    R = _rot_z(90.0)
    pivot = np.array([0.45, 0.45, 0.45])
    r = _transform(server, sid, _pivot_matrix(R, pivot, np.zeros(3)))
    assert r.status_code == 200, r.text
    tb = r.json()["tight_bounds"]
    # Corners rotated about the pivot: world_new = R·(world − P) + P.
    moved = (_grid_corners() - pivot) @ R.T + pivot
    np.testing.assert_allclose(tb["min"], moved.min(axis=0), atol=1e-3)
    np.testing.assert_allclose(tb["max"], moved.max(axis=0), atol=1e-3)


def test_transform_euler_xyz_about_pivot_readback(tmp_path, monkeypatch):
    """Full rigid transform matching the renderer's contract end-to-end: a combined
    X/Y/Z Euler rotation about a non-origin pivot plus a translation. Asserts the
    world-frame read-back equals R·(world − P) + P + t, pinning both the XYZ Euler
    order (R = Rz·Ry·Rx) and the pivot-conjugation the frontend bake composes.
    In-process so we can read the session back (the rebuild runs in the main
    thread — stable, unlike TestClient's worker thread on macOS)."""
    import asyncio

    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "cache"))
    grid = tmp_path / "grid.xyz"
    grid.write_text("\n".join(
        f"{i*0.1:.4f} {j*0.1:.4f} {k*0.1:.4f} 10 20 30 0.5"
        for i in range(10) for j in range(10) for k in range(10)
    ) + "\n")

    create_req = main.CloudSessionCreateRequest(source_path=str(grid), ascii_format=GRID_FORMAT)
    sid = asyncio.new_event_loop().run_until_complete(
        _create_session_direct(create_req))["session_id"]

    src = main.PointSource(source_path="", session_id=sid)
    before = main._read_points_from_source(src)[0].copy()  # world frame

    R = _euler_xyz(30.0, -20.0, 45.0)
    pivot = np.array([0.45, 0.45, 0.45])
    t = np.array([2.0, -1.0, 0.5])
    req = main.SessionTransformRequest(matrix=_pivot_matrix(R, pivot, t))
    main.session_transform(sid, req)

    after = main._read_points_from_source(src)[0]  # world frame
    expected = (before - pivot) @ R.T + pivot + t
    np.testing.assert_allclose(after, expected, atol=1e-6)


def test_transform_conjugates_world_shift(tmp_path, monkeypatch):
    """Highest-risk case: with a world_shift set, the transform must apply in WORLD
    frame — proving the conjugation stored_new = R·(stored+shift)+t−shift. The
    octree's tight_bounds are in STORED frame (shift not re-added), so this asserts
    on the WORLD-frame read-back via _read_points_from_source, which must equal
    M · original_world and leave world_shift unchanged. In-process (no HTTP) so we
    can read the session back; the real rebuild runs in the stable main thread."""
    import asyncio

    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "cache"))
    grid = tmp_path / "grid.xyz"
    grid.write_text("\n".join(
        f"{i*0.1:.4f} {j*0.1:.4f} {k*0.1:.4f} 10 20 30 0.5"
        for i in range(10) for j in range(10) for k in range(10)
    ) + "\n")

    shift = np.array([1000.0, -500.0, 30.0])
    create_req = main.CloudSessionCreateRequest(
        source_path=str(grid), ascii_format=GRID_FORMAT, world_shift=shift.tolist())
    sid = asyncio.new_event_loop().run_until_complete(_create_session_direct(create_req))["session_id"]

    src = main.PointSource(source_path="", session_id=sid)
    before = main._read_points_from_source(src)[0].copy()  # world frame (shift re-added)

    R = _rot_z(45.0)
    t = np.array([2.0, 3.0, -1.0])
    req = main.SessionTransformRequest(matrix=_matrix(R, t))
    main.session_transform(sid, req)

    after = main._read_points_from_source(src)[0]  # world frame
    np.testing.assert_allclose(after, before @ R.T + t, atol=1e-6)
    # world_shift must be preserved (points re-stored in the same shifted frame).
    np.testing.assert_allclose(main._cloud_sessions[sid].world_shift, shift, atol=0)


def test_transform_bad_matrix_length_is_400(server, grid_xyz):
    sid, _ = _create(server, grid_xyz)
    r = _transform(server, sid, [1.0, 0.0, 0.0])
    assert r.status_code == 400
    assert "16" in r.json()["detail"]


def test_transform_unknown_session_is_404(server):
    r = _transform(server, "does-not-exist", _matrix(np.eye(3), np.zeros(3)))
    assert r.status_code == 404


def test_transform_moves_backfilled_misses_and_flags_stale(tmp_path, monkeypatch):
    """A moved cloud's separate miss buffer + miss-octree origin move with it, and
    the buffer is flagged stale (its LAD beam directions are now pre-move).

    Seeding/inspecting the miss buffer needs in-process access to the session, so
    this drives the endpoint coroutine directly (no HTTP, no TestClient) — the
    real octree rebuild runs in the MAIN thread, which is stable (only
    TestClient's worker thread triggers the macOS converter flake). No mocks."""
    import asyncio

    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "cache"))
    grid = tmp_path / "grid.xyz"
    grid.write_text("\n".join(
        f"{i*0.1:.4f} {j*0.1:.4f} {k*0.1:.4f} 10 20 30 0.5"
        for i in range(10) for j in range(10) for k in range(10)
    ) + "\n")

    create_req = main.CloudSessionCreateRequest(source_path=str(grid), ascii_format=GRID_FORMAT)
    created = asyncio.new_event_loop().run_until_complete(_create_session_direct(create_req))
    sid = created["session_id"]
    sess = main._cloud_sessions[sid]

    miss_pos = np.array([[5.0, 5.0, 5.0], [6.0, 4.0, 5.0]], dtype=np.float64)
    origins = np.zeros((2, 3), dtype=np.float64)
    sess.backfilled_misses = {"positions": miss_pos.copy(), "origins": origins.copy(),
                              "directions": np.zeros((2, 3), dtype=np.float32)}
    sess.miss_octree_origin = [0.0, 0.0, 0.0]
    sess.miss_octree_cache_id = None
    sess.backfilled_misses_stale = False

    t = np.array([10.0, 0.0, 0.0])
    req = main.SessionTransformRequest(matrix=_matrix(np.eye(3), t))
    main.session_transform(sid, req)

    sess = main._cloud_sessions[sid]
    np.testing.assert_allclose(sess.backfilled_misses["positions"], miss_pos + t, atol=1e-6)
    np.testing.assert_allclose(sess.backfilled_misses["origins"], origins + t, atol=1e-6)
    np.testing.assert_allclose(sess.miss_octree_origin, np.array([10.0, 0.0, 0.0]), atol=1e-6)
    assert sess.backfilled_misses_stale is True


# ---------------------------------------------------------------------------
# In-place octree fast path (pure translation)
#
# A rigid transform doesn't invalidate an octree, and for a pure TRANSLATION the
# node structure is provably unchanged — so the endpoint rewrites the built
# octree's coordinates (~0.8 s on 5 M points) instead of reconverting (~39 s).
# These pin the two halves that can silently rot: that the fast path is actually
# TAKEN (a regression would still be correct, just slow again — invisible without
# an explicit assertion), and that what it produces matches a full rebuild.
# ---------------------------------------------------------------------------

def _grid_session(tmp_path, monkeypatch, shift=None):
    """A real octree-backed session, created in-process."""
    import asyncio

    tmp_path.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "cache"))
    grid = tmp_path / "grid.xyz"
    grid.write_text("\n".join(
        f"{i*0.1:.4f} {j*0.1:.4f} {k*0.1:.4f} 10 20 30 0.5"
        for i in range(10) for j in range(10) for k in range(10)
    ) + "\n")
    req = main.CloudSessionCreateRequest(
        source_path=str(grid), ascii_format=GRID_FORMAT,
        world_shift=(list(shift) if shift is not None else None))
    created = asyncio.new_event_loop().run_until_complete(_create_session_direct(req))
    return created["session_id"]


def test_pure_translation_uses_the_in_place_octree_path(tmp_path, monkeypatch):
    """The fast path must be TAKEN, not merely available. Asserted by failing the
    converter: if the endpoint still reconverts, this raises."""
    sid = _grid_session(tmp_path, monkeypatch)

    def _boom(*a, **k):
        raise AssertionError("PotreeConverter ran for a pure translation")

    monkeypatch.setattr(main, "_run_potree_converter", _boom)
    res = main.session_transform(
        sid, main.SessionTransformRequest(matrix=_matrix(np.eye(3), np.array([5.0, -3.0, 2.0]))))
    assert res["cache_id"]


def test_rotation_still_falls_back_to_a_full_rebuild(tmp_path, monkeypatch):
    """The complement: rotation must NOT take the in-place path, because node
    membership is octant containment in an axis-aligned cube and a rotated cloud
    re-buckets. Guards against someone widening the classifier."""
    sid = _grid_session(tmp_path, monkeypatch)

    calls = []
    real = main._run_potree_converter
    monkeypatch.setattr(main, "_run_potree_converter",
                        lambda *a, **k: (calls.append(1), real(*a, **k))[1])
    main.session_transform(
        sid, main.SessionTransformRequest(matrix=_matrix(_rot_z(30.0), np.array([1.0, 0.0, 0.0]))))
    assert calls, "rotation must fall back to PotreeConverter"


def test_in_place_translation_matches_a_full_rebuild(tmp_path, monkeypatch):
    """Equivalence: the fast path and the converter must agree on the octree's
    world-frame extent, to within the format's 1 mm quantisation."""
    import octree_transform

    delta = np.array([12.0, -4.0, 3.0])

    fast_id = _grid_session(tmp_path / "fast", monkeypatch)
    fast = main.session_transform(
        fast_id, main.SessionTransformRequest(matrix=_matrix(np.eye(3), delta)))

    # Same move, forced down the converter path.
    slow_id = _grid_session(tmp_path / "slow", monkeypatch)
    monkeypatch.setattr(octree_transform, "classify_matrix",
                        lambda m: (False, np.zeros(3)))
    slow = main.session_transform(
        slow_id, main.SessionTransformRequest(matrix=_matrix(np.eye(3), delta)))

    for key in ("min", "max"):
        np.testing.assert_allclose(
            np.asarray(fast["tight_bounds"][key]),
            np.asarray(slow["tight_bounds"][key]), atol=2e-3)


def test_in_place_translation_moves_the_octree_bounds(tmp_path, monkeypatch):
    """The rebuilt octree must describe the MOVED cloud — a stale bounding box
    would frame the camera on empty space."""
    sid = _grid_session(tmp_path, monkeypatch)
    before = main._read_octree_metadata(
        main._octree_cache_root() / main._cloud_sessions[sid].octree_cache_id)

    delta = np.array([100.0, 50.0, 7.0])
    after = main.session_transform(
        sid, main.SessionTransformRequest(matrix=_matrix(np.eye(3), delta)))

    for key in ("min", "max"):
        np.testing.assert_allclose(
            np.asarray(after["tight_bounds"][key]),
            np.asarray(before["tight_bounds"][key]) + delta, atol=2e-3)


def test_in_place_translation_conjugates_world_shift(tmp_path, monkeypatch):
    """With a world_shift set, the fast path must still land the WORLD-frame
    points at M·world. For a pure translation the conjugation collapses to +t,
    and this pins that it really does."""
    shift = np.array([1000.0, -500.0, 30.0])
    sid = _grid_session(tmp_path, monkeypatch, shift=shift)

    src = main.PointSource(source_path="", session_id=sid)
    before = main._read_points_from_source(src)[0].copy()

    delta = np.array([2.0, 3.0, -1.0])
    main.session_transform(sid, main.SessionTransformRequest(matrix=_matrix(np.eye(3), delta)))

    after = main._read_points_from_source(src)[0]
    np.testing.assert_allclose(after, before + delta, atol=1e-6)
    np.testing.assert_allclose(main._cloud_sessions[sid].world_shift, shift, atol=0)


def test_pending_deletions_force_a_full_rebuild(tmp_path, monkeypatch):
    """A session with UNBAKED deletions has octree_cache_id = None ("stale"), so
    there is no valid octree to rewrite — the transform must reconvert from the
    survivors instead of resurrecting the pre-delete octree.

    This is the fast path's most dangerous failure mode: reusing a stale octree
    would move the deleted points along with the cloud and silently bring them
    back on screen.
    """
    sid = _grid_session(tmp_path, monkeypatch)
    sess = main._cloud_sessions[sid]

    # Erase a slab, the way delete_cloud_region does (mask set, octree stale).
    sess.deleted[sess.positions[:, 0] > 0.5] = True
    sess.deleted_history.append(sess.deleted.copy())
    sess.octree_cache_id = None
    survivors = int((~sess.deleted).sum())
    assert 0 < survivors < len(sess.positions)

    res = main.session_transform(
        sid, main.SessionTransformRequest(matrix=_matrix(np.eye(3), np.array([5.0, 0.0, 0.0]))))

    # The rebuilt octree describes the SURVIVORS only.
    assert res["point_count"] == survivors
    assert res["point_count"] < len(sess.positions)


def test_miss_octree_also_takes_the_in_place_path(tmp_path, monkeypatch):
    """The projected-miss shell is a second derived octree of the same geometry.
    If only the hits octree took the fast path, any scan carrying sky/miss points
    would still pay a full reconvert and the saving would vanish exactly where
    clouds are largest.

    Asserted the same way as the hits path: fail the converter, and require the
    miss octree to still come back with a fresh id.
    """
    sid = _grid_session(tmp_path, monkeypatch)
    sess = main._cloud_sessions[sid]

    # Give the session a real projected-miss octree to move.
    sess.backfilled_misses = {
        "positions": np.array([[5.0, 5.0, 5.0], [6.0, 4.0, 5.0]], dtype=np.float64),
        "origins": np.zeros((2, 3), dtype=np.float64),
        "directions": np.zeros((2, 3), dtype=np.float32),
    }
    sess.miss_octree_origin = [0.0, 0.0, 0.0]
    sess.miss_octree_cache_id = main._build_miss_octree(sess, sess.miss_octree_origin)
    assert sess.miss_octree_cache_id, "fixture needs a real miss octree to rewrite"
    before_id = sess.miss_octree_cache_id

    def _boom(*a, **k):
        raise AssertionError("PotreeConverter ran for a pure translation")

    monkeypatch.setattr(main, "_run_potree_converter", _boom)
    res = main.session_transform(
        sid, main.SessionTransformRequest(matrix=_matrix(np.eye(3), np.array([10.0, 0.0, 0.0]))))

    assert res["miss_octree_cache_id"]
    assert res["miss_octree_cache_id"] != before_id


# ---------------------------------------------------------------------------
# Deferred octree refresh (octree_mode="pose")
#
# A rotation cannot reuse the octree's nodes, so bringing the DISPLAY cache back
# in line costs a full PotreeConverter reindex — ~83 s on a 10 M-point scan. The
# GEOMETRY, which is all any compute path reads (`_read_points_from_source` ->
# sess.positions), moves in well under a second.
#
# So "auto" splits them: move the geometry now, leave the octree, and report
# `octree_posed` so the renderer poses it instead. These pin that the split is
# real (geometry moved, octree untouched) and — the dangerous half — that every
# path which later rebuilds the octree clears the flag, because a stale flag
# left set makes the renderer double-apply the transform.
# ---------------------------------------------------------------------------

def _rot_matrix(deg: float = 30.0) -> list:
    return _matrix(_rot_z(deg), np.array([5.0, 2.0, 1.0]))


def test_pose_mode_keeps_the_octree_but_still_moves_the_geometry(tmp_path, monkeypatch):
    """The core of the feature: positions move, the octree does not."""
    sid = _grid_session(tmp_path, monkeypatch)
    sess = main._cloud_sessions[sid]
    before_id = sess.octree_cache_id
    before = sess.positions.copy()

    M = np.asarray(_rot_matrix(), dtype=np.float64).reshape(4, 4)

    def _boom(*a, **k):
        raise AssertionError("PotreeConverter ran for a deferred transform")

    monkeypatch.setattr(main, "_run_potree_converter", _boom)
    res = main.session_transform(
        sid, main.SessionTransformRequest(matrix=_rot_matrix(), octree_mode="pose"))

    assert res["octree_posed"] is True
    assert res["cache_id"] == before_id, "the octree must NOT be rebuilt"
    # Asserted against an independently computed transform, not the endpoint's
    # own arithmetic.
    np.testing.assert_allclose(sess.positions, before @ M[:3, :3].T + M[:3, 3], atol=1e-9)
    assert sess.octree_pose is not None


def test_pose_mode_skips_the_rewrite_for_a_translation_too(tmp_path, monkeypatch):
    """"pose" skips the in-place rewrite for a TRANSLATION as well as a rotation.

    The in-place rewrite is far cheaper than a reconvert but still O(file) — it
    re-encodes every point record (~2.8 s on a 13 M-point scan) and the renderer
    then re-streams the whole octree. Posing costs nothing. Doing the rewrite
    here made a translation visibly SLOWER than a rotation, the opposite of what
    the cost model predicts.
    """
    sid = _grid_session(tmp_path, monkeypatch)
    sess = main._cloud_sessions[sid]
    before_id = sess.octree_cache_id

    def _boom(*a, **k):
        raise AssertionError("PotreeConverter ran for a deferred translation")

    monkeypatch.setattr(main, "_run_potree_converter", _boom)
    res = main.session_transform(
        sid, main.SessionTransformRequest(
            matrix=_matrix(np.eye(3), np.array([4.0, -2.0, 1.0])), octree_mode="pose"))

    assert res["octree_posed"] is True
    assert res["cache_id"] == before_id, "the octree must NOT be rewritten"
    assert sess.octree_pose is not None


def test_rebuild_mode_rewrites_a_translation_in_place(tmp_path, monkeypatch):
    """The in-place rewrite still earns its place on the "now" path, where a
    CURRENT octree is required and the alternative is a full reconvert."""
    sid = _grid_session(tmp_path, monkeypatch)
    sess = main._cloud_sessions[sid]
    before_id = sess.octree_cache_id

    def _boom(*a, **k):
        raise AssertionError("PotreeConverter ran for a pure translation")

    monkeypatch.setattr(main, "_run_potree_converter", _boom)
    res = main.session_transform(
        sid, main.SessionTransformRequest(
            matrix=_matrix(np.eye(3), np.array([4.0, -2.0, 1.0]))))

    assert res["octree_posed"] is False
    assert res["cache_id"] != before_id
    assert sess.octree_pose is None


def test_default_is_unchanged_behaviour(tmp_path, monkeypatch):
    """Back-compat: an omitted `octree_mode` must behave exactly as before —
    a rotation reconverts and nothing is left stale."""
    sid = _grid_session(tmp_path, monkeypatch)
    sess = main._cloud_sessions[sid]
    before_id = sess.octree_cache_id

    res = main.session_transform(sid, main.SessionTransformRequest(matrix=_rot_matrix()))

    assert res["octree_posed"] is False
    assert res["cache_id"] != before_id
    assert sess.octree_pose is None


def test_rebuild_octree_re_tiles_to_the_current_geometry(tmp_path, monkeypatch):
    """`rebuild_octree` must re-tile to the CURRENT geometry and drop the pose —
    it is what the region-edit chokepoint calls before shipping a frozen camera."""
    import octree_transform

    sid = _grid_session(tmp_path, monkeypatch)
    sess = main._cloud_sessions[sid]
    before_id = sess.octree_cache_id
    main.session_transform(
        sid, main.SessionTransformRequest(matrix=_rot_matrix(), octree_mode="pose"))

    res = main.session_rebuild_octree(sid)

    assert res["octree_posed"] is False
    assert res["cache_id"] != before_id
    assert sess.octree_pose is None

    # The rebuilt octree must describe the ROTATED cloud, not the original.
    meta = octree_transform.read_metadata(main._octree_cache_root() / res["cache_id"])
    pos_attr = next(a for a in meta["attributes"] if a["name"] == "position")
    np.testing.assert_allclose(pos_attr["min"], sess.positions.min(axis=0), atol=2e-3)
    np.testing.assert_allclose(pos_attr["max"], sess.positions.max(axis=0), atol=2e-3)


def test_bake_refuses_to_return_a_stale_octree_as_current(tmp_path, monkeypatch):
    """THE dangerous case.

    `bake_cloud_session` has a no-deletions fast path that returns the current
    cache_id and calls it baked. With a deferred transform outstanding that id
    points at an octree in the OLD frame — returning it would tell the renderer
    "this is current" while the renderer, seeing an unchanged id, keeps posing
    it. The transform would be applied twice, silently.
    """
    sid = _grid_session(tmp_path, monkeypatch)
    sess = main._cloud_sessions[sid]
    main.session_transform(
        sid, main.SessionTransformRequest(matrix=_rot_matrix(), octree_mode="pose"))
    stale_id = sess.octree_cache_id
    assert not sess.deleted.any(), "fixture must have no deletions (the fast path)"

    res = main._do_bake_cloud_session(sid)

    assert res["cache_id"] != stale_id, "bake returned the stale octree as current"
    assert sess.octree_pose is None


def test_any_rebuild_clears_the_stale_flag(tmp_path, monkeypatch):
    """A filter rebuilds the octree from the moved arrays, so the deferred
    transform is folded in and the renderer must stop posing. Pins that the clear
    lives in the shared rebuild path rather than only at the transform site."""
    sid = _grid_session(tmp_path, monkeypatch)
    sess = main._cloud_sessions[sid]
    main.session_transform(
        sid, main.SessionTransformRequest(matrix=_rot_matrix(), octree_mode="pose"))
    assert sess.octree_pose is not None

    main._do_session_filter(sid, main.SessionFilterRequest(
        region=main.CropOctreeRegion(kind="box", min=[-1e6] * 3, max=[1e6] * 3)))

    assert sess.octree_pose is None


def test_dropping_the_octree_also_drops_the_stale_pose(tmp_path, monkeypatch):
    """INVARIANT: `octree_pose` set means "the cached octree is valid, just
    in an older frame". A delete sets `octree_cache_id = None` — there is no
    cached octree at all — so the flag must not survive, or a later reader that
    trusts it to decide whether the cache is servable reads a contradiction.
    """
    sid = _grid_session(tmp_path, monkeypatch)
    sess = main._cloud_sessions[sid]
    main.session_transform(
        sid, main.SessionTransformRequest(matrix=_rot_matrix(), octree_mode="pose"))
    assert sess.octree_pose is not None

    main.delete_cloud_region(sid, main.DeleteRegionRequest(
        region=main.CropOctreeRegion(kind="box", min=[0.0, 0.0, 0.0], max=[0.2, 0.2, 0.2])))

    assert sess.octree_cache_id is None
    assert sess.octree_pose is None, (
        "a session with no cached octree must not claim a stale pose")
