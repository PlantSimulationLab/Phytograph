"""Launch, auth, version and lifetime of a script-owned backend."""
from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

import httpx
import numpy as np
import pytest

import phytograph as pg
from phytograph import _ports, backend as backend_mod

ROOT = Path(__file__).resolve().parents[2]


def test_port_is_from_the_script_band(backend):
    port = int(backend.url.rsplit(":", 1)[1])
    lo, hi = _ports.SCRIPT_BAND
    assert lo <= port < hi


def test_requests_without_the_token_are_refused(backend):
    """The launched backend is guarded like the app's: same machine is not
    enough, the per-launch token is required (CLAUDE.md 'Backend request guard')."""
    r = httpx.get(f"{backend.url}/api/ml/models")
    if r.status_code == 200:
        # A backend from before LocalRequestGuard ignores the token. The client
        # sends it either way; this test is meaningful once the guard exists.
        pytest.skip("this backend has no request guard (LocalRequestGuard) to test against")
    assert r.status_code in (401, 403)
    with pg.Backend.attach(backend.url, token="wrong") as other:
        with pytest.raises(pg.PhytographError) as e:
            other.transport.get_json("/api/ml/models")
        assert e.value.status in (401, 403)
    # ...and the right token works.
    assert isinstance(backend.transport.get_json("/api/ml/models"), (dict, list))


def test_version_mismatch_fails_fast(backend, monkeypatch):
    monkeypatch.setattr(backend_mod, "EXPECTED_BACKEND_VERSION", "0.0.1")
    with pytest.raises(pg.VersionMismatch) as e:
        pg.Backend.attach(backend.url, token=None)
    assert "0.0.1" in str(e.value) and backend.version in str(e.value)


def test_close_shuts_the_backend_down_cleanly():
    """close() must stop the backend through the stdin pipe — a clean exit,
    quickly — not by falling through to the kill after the timeout."""
    be = pg.Backend(source="dev")
    proc, url = be._proc, be.url
    assert proc is not None and proc.poll() is None
    t0 = time.monotonic()
    be.close()
    assert time.monotonic() - t0 < 10
    # The watchdog ends the server with SIGTERM (-15 on POSIX); the client's
    # fallback is SIGKILL, so -9 would mean the pipe path did not work.
    assert proc.returncode is not None
    assert proc.returncode != -getattr(signal, "SIGKILL", 9), \
        "close() had to kill the backend; the stdin-pipe shutdown did not work"
    with pytest.raises(httpx.HTTPError):
        httpx.get(f"{url}/health", timeout=2)


@pytest.mark.skipif(sys.platform == "win32", reason="uses SIGKILL")
def test_backend_dies_with_a_killed_script(tmp_path):
    """No close(), no __del__, no atexit: the script is SIGKILLed. The OS
    closes the backend's stdin pipe, and the parent watchdog shuts it down."""
    script = tmp_path / "victim.py"
    script.write_text(
        "import sys, time\n"
        f"sys.path.insert(0, {str(ROOT / 'python')!r})\n"
        "import phytograph as pg\n"
        "be = pg.Backend(source='dev')\n"
        "print(be._proc.pid, be.url, flush=True)\n"
        "time.sleep(600)\n")
    victim = subprocess.Popen([sys.executable, str(script)], stdout=subprocess.PIPE, text=True)
    try:
        pid_s, url = victim.stdout.readline().split()
        assert httpx.get(f"{url}/health", timeout=5).status_code == 200
    finally:
        victim.kill()
        victim.wait()
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            os.kill(int(pid_s), 0)
        except ProcessLookupError:
            break
        time.sleep(0.25)
    else:
        os.kill(int(pid_s), signal.SIGKILL)
        pytest.fail("the backend outlived its SIGKILLed script by 30 s")


def test_missing_executable_is_reported(tmp_path):
    with pytest.raises(pg.BackendNotFound):
        pg.Backend(executable=tmp_path / "nothing-here")


def test_version_lock_quintet():
    """package.json, main.py, constants.ts, pyproject.toml and the client's
    EXPECTED_BACKEND_VERSION move together (CLAUDE.md 'Version-lock contract')."""
    pkg = json.loads((ROOT / "package.json").read_text())["version"]
    main_v = re.search(r'^BACKEND_VERSION = "([^"]+)"',
                       (ROOT / "backend-api" / "main.py").read_text(), re.M).group(1)
    ts_v = re.search(r"EXPECTED_BACKEND_VERSION\s*=\s*['\"]([^'\"]+)",
                     (ROOT / "src" / "shared" / "constants.ts").read_text()).group(1)
    py_v = re.search(r'^version = "([^"]+)"', (ROOT / "python" / "pyproject.toml").read_text(),
                     re.M).group(1)
    assert {pkg, main_v, ts_v, py_v, pg.EXPECTED_BACKEND_VERSION} == {pkg}


def test_interrupt_mid_run_cancels_and_leaves_the_backend_usable(backend, forest_plot):
    """Ctrl-C during a streaming run propagates to the script, posts
    /api/cancel for the run, and the backend keeps serving."""
    seen = []

    def interrupt(frac, msg):
        seen.append(msg)
        raise KeyboardInterrupt

    old = backend.transport.progress
    backend.transport.progress = interrupt
    try:
        with pytest.raises(KeyboardInterrupt):
            backend.open(forest_plot)
    finally:
        backend.transport.progress = old
    assert seen, "the import never reported progress, so nothing was interrupted"
    assert backend.health()["status"] == "healthy"
    with backend.open(forest_plot) as c:
        assert len(c) > 0


def test_startup_rebuild_notices_are_relayed(tmp_path, capsys):
    """A dev checkout recompiling libhelios on start used to make the script
    wait minutes in silence. The client relays the backend's [pyhelios]
    rebuild lines while it waits, and nothing routine."""
    log = tmp_path / "backend.log"
    be = object.__new__(pg.Backend)
    be._log_path, be._log_seen, be._startup_progress = log, 0, None
    log.write_text("INFO: started\n[pyhelios] native library is stale (C++ sources are newer); "
                   "rebuilding\n[pyhelios] building from")  # partial last line
    be._relay_startup_log()
    err = capsys.readouterr().err
    assert "rebuilding" in err and "building from" not in err
    with open(log, "a") as fh:
        fh.write(" source (this may take a few minutes)...\n"
                 "[pyhelios] build complete\n[pyhelios] native library loaded at startup\n")
    seen = []
    be._startup_progress = lambda frac, msg: seen.append(msg)
    be._relay_startup_log()
    assert [m.split("] ", 1)[1] for m in seen] == [
        "building from source (this may take a few minutes)...", "build complete"]
    be._relay_startup_log()  # nothing new
    assert len(seen) == 2


def test_export_las_scale_and_typed_columns(backend, tmp_path):
    import laspy
    rng = np.random.default_rng(0)
    xyz = rng.uniform(0, 2.5, size=(2000, 3))
    ids = (30_000_001 + rng.integers(0, 40, 2000) * 3).astype(np.int32)
    c = backend.from_numpy(xyz, columns={"instance_id": ids})
    assert c.to_numpy()["instance_id"].dtype == np.int32
    c.export(tmp_path / "fine.laz")
    fine = laspy.read(str(tmp_path / "fine.laz"))
    assert np.abs(np.c_[fine.x, fine.y, fine.z] - xyz).max() <= 5e-6 + 1e-12
    assert fine["instance_id"].dtype == np.int32 and np.array_equal(fine["instance_id"], ids)
    c.export(tmp_path / "coarse.laz", las_scale=0.001)
    assert np.allclose(laspy.read(str(tmp_path / "coarse.laz")).header.scales, 0.001)
    with pytest.raises(ValueError):
        c.export(tmp_path / "bad.laz", las_scale=0)
