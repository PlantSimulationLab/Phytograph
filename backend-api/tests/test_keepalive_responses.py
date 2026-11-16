"""KeepaliveResponses: keepalives for a slow response, real status for a fast one.

Every long operation that does not stream on its own used to sit behind a fixed
client deadline on the whole request. Issue #7 was one of them running past it.
With `?keepalive=1` the backend sends a few bytes while it works, so the
client's deadline can be an idle one. These pin the contract the renderer's
`keepaliveFetch` relies on:

  - a prompt answer is passed through byte for byte, status included, so every
    refusal the client acts on (400, 404, a 409 cost prompt) stays a refusal;
  - a slow answer becomes 200 + 4-byte whitespace keepalives + the endpoint's
    own body, with CORS headers, and a binary body stays 4-byte aligned;
  - a slow FAILURE is reported in band with the endpoint's detail text;
  - the endpoint still sees the client disconnect;
  - without the flag, nothing changes;
  - it is registered where its own 200 still gets CORS headers.

The mechanics are driven on a small app (slow endpoints on demand); the wiring
is asserted on the real one.
"""

import asyncio
import json
import time

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.testclient import TestClient

import main
from tests.binframe import decode_progress_markers

ORIGIN = "http://localhost:5173"


@pytest.fixture
def slow_app(monkeypatch):
    """A small app behind the real middleware, with its waits shortened."""
    monkeypatch.setattr(main.KeepaliveResponses, "first_wait", 0.15)
    monkeypatch.setattr(main.KeepaliveResponses, "interval", 0.05)
    app = FastAPI()
    state = {"disconnected": None}

    @app.post("/json")
    def as_json(delay: float = 0.0):
        time.sleep(delay)
        return {"labels": [1, 2, 3]}

    @app.post("/binary")
    def as_binary(delay: float = 0.0):
        time.sleep(delay)
        return Response(b"PHX1" + bytes(range(28)), media_type="application/octet-stream")

    @app.post("/fails")
    def fails(delay: float = 0.0, code: int = 500):
        time.sleep(delay)
        raise HTTPException(status_code=code, detail="The worker ran out of memory.")

    @app.post("/crashes")
    def crashes(delay: float = 0.0):
        time.sleep(delay)
        raise ValueError("kaboom in the worker")

    @app.post("/cost")
    def cost():
        raise HTTPException(status_code=409, detail={
            "cost_warning": {"message": "about 4 min"}, "message": "about 4 min"})

    @app.post("/watches")
    async def watches(request: Request):
        for _ in range(100):
            if await request.is_disconnected():
                state["disconnected"] = True
                return {"saw": "disconnect"}
            await asyncio.sleep(0.02)
        state["disconnected"] = False
        return {"saw": "nothing"}

    app.add_middleware(main.KeepaliveResponses)
    app.add_middleware(CORSMiddleware, allow_origins=[ORIGIN], allow_methods=["*"],
                       allow_headers=["*"])
    return TestClient(app), state


def test_a_prompt_answer_is_passed_through_untouched(slow_app):
    client, _ = slow_app
    plain = client.post("/json")
    kept = client.post("/json?keepalive=1")
    assert kept.status_code == 200
    assert kept.content == plain.content
    assert kept.headers["content-type"] == plain.headers["content-type"] == "application/json"
    assert "x-phytograph-keepalive" not in kept.headers


@pytest.mark.parametrize("path,code", [("/fails?code=400", 400), ("/fails?code=404", 404),
                                       ("/cost", 409)])
def test_a_prompt_refusal_keeps_its_status_and_body(slow_app, path, code):
    client, _ = slow_app
    plain = client.post(path)
    sep = "&" if "?" in path else "?"
    kept = client.post(f"{path}{sep}keepalive=1")
    assert kept.status_code == plain.status_code == code
    assert kept.json() == plain.json()


def test_a_slow_answer_gets_keepalives_then_its_own_body(slow_app):
    client, _ = slow_app
    res = client.post("/json?keepalive=1&delay=0.5", headers={"Origin": ORIGIN})
    assert res.status_code == 200
    assert res.headers["x-phytograph-keepalive"] == "1"
    # Its own 200 still carries CORS headers, or the renderer could not read it.
    assert res.headers["access-control-allow-origin"] == ORIGIN
    lead = len(res.content) - len(res.content.lstrip(b" "))
    assert lead >= 8 and lead % 4 == 0, f"expected several 4-byte keepalives, got {lead} bytes"
    assert json.loads(res.content) == {"labels": [1, 2, 3]}     # whitespace is valid before JSON


def test_a_slow_binary_answer_stays_four_byte_aligned(slow_app):
    client, _ = slow_app
    res = client.post("/binary?keepalive=1&delay=0.4")
    lead = len(res.content) - len(res.content.lstrip(b" "))
    assert lead >= 4 and lead % 4 == 0
    assert res.content[lead:] == b"PHX1" + bytes(range(28))


def test_a_slow_failure_is_reported_in_the_stream_with_its_detail(slow_app):
    client, _ = slow_app
    res = client.post("/fails?keepalive=1&delay=0.4")
    assert res.status_code == 200                         # already committed
    errors = [m["error"] for m in decode_progress_markers(res.content) if m.get("error")]
    assert errors == ["The worker ran out of memory."]


def test_a_slow_crash_is_logged_and_named_in_the_stream(slow_app, caplog):
    """An endpoint that RAISES sends no response. Answered promptly, uvicorn
    logs the traceback; after keepalives began the middleware used to retrieve
    and drop the exception: nothing in the log, and only 'HTTP 500' for the user."""
    import logging
    client, _ = slow_app
    with caplog.at_level(logging.ERROR):
        res = client.post("/crashes?keepalive=1&delay=0.4")
    assert res.status_code == 200
    errors = [m["error"] for m in decode_progress_markers(res.content) if m.get("error")]
    assert errors == ["ValueError: kaboom in the worker"]
    logged = [r for r in caplog.records if r.exc_info and "kaboom" in str(r.exc_info[1])]
    assert logged, "the traceback never reached the log"
    assert "/crashes" in logged[0].getMessage()


def test_without_the_flag_a_slow_answer_is_plain(slow_app):
    client, _ = slow_app
    res = client.post("/json?delay=0.4")
    assert res.content == b'{"labels":[1,2,3]}'
    assert "x-phytograph-keepalive" not in res.headers


async def test_the_endpoint_still_sees_the_client_disconnect(slow_app):
    """Cancellation of the killable tools depends on it: `receive` must reach
    the endpoint untouched."""
    _client, state = slow_app
    app = _client.app
    sent = []
    disconnect = asyncio.Event()

    async def receive():
        if not sent:
            sent.append(1)
            return {"type": "http.request", "body": b"", "more_body": False}
        await disconnect.wait()
        return {"type": "http.disconnect"}

    async def send(message):
        pass

    scope = {"type": "http", "method": "POST", "path": "/watches", "raw_path": b"/watches",
             "query_string": b"keepalive=1", "headers": [], "scheme": "http",
             "server": ("testserver", 80), "client": ("testclient", 1), "http_version": "1.1",
             "root_path": "", "asgi": {"version": "3.0"}}
    task = asyncio.ensure_future(app(scope, receive, send))
    await asyncio.sleep(0.3)                              # into the keepalive phase
    disconnect.set()
    await asyncio.wait_for(task, timeout=5)
    assert state["disconnected"] is True


def test_it_is_registered_inside_cors_and_outside_the_request_guard():
    """Outside CORS, the 200 it sends itself would carry no CORS headers and
    the renderer could not read a slow response at all. Inside the guard, a
    refused request would be held for the first wait before being refused."""
    order = [m.cls.__name__ for m in main.app.user_middleware]     # outermost first
    assert "KeepaliveResponses" in order
    assert order.index("CORSMiddleware") < order.index("KeepaliveResponses")
    assert order.index("KeepaliveResponses") < order.index("LocalRequestGuard")


def test_the_real_app_answers_a_quick_request_identically(client):
    plain = client.get("/version")
    kept = client.get("/version?keepalive=1")
    assert kept.status_code == 200 and kept.json() == plain.json()
    assert client.post("/api/cloud/session/nope/bake?keepalive=1").status_code == 404


def test_the_real_app_keeps_a_slow_segmentation_alive(client, monkeypatch, tmp_path):
    """End to end on a real tool: a slow ground segmentation comes back as
    keepalives plus the same JSON a plain request returns."""
    import numpy as np
    monkeypatch.setattr(main.KeepaliveResponses, "first_wait", 0.05)
    monkeypatch.setattr(main.KeepaliveResponses, "interval", 0.05)
    rng = np.random.default_rng(0)
    pts = np.column_stack([rng.uniform(0, 5, 400), rng.uniform(0, 5, 400), rng.uniform(0, 0.02, 400)])
    body = {"points": pts.tolist(), "cloth_resolution": 0.5}
    plain = client.post("/api/segment/ground", json=body)
    assert plain.status_code == 200, plain.text
    real = main._run_killable

    async def slowed(*a, **k):
        await asyncio.sleep(0.4)
        return await real(*a, **k)

    monkeypatch.setattr(main, "_run_killable", slowed)
    kept = client.post("/api/segment/ground?keepalive=1", json=body)
    assert kept.status_code == 200
    assert kept.headers.get("x-phytograph-keepalive") == "1"
    lead = len(kept.content) - len(kept.content.lstrip(b" "))
    assert lead >= 4
    assert json.loads(kept.content)["labels"] == plain.json()["labels"]
