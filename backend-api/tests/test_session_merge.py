"""Tests for POST /api/cloud/session/merge — the stitch op that concatenates the
surviving points of >=2 sessions into one new session and rebuilds its octree.

This is the fix for issue #3: the old renderer-side stitch concatenated each
cloud's flat `data.positions`, which is EMPTY for octree-backed clouds (points
live in the backend session), so every merged point collapsed to the origin. The
correct merge reads the in-RAM arrays server-side. The tests below assert the
things a count-only check would miss:

  - the merged cloud keeps every input's REAL world coordinates (bounds span both
    inputs), including when the two inputs were imported at DIFFERENT global shifts
    — the whole point of the world-shift reconciliation;
  - scalar extra-dim columns are UNIONED with zero-fill, so a cloud that carries a
    column the other lacks doesn't fall out of point-alignment.

The world-shift / extras cases need in-process access to read the session back, so
(like test_session_transform.py) they drive the endpoint coroutine directly — the
real octree rebuild runs in the stable MAIN thread. The HTTP-level cases use a real
uvicorn subprocess (TestClient's worker thread intermittently SIGSEGVs the macOS
PotreeConverter child — a harness quirk, not app behavior).
"""

import asyncio
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
    """A real uvicorn server bound to a free port, isolated octree cache."""
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


def _write_grid(path: Path, x0: float = 0.0, y0: float = 0.0, z0: float = 0.0,
                refl: float = 0.5) -> Path:
    """10×10×10 grid over [x0, x0+0.9]³ (1000 points), GRID_FORMAT columns."""
    lines = [
        f"{x0 + i*0.1:.4f} {y0 + j*0.1:.4f} {z0 + k*0.1:.4f} 10 20 30 {refl:.4f}"
        for i in range(10) for j in range(10) for k in range(10)
    ]
    path.write_text("\n".join(lines) + "\n")
    return path


def _create(base: str, grid: Path, world_shift=None) -> dict:
    body = {"source_path": str(grid), "ascii_format": GRID_FORMAT}
    if world_shift is not None:
        body["world_shift"] = list(world_shift)
    r = requests.post(f"{base}/api/cloud/session/create", json=body, timeout=60)
    assert r.status_code == 200, r.text
    return decode_streamed_json(r.content)


def test_merge_concatenates_and_spans_both_inputs(server, tmp_path):
    """Two grids at DIFFERENT locations → merged cloud has both point counts and
    tight_bounds that span the union of both grids' extents."""
    a = _write_grid(tmp_path / "a.xyz", x0=0.0)
    b = _write_grid(tmp_path / "b.xyz", x0=5.0)  # 5 m away in x
    sa = _create(server, a)["session_id"]
    sb = _create(server, b)["session_id"]

    r = requests.post(f"{server}/api/cloud/session/merge",
                      json={"session_ids": [sa, sb]}, timeout=120)
    assert r.status_code == 200, r.text
    m = r.json()["merged"]
    assert m["point_count"] == 2000
    assert m["cache_id"]

    tb = m["tight_bounds"]
    # Union spans grid A [0,0.9] and grid B [5,5.9] in x; y,z stay [0,0.9].
    np.testing.assert_allclose(tb["min"], [0.0, 0.0, 0.0], atol=1e-3)
    np.testing.assert_allclose(tb["max"], [5.9, 0.9, 0.9], atol=1e-3)


def test_merge_reconciles_different_world_shifts(tmp_path, monkeypatch):
    """The core issue-#3 correctness case: two clouds imported at DIFFERENT global
    shifts must line up in TRUE world space after merge (not collapse or offset).
    In-process so we can read the merged session back in world coords."""
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "cache"))
    loop = asyncio.new_event_loop()

    # Two grids that occupy the SAME true-world box [0,0.9]³, but imported with
    # different global shifts — so their STORED coords differ by the shift delta.
    a = _write_grid(tmp_path / "a.xyz")
    b = _write_grid(tmp_path / "b.xyz")
    shift_a = [1000.0, 0.0, 0.0]
    shift_b = [1000.5, -3.0, 2.0]
    sa = loop.run_until_complete(_create_session_direct(
        main.CloudSessionCreateRequest(source_path=str(a), ascii_format=GRID_FORMAT, world_shift=shift_a)))["session_id"]
    sb = loop.run_until_complete(_create_session_direct(
        main.CloudSessionCreateRequest(source_path=str(b), ascii_format=GRID_FORMAT, world_shift=shift_b)))["session_id"]

    merged = main.session_merge(main.SessionMergeRequest(session_ids=[sa, sb]))["merged"]
    mid = merged["session_id"]
    assert merged["point_count"] == 2000

    # Read the merged cloud back in WORLD coords (shift re-added at the read
    # chokepoint). Both halves occupied true-world [0,0.9]³, so the union is [0,0.9]³
    # — NOT collapsed to the origin, and NOT offset by a mismatched shift.
    world = main._read_points_from_source(main.PointSource(source_path="", session_id=mid))[0]
    np.testing.assert_allclose(world.min(axis=0), [0.0, 0.0, 0.0], atol=1e-3)
    np.testing.assert_allclose(world.max(axis=0), [0.9, 0.9, 0.9], atol=1e-3)
    # The merged cloud adopts the first input's shift as its common frame.
    np.testing.assert_allclose(main._cloud_sessions[mid].world_shift, shift_a, atol=0)


def test_merge_unions_extra_columns_with_zero_fill(tmp_path, monkeypatch):
    """A scalar column present on only ONE input survives on the merged cloud,
    zero-filled for the rows of the input that lacked it — and stays point-aligned.
    Uses `deviation` (an unmapped role → real extra-dim column) since reserved
    roles like reflectance/intensity are folded into LAS fields, not `extras`."""
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "cache"))
    loop = asyncio.new_event_loop()

    # Grid A carries a `deviation` extra column (value 0.7); grid B is plain xyz.
    a = tmp_path / "a.xyz"
    a.write_text("\n".join(
        f"{i*0.1:.4f} {j*0.1:.4f} {k*0.1:.4f} 0.7"
        for i in range(10) for j in range(10) for k in range(10)
    ) + "\n")
    b = tmp_path / "b.xyz"
    b.write_text("\n".join(
        f"{i*0.1:.4f} {j*0.1:.4f} {k*0.1:.4f}"
        for i in range(10) for j in range(10) for k in range(10)
    ) + "\n")
    sa = loop.run_until_complete(_create_session_direct(
        main.CloudSessionCreateRequest(source_path=str(a), ascii_format="x y z deviation")))["session_id"]
    sb = loop.run_until_complete(_create_session_direct(
        main.CloudSessionCreateRequest(source_path=str(b), ascii_format="x y z")))["session_id"]

    na = len(main._cloud_sessions[sa].positions)
    nb = len(main._cloud_sessions[sb].positions)
    # Sanity: grid A really did produce the extra column, grid B did not.
    assert "deviation" in main._cloud_sessions[sa].extras
    assert "deviation" not in main._cloud_sessions[sb].extras

    merged = main.session_merge(main.SessionMergeRequest(session_ids=[sa, sb]))["merged"]
    sess = main._cloud_sessions[merged["session_id"]]

    assert "deviation" in sess.extras
    col = sess.extras["deviation"]
    assert col.shape[0] == na + nb
    # First input's rows carry ~0.7; the input that lacked the column is zero-filled.
    np.testing.assert_allclose(col[:na], 0.7, atol=1e-3)
    np.testing.assert_allclose(col[na:], 0.0, atol=0)


def test_merge_requires_two_sessions(server, tmp_path):
    a = _write_grid(tmp_path / "a.xyz")
    sa = _create(server, a)["session_id"]
    r = requests.post(f"{server}/api/cloud/session/merge",
                      json={"session_ids": [sa]}, timeout=30)
    assert r.status_code == 400
    assert "at least 2" in r.json()["detail"]


def test_merge_unknown_session_is_404(server, tmp_path):
    a = _write_grid(tmp_path / "a.xyz")
    sa = _create(server, a)["session_id"]
    r = requests.post(f"{server}/api/cloud/session/merge",
                      json={"session_ids": [sa, "does-not-exist"]}, timeout=30)
    assert r.status_code == 404
