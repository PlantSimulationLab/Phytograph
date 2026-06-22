"""Cancellation of long-running streaming ops (synthetic scan / triangulation /
LAD inversion) — `POST /api/cancel/{run_id}`.

The bug this fixes: cancelling a heavy synthetic scan left a Python process
holding tens of GB because the backend never stopped the C++ ray trace — it ran
to completion holding the live Helios Context/LiDARCloud and the numpy staging
arrays. The fix is cooperative cancellation: a per-run threading.Event polled at
every stage boundary (and mirrored into a C++ cancel flag the ray loop reads), so
a cancel unwinds the `with Context()/LiDARCloud()` blocks and frees the memory.

These tests assert the real mechanism, not the absence of errors:
  * the C++ ray loop genuinely short-circuits when the flag is set (hit count
    drops to ~0), proving the trace itself stops rather than finishing;
  * the registry + endpoint flip the right Event;
  * a worker raises ScanCancelled (which the streaming wrapper turns into a
    `cancelled` marker) when its run is cancelled, instead of returning a frame.
"""

import ctypes
import threading
import queue

import pytest

import main


# A small solid pyramid (tetrahedron) — a flat mesh culls to zero hits, so we
# need real 3-D geometry to exercise the ray trace (mirrors test_lidar_scan.py).
_PYRAMID_VERTS = [[-0.5, -0.5, 0.0], [0.5, -0.5, 0.0], [0.0, 0.5, 0.0], [0.0, 0.0, 0.6]]
_PYRAMID_TRIS = [[0, 1, 2], [0, 1, 3], [1, 2, 3], [0, 2, 3]]


def _scan_request(n=400):
    return main.LidarScanRequest(
        meshes=[{"vertices": _PYRAMID_VERTS, "triangles": _PYRAMID_TRIS}],
        scanners=[{
            "id": "s0", "origin": [0.0, 0.0, 3.0],
            "n_theta": n, "n_phi": n,
            "theta_min_deg": 0.0, "theta_max_deg": 180.0,
            "phi_min_deg": 0.0, "phi_max_deg": 360.0,
            "return_type": "single",
            "exit_diameter_m": 0.0, "beam_divergence_mrad": 0.0,
        }],
    )


# ---- Registry / endpoint ---------------------------------------------------

def test_registry_token_lifecycle():
    run_id, event = main._new_cancel_token()
    assert not event.is_set()
    assert main._cancel_run(run_id) is True
    assert event.is_set()
    main._clear_run(run_id)
    # A cleared (or never-registered) run is a no-op, not an error.
    assert main._cancel_run(run_id) is False


def test_cancel_endpoint_unknown_run(client):
    resp = client.post("/api/cancel/nope")
    assert resp.status_code == 200
    assert resp.json() == {"cancelled": False, "run_id": "nope"}


def test_cancel_endpoint_flips_event(client):
    run_id, event = main._new_cancel_token()
    resp = client.post(f"/api/cancel/{run_id}")
    assert resp.json() == {"cancelled": True, "run_id": run_id}
    assert event.is_set()
    main._clear_run(run_id)


# ---- C++ ray loop honors the cancel flag (the core fix) --------------------

class TestNativeCancelFlag:
    """The flag set non-zero short-circuits the OpenMP ray loop in castRaysSoA."""

    def _run(self, cancel: bool) -> int:
        pytest.importorskip("pyhelios")
        from pyhelios import Context, LiDARCloud
        from pyhelios.types import vec3

        with Context() as ctx:
            for a, b, c in _PYRAMID_TRIS:
                ctx.addTriangle(vec3(*_PYRAMID_VERTS[a]),
                                vec3(*_PYRAMID_VERTS[b]),
                                vec3(*_PYRAMID_VERTS[c]))
            with LiDARCloud() as lidar:
                lidar.disableMessages()
                lidar.addScan(origin=vec3(0, 0, 3), Ntheta=200, theta_range=(0, 3.14159),
                              Nphi=200, phi_range=(0, 6.28318),
                              exit_diameter=0, beam_divergence=0)
                flag = ctypes.c_int(1 if cancel else 0)
                lidar.syntheticScan(ctx, record_misses=False, cancel_flag=flag)
                return lidar.getHitCount()

    def test_uncancelled_scan_hits_the_pyramid(self):
        assert self._run(cancel=False) > 0

    def test_preset_cancel_flag_yields_no_hits(self):
        # Flag set before the trace ⇒ every ray short-circuits ⇒ ~no hits. This
        # is the proof the C++ loop actually stops rather than running to
        # completion (which is what leaked the 16GB).
        baseline = self._run(cancel=False)
        cancelled = self._run(cancel=True)
        assert cancelled < baseline
        assert cancelled == 0


# ---- Worker raises ScanCancelled (→ streaming wrapper emits cancel marker) --

def test_scan_worker_raises_on_preset_cancel():
    pytest.importorskip("pyhelios")
    event = threading.Event()
    event.set()  # cancelled before the worker even starts
    reporter = main._ProgressReporter(queue.Queue(), event)
    with pytest.raises(main.ScanCancelled):
        main._do_lidar_scan(_scan_request(), progress=reporter)


def test_scan_worker_cancelled_mid_flight_via_flag():
    """A worker whose run is cancelled while the C++ trace runs raises
    ScanCancelled (not a frame). Exercises the c_int bridge: the reporter binds
    a c_int, we flip the Event + mirror it (as the stream loop does), and the
    in-flight trace bails, after which the post-trace checkpoint fires."""
    pytest.importorskip("pyhelios")
    event = threading.Event()
    reporter = main._ProgressReporter(queue.Queue(), event)

    raised = {}

    def go():
        try:
            main._do_lidar_scan(_scan_request(n=600), progress=reporter)
            raised["value"] = None
        except main.ScanCancelled:
            raised["value"] = "cancelled"

    t = threading.Thread(target=go)
    t.start()
    # Cancel as soon as the worker has bound its c_int (the reporter exposes it
    # via bind_cancel_int). Spin briefly until bound, then signal + mirror.
    for _ in range(10000):
        if reporter._cancel_int is not None:
            break
    event.set()
    reporter.propagate_cancel()  # mirror Event -> c_int, as the stream loop does
    t.join(timeout=60)
    assert raised.get("value") == "cancelled"


# ---- Streaming wrapper surfaces run_id and the cancelled marker ------------

def test_stream_emits_run_id_then_cancelled_marker(client):
    """End-to-end through the endpoint: the first marker carries the run_id; a
    cancel mid-stream produces a terminal `cancelled` marker instead of a frame.

    We can't easily race a real scan deterministically from the test client, so
    this drives the wrapper directly with a worker that blocks until cancelled."""
    from tests.binframe import decode_progress_markers
    import asyncio

    run_id, event = main._new_cancel_token()
    started = threading.Event()

    def build(progress):
        started.set()
        # Block until the run is cancelled, then raise as a real worker would.
        for _ in range(600):  # ~6s cap so a hung test still fails fast
            if progress.should_cancel():
                raise main.ScanCancelled()
            threading.Event().wait(0.01)
        return b"PHB1unused"

    resp = main._bin_frame_streaming_response(
        build, request=None, cancel_event=event, run_id=run_id)

    async def drain():
        chunks = []
        async for chunk in resp.body_iterator:
            chunks.append(chunk if isinstance(chunk, bytes) else bytes(chunk))
            # Once the worker has started, request cancellation.
            if started.is_set() and not event.is_set():
                event.set()
        return b"".join(chunks)

    # Use a dedicated loop so this test doesn't depend on (or disturb) any
    # event loop another test left installed.
    loop = asyncio.new_event_loop()
    try:
        body = loop.run_until_complete(drain())
    finally:
        loop.close()
    markers = decode_progress_markers(body)
    assert markers, "expected at least the run_id + cancelled markers"
    assert markers[0].get("run_id") == run_id
    assert any(m.get("cancelled") for m in markers), "expected a terminal cancelled marker"
    # The registry entry is cleared by the wrapper's finally.
    assert main._cancel_run(run_id) is False
