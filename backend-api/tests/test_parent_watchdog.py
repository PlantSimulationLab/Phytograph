"""The backend must exit when the app that launched it dies, however it dies.

The supervisor (src/main/backend.ts) spawns the backend detached and cleans it
up from JavaScript, which never runs on SIGKILL, Force Quit, an OOM kill or a
native crash; the orphan kept every session array in RAM, and the next launch
picked a different port and never found it. Now the supervisor hands the
backend a stdin pipe and sets PHYTOGRAPH_EXIT_WITH_PARENT=1, and the backend
treats EOF on that pipe as its death notice (parent_watchdog.py). Closing the
pipe here is exactly what the OS does when the app process dies.
"""

import os
import random
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

import pytest

import parent_watchdog

WRAPPER = Path(__file__).resolve().parent.parent / "backend_wrapper.py"


def test_eof_fires_the_callback():
    r, w = os.pipe()
    fired = threading.Event()
    with os.fdopen(r, "rb", buffering=0) as stream:
        parent_watchdog.watch_stdin_eof(fired.set, stream=stream)
        os.write(w, b"ignored, not a death notice")
        assert not fired.wait(0.3), "data on the pipe was taken for EOF"
        os.close(w)
        assert fired.wait(5), "EOF never noticed"


def _free_port() -> int:
    # Below every ephemeral range (see scripts/free-port.mjs), never :0.
    for _ in range(200):
        port = random.randint(20000, 31999)
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("no free port")


def _launch(tmp_path, exit_with_parent: bool):
    port = _free_port()
    env = dict(os.environ)
    env.update(
        PHYTOGRAPH_BACKEND_PORT=str(port),
        PHYTOGRAPH_OCTREE_CACHE_ROOT=str(tmp_path / "octrees"),
        PHYTOGRAPH_LOG_DIR=str(tmp_path / "logs"),
    )
    env.pop(parent_watchdog.ENV_VAR, None)
    if exit_with_parent:
        env[parent_watchdog.ENV_VAR] = "1"
    proc = subprocess.Popen(
        [sys.executable, str(WRAPPER)], stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    deadline = time.time() + 120
    while time.time() < deadline:
        if proc.poll() is not None:
            raise AssertionError(f"backend exited during startup (code {proc.returncode})")
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2):
                return proc
        except OSError:
            time.sleep(0.5)
    proc.kill()
    raise AssertionError("backend never answered /health")


@pytest.mark.parametrize("exit_with_parent", [True, False])
def test_the_real_backend_exits_when_its_stdin_closes(tmp_path, exit_with_parent):
    """Runs the shipped entrypoint, not the module in isolation: what matters is
    that backend_wrapper.py arms the watchdog before uvicorn takes over, and
    that uvicorn's own SIGTERM path then actually stops the server."""
    proc = _launch(tmp_path, exit_with_parent)
    try:
        proc.stdin.close()     # what the OS does when the app process dies
        if exit_with_parent:
            proc.wait(timeout=parent_watchdog.GRACE_SECONDS + 15)
            # uvicorn re-raises the SIGTERM after a clean shutdown, so the
            # exit status is -SIGTERM on that path and 0 only on the forced
            # one; the log says which ran.
            log = "".join(p.read_text(errors="replace")
                          for p in (tmp_path / "logs").rglob("*") if p.is_file())
            assert "has exited; shutting down" in log
            assert "Finished server process" in log, "the forced exit ran, not uvicorn's shutdown"
        else:
            # A terminal launch has a TTY there; without the switch, EOF on
            # stdin must not take the server down.
            with pytest.raises(subprocess.TimeoutExpired):
                proc.wait(timeout=3)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=30)


# Spawn calls that create a child process. `_SUBPROCESS_RUN` is `_spawn_run`'s
# captured `subprocess.run` (its Windows branch).
_SPAWN_NAMES = {"Popen", "run", "call", "check_call", "check_output", "_SUBPROCESS_RUN"}


def _spawn_calls_without_stdin(source: str) -> list[int]:
    import ast
    missing = []
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, ast.Call):
            continue
        f = node.func
        if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) \
                and f.value.id in ("subprocess", "_subprocess") and f.attr in _SPAWN_NAMES:
            pass
        elif isinstance(f, ast.Name) and f.id == "_SUBPROCESS_RUN":
            pass
        else:
            continue
        if not any(k.arg == "stdin" for k in node.keywords):
            missing.append(node.lineno)
    return missing


def test_no_child_inherits_the_watchdog_stdin():
    """Every spawn in main.py passes stdin explicitly. Inheriting it hands the
    child the watchdog's pipe, and on Windows a Python child (the killable seg
    worker is this same binary) then blocks at startup stat-ing it behind the
    watchdog's pending read: ground segmentation hung forever in the packaged
    Windows app. Nothing on macOS/Linux can observe it, so this is a source check."""
    main_py = Path(__file__).resolve().parent.parent / "main.py"
    missing = _spawn_calls_without_stdin(main_py.read_text(encoding="utf-8"))
    assert not missing, f"main.py spawns without stdin= at lines {missing}; pass stdin=subprocess.DEVNULL"


def test_stdin_check_catches_a_bare_spawn():
    assert _spawn_calls_without_stdin("import subprocess\nsubprocess.Popen(['x'])\n") == [2]
    assert _spawn_calls_without_stdin("_SUBPROCESS_RUN(['x'], capture_output=True)\n") == [1]
    assert _spawn_calls_without_stdin(
        "import subprocess\nsubprocess.Popen(['x'], stdin=subprocess.DEVNULL)\n") == []


def test_poll_fires_when_the_pipe_breaks():
    calls, sleeps = [], []

    def peek():
        calls.append(1)
        if len(calls) == 3:
            raise BrokenPipeError(109, "The pipe has been ended.")
        return (0, 0)

    assert parent_watchdog.poll_until_broken(peek, interval=0.25, sleep=sleeps.append) is True
    assert len(calls) == 3 and sleeps == [0.25, 0.25]


def test_poll_never_reads_an_unwatchable_handle_as_the_apps_death():
    def peek():
        raise OSError(6, "The handle is invalid.")

    assert parent_watchdog.poll_until_broken(peek, sleep=lambda s: None) is False


def test_windows_watchdog_polls_and_never_reads_stdin(monkeypatch):
    """On Windows a pending read on the stdin pipe blocks every other query on
    it, in this process too: `from scipy.interpolate import griddata` hung every
    DEM. The default-stdin path must peek, never read."""
    class _NoRead:
        def fileno(self):
            return 0

        def read(self, *a):
            raise AssertionError("the Windows watchdog read stdin")

        buffer = property(lambda self: self)

    peeks = []

    def fake_peek():
        peeks.append(1)
        if len(peeks) == 2:
            raise BrokenPipeError(109, "The pipe has been ended.")
        return (0, 0)

    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(sys, "stdin", _NoRead())
    monkeypatch.setattr(parent_watchdog, "_windows_stdin_peek", lambda: fake_peek)
    monkeypatch.setattr(parent_watchdog, "POLL_SECONDS", 0.01)
    fired = threading.Event()
    t = parent_watchdog.watch_stdin_eof(fired.set)
    assert t is not None
    assert fired.wait(5), "the broken pipe was never noticed"
    assert len(peeks) == 2
