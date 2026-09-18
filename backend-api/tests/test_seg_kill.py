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
    # Like `wood`, the ground worker returns (labels, meta); meta carries the
    # class_threshold actually applied so the panel can show what auto mode chose.
    labels, meta = _run(main._run_killable("ground", pts, csf, http_request=None))
    assert labels.shape == (len(pts),)
    assert meta["class_threshold"] == pytest.approx(0.1)
    assert meta["method"] == "manual"
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


# ── The orphan case: the backend dies, the worker must not survive ──────────
#
# `_SegProc` spawns each worker with `posix_spawn(..., setpgroup=0)` so a Cancel
# can killpg it without taking down the backend. That split is load-bearing --
# and it also means the supervisor's `process.kill(-pid)` (the BACKEND's group)
# never reaches a worker. The only other cleanup was
# `atexit.register(reap_seg_workers)`, which needs a graceful Python exit, so an
# abrupt backend death (SIGKILL after stopBackend's 1.5s grace, an OOM kill, a
# native crash) left a multi-GB compute running with no parent. They stack
# across launches.

def test_a_worker_is_spawned_into_its_own_process_group():
    """Pins the premise: the supervisor signals the BACKEND's group
    (`process.kill(-pid)` in src/main/backend.ts), and `setpgroup=0` puts each
    worker outside it — which is WHY the watchdog below has to exist. Asserted
    against the source, since observing it needs a live spawn whose inherited
    stdout would outlive the test. If this ever stops being true the orphan
    problem changes shape and the watchdog should be re-justified."""
    import inspect
    import re

    src = inspect.getsource(main._SegProc.spawn if hasattr(main._SegProc, "spawn")
                            else main._SegProc)
    assert re.search(r"posix_spawn\(.*setpgroup=0", src, re.S), (
        "the worker is no longer spawned into its own process group"
    )


def test_the_worker_exits_when_its_parent_dies():
    """The fix, driven as a real orphan: spawn a watchdog-running grandchild
    into its own group (exactly as _SegProc does), SIGKILL its parent so no
    atexit runs, and require the grandchild to reap itself."""
    import os
    import signal
    import subprocess
    import sys
    import tempfile
    import textwrap
    import time as _time

    worker_dir = str(main._Path(main.__file__).resolve().parent)
    with tempfile.TemporaryDirectory() as td:
        pidfile = os.path.join(td, "worker.pid")
        worker = os.path.join(td, "w.py")
        with open(worker, "w") as f:
            f.write(textwrap.dedent(f"""
                import os, sys, time
                sys.path.insert(0, {worker_dir!r})
                from seg_worker import _watch_parent
                _watch_parent(poll_s=0.2)
                open({pidfile!r}, "w").write(str(os.getpid()))
                time.sleep(60)
            """))
        parent_src = os.path.join(td, "p.py")
        with open(parent_src, "w") as f:
            f.write(textwrap.dedent(f"""
                import os, sys, time
                argv = [sys.executable, {worker!r}]
                os.posix_spawn(argv[0], argv, os.environ, setpgroup=0)
                time.sleep(60)
            """))

        parent = subprocess.Popen([sys.executable, parent_src])
        try:
            deadline = _time.time() + 20
            while _time.time() < deadline and not os.path.exists(pidfile):
                _time.sleep(0.05)
            assert os.path.exists(pidfile), "worker never started"
            wpid = int(open(pidfile).read())
            assert os.getpgid(wpid) != os.getpgid(parent.pid), "not orphan-shaped"

            os.kill(parent.pid, signal.SIGKILL)   # no atexit, no group reach
            parent.wait(timeout=10)

            deadline = _time.time() + 20
            alive = True
            while _time.time() < deadline:
                _time.sleep(0.1)
                try:
                    os.kill(wpid, 0)
                except OSError:
                    alive = False
                    break
            if alive:
                os.kill(wpid, signal.SIGKILL)     # don't leak from the test itself
            assert not alive, (
                "the worker outlived its backend: a multi-GB compute with no "
                "parent, which is exactly the orphan this watchdog prevents"
            )
        finally:
            if parent.poll() is None:
                parent.kill()
