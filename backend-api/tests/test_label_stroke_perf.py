"""Timing of one label stroke on a large session. Run with PHYTOGRAPH_PERF=1.

A 12-stamp brush stroke on 30 M points took 4.2 s, all of it holding the global
session lock every other request waits on (the exact sphere test ran over every
point, once per stamp). The selection now culls to the stamps' bounding box and
runs outside the lock. Budgets are generous for a loaded dev machine; the point
is to catch a return to whole-cloud work, which is 10x over them.
"""
import os
import time

import numpy as np
import pytest

import main

pytestmark = pytest.mark.skipif(
    os.environ.get("PHYTOGRAPH_PERF") != "1", reason="set PHYTOGRAPH_PERF=1 to run")


class _TimedLock:
    def __init__(self, inner):
        self.inner, self.holds, self._t = inner, [], 0.0

    def __enter__(self):
        self.inner.acquire()
        self._t = time.perf_counter()
        return self

    def __exit__(self, *exc):
        self.holds.append(time.perf_counter() - self._t)
        self.inner.release()


def test_brush_stroke_on_30m_points(monkeypatch):
    n = 30_000_000
    rng = np.random.default_rng(0)
    sess = main.CloudSession(
        session_id="perf30m", source_path="<perf>", ascii_format=None, column_plan=None,
        positions=rng.uniform(0, 20, size=(n, 3)), colors=None, intensity=None,
        extras={}, extra_dims_meta=[], deleted=np.zeros(n, dtype=bool),
        deleted_history=[], octree_cache_id=None, created_at=time.time())
    main._cloud_sessions[sess.session_id] = sess
    lock = _TimedLock(main._cloud_session_lock)
    monkeypatch.setattr(main, "_cloud_session_lock", lock)
    try:
        def stroke(to_class, stroke_id):
            return main.LabelRegionRequest(strokes=[{
                "region": {"kind": "spheres_union",
                           "centers": [[5 + i * 0.3, 10, 10] for i in range(12)],
                           "radii": [0.4] * 12, "invert": False},
                "to_class": to_class, "stroke_id": stroke_id}])
        main.label_cloud_region(sess.session_id, stroke(64, "b1"))   # creates the column
        lock.holds.clear()
        t0 = time.perf_counter()
        res = main.label_cloud_region(sess.session_id, stroke(65, "b2"))
        total = time.perf_counter() - t0
        assert res["applied"][0]["changed_count"] > 0
        print(f"\n30M brush stroke: {total * 1000:.0f} ms, lock held max "
              f"{max(lock.holds) * 1000:.1f} ms")
        assert total < 0.8, f"stroke took {total:.2f} s"
        assert max(lock.holds) < 0.05, f"lock held {max(lock.holds) * 1000:.0f} ms"
    finally:
        main._cloud_sessions.pop(sess.session_id, None)
