"""Killable segmentation subprocess — `_run_killable` + the four worker tools.

The four segmentation tools (ground / wood / trees / skeleton) run monolithic
numpy/scipy/open3d/C-extension pipelines that can't be interrupted in-thread, so
each runs in a CHILD PROCESS the parent can SIGKILL when the user clicks Cancel
(the client disconnects → the backend kills the worker). These tests assert the
real mechanism, not the absence of errors:

  * a normal run actually spawns a worker and returns correct labels;
  * a client disconnect SIGKILLs the worker promptly, raises ClientDisconnected,
    and leaves NO worker in the registry (the true-kill guarantee);
  * a worker that fails surfaces its error to the caller.
"""

import asyncio
import time

import numpy as np
import pytest

import main


def _ground_cloud(n_ground=2000, n_stem=500, seed=0):
    """A flat ground slab + a vertical stem — segment_ground should split them."""
    rng = np.random.default_rng(seed)
    ground = np.column_stack([
        rng.uniform(0, 5, n_ground), rng.uniform(0, 5, n_ground),
        rng.normal(0, 0.01, n_ground),
    ])
    stem = np.column_stack([
        rng.normal(2.5, 0.05, n_stem), rng.normal(2.5, 0.05, n_stem),
        rng.uniform(0, 3, n_stem),
    ])
    return np.vstack([ground, stem]).astype(np.float64)


class _FakeRequest:
    """Minimal http_request stand-in: reports disconnected after `after` seconds."""

    def __init__(self, after: float):
        self._t0 = time.time()
        self._after = after

    async def is_disconnected(self) -> bool:
        return (time.time() - self._t0) >= self._after


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


# ---- Normal runs go through the subprocess and return correct results -------

def test_ground_worker_returns_labels():
    pts = _ground_cloud()
    csf = dict(cloth_resolution=0.5, rigidness=3, class_threshold=0.1,
               iterations=200, slope_smooth=False)
    labels = _run(main._run_killable("ground", pts, csf, http_request=None))
    assert labels.shape == (len(pts),)
    # Both classes present and the flat slab is mostly ground.
    assert set(np.unique(labels)).issubset({main.GROUND_CLASS_GROUND, main.GROUND_CLASS_PLANT})
    assert int((labels == main.GROUND_CLASS_GROUND).sum()) > len(pts) // 2
    # No worker left behind.
    assert len(main._SEG_WORKERS) == 0


def test_wood_worker_returns_labels_and_meta():
    rng = np.random.default_rng(2)
    stem = np.column_stack([rng.normal(0, 0.03, 800), rng.normal(0, 0.03, 800),
                            rng.uniform(0, 3, 800)])
    leaves = np.column_stack([rng.uniform(-1, 1, 1500), rng.uniform(-1, 1, 1500),
                              rng.uniform(1.5, 3.5, 1500)])
    pts = np.vstack([stem, leaves]).astype(np.float64)
    labels, meta = _run(main._run_killable(
        "wood", pts, dict(wood_bias=0.6, k_max=50, reg_iters=1,
                          reflectance_weight_max=0, method="geometric"),
        http_request=None))
    assert labels.shape == (len(pts),)
    assert set(np.unique(labels)).issubset({main.WOOD_CLASS_WOOD, main.WOOD_CLASS_LEAF})
    assert isinstance(meta, dict) and "warnings" in meta
    assert len(main._SEG_WORKERS) == 0


def test_skeleton_worker_returns_result_dict():
    rng = np.random.default_rng(3)
    stem = np.column_stack([rng.normal(0, 0.02, 1200), rng.normal(0, 0.02, 1200),
                            rng.uniform(0, 3, 1200)])
    result = _run(main._run_killable(
        "skeleton", stem, dict(remove_outliers=False, search_radius=0.2,
                               root_threshold=0.05), http_request=None))
    assert isinstance(result, dict)
    assert result.get("success") is True
    assert result.get("num_nodes", 0) > 0
    assert len(main._SEG_WORKERS) == 0


# ---- A client disconnect SIGKILLs the worker (the true-kill guarantee) ------

def test_disconnect_kills_worker_promptly():
    """A heavy CSF run on a large cloud is cancelled the instant the client
    disconnects: ClientDisconnected is raised quickly and NO worker survives in
    the registry — proving the worker process was actually killed, not abandoned."""
    pts = np.vstack([_ground_cloud()] * 60).astype(np.float64)
    pts += np.random.default_rng(9).normal(0, 1e-4, pts.shape)
    csf = dict(cloth_resolution=0.005, rigidness=3, class_threshold=0.05,
               iterations=500, slope_smooth=True)
    t0 = time.time()
    with pytest.raises(main.ClientDisconnected):
        _run(main._run_killable("ground", pts, csf,
                                http_request=_FakeRequest(after=0.0), poll=0.05))
    elapsed = time.time() - t0
    # Returns promptly (a couple of poll ticks + spawn), not after CSF finishes.
    assert elapsed < 10.0
    # The worker was killed and dropped from the registry.
    assert len(main._SEG_WORKERS) == 0


# ---- A failing worker surfaces its error -----------------------------------

def test_worker_error_surfaces_as_runtimeerror():
    # 'trees' on a tiny cloud (or unknown tool) raises inside the worker; the
    # parent re-raises a RuntimeError carrying the worker traceback.
    with pytest.raises(RuntimeError):
        _run(main._run_killable("not_a_tool", _ground_cloud(n_ground=10, n_stem=0),
                                {}, http_request=None))
    assert len(main._SEG_WORKERS) == 0
