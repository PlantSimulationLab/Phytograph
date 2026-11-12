"""PHYTOGRAPH_THREADS caps every thread pool the engine uses (thread_cap.py)."""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

import thread_cap

ROOT = Path(__file__).resolve().parent.parent
SKIP_DIRS = {"venv", "tests", "research", "build", "dist", "__pycache__"}


def _engine_sources():
    for path in ROOT.rglob("*.py"):
        rel = path.relative_to(ROOT)
        if rel.parts[0] in SKIP_DIRS or rel.name == "thread_cap.py":
            continue
        yield rel, path.read_text(encoding="utf-8", errors="replace")


def test_no_pool_sizes_itself_from_the_machine():
    """Every core count and every cKDTree worker count goes through thread_cap,
    so the cap reaches it. The request limiter is the one deliberate exception."""
    offenders = []
    for rel, text in _engine_sources():
        for no, line in enumerate(text.splitlines(), 1):
            code = line.split("#", 1)[0]
            if re.search(r"workers\s*=\s*-1", code):
                offenders.append(f"{rel}:{no}: {line.strip()}")
            if re.search(r"\bcpu_count\(\)", code) and "thread_cap." not in code \
                    and "thread_cap: request concurrency" not in line:
                offenders.append(f"{rel}:{no}: {line.strip()}")
    assert not offenders, "size these through thread_cap:\n" + "\n".join(offenders)


def test_unset_means_uncapped(monkeypatch):
    monkeypatch.delenv(thread_cap.ENV, raising=False)
    assert thread_cap.cap() is None
    assert thread_cap.kd_workers() == -1
    assert thread_cap.pool_size(8) == 8


def test_cap_bounds_pools(monkeypatch):
    monkeypatch.setenv(thread_cap.ENV, "3")
    assert thread_cap.cap() == 3
    assert thread_cap.cpu_count() == 3
    assert thread_cap.kd_workers() == 3
    assert thread_cap.pool_size(8) == 3
    assert thread_cap.pool_size(2) == 2


@pytest.mark.parametrize("raw", ["0", "-2", "four", "1.5"])
def test_a_bad_cap_is_an_error_not_every_core(monkeypatch, raw):
    monkeypatch.setenv(thread_cap.ENV, raw)
    with pytest.raises(ValueError, match=thread_cap.ENV):
        thread_cap.cap()


PROBE = """
import json, sys
sys.path.insert(0, sys.argv[1])
import main, thread_cap
from threadpoolctl import threadpool_info
print(json.dumps({"pools": [p["num_threads"] for p in threadpool_info()]}))
"""


def test_importing_the_engine_under_a_cap_pins_every_native_pool():
    """main.py applies the cap before numpy loads, so the BLAS/OpenMP pools
    open3d, scipy and sklearn bring in all start at the cap."""
    env = dict(os.environ, PHYTOGRAPH_THREADS="2")
    for var in thread_cap.NATIVE_VARS:
        env.pop(var, None)
    proc = subprocess.run([sys.executable, "-c", PROBE, str(ROOT)], env=env,
                          capture_output=True, text=True, timeout=300)
    assert proc.returncode == 0, proc.stderr[-2000:]
    report = json.loads(proc.stdout.strip().splitlines()[-1])
    assert report["pools"], "no native thread pools were loaded"
    assert set(report["pools"]) == {2}, report
