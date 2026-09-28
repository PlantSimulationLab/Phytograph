"""PyTorch and libhelios must never run in the same process.

On macOS they bring two different LLVM OpenMP runtimes: libhelios links
Homebrew's libomp (bundled as `_internal/libomp.dylib`) and torch ships
`torch/lib/libomp.dylib`. Both export the same weak C++ template symbols
(`__kmp_suspend_64<...>`, `kmp_flag_64<...>`), which dyld coalesces across
images, so one runtime ends up executing the other's code on its own state.
Neither load order is safe:

  * libhelios first, then any parallel torch op: SIGSEGV in a torch worker
    thread, or a deadlock inside `Module.load_state_dict`.
  * torch first, then any Helios OpenMP region: libomp aborts in
    `__kmp_register_library_startup` ("already initialized").

Linux doesn't reproduce it (GCC's libgomp on both sides), so CI never sees it.

The app keeps them apart already: torch runs only in the seg worker, and `main`
skips its pyhelios preload when PHYTOGRAPH_SEG_WORKER is set. This test pins
that, by running the worker's ML wood call in a fresh worker-mode interpreter.
If the exemption is removed, the probe crashes or hangs, and this test fails
with that diagnosis instead of the suite hanging on a macOS machine.

pytest itself imports `main` WITHOUT the flag, so libhelios is loaded here.
That's why every torch-using test file must be named `test_ml_*.py`:
`scripts/run-pytest.mjs` runs those in their own process, where torch loads
before `main` and nothing runs Helios compute.
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import signal
import sys
import time
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
TESTS = BACKEND / "tests"
PROBE = TESTS / "ml_worker_isolation_probe.py"
TIMEOUT_S = 240


def _run_probe(tmp_path: Path) -> dict:
    env = dict(os.environ)
    env["PHYTOGRAPH_SEG_WORKER"] = "1"      # what the real worker sets
    out = tmp_path / "probe.json"
    log = tmp_path / "probe.log"
    # posix_spawn, not subprocess: this pytest process has libhelios loaded,
    # and a fork-then-exec child can die in the post-fork window.
    out_fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    log_fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    try:
        pid = os.posix_spawn(sys.executable, [sys.executable, str(PROBE)], env,
                             file_actions=[(os.POSIX_SPAWN_DUP2, out_fd, 1),
                                           (os.POSIX_SPAWN_DUP2, log_fd, 2)])
    finally:
        os.close(out_fd)
        os.close(log_fd)

    # Poll rather than block: the failure this guards against is a HANG, and a
    # blocking waitpid would turn it back into a silently stuck suite.
    deadline = time.monotonic() + TIMEOUT_S
    while True:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            break
        if time.monotonic() > deadline:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
            pytest.fail(f"worker-mode ML probe hung for {TIMEOUT_S}s — torch and libhelios "
                        f"sharing a process deadlock on macOS (see module docstring).\n"
                        f"{log.read_text()[-3000:]}")
        time.sleep(0.5)

    code = os.waitstatus_to_exitcode(status)
    assert code == 0, (f"worker-mode ML probe exited {code} (-11 = SIGSEGV, -6 = abort: "
                       f"the OpenMP clash in the module docstring).\n{log.read_text()[-3000:]}")
    return json.loads(out.read_text())


@pytest.mark.skipif(not hasattr(os, "posix_spawn"), reason="POSIX-only launcher")
@pytest.mark.skipif(importlib.util.find_spec("torch") is None, reason="torch not installed")
def test_worker_runs_ml_wood_without_libhelios(tmp_path):
    r = _run_probe(tmp_path)
    assert r["libhelios_after_main"] == [], (
        "`import main` loaded libhelios in a PHYTOGRAPH_SEG_WORKER process; torch "
        f"inference there will crash on macOS: {r['libhelios_after_main']}")
    assert r["n_labels"] == r["n_points"] == 50_000
    # The bundled model splits this oak roughly in half (tests/test_ml_wood.py
    # gates its accuracy); both classes present means inference really ran.
    assert r["n_wood"] > 10_000 and r["n_leaf"] > 10_000, r


def test_torch_tests_are_isolated_by_name():
    """Any test file that loads torch must be `test_ml_*.py`, or it runs in the
    main pytest process after libhelios and hangs the suite on macOS."""
    torch_import = re.compile(r"^\s*(import torch|from torch\b)|importorskip\(\s*[\"']torch[\"']", re.M)
    offenders = [p.name for p in TESTS.rglob("test_*.py")
                 if torch_import.search(p.read_text(encoding="utf-8"))
                 and not p.name.startswith("test_ml_")]
    assert offenders == [], (
        f"{offenders} load torch but aren't named test_ml_*.py, so scripts/run-pytest.mjs "
        "won't run them in the torch-only process")


def test_runner_isolates_ml_test_files():
    """The npm runner, not a convention, is what keeps torch tests apart."""
    src = (BACKEND.parent / "scripts" / "run-pytest.mjs").read_text(encoding="utf-8")
    assert "test_ml_" in src and "--ignore=" in src and "--cov-append" in src
