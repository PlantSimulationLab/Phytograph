"""Poisson runs in a child process so an Open3D segfault can't kill the backend.

Open3D 0.19.0's `create_from_point_cloud_poisson` segfaults inside its own
OpenMP microtask on roughly 6% of calls. Measured on macOS/arm64: 28/30 survived
a single-call trial in a bare interpreter, with the whole crash stack in open3d's
pybind + libomp `__kmp_invoke_microtask`. It is NOT caused by pyhelios' libomp
(it reproduces with pyhelios absent), NOT by running off the main thread (it
reproduces on the main thread), and OMP_NUM_THREADS=1 does not help.

In-process that SIGSEGV takes the whole backend down mid-session. `main._run_poisson_isolated`
therefore runs the reconstruction in the seg-worker child, so the crash becomes a
non-zero exit that surfaces as an ordinary failed-triangulation response.

These tests pin the containment, not the Open3D bug itself: a real Poisson still
has to produce a real mesh, and a crashing child must degrade to a clean error
rather than taking the process with it.
"""

import numpy as np
import pytest

import main

from tests.binframe import decode_bin_frame


def _sphere(n=2000):
    """Fibonacci-sphere point cloud — a closed surface Poisson can reconstruct."""
    i = np.arange(n) + 0.5
    phi = np.arccos(1 - 2 * i / n)
    theta = np.pi * (1 + 5 ** 0.5) * i
    return np.c_[
        np.cos(theta) * np.sin(phi),
        np.sin(theta) * np.sin(phi),
        np.cos(phi),
    ]


def test_poisson_runs_out_of_process_and_returns_a_real_mesh(client):
    """The isolated path is wired into the endpoint and still reconstructs the
    surface — isolation must not change the result."""
    pts = _sphere().tolist()
    for attempt in range(_POISSON_ATTEMPTS):
        res = client.post(
            "/api/triangulate",
            json={"method": "poisson", "points": pts, "depth": 8},
        )
        assert res.status_code == 200
        body, _ = decode_bin_frame(res.content)
        if body["success"]:
            break
        # Only the known upstream segfault may be retried (see _poisson_with_retry).
        err = str(body.get("error"))
        assert "crashed inside Open3D" in err, err
        # Even when it crashes, the endpoint answered 200 with a structured error
        # instead of the connection dying with the backend — the whole point.
        assert attempt < _POISSON_ATTEMPTS - 1, f"crashed every attempt: {err}"
    assert body["success"] is True, body.get("error")
    # A closed sphere at depth 8 is a few thousand triangles — assert a real
    # surface came back, not an empty/degenerate mesh.
    assert body["num_triangles"] > 500, body["num_triangles"]
    assert body["num_vertices"] > 250, body["num_vertices"]


def _sphere_normals(pts):
    """Outward unit normals — Poisson requires them (the endpoint estimates them
    in the parent before handing the cloud to the child)."""
    return pts / np.linalg.norm(pts, axis=1, keepdims=True)


# The Open3D crash this module exists to contain hits ~6% of Poisson calls, so a
# test that runs a REAL Poisson once would itself flake ~6% of the time. Retrying
# is legitimate here rather than a papered-over failure: the crash is precisely
# the documented upstream bug, the retry is what the tool tells users to do, and
# the graceful-degradation contract is pinned separately (and deterministically)
# by the monkeypatched crash tests below. Three attempts leaves a ~0.02% flake.
_POISSON_ATTEMPTS = 3


def _poisson_with_retry(fn):
    """Run `fn` (one real Poisson call), retrying only the known Open3D segfault.
    Any other error fails immediately — this must not mask real regressions."""
    last = None
    for _ in range(_POISSON_ATTEMPTS):
        try:
            return fn()
        except RuntimeError as exc:  # noqa: PERF203
            if "crashed inside Open3D" not in str(exc):
                raise
            last = exc
    pytest.fail(f"Poisson crashed on all {_POISSON_ATTEMPTS} attempts: {last}")


def test_poisson_helper_returns_arrays_matching_the_mesh():
    """`_run_poisson_isolated` returns (vertices, triangles, densities) with one
    density per vertex — the contract the density-filtering step depends on."""
    pts = _sphere()
    verts, tris, densities = _poisson_with_retry(
        lambda: main._run_poisson_isolated(pts, _sphere_normals(pts), 8)
    )
    assert verts.ndim == 2 and verts.shape[1] == 3
    assert tris.ndim == 2 and tris.shape[1] == 3
    # One density per vertex, or the quantile mask would misalign.
    assert densities.shape == (len(verts),)
    # Triangle indices must address the returned vertex array.
    assert tris.min() >= 0 and tris.max() < len(verts)


def test_worker_crash_becomes_an_error_not_a_dead_backend(client, monkeypatch):
    """The containment contract: when the child dies on a signal (returncode -11
    is the real SIGSEGV this guards against), the parent raises a descriptive
    RuntimeError and keeps serving — it does not die with the child."""

    class _CrashedProc:
        """Stands in for a worker killed by SIGSEGV — no error.txt, no stderr,
        exactly the state the real Open3D crash leaves behind."""
        pid = -1
        returncode = -11

        def wait(self):
            return self.returncode

        def poll(self):
            return self.returncode

    monkeypatch.setattr(main, "_spawn_seg_worker", lambda env, log: _CrashedProc())

    with pytest.raises(RuntimeError) as excinfo:
        main._run_poisson_isolated(_sphere(), None, 8)
    msg = str(excinfo.value)
    # The message must name the cause and the workaround, since the user sees it.
    assert "-11" in msg
    assert "Open3D" in msg
    assert "Ball Pivoting" in msg

    # The parent is still alive and serving: a normal request still succeeds.
    res = client.post(
        "/api/triangulate",
        json={"method": "ball_pivoting", "points": _sphere().tolist()},
    )
    assert res.status_code == 200
    body, _ = decode_bin_frame(res.content)
    assert body["success"] is True, body.get("error")


def test_worker_that_exits_clean_without_writing_a_mesh_is_still_an_error(monkeypatch):
    """Success is judged by the OUTPUTS, not the exit code.

    `_SegProc.wait()` can leave `returncode` as None when the pid was already
    reaped elsewhere (shutdown reaper, or a racing poll()). `None != 0` would
    sail past an exit-code-only guard and then die on a bare FileNotFoundError
    for vertices.npy — which is exactly how this surfaced in the packaged build.
    A child that writes no mesh must raise the descriptive error instead."""

    class _SilentProc:
        """Exits 'cleanly' (and with an unknown code) but writes nothing."""
        pid = -515151
        returncode = None

        def wait(self):
            return None

        def poll(self):
            return None

    monkeypatch.setattr(main, "_spawn_seg_worker", lambda env, log: _SilentProc())

    with pytest.raises(RuntimeError) as excinfo:
        main._run_poisson_isolated(_sphere(), None, 8)
    # The descriptive message, NOT a FileNotFoundError leaking from np.load.
    assert "Open3D" in str(excinfo.value)


def test_crashed_worker_is_not_left_in_the_reaper_registry(monkeypatch):
    """A crashed worker must be removed from `_SEG_WORKERS`, or shutdown would
    try to reap a pid that is already gone (and the dict would leak per call)."""

    class _CrashedProc:
        pid = -424242
        returncode = -11

        def wait(self):
            return self.returncode

        def poll(self):
            return self.returncode

    monkeypatch.setattr(main, "_spawn_seg_worker", lambda env, log: _CrashedProc())

    with pytest.raises(RuntimeError):
        main._run_poisson_isolated(_sphere(), None, 8)

    assert _CrashedProc.pid not in main._SEG_WORKERS
