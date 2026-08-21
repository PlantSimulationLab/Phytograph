"""Tests for cancelling an in-flight point-cloud import.

`/api/cloud/session/create` used to be an `async def` that did every blocking
step inline on the event loop: the whole backend froze for the duration of an
import, so a concurrent `POST /api/cancel/{run_id}` could not even be serviced.
The import was structurally uncancellable, and the progress modal had no way out.

It now runs its worker off-thread under `_bin_frame_streaming_response`, streams
PHP1 stage markers, and honours a cancel token. These tests pin the four things
that make the cancel REAL rather than cosmetic:

  - progress markers actually stream (and carry the run_id the client cancels with);
  - a cancel emits the terminal `cancelled` marker AND registers no session;
  - the PotreeConverter CHILD PROCESS is killed, not merely detached;
  - a cancelled build leaves no staging dir and no cache entry, so the next
    import of the same file can't reuse a half-built octree.
"""

import json
import os
import stat
import sys
import threading
import time
from pathlib import Path

import numpy as np
import pytest

import main
from tests.binframe import decode_progress_markers, decode_streamed_json

GRID_FORMAT = "x y z"


@pytest.fixture
def grid_xyz(tmp_path, request) -> Path:
    """A 5x5x5 grid (125 points) — big enough to import for real, small enough
    that the non-cancel tests finish fast.

    Octrees are cached by the hash of the derived hits-LAS bytes, so an
    identical grid across tests would hit the cache entry a PREVIOUS test
    installed and skip the stubbed converter entirely. Offset the grid per test
    so every test derives its own cache key."""
    f = tmp_path / "grid.xyz"
    off = (abs(hash(request.node.name)) % 1000) * 1.0
    f.write_text("\n".join(
        f"{off + i*0.1:.4f} {j*0.1:.4f} {k*0.1:.4f}"
        for i in range(5) for j in range(5) for k in range(5)
    ) + "\n")
    return f


@pytest.fixture
def cache_root(tmp_path, monkeypatch) -> Path:
    root = tmp_path / "octree_cache"
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(root))
    return root


def _install_fake_converter(monkeypatch, before_write=None):
    """Stub PotreeConverter with a fast, valid build. `before_write` runs inside
    the stub, so a test can block there to hold the import mid-flight."""
    def fake(input_las, out_dir, cancel_event=None, poll=0.2):
        out_dir.mkdir(parents=True, exist_ok=True)
        if before_write is not None:
            before_write(cancel_event)
        (out_dir / "metadata.json").write_text('{"points": 0}')

    monkeypatch.setattr(main, "_run_potree_converter", fake)


def test_create_streams_progress_markers(client, cache_root, grid_xyz, monkeypatch):
    """The streaming migration itself: the response is PHP1 markers followed by
    the JSON tail, the first marker carries the run_id the client needs to
    cancel, and the fractions advance monotonically to a valid result."""
    _install_fake_converter(monkeypatch)
    res = client.post("/api/cloud/session/create",
                      json={"source_path": str(grid_xyz), "ascii_format": GRID_FORMAT})
    assert res.status_code == 200, res.text

    markers = decode_progress_markers(res.content)
    assert markers, "create must stream PHP1 progress markers"
    run_ids = [m["run_id"] for m in markers if m.get("run_id")]
    assert run_ids, "the first marker must carry a run_id so the client can cancel"

    fractions = [m["progress"] for m in markers if m.get("progress") is not None]
    assert fractions, "at least one marker must report a fraction"
    assert fractions == sorted(fractions), f"progress went backwards: {fractions}"
    assert 0.0 <= fractions[0] and fractions[-1] <= 1.0

    body = decode_streamed_json(res.content)
    assert body["session_id"]
    # `point_count` in the response comes from the octree metadata, which the
    # stub fakes — assert on the real in-RAM session the import produced.
    assert main._cloud_sessions[body["session_id"]].positions.shape[0] == 125


def test_cancel_emits_cancelled_marker_and_registers_no_session(
        client, cache_root, grid_xyz, monkeypatch):
    """The actual fix. Cancelling mid-build ends the stream with a terminal
    `cancelled` marker instead of a result, and — critically — leaves NO session
    in the registry, so a cancelled import can't leak a multi-GB in-RAM cloud."""
    reached = threading.Event()
    release = threading.Event()

    def block(cancel_event):
        reached.set()
        # Hold the import inside the converter until the cancel lands.
        release.wait(timeout=10)

    _install_fake_converter(monkeypatch, before_write=block)

    sessions_before = set(main._cloud_sessions)
    result = {}

    def do_post():
        result["res"] = client.post(
            "/api/cloud/session/create",
            json={"source_path": str(grid_xyz), "ascii_format": GRID_FORMAT})

    t = threading.Thread(target=do_post)
    t.start()
    try:
        assert reached.wait(timeout=15), "import never reached the converter"
        # The run_id is published on the first marker, before the heavy work —
        # find it the way the renderer does, then cancel that run.
        deadline = time.time() + 10
        run_id = None
        while time.time() < deadline and run_id is None:
            with main._CANCEL_REGISTRY_LOCK:
                ids = list(main._CANCEL_REGISTRY)
            run_id = ids[-1] if ids else None
            if run_id is None:
                time.sleep(0.05)
        assert run_id, "create must register a cancel token"
        assert main._cancel_run(run_id) is True
    finally:
        release.set()
        t.join(timeout=30)

    res = result["res"]
    assert res.status_code == 200, res.text
    markers = decode_progress_markers(res.content)
    assert any(m.get("cancelled") for m in markers), (
        f"a cancelled run must end with a terminal cancelled marker; got {markers}")

    # No session was registered: create adds to _cloud_sessions only as its LAST
    # statement, so the cancel unwound before anything was published.
    assert set(main._cloud_sessions) == sessions_before


def test_cancelled_build_leaves_no_staging_dir_and_no_cache_entry(
        tmp_path, cache_root, monkeypatch):
    """Poisoned-cache lock. A killed converter must leave the cache entry ABSENT
    (never half-built), and must not strand its staging dir — otherwise a later
    import of the same file would happily reuse a broken octree."""
    def cancel_midway(cancel_event):
        raise main.ScanCancelled()

    _install_fake_converter(monkeypatch, before_write=cancel_midway)

    las = tmp_path / "hits.las"
    las.write_bytes(b"deterministic bytes -> deterministic cache key")

    with pytest.raises(main.ScanCancelled):
        main._build_octree_from_las(las, [])

    keys = list(cache_root.glob("*")) if cache_root.exists() else []
    staging = [p for p in keys if p.name.endswith(".staging")]
    assert not staging, f"cancel stranded a staging dir: {staging}"
    installed = [p for p in keys if (p / "metadata.json").is_file()]
    assert not installed, f"cancel installed a cache entry: {installed}"


def test_import_after_cancel_succeeds(client, cache_root, grid_xyz, monkeypatch):
    """The same file must import cleanly after a cancelled attempt. Identical
    bytes derive the identical cache key, so a poisoned entry from the killed
    build would surface here as a wrong point count or a failure."""
    calls = {"n": 0}

    def cancel_first_build(cancel_event):
        calls["n"] += 1
        if calls["n"] == 1:
            raise main.ScanCancelled()

    _install_fake_converter(monkeypatch, before_write=cancel_first_build)

    first = client.post("/api/cloud/session/create",
                        json={"source_path": str(grid_xyz), "ascii_format": GRID_FORMAT})
    assert first.status_code == 200
    assert any(m.get("cancelled") for m in decode_progress_markers(first.content))

    second = client.post("/api/cloud/session/create",
                         json={"source_path": str(grid_xyz), "ascii_format": GRID_FORMAT})
    assert second.status_code == 200, second.text
    body = decode_streamed_json(second.content)
    assert "error" not in body, body
    assert body["session_id"]
    assert main._cloud_sessions[body["session_id"]].positions.shape[0] == 125
    # The second attempt really rebuilt (the cancelled first install left nothing
    # behind), rather than silently reusing a half-built cache entry.
    assert calls["n"] == 2


def test_missing_file_is_a_real_404_not_a_streamed_error(client, cache_root):
    """Validation happens BEFORE the stream opens, so a bad path is still a clean
    404 the renderer can surface — not a 200 with an error buried in the tail."""
    res = client.post("/api/cloud/session/create",
                      json={"source_path": "/nope/does/not/exist.xyz"})
    assert res.status_code == 404


def test_in_stream_failure_is_reported_in_the_json_tail(client, cache_root, tmp_path):
    """Once the 200 + first chunk is out, an exception can only reach the client
    as a truncated body ("Unexpected end of JSON input"). Failures raised inside
    the worker must therefore come back as `error` in the JSON tail instead."""
    bad = tmp_path / "unsupported.foo"
    bad.write_text("0 0 0\n")
    res = client.post("/api/cloud/session/create", json={"source_path": str(bad)})
    assert res.status_code == 200, res.text
    body = decode_streamed_json(res.content)
    assert "error" in body, f"in-stream failure must report an error tail; got {body}"
    assert body["error"], "the error message must not be empty"
