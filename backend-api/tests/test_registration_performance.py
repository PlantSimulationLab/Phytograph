"""Performance guards for the registration path.

Every number here was a real regression found on real data (a 4-scan RIEGL
almond survey). They are asserted loosely — the point is to catch a return to
the pathological behaviour, not to police normal variation on a busy machine.
"""

import time

import numpy as np
import pytest

import main
import anchor_extraction as ae


def _orchard(n=120_000, seed=0):
    """A plot-sized cloud: ground plus scattered canopy over ~60 m."""
    rng = np.random.default_rng(seed)
    g = rng.uniform(-30, 30, (n // 2, 2))
    ground = np.column_stack([g, rng.normal(0, 0.05, len(g))])
    trees = []
    for _ in range(25):
        cx, cy = rng.uniform(-25, 25, 2)
        k = (n - len(ground)) // 25
        v = rng.normal(size=(k, 3))
        v /= np.linalg.norm(v, axis=1, keepdims=True)
        trees.append(np.column_stack([cx + v[:, 0] * 1.8, cy + v[:, 1] * 1.8,
                                      3.0 + v[:, 2] * 1.5]))
    return np.vstack([ground] + trees)


def test_ground_removal_is_not_a_terrain_model():
    """Anchor extraction must not run the cloth-simulation filter.

    CSF builds a full terrain MODEL. Extraction only needs to know which points
    are ground, and the difference is enormous: measured on a real 40 m-radius
    orchard scan at 200k points, CSF took **396 s** while a per-cell height cut
    did the same job in **0.08 s**. CSF was 93% of the entire extraction time
    and made the tool unusable on real scans."""
    cloud = _orchard()
    start = time.perf_counter()
    non_ground = ae._drop_ground(cloud, main._robust_cloud_diagonal(cloud))
    elapsed = time.perf_counter() - start

    assert 0 < len(non_ground) < len(cloud), "ground removal did nothing"
    # Two orders of magnitude of headroom over the CSF path it replaced.
    assert elapsed < 5.0, f"ground removal took {elapsed:.1f}s — is CSF back?"


def test_both_clouds_are_extracted_in_one_worker():
    """Starting the killable worker costs ~4.3 s, because it re-imports main.py
    and the native library. Extracting target and source in separate calls paid
    that twice — ~8.6 s of pure overhead on ~4 s of real work, and it was the
    single largest cost in a registration. One call must handle both."""
    calls = {"n": 0}
    real = main._SegProc

    class Counting(real):
        def __init__(self, *a, **k):
            calls["n"] += 1
            super().__init__(*a, **k)

    a, b = _orchard(seed=1), _orchard(seed=2)
    main._SegProc = Counting
    try:
        main._do_global_register(main.GlobalRegisterRequest(
            target_points=a.ravel().tolist(), source_points=b.ravel().tolist(),
            scene_type="agriculture", anchor_method="crown"), progress=None)
    finally:
        main._SegProc = real

    assert calls["n"] <= 1, (
        f"spawned {calls['n']} workers; both clouds must share one "
        "(~4.3 s of startup each)")


def test_scene_check_runs_before_the_expensive_stage():
    """The whole value of the scene-type check is that a wrong choice costs a
    moment instead of a full extraction. If it ever moved after the slow work it
    would still be *correct* and completely pointless, so the cost is the
    assertion."""
    from scene_classify import classify_scene

    cloud = _orchard()
    start = time.perf_counter()
    observed = classify_scene(cloud)
    elapsed = time.perf_counter() - start

    assert observed["scene_type"] is not None
    assert elapsed < 3.0, f"scene check took {elapsed:.1f}s — too slow to gate on"
