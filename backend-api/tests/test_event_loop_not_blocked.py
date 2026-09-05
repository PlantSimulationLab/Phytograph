"""The event loop must stay free while a heavy request runs.

This process serves every request from one asyncio event loop. When a route
handler is declared `async def` and then does blocking CPU work inline, it owns
that loop for the whole operation and every other request — including ones that
would take microseconds — waits behind it. That is not a hypothetical: an LAZ
export whose real cost is ~1-2 s died on a 2-minute client deadline, and two
`/api/pointcloud/preview` calls that measure 3-70 ms timed out at 60 s in the
same window, purely from starvation.

The fix is that blocking handlers are declared `def`, so FastAPI runs them in the
worker threadpool. These tests pin the property (a slow request does not delay a
fast one) and the rule that produces it (no `async def` handler without awaits).
"""

import concurrent.futures
import re
import time
from pathlib import Path

import pytest

import main

MAIN_PY = Path(main.__file__).resolve()


def _route_handlers():
    """(path, name, is_async, body) for every @app.<method> route in main.py.

    Read from source rather than from `app.routes` because what matters is how
    the handler is *declared* — `async def` vs `def` is exactly the bug.
    """
    lines = MAIN_PY.read_text(encoding="utf-8").split("\n")
    out = []
    i = 0
    while i < len(lines):
        if re.match(r"^@app\.(get|post|put|delete)", lines[i]):
            path = re.search(r'"([^"]+)"', lines[i]).group(1)
            j = i
            while j < len(lines) and not re.match(r"^(async )?def ", lines[j]):
                j += 1
            m = re.match(r"^(async )?def (\w+)", lines[j])
            k = j + 1
            while k < len(lines) and not re.match(
                r"^(@app\.|@\w|async def |def |class |# =====)", lines[k]
            ):
                k += 1
            out.append((path, m.group(2), bool(m.group(1)), "\n".join(lines[j:k])))
            i = k
        else:
            i += 1
    return out


def test_no_async_handler_without_an_await():
    """The rule that keeps the loop free.

    An `async def` handler with no `await` in its body cannot yield: it holds the
    event loop from first statement to last. Such a handler must be `def` so it
    runs in the threadpool. If this fails, you added one — drop the `async`, or
    wrap the blocking section in `await run_in_threadpool(...)`.
    """
    offenders = [
        f"{path} ({name})"
        for path, name, is_async, body in _route_handlers()
        if is_async and not re.search(r"\bawait\b", body)
    ]
    assert offenders == [], (
        "these handlers hold the event loop for their whole duration:\n  "
        + "\n  ".join(offenders)
    )


def test_the_heavy_handlers_are_threadpooled():
    """Spot-check the routes that actually carry the load."""
    by_path = {p: (n, a) for p, n, a, _ in _route_handlers()}
    for path in [
        "/api/pointcloud/export",
        "/api/pointcloud/import_by_path",
        "/api/pointcloud/preview",
        "/api/triangulate",
        "/api/cloud/session/{session_id}/bake",
        "/api/cloud/session/{session_id}/filter",
        "/api/plant/generate",
        "/api/c2m/distance",
    ]:
        name, is_async = by_path[path]
        assert not is_async, f"{path} ({name}) is async def — it will block the loop"


# The runtime half of this file needs a REAL server. Starlette's TestClient runs
# each request through its own blocking portal, so two concurrent calls do not
# share one event loop — under TestClient even a deliberately blocking `async def`
# handler fails to stall its neighbour, which would make the measurement below
# pass for the wrong reason. uvicorn in a thread is the actual arrangement we ship.


@pytest.fixture(scope="module")
def live_server():
    """A real uvicorn server on a free port, with a blocking route pair to probe."""
    import socket
    import threading

    import uvicorn

    @main.app.get("/api/_test_blocking_sync")
    def _blocking_sync():  # pragma: no cover - driven over HTTP
        time.sleep(1.0)
        return {"ok": True}

    @main.app.get("/api/_test_blocking_async")
    async def _blocking_async():  # pragma: no cover - driven over HTTP
        time.sleep(1.0)  # deliberately blocking: this is the anti-pattern
        return {"ok": True}

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]

    server = uvicorn.Server(
        uvicorn.Config(main.app, host="127.0.0.1", port=port, log_level="error")
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    base = f"http://127.0.0.1:{port}"
    deadline = time.time() + 30
    while time.time() < deadline:
        try:
            if _get(f"{base}/health")[0] == 200:
                break
        except OSError:
            time.sleep(0.05)
    else:  # pragma: no cover - startup failure
        pytest.fail("uvicorn did not come up")

    yield base

    server.should_exit = True
    thread.join(timeout=10)
    main.app.router.routes = [
        r
        for r in main.app.router.routes
        if getattr(r, "path", "")
        not in ("/api/_test_blocking_sync", "/api/_test_blocking_async")
    ]


def _get(url):
    import urllib.request

    with urllib.request.urlopen(url, timeout=30) as r:
        return r.status, r.read()


def _time_health_during(base, slow_path):
    """Fire the slow route, then time a /health round-trip while it runs."""
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        slow = pool.submit(_get, f"{base}{slow_path}")
        time.sleep(0.25)  # let the slow request take hold
        t0 = time.perf_counter()
        status, _ = _get(f"{base}/health")
        waited = time.perf_counter() - t0
        assert status == 200
        assert slow.result()[0] == 200
    return waited


def test_a_blocking_def_handler_does_not_delay_other_requests(live_server):
    """The fix: /health answers immediately while a 1 s handler runs."""
    waited = _time_health_during(live_server, "/api/_test_blocking_sync")
    assert waited < 0.3, f"/health waited {waited:.2f}s behind a threadpooled handler"


def test_a_blocking_async_handler_does_delay_other_requests(live_server):
    """The control.

    Without this, the test above could pass for the wrong reason (the client never
    actually overlapping the two requests). The same measurement against an
    `async def` twin must show the stall — that is the bug this change removes.
    """
    waited = _time_health_during(live_server, "/api/_test_blocking_async")
    assert waited > 0.4, (
        f"/health returned in {waited:.2f}s behind a blocking async handler — the "
        "control did not reproduce the stall, so the positive test proves nothing"
    )
