"""Imports that are canceled, fail part-way, or finish unobserved free their sessions.

Every import below registers one session per position (or per scanner) as it
goes. A request that ends in a cancel or an error returns none of their ids, and
neither does a finished result whose client already left, so nothing could ever
free them: each stayed resident (RAM, or a disk store) until the app quit. Also
here: RIEGL's container deadline is an IDLE deadline, not a whole-run one.
"""

import asyncio
import struct
import sys
import textwrap

import numpy as np
import pytest

import main


def _register_fake_session(tag: str) -> str:
    n = 10
    s = main.CloudSession(
        session_id=f"leak-{tag}-{np.random.randint(1 << 30)}", source_path="", ascii_format=None,
        column_plan=None, positions=np.zeros((n, 3)), colors=None, intensity=None,
        extras={}, extra_dims_meta=[], deleted=np.zeros(n, dtype=bool),
        deleted_history=[], octree_cache_id=None, created_at=0.0)
    with main._cloud_session_lock:
        main._cloud_sessions[s.session_id] = s
    return s.session_id


@pytest.fixture
def fake_imports(monkeypatch):
    """`_do_create_cloud_session` registers a real session per call and raises a
    cancel on the call numbered `cancel_on` (1-based; None never)."""
    state = {"calls": 0, "cancel_on": None, "made": []}

    def fake_create(request, source_path, progress=None, cancel_event=None, **kw):
        state["calls"] += 1
        if state["cancel_on"] == state["calls"]:
            raise main.ScanCanceled()
        sid = _register_fake_session(str(state["calls"]))
        state["made"].append(sid)
        return {"session_id": sid}

    monkeypatch.setattr(main, "_do_create_cloud_session", fake_create)
    yield state
    for sid in state["made"]:
        main._cloud_sessions.pop(sid, None)


def _live(ids):
    return [sid for sid in ids if sid in main._cloud_sessions]


def test_a_canceled_multi_position_import_frees_the_positions_it_built(
        fake_imports, monkeypatch, tmp_path):
    src = tmp_path / "three.e57"
    src.write_bytes(b"x")
    monkeypatch.setattr(main, "_source_scan_count", lambda p: 3)
    fake_imports["cancel_on"] = 3
    with pytest.raises(main.ScanCanceled):
        main._do_create_multi_cloud_session(
            main.CloudSessionCreateRequest(source_path=str(src)), src)
    assert len(fake_imports["made"]) == 2
    assert _live(fake_imports["made"]) == [], "the positions built before the cancel leaked"


async def _read_to_result_then_leave(resp):
    """Read up to and including the result, then close without reading on:
    the client leaving just as the work finished."""
    body = resp.body_iterator
    while True:
        chunk = await body.__anext__()
        if chunk.lstrip()[:1] in (b"{", b"P"):     # JSON tail or a PHB1 frame
            if not chunk.lstrip().startswith(b"PHP1"):
                break
    await body.aclose()


async def _eventually_gone(ids, timeout=5.0):
    for _ in range(int(timeout / 0.05)):
        if not _live(ids):
            return True
        await asyncio.sleep(0.05)
    return not _live(ids)


@pytest.mark.parametrize("route", ["create", "create-multi"])
async def test_an_import_result_nobody_collects_is_discarded(
        fake_imports, monkeypatch, tmp_path, route):
    src = tmp_path / "two.e57"
    src.write_bytes(b"x")
    monkeypatch.setattr(main, "_source_scan_count", lambda p: 2)
    req = main.CloudSessionCreateRequest(source_path=str(src))
    resp = (main.create_cloud_session(req, None) if route == "create"
            else main.create_multi_cloud_session(req, None))
    await _read_to_result_then_leave(resp)
    assert fake_imports["made"], "the import never ran"
    assert await _eventually_gone(fake_imports["made"]), "an uncollected import stayed resident"


async def test_a_collected_import_is_kept(fake_imports, monkeypatch, tmp_path):
    src = tmp_path / "two.e57"
    src.write_bytes(b"x")
    monkeypatch.setattr(main, "_source_scan_count", lambda p: 2)
    resp = main.create_multi_cloud_session(main.CloudSessionCreateRequest(source_path=str(src)), None)
    _ = [c async for c in resp.body_iterator]
    await asyncio.sleep(0.3)
    assert _live(fake_imports["made"]) == fake_imports["made"]


def test_a_canceled_synthetic_scan_frees_the_scanners_it_built(monkeypatch):
    """Two scanners: the first's session is built, then a cancel lands."""
    made = []

    def fake_session(r, retained):
        sid = _register_fake_session("scan")
        made.append(sid)
        return {"session_id": sid, "point_count": 10}

    monkeypatch.setattr(main, "_create_lidar_scan_session", fake_session)

    class CancelAfterFirstSession:
        def __call__(self, fraction, message=""):
            pass

        def should_cancel(self):
            return bool(made)

    scanner = {"origin": [0.0, 0.0, 3.0], "n_theta": 60, "n_phi": 60,
               "theta_min_deg": 0.0, "theta_max_deg": 180.0, "phi_min_deg": 0.0,
               "phi_max_deg": 360.0, "return_type": "single",
               "exit_diameter_m": 0.0, "beam_divergence_mrad": 0.0}
    from tests.test_cancel import _PYRAMID_TRIS, _PYRAMID_VERTS
    req = main.LidarScanRequest(
        meshes=[{"vertices": _PYRAMID_VERTS, "triangles": _PYRAMID_TRIS}],
        scanners=[{"id": "a", **scanner}, {"id": "b", **scanner, "origin": [0.5, 0.0, 3.0]}])
    try:
        with pytest.raises(main.ScanCanceled):
            main._do_lidar_scan(req, progress=CancelAfterFirstSession())
        assert len(made) == 1, "the cancel did not land between the two scanners"
        assert _live(made) == [], "the first scanner's session leaked"
    finally:
        for sid in made:
            main._cloud_sessions.pop(sid, None)


async def test_a_canceled_riegl_extract_frees_the_positions_it_built(
        fake_imports, monkeypatch, tmp_path):
    monkeypatch.setattr(main, "_resolve_riegl_runtime", lambda p: {"available": True})
    monkeypatch.setattr(main, "_validate_riegl_project", lambda p: tmp_path)
    monkeypatch.setattr(main, "_riegl_project_mounts", lambda status, project: [])
    monkeypatch.setattr(main, "_riegl_extract_dir", lambda: tmp_path / "extract")
    monkeypatch.setattr(main, "_riegl_arrays_to_las_result", lambda arrays, **kw: None)

    def fake_stream(args, mounts, out_dir, cancel_event=None, timeout_s=0, on_scan=None):
        arrays = {"positions": np.zeros((5, 3))}
        on_scan(0, {"name": "ScanPos001"}, arrays)
        on_scan(1, {"name": "ScanPos002"}, arrays)
        raise main.ScanCanceled()

    monkeypatch.setattr(main, "_stream_riegl_container", fake_stream)
    resp = main.riegl_project_extract(
        main.RieglProjectExtractRequest(project_path=str(tmp_path)), None)
    _ = [c async for c in resp.body_iterator]
    assert len(fake_imports["made"]) == 2
    assert _live(fake_imports["made"]) == [], "positions built before the cancel leaked"


# --- RIEGL: an idle deadline, not a whole-run one ----------------------------

_FAKE_READER = textwrap.dedent("""
    import json, struct, sys, time
    magic, version, beats, gap = sys.argv[1].encode("latin-1"), int(sys.argv[2]), int(sys.argv[3]), float(sys.argv[4])
    hdr = json.dumps({"scans": []}).encode()
    sys.stdout.buffer.write(magic + struct.pack("<II", version, len(hdr)) + hdr)
    sys.stdout.buffer.flush()
    for i in range(beats):
        time.sleep(gap)
        sys.stderr.write(json.dumps({"progress": i}) + "\\n"); sys.stderr.flush()
    sys.stderr.write(json.dumps({"trailer": []}) + "\\n"); sys.stderr.flush()
""")


def _fake_reader(monkeypatch, tmp_path, beats, gap):
    script = tmp_path / "fake_reader.py"
    script.write_text(_FAKE_READER)
    cmd = [sys.executable, str(script), main._RIEGL_STREAM_MAGIC.decode("latin-1"),
           str(main._RIEGL_STREAM_VERSION), str(beats), str(gap)]
    import os
    env = dict(os.environ)
    monkeypatch.setattr(main, "_riegl_reader_invocation", lambda args, mounts: (cmd, env, None))


def test_a_riegl_run_that_keeps_progressing_outlives_its_timeout(monkeypatch, tmp_path):
    """3 s of steady progress against a 1 s timeout: the run must finish. The
    deadline used to count from the start, killing long projects mid-import."""
    _fake_reader(monkeypatch, tmp_path, beats=12, gap=0.25)
    out = tmp_path / "out"
    out.mkdir()
    header, _results, trailer = main._stream_riegl_container_once(
        [], [], out, timeout_s=1.0)
    assert header == {"scans": []} and trailer == []


def test_a_riegl_run_that_stops_progressing_is_stopped(monkeypatch, tmp_path):
    _fake_reader(monkeypatch, tmp_path, beats=1, gap=4.0)     # silent for 4 s
    out = tmp_path / "out"
    out.mkdir()
    with pytest.raises(main.HTTPException) as exc:
        main._stream_riegl_container_once([], [], out, timeout_s=1.0)
    assert exc.value.status_code == 504 and "no progress" in exc.value.detail
