"""The slow-request logger: contention visibility without touching the ASGI stream.

Context: an LAZ export failed on its client-side 2-minute deadline with nothing in
any log to say whether the backend had even started it. uvicorn's access log records
that a request happened, not how long it took nor what else was running. These tests
pin the two properties that make `SlowRequestLogger` worth having, and the one that
makes it safe.
"""

import re
import time

import main


def test_fast_request_logs_nothing(client, capfd):
    """The common case stays silent — this is a warning channel, not a trace."""
    capfd.readouterr()
    assert client.get("/health").status_code == 200
    assert "[slow]" not in capfd.readouterr().out


def test_slow_request_is_logged_with_method_path_and_duration(client, capfd, monkeypatch):
    """A request over the threshold names itself, so a stall is attributable."""
    monkeypatch.setattr(main, "_SLOW_REQUEST_SECONDS", 0.05)

    @main.app.get("/api/_test_slow")
    def _slow():  # pragma: no cover - exercised through the client
        time.sleep(0.1)
        return {"ok": True}

    try:
        capfd.readouterr()
        assert client.get("/api/_test_slow").status_code == 200
        out = capfd.readouterr().out
        assert "[slow]" in out
        assert "GET /api/_test_slow" in out
        # Duration is reported, and it is the real one (>= the sleep, < a second).
        elapsed = float(re.search(r"took ([\d.]+)s", out).group(1))
        assert 0.1 <= elapsed < 1.0
    finally:
        main.app.router.routes = [
            r for r in main.app.router.routes
            if getattr(r, "path", None) != "/api/_test_slow"
        ]


def test_middleware_is_raw_asgi_not_basehttpmiddleware():
    """Guard the reason it is written this way.

    Starlette's BaseHTTPMiddleware wraps the response in its own task group and
    breaks client-disconnect propagation. `_run_killable` depends on that
    disconnect to SIGKILL its worker when the user cancels, so switching this to
    `@app.middleware("http")` would silently disarm Cancel for every long tool.
    """
    from starlette.middleware.base import BaseHTTPMiddleware

    assert not issubclass(main.SlowRequestLogger, BaseHTTPMiddleware)
    assert main.SlowRequestLogger in [m.cls for m in main.app.user_middleware]


def test_streaming_response_still_streams(client):
    """The logger must not buffer or truncate a streamed body.

    Every heavy tool (scan, triangulate, LAD) returns a binary frame with inline
    progress markers; a middleware that collected the body would break progress
    reporting and the frame itself.
    """
    resp = client.post(
        "/api/triangulate",
        json={
            "points": [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0.5, 0.5, 0.4]],
            "method": "delaunay",
        },
    )
    assert resp.status_code == 200
    # Inline progress markers first, then the binary frame — both intact.
    assert resp.content[:4] == b"PHP1"
    assert b"PHB1" in resp.content
