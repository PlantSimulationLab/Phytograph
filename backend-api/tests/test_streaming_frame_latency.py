"""Regression: the PHB1 streaming wrapper must flush a finished frame promptly.

`_bin_frame_streaming_response` runs the frame build off-thread and polls the
future, emitting whitespace keepalives during long silences so WebKit's stall
timeout never fires. The bug this guards against: the non-progress branch once
used `poll = 5.0`, which is BOTH the keepalive cadence AND the future re-check
granularity. A build that finished mid-`asyncio.sleep(5.0)` — e.g. the
misses-overlay endpoint, whose frame is fully built *before* the wrapper even
runs — sat idle for the remainder of that 5 s interval, adding a ~5 s stall to
every fast binary-frame response (the "show misses takes ~10 s" report).

Poll granularity is now decoupled from the keepalive cadence, so a ready frame
is delivered in tens of ms regardless of size. We assert the wrapper drains an
already-built frame well under the old 5 s floor.
"""

import asyncio
import time

import numpy as np

import main


def _drain(response) -> bytes:
    """Collect a StreamingResponse's body via its async iterator."""
    async def run():
        chunks = []
        async for chunk in response.body_iterator:
            chunks.append(chunk if isinstance(chunk, bytes) else bytes(chunk))
        return b"".join(chunks)

    return asyncio.run(run())


def test_prebuilt_frame_is_flushed_without_keepalive_stall():
    # Mirror the misses endpoint: build the frame up front, hand the wrapper a
    # trivial thunk. Before the fix this returned only after a full 5 s poll.
    frame = main._bin_frame_bytes(
        {"count": 1}, [("positions", np.arange(9, dtype=np.float32), "f32")]
    )
    response = main._bin_frame_streaming_response(lambda: frame)

    t0 = time.perf_counter()
    body = _drain(response)
    elapsed = time.perf_counter() - t0

    # The PHB1 frame must be present and intact (keepalives are 4-space chunks
    # ahead of the magic; none should appear for an instant build).
    assert main._BIN_FRAME_MAGIC in body
    assert body.endswith(frame)
    # Generously under the old 5 s floor; a prompt poll delivers in tens of ms.
    assert elapsed < 1.0, f"frame stalled {elapsed:.2f}s — keepalive poll regressed"
