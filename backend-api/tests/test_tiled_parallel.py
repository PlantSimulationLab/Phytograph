"""Tiles run on a spawn pool inside the seg worker, and the pool's answer is
the sequential answer.

The pool is exercised through `tile_pool_probe.py` in a FRESH interpreter
with PHYTOGRAPH_SEG_WORKER set - the conditions the real seg worker gives it.
It must not be opened from this pytest process: `main` is imported here with
libhelios (GLFW) and open3d loaded, and multiprocessing's POSIX launcher
forks before it execs, so a child can die in the post-fork window and leave
the pool blocked on its start-up pipe (observed as a hang after other tests
had exercised open3d's threads). `tiled.worker_count` therefore refuses a
pool outside a worker, which is pinned here too, along with the count policy
and the frozen entry point's guards.
"""
import json
import os
import sys
from pathlib import Path

import numpy as np
import pytest

import tiled

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND / "tools"))
PROBE = BACKEND / "tests" / "tile_pool_probe.py"


def _cloud(n, extent=40.0, seed=3):
    from make_big_cloud import _tree_centres, generate_chunk

    rng = np.random.default_rng(seed)
    centres = _tree_centres(rng, extent, 9)
    scanner = np.array([extent / 2, extent / 2, 1.6])
    return generate_chunk(rng, n, extent, centres, 0.5, 0.0, scanner)["xyz"]


def _probe(tool, pts, workers, tmp_path, tag):
    src = tmp_path / f"{tag}_pts.npy"
    out = tmp_path / f"{tag}_w{workers}.npy"
    meta = tmp_path / f"{tag}_w{workers}.json"
    if not src.exists():
        np.save(src, pts)
    env = {k: v for k, v in os.environ.items() if not k.startswith("PHYTOGRAPH_TILE")}
    env["PHYTOGRAPH_SEG_WORKER"] = "1"          # what the real worker sets; skips libhelios
    # posix_spawn, NOT subprocess.run: this pytest process has libhelios loaded,
    # and a fork-then-exec child dies with SIGSEGV in the post-fork window
    # (the same reason main._SegProc exists). posix_spawn never forks the
    # loaded image.
    log = tmp_path / f"{tag}_w{workers}.log"
    argv = [sys.executable, str(PROBE), tool, str(src), str(workers), str(out), str(meta)]
    fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    try:
        cwd = os.getcwd()
        os.chdir(BACKEND)
        try:
            pid = os.posix_spawn(sys.executable, argv, env,
                                 file_actions=[(os.POSIX_SPAWN_DUP2, fd, 1), (os.POSIX_SPAWN_DUP2, fd, 2)])
        finally:
            os.chdir(cwd)
    finally:
        os.close(fd)
    _, status = os.waitpid(pid, 0)
    code = os.waitstatus_to_exitcode(status)
    assert code == 0, f"probe exited {code}:\n{log.read_text()[-3000:]}"
    return np.load(out), json.loads(meta.read_text())


def test_pool_matches_in_process_runner(tmp_path):
    pts = np.random.default_rng(0).uniform(0, 40, (20_000, 3))
    seq, m1 = _probe("mean_z", pts, 1, tmp_path, "mz")
    par, m2 = _probe("mean_z", pts, 2, tmp_path, "mz")
    assert m1["workers"] == 1 and m2["workers"] == 2 and m2["tiles"] >= 4
    np.testing.assert_array_equal(par, seq)


def test_row_map_gathers_from_a_larger_file(tmp_path, monkeypatch):
    """`staged_points` with `file_rows` reuses the worker's staged file even
    when the plan covers a subset of its rows (denoise drops non-finite rows)."""
    rng = np.random.default_rng(1)
    all_pts = rng.uniform(0, 40, (5000, 3))
    finite = rng.random(5000) < 0.9
    usable = all_pts[finite]
    full = tmp_path / "input.npy"
    np.save(full, all_pts)
    monkeypatch.setenv("PHYTOGRAPH_TILE_POINTS_NPY", str(full))
    with tiled.staged_points(usable, file_rows=np.flatnonzero(finite)) as (path, rows):
        assert path == str(full) and rows is not None
        plan = tiled.TilePlan.build(usable[:, :2], tile_m=10.0, buffer_m=1.0)
        # Build the tasks the pool would run and execute them in-process.
        for tile in plan.tiles():
            idx, core = plan.gather(tile)
            out_idx, res = tiled._tile_task((path, rows[idx], idx[core], core,
                                             "tests.test_tiled_parallel", "mean_z_job", {}))
            np.testing.assert_array_equal(out_idx, idx[core])
            assert res.shape[0] == int(core.sum())
    monkeypatch.delenv("PHYTOGRAPH_TILE_POINTS_NPY")
    with tiled.staged_points(usable) as (path, rows):
        assert rows is None and path.endswith(".npy") and np.load(path).shape == usable.shape


def mean_z_job(chunk, core):
    return np.full(len(chunk), int(round(chunk[:, 2].mean() * 1000)), dtype=np.int32)


def test_worker_count_policy(monkeypatch):
    monkeypatch.delenv("PHYTOGRAPH_TILE_WORKERS", raising=False)
    monkeypatch.delenv("PHYTOGRAPH_SEG_WORKER", raising=False)
    # Outside a seg worker: never a pool, whatever the machine.
    assert tiled.worker_count(64, per_worker_bytes=1, budget_bytes=10 ** 12) == 1
    monkeypatch.setenv("PHYTOGRAPH_SEG_WORKER", "/tmp/x")
    assert tiled.worker_count(2, per_worker_bytes=1, budget_bytes=10 ** 12) == 1
    n = tiled.worker_count(64, per_worker_bytes=200 * 2 ** 20, budget_bytes=64 * 2 ** 30)
    assert 1 <= n <= (os.cpu_count() or 1)
    # Memory bound: 1 GB budget, 600 MB per worker incl. baseline -> 1.
    assert tiled.worker_count(64, per_worker_bytes=200 * 2 ** 20, budget_bytes=2 ** 30) == 1
    monkeypatch.setenv("PHYTOGRAPH_TILE_WORKERS", "3")
    assert tiled.worker_count(64, per_worker_bytes=1, budget_bytes=1) == 3


def test_ground_segmentation_pool_equals_sequential(tmp_path):
    pytest.importorskip("CSF")
    xyz = _cloud(60_000)
    seq, m1 = _probe("ground", xyz, 1, tmp_path, "ground")
    par, m2 = _probe("ground", xyz, 2, tmp_path, "ground")
    assert m1["workers"] == 1 and m1["tiles"] >= 4
    assert m2["workers"] == 2
    np.testing.assert_array_equal(par, seq)


@pytest.mark.parametrize("method", ["ror", "voxel_count"])
def test_denoise_pool_equals_sequential(tmp_path, method):
    xyz = _cloud(40_000)
    seq, m1 = _probe(method, xyz, 1, tmp_path, method)
    par, m2 = _probe(method, xyz, 2, tmp_path, method)
    assert m1["workers"] == 1 and m2["workers"] == 2
    np.testing.assert_array_equal(par, seq)


def test_frozen_entry_point_guards_pool_children():
    src = (BACKEND / "backend_wrapper.py").read_text()
    assert "_mp.freeze_support()" in src
    i_freeze = src.index("_mp.freeze_support()")
    i_dispatch = src.index("if _SEG_WORKER_DIR and __name__ == \"__main__\":")
    assert i_freeze < i_dispatch
    assert "if _SEG_WORKER_DIR:\n" not in src
