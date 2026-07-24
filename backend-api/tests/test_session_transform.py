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
    return r.json()["session_id"], r.json()


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
        main.create_cloud_session(create_req))["session_id"]

    src = main.PointSource(source_path="", session_id=sid)
    before = main._read_points_from_source(src)[0].copy()  # world frame

    R = _euler_xyz(30.0, -20.0, 45.0)
    pivot = np.array([0.45, 0.45, 0.45])
    t = np.array([2.0, -1.0, 0.5])
    req = main.SessionTransformRequest(matrix=_pivot_matrix(R, pivot, t))
    asyncio.new_event_loop().run_until_complete(main.session_transform(sid, req))

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
    sid = asyncio.new_event_loop().run_until_complete(main.create_cloud_session(create_req))["session_id"]

    src = main.PointSource(source_path="", session_id=sid)
    before = main._read_points_from_source(src)[0].copy()  # world frame (shift re-added)

    R = _rot_z(45.0)
    t = np.array([2.0, 3.0, -1.0])
    req = main.SessionTransformRequest(matrix=_matrix(R, t))
    asyncio.new_event_loop().run_until_complete(main.session_transform(sid, req))

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
    created = asyncio.new_event_loop().run_until_complete(main.create_cloud_session(create_req))
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
    asyncio.new_event_loop().run_until_complete(main.session_transform(sid, req))

    sess = main._cloud_sessions[sid]
    np.testing.assert_allclose(sess.backfilled_misses["positions"], miss_pos + t, atol=1e-6)
    np.testing.assert_allclose(sess.backfilled_misses["origins"], origins + t, atol=1e-6)
    np.testing.assert_allclose(sess.miss_octree_origin, np.array([10.0, 0.0, 0.0]), atol=1e-6)
    assert sess.backfilled_misses_stale is True
