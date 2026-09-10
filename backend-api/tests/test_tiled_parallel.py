"""Tiles run on a spawn pool, and the pool's answer is the sequential answer.

Pinned: the pool runner scatters exactly what the in-process runner does
(including through a row map onto a larger file), the worker-count policy,
that ground segmentation and denoising take the pool when it is enabled,
and that a pool child never re-enters the seg-worker dispatch (the
`__name__` guard in backend_wrapper).
"""
import os
import sys
from pathlib import Path

import numpy as np
import pytest

import tiled

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND / "tools"))


def mean_z_job(chunk, core):
    return np.full(len(chunk), int(round(chunk[:, 2].mean() * 1000)), dtype=np.int32)


def test_pool_matches_in_process_runner_with_and_without_a_row_map(tmp_path, monkeypatch):
    rng = np.random.default_rng(0)
    all_pts = rng.uniform(0, 40, (20_000, 3))
    finite = rng.random(20_000) < 0.9
    usable = all_pts[finite]
    plan = tiled.TilePlan.build(usable[:, :2], tile_m=10.0, buffer_m=1.0)
    ref = tiled.run_tiled(plan, usable, mean_z_job)

    # Temporary file staged by the context manager (no env file).
    monkeypatch.delenv("PHYTOGRAPH_TILE_POINTS_NPY", raising=False)
    with tiled.staged_points(usable) as (path, rows):
        assert rows is None and path.endswith(".npy")
        out = tiled.run_tiled_parallel(plan, path, ("tests.test_tiled_parallel", "mean_z_job"), workers=2)
    np.testing.assert_array_equal(out, ref)

    # The worker's staged input, with a row map onto it.
    full = tmp_path / "input.npy"
    np.save(full, all_pts)
    monkeypatch.setenv("PHYTOGRAPH_TILE_POINTS_NPY", str(full))
    with tiled.staged_points(usable, file_rows=np.flatnonzero(finite)) as (path, rows):
        assert path == str(full) and rows is not None
        prog = []
        out2 = tiled.run_tiled_parallel(plan, path, ("tests.test_tiled_parallel", "mean_z_job"),
                                        workers=2, file_rows=rows, progress=lambda f, m: prog.append(f))
    np.testing.assert_array_equal(out2, ref)
    assert prog[-1] == 1.0 and len(prog) == len(plan.tiles())


def test_worker_count_policy(monkeypatch):
    monkeypatch.delenv("PHYTOGRAPH_TILE_WORKERS", raising=False)
    assert tiled.worker_count(2, per_worker_bytes=1, budget_bytes=10 ** 12) == 1
    n = tiled.worker_count(64, per_worker_bytes=200 * 2 ** 20, budget_bytes=64 * 2 ** 30)
    assert 1 <= n <= (os.cpu_count() or 1)
    # Memory bound: 1 GB budget, 600 MB per worker incl. baseline -> 1.
    assert tiled.worker_count(64, per_worker_bytes=200 * 2 ** 20, budget_bytes=2 ** 30) == 1
    monkeypatch.setenv("PHYTOGRAPH_TILE_WORKERS", "3")
    assert tiled.worker_count(64, per_worker_bytes=1, budget_bytes=1) == 3


def _cloud(n, extent=40.0, seed=3):
    from make_big_cloud import _tree_centres, generate_chunk

    rng = np.random.default_rng(seed)
    centres = _tree_centres(rng, extent, 9)
    scanner = np.array([extent / 2, extent / 2, 1.6])
    return generate_chunk(rng, n, extent, centres, 0.5, 0.0, scanner)["xyz"]


def test_ground_segmentation_pool_equals_sequential(monkeypatch):
    pytest.importorskip("CSF")
    import main

    xyz = _cloud(60_000)
    monkeypatch.setenv("PHYTOGRAPH_GROUND_TILE_MIN_POINTS", "0")
    monkeypatch.setenv("PHYTOGRAPH_GROUND_TILE_TARGET_POINTS", "10000")
    monkeypatch.delenv("PHYTOGRAPH_TILE_POINTS_NPY", raising=False)
    monkeypatch.setenv("PHYTOGRAPH_TILE_WORKERS", "1")
    meta_s: dict = {}
    seq = main.segment_ground(xyz, cloth_resolution=0.1, class_threshold=0.1, meta=meta_s)
    assert meta_s["tiled"]["workers"] == 1 and meta_s["tiled"]["tiles"] >= 4
    monkeypatch.setenv("PHYTOGRAPH_TILE_WORKERS", "2")
    meta_p: dict = {}
    par = main.segment_ground(xyz, cloth_resolution=0.1, class_threshold=0.1, meta=meta_p)
    assert meta_p["tiled"]["workers"] == 2
    np.testing.assert_array_equal(par, seq)


def test_denoise_pool_equals_sequential(monkeypatch):
    import denoise

    xyz = _cloud(40_000)
    monkeypatch.setenv("PHYTOGRAPH_DENOISE_TILE_MIN_POINTS", "0")
    monkeypatch.setenv("PHYTOGRAPH_DENOISE_TILE_TARGET_POINTS", "5000")
    monkeypatch.delenv("PHYTOGRAPH_TILE_POINTS_NPY", raising=False)
    for method in ("ror", "voxel_count"):
        monkeypatch.setenv("PHYTOGRAPH_TILE_WORKERS", "1")
        keep_s, st_s = denoise.denoise_mask(xyz, method, {})
        monkeypatch.setenv("PHYTOGRAPH_TILE_WORKERS", "2")
        keep_p, st_p = denoise.denoise_mask(xyz, method, {})
        assert st_s["tiled"]["workers"] == 1 and st_p["tiled"]["workers"] == 2
        np.testing.assert_array_equal(keep_p, keep_s, err_msg=method)


def test_frozen_entry_point_guards_pool_children():
    src = (BACKEND / "backend_wrapper.py").read_text()
    assert "_mp.freeze_support()" in src
    i_freeze = src.index("_mp.freeze_support()")
    i_dispatch = src.index("if _SEG_WORKER_DIR and __name__ == \"__main__\":")
    assert i_freeze < i_dispatch
    assert "if _SEG_WORKER_DIR:\n" not in src
