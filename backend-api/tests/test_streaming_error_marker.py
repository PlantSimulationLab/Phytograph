"""A streaming worker that RAISES must report the failure in-band.

These endpoints are StreamingResponses: FastAPI sends `200 OK` and the headers
the moment the response object is returned — before the off-thread worker has
run at all. So an exception raised inside the worker CANNOT change the status
code; there is nothing left to set it on.

The observed symptom (user-reported, with logs): Helios triangulation crashed
with a full server-side traceback while the access log recorded

    POST /api/triangulate/helios HTTP/1.1" 200

and the client received a 200 with a truncated body. The renderer then failed
while trying to decode a frame that was never written, so the user saw a
decode-shaped message rather than the real cause.

The fix mirrors the mechanism `cancelled` already uses: a terminal PHP1 marker
carrying `error`, which the client turns into a real thrown error. This is
shared by all ~15 endpoints built on `_bin_frame_streaming_response`.
"""

import asyncio
import threading

import pytest

import main
from tests.binframe import decode_progress_markers


def _drain(resp):
    """Run a StreamingResponse's body iterator to completion, returning bytes.

    Uses a dedicated event loop so this doesn't depend on (or disturb) any loop
    another test left installed — same reason as test_cancel.py.
    """
    async def go():
        chunks = []
        async for chunk in resp.body_iterator:
            chunks.append(chunk if isinstance(chunk, bytes) else bytes(chunk))
        return b"".join(chunks)

    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(go())
    finally:
        loop.close()


def test_worker_exception_becomes_a_terminal_error_marker():
    def build():
        raise ValueError("boom in the worker")

    body = _drain(main._bin_frame_streaming_response(build))
    markers = decode_progress_markers(body)

    err = [m for m in markers if m.get("error")]
    assert err, f"expected a terminal error marker, got {markers}"
    assert err[-1]["error"] == "boom in the worker"


def test_error_marker_carries_the_real_message_not_a_generic_one():
    """The user's report was only actionable because the message was specific.
    A generic 'internal error' would have been strictly worse than the 200."""
    def build():
        raise ValueError(
            "Helios triangulation needs an ASCII point file, but 'scan.las' is "
            "a binary .las file.")

    body = _drain(main._bin_frame_streaming_response(build))
    err = [m for m in decode_progress_markers(body) if m.get("error")]
    assert err
    assert "scan.las" in err[-1]["error"]
    assert "binary .las" in err[-1]["error"]


def test_no_frame_is_emitted_after_a_failure():
    """The stream must not also contain a PHB1 frame — there is no result."""
    def build():
        raise RuntimeError("nope")

    body = _drain(main._bin_frame_streaming_response(build))
    assert b"PHB1" not in body


def test_exception_with_empty_message_still_reports_a_type():
    """`str(e)` is empty for e.g. a bare KeyError-less raise; the marker must
    still say something rather than sending error:'' (which is falsy, so the
    client would skip it and fall through to a decode failure)."""
    class Weird(Exception):
        def __str__(self):
            return ""

    body = _drain(main._bin_frame_streaming_response(lambda: (_ for _ in ()).throw(Weird())))
    err = [m for m in decode_progress_markers(body) if m.get("error")]
    assert err, "an exception with an empty str() still needs a reported error"
    assert err[-1]["error"] == "Weird"


def test_progress_mode_also_reports_errors():
    """The progress-taking worker signature goes down the same path."""
    def build(progress):
        progress(0.2, "starting")
        raise ValueError("failed after some progress")

    body = _drain(main._bin_frame_streaming_response(build))
    markers = decode_progress_markers(body)

    assert any(m.get("message") == "starting" for m in markers), \
        "progress before the failure should still reach the client"
    err = [m for m in markers if m.get("error")]
    assert err and err[-1]["error"] == "failed after some progress"


def test_cancellation_is_still_reported_as_cancelled_not_error():
    """A user cancel must stay distinguishable from a real failure — the client
    maps them to different types (ScanCancelledError vs Error)."""
    run_id, event = main._new_cancel_token()
    started = threading.Event()

    def build(progress):
        started.set()
        for _ in range(600):  # ~6s cap so a hung test fails fast
            if progress.should_cancel():
                raise main.ScanCancelled()
            threading.Event().wait(0.01)
        return b"PHB1unused"

    resp = main._bin_frame_streaming_response(
        build, request=None, cancel_event=event, run_id=run_id)

    async def go():
        chunks = []
        async for chunk in resp.body_iterator:
            chunks.append(chunk if isinstance(chunk, bytes) else bytes(chunk))
            if started.is_set() and not event.is_set():
                event.set()
        return b"".join(chunks)

    loop = asyncio.new_event_loop()
    try:
        body = loop.run_until_complete(go())
    finally:
        loop.close()

    markers = decode_progress_markers(body)
    assert any(m.get("cancelled") for m in markers)
    assert not any(m.get("error") for m in markers), \
        "a cancel must not be reported as an error"


def test_run_token_is_released_after_a_failure():
    """The wrapper's `finally` must still clear the registry when the worker
    raised, or a failed run leaks its cancel token."""
    run_id, event = main._new_cancel_token()

    def build():
        raise ValueError("boom")

    body = _drain(main._bin_frame_streaming_response(
        build, request=None, cancel_event=event, run_id=run_id))

    assert any(m.get("error") for m in decode_progress_markers(body))
    assert main._cancel_run(run_id) is False, "cancel token leaked after failure"


def test_successful_worker_emits_no_error_marker():
    """Guard against the error path firing on the happy path."""
    body = _drain(main._bin_frame_streaming_response(lambda: b"PHB1payload"))
    assert not any(m.get("error") for m in decode_progress_markers(body))
    assert b"PHB1payload" in body


def test_endpoint_without_a_worker_catch_all_reports_in_band(client):
    """End-to-end over HTTP on a real endpoint that has NO catch-all.

    Most streaming workers (`_do_helios_computation`, `_do_lad_computation`, …)
    catch their own exceptions and return a `success: False` frame, so their
    errors always reached the client. But `_do_crown_fit` and
    `_do_session_extract_by_column` do NOT, and neither do the `_pack_*` packers
    or the inline `json.dumps(...)` lambdas — an exception there escaped the
    generator after the 200 and headers were already sent, leaving the client
    with a truncated body and nothing to report.

    A 404 for a missing session is the cheapest way to make that worker raise.
    """
    resp = client.post("/api/fit/crown", json={
        "source": {"session_id": "does-not-exist-12345"},
        "shape": "ellipsoid",
    })

    # The status is necessarily 200: it was committed before the worker ran.
    assert resp.status_code == 200
    assert b"PHB1" not in resp.content, "no frame should be emitted for a failed run"

    err = [m for m in decode_progress_markers(resp.content) if m.get("error")]
    assert err, "the failure must be reported in-band"
    assert "does-not-exist-12345" in err[-1]["error"]
