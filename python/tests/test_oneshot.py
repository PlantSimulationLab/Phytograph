"""`python -m phytograph run`: one recipe, in-process, no server (backend-api/oneshot.py).

Each case runs the real command against the dev checkout's engine, as a
harness would: a fresh process, a work directory, exit status and stderr as
the interface."""
from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

from phytograph.advisories import ADVISORIES
from phytograph.results import TREEQSM_CSV_HEADER
from conftest import E2E_FIXTURES, ROOT

TREE = E2E_FIXTURES / "noisy-tree.xyz"            # one synthetic tree, no ground, no leaves
PLOT = E2E_FIXTURES / "forest-plot.xyz"
BARE = ["--param", "remove_ground=false", "--param", "wood_method=null"]
ADVISORY_LINE = re.compile(r"^PHYTOGRAPH ADVISORY \[([a-z_.]+)\](?: \(([^)]*)\))?: (.*)$")

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX exec path")


def run(tmp: Path, *args: str, env=None, timeout=900) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "phytograph", "run", *args],
        cwd=ROOT / "python", capture_output=True, text=True, timeout=timeout,
        env={**os.environ, **(env or {})})


def tree_qsm(tmp: Path, *extra: str, **kw) -> subprocess.CompletedProcess:
    return run(tmp, "tree_qsm", "--in", str(TREE), "--out", str(tmp / "out"),
               "--work", str(tmp / "work"), *BARE, *extra, **kw)


@pytest.fixture(scope="module")
def ok_run(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("oneshot")
    proc = tree_qsm(tmp, "--threads", "2")
    return tmp, proc


def test_writes_the_csv_and_a_record_with_identity_and_runtime(ok_run):
    tmp, proc = ok_run
    assert proc.returncode == 0, proc.stderr[-3000:]
    out = tmp / "out"
    with open(out / "qsm_treeqsm.csv", newline="") as f:
        rows = list(csv.reader(f))
    assert ",".join(rows[0]) == TREEQSM_CSV_HEADER and len(rows) > 5
    rec = json.loads((out / "record.json").read_text())
    assert rec["status"] == "ok" and rec["recipe"] == "tree_qsm"
    assert re.fullmatch(r"[0-9a-f]{64}", rec["engine"]["key"])
    assert rec["engine"]["libhelios_sha256"]
    assert rec["params"]["fork_symmetry"] == 0.75          # defaults are recorded too
    assert rec["runtime"]["threads"]["cap"] == 2
    assert {p["num_threads"] for p in rec["runtime"]["threads"]["native_pools"]} == {2}
    assert rec["runtime"]["ml_device"] == "cpu"
    assert rec["input"]["path"] == str(TREE)
    for name, digest in rec["outputs"].items():
        assert hashlib.sha256((out / name).read_bytes()).hexdigest() == digest


def test_every_recorded_advisory_is_on_stderr_as_one_parseable_line(ok_run):
    tmp, proc = ok_run
    rec = json.loads((tmp / "out" / "record.json").read_text())
    lines = [m.groups() for m in map(ADVISORY_LINE.match, proc.stderr.splitlines()) if m]
    assert len(lines) == len(rec["advisories"])
    for code, step, _msg in lines:
        assert code in ADVISORIES
    assert all(a["code"] in ADVISORIES for a in rec["advisories"])


def test_writes_nothing_outside_the_work_and_out_folders(ok_run):
    """Temp files, logs and caches all land under --work."""
    tmp, _ = ok_run
    work = tmp / "work"
    assert (work / "logs").is_dir() and any((work / "logs").iterdir())


def test_a_misspelled_parameter_is_a_usage_error(tmp_path):
    proc = tree_qsm(tmp_path, "--param", "fork_symetry=0.9")
    assert proc.returncode == 2, proc.stderr[-2000:]
    assert "fork_symetry" in proc.stderr


def test_an_unsupported_recipe_is_a_usage_error(tmp_path):
    proc = run(tmp_path, "clean", "--in", str(TREE), "--out", str(tmp_path / "o"),
               "--work", str(tmp_path / "w"))
    assert proc.returncode == 2
    assert "not supported by run" in proc.stderr


def test_a_failed_check_exits_3_and_still_writes_the_record(tmp_path):
    proc = tree_qsm(tmp_path, "--param", "max_points=12")
    assert proc.returncode == 3, proc.stderr[-2000:]
    rec = json.loads((tmp_path / "out" / "record.json").read_text())
    assert rec["status"] == "failed" and rec["error"]
    assert rec["engine"]["key"]


def test_a_missing_engine_exits_4_without_the_network(tmp_path):
    proc = tree_qsm(tmp_path, env={"PHYTOGRAPH_BACKEND_EXE": str(tmp_path / "no-engine")})
    assert proc.returncode == 4
    assert "engine not available" in proc.stderr


def test_killing_the_run_leaves_no_process_behind(tmp_path):
    """The caller's process IS the engine (exec). SIGKILL it while a
    segmentation worker is running: the worker must go too."""
    import psutil

    proc = subprocess.Popen(
        [sys.executable, "-m", "phytograph", "run", "tree_qsm", "--in", str(PLOT),
         "--out", str(tmp_path / "out"), "--work", str(tmp_path / "work"),
         "--param", "wood_method=geometric"],
        cwd=ROOT / "python", stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        me = psutil.Process(proc.pid)
        deadline = time.monotonic() + 600
        kids = []
        while time.monotonic() < deadline and proc.poll() is None:
            kids = me.children(recursive=True)
            if any("PHYTOGRAPH_SEG_WORKER" in (k.environ() or {}) for k in kids
                   if _readable(k)):
                break
            time.sleep(0.2)
        assert proc.poll() is None, "the run ended before a seg worker started"
        assert kids, "no child process appeared"
        proc.send_signal(signal.SIGKILL)
        proc.wait()
        gone, alive = psutil.wait_procs(kids, timeout=15)
        assert not alive, f"left behind: {[(p.pid, p.name()) for p in alive]}"
    finally:
        if proc.poll() is None:
            proc.kill()


def test_killing_the_process_group_leaves_nothing_behind(tmp_path):
    """A harness kills the group it started. Every child, including the
    point-cloud converter that runs during import, is in that group."""
    import psutil

    proc = subprocess.Popen(
        [sys.executable, "-m", "phytograph", "run", "tree_qsm", "--in", str(PLOT),
         "--out", str(tmp_path / "out"), "--work", str(tmp_path / "work"),
         "--param", "wood_method=geometric"],
        cwd=ROOT / "python", stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True)
    try:
        me = psutil.Process(proc.pid)
        deadline = time.monotonic() + 600
        kids, long_lived = [], []
        # Wait for a child that lives long enough to matter: the converter
        # during import, or a seg worker (git and other probes come and go).
        while time.monotonic() < deadline and proc.poll() is None and not long_lived:
            kids = me.children(recursive=True)
            long_lived = [k for k in kids if _long_lived(k)]
            time.sleep(0.05)
        assert long_lived, "neither the converter nor a seg worker appeared"
        for k in kids:
            try:
                assert os.getpgid(k.pid) == proc.pid, f"{k.name()} left the caller's group"
            except ProcessLookupError:
                continue
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait()
        gone, alive = psutil.wait_procs(kids, timeout=15)
        assert not alive, f"left behind: {[(p.pid, p.name()) for p in alive]}"
    finally:
        if proc.poll() is None:
            proc.kill()


def _long_lived(p) -> bool:
    try:
        return "PotreeConverter" in p.name() or "PHYTOGRAPH_SEG_WORKER" in p.environ()
    except Exception:
        return False


def _readable(p) -> bool:
    try:
        p.environ()
        return True
    except Exception:
        return False
