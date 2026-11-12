"""`run tree_qsm` gives byte-identical outputs run to run and across thread counts.

The record's `outputs` holds each output's sha256, so the comparison is
exactly what a harness caching on (engine key, inputs, parameters) relies on.
Measured on the leaf-off redbud scan (1.2 M points, ground + ML wood + QSM)
too; see docs/docs/guide/headless.md "Reproducibility"."""
from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest

from conftest import E2E_FIXTURES, ROOT

TREE = E2E_FIXTURES / "noisy-tree.xyz"

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX exec path")


def outputs(tmp, name: str, threads: int):
    d = tmp / name
    proc = subprocess.run(
        [sys.executable, "-m", "phytograph", "run", "tree_qsm", "--in", str(TREE),
         "--out", str(d / "out"), "--work", str(d / "work"), "--threads", str(threads),
         "--param", "remove_ground=false", "--param", "wood_method=null",
         "--param", "max_points=2000", "--param", "seed=7"],
        cwd=ROOT / "python", capture_output=True, text=True, timeout=1800, env=dict(os.environ))
    assert proc.returncode == 0, proc.stderr[-3000:]
    rec = json.loads((d / "out" / "record.json").read_text())
    assert rec["runtime"]["threads"]["cap"] == threads
    return rec["outputs"]


def test_same_inputs_same_bytes_and_thread_count_does_not_matter(tmp_path):
    a = outputs(tmp_path, "a", 2)
    b = outputs(tmp_path, "b", 2)
    assert a == b, "two runs with the same inputs and threads differ"
    c = outputs(tmp_path, "c", 1)
    d = outputs(tmp_path, "d", 4)
    assert a == c == d, "the thread count changed the output"
