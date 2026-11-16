"""Wood/leaf segmentation past the downsample cap: memory and its admission.

After classifying a downsampled cloud, `segment_wood` propagates the labels to
every point and regularizes them at full resolution. That pass used one
whole-cloud k-NN query (float64 distances + int64 indices + an int32 copy) and
an (N, k) float64 gather per vote: 744 B per point by exact allocation count,
while the worker was admitted at a flat 56 B per point. These pin the
block-wise replacement and the admission that now charges what it uses.
"""

import asyncio
import tracemalloc

import numpy as np
import pytest
from scipy.spatial import cKDTree

import main


def _cloud(n, seed=0):
    rng = np.random.default_rng(seed)
    pts = rng.uniform(0, 30, (n, 3))
    labels = np.where(rng.random(n) < 0.3, main.WOOD_CLASS_WOOD, main.WOOD_CLASS_LEAF).astype(np.int32)
    return pts, labels


@pytest.mark.parametrize("k,iters", [(20, 3), (7, 2), (2, 1)])
def test_block_wise_vote_equals_the_reference(monkeypatch, k, iters):
    pts, labels = _cloud(60_000)
    monkeypatch.setattr(main, "_WOOD_FULL_RES_BLOCK", 9_999)   # many blocks
    _, idx = cKDTree(pts).query(pts, k=k)
    want = main._wood_regularize(labels, idx.astype(np.int32), k, iters)
    got = main._wood_regularize_full_res(labels, pts, k, iters)
    np.testing.assert_array_equal(got, want)


def test_full_resolution_pass_holds_no_cloud_sized_float_matrix():
    pts, labels = _cloud(1_000_000)
    tracemalloc.start()
    main._wood_regularize_full_res(labels, pts, 20, 3)
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    # The int32 neighbor table is 80 B/pt, plus block buffers that do not grow
    # with the cloud (~100 MB at the default block). The old pass peaked at
    # ~744 B/pt: 744 MB here.
    n = len(pts)
    assert peak < 120 * n + 160 * 2 ** 20, f"{peak / 2 ** 20:.0f} MB on {n:,} points"


def test_wood_is_admitted_at_its_real_working_set():
    n = 25_000_000
    generic = main._killable_worker_bytes(n)
    wood = main._killable_worker_bytes(n, tool="wood")
    cap = main._WOOD_SEGMENT_MAX_POINTS
    assert wood - generic == (main._WOOD_CORE_FIXED_BYTES
                              + main._WOOD_CORE_BYTES_PER_POINT * cap
                              + main._WOOD_FULL_RES_BYTES_PER_POINT * n)
    assert wood > 5 * 2 ** 30          # was 1.4 GB for a 25 M-point plot
    # Under the cap there is no full-resolution pass to charge.
    small = 100_000
    assert main._wood_compute_bytes(small) == (
        main._WOOD_CORE_FIXED_BYTES + main._WOOD_CORE_BYTES_PER_POINT * small)


def test_run_killable_charges_wood_its_own_estimate(monkeypatch):
    seen = {}

    class _Stop(Exception):
        pass

    class _Admit:
        def __init__(self, estimate, label):
            seen["estimate"] = estimate

        def __enter__(self):
            raise _Stop()

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(main._ADMISSION, "admit", lambda est, label, **_kw: _Admit(est, label))
    pts = np.zeros((2_000_000, 3))
    with pytest.raises(_Stop):
        asyncio.run(main._run_killable("wood", pts, {}))
    assert seen["estimate"] == main._killable_worker_bytes(len(pts), tool="wood")
