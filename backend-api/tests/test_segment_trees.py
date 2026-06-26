"""Tree (individual-tree) instance segmentation tests (TreeIso).

`fixtures/multi_tree_small.xyz` is a voxel-downsampled excerpt of TreeIso's MIT
demo cloud (see fixtures/README.md). Columns: x y z treeiso_label. These tests
assert on a fresh re-run of the vendored engine (not on the stored label
column), so they validate the algorithm + endpoint rather than "didn't crash".
"""
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

import main

FIXTURE = Path(__file__).parent / "fixtures" / "multi_tree_small.xyz"
# Same cloud as a binary PLY carrying ground-truth `instance` + `semantic`
# vertex fields — mirrors the Cherlet TLS benchmark format, which is the data
# the eval harness actually runs on. Committed alongside the .xyz.
PLY_FIXTURE = Path(__file__).parent / "fixtures" / "multi_tree_small.ply"


def _treeiso_available() -> bool:
    try:
        import cut_pursuit_py  # noqa: F401
        from treeiso.treeiso_core import segment_trees  # noqa: F401
        return True
    except Exception:
        return False


def _plyfile_available() -> bool:
    try:
        import plyfile  # noqa: F401
        return True
    except Exception:
        return False


requires_treeiso = pytest.mark.skipif(
    not _treeiso_available(),
    reason="TreeIso deps not installed (cut_pursuit_py / vendored treeiso)",
)

requires_plyfile = pytest.mark.skipif(
    not _plyfile_available(), reason="plyfile not installed",
)


def _load_fixture():
    df = pd.read_csv(FIXTURE, sep=r"\s+", header=None, comment="#")
    points = df.iloc[:, :3].to_numpy(dtype=np.float64)
    ref = df.iloc[:, 3].to_numpy().astype(int) if df.shape[1] > 3 else None
    return points, ref


def _purity(pred, truth):
    shares = []
    for u in np.unique(pred):
        t = truth[pred == u]
        shares.append(np.bincount(t).max() / len(t))
    return float(np.mean(shares))


@requires_treeiso
def test_core_segments_multiple_trees_deterministically():
    from treeiso.treeiso_core import segment_trees, TreeIsoParams

    points, ref = _load_fixture()
    labels = segment_trees(points, TreeIsoParams())

    assert labels.shape == (len(points),)
    assert labels.min() == 1                       # contiguous 1-based ids
    n_trees = len(np.unique(labels))
    print(f"\nmulti_tree fixture: {len(points)} pts -> {n_trees} trees")
    assert n_trees >= 2, "fixture should segment into multiple trees"

    # deterministic: a second run is identical
    labels2 = segment_trees(points, TreeIsoParams())
    assert np.array_equal(labels, labels2)

    # agrees with the stored reference partition (same trees, same points)
    if ref is not None:
        assert _purity(labels, ref) > 0.95


@requires_treeiso
def test_endpoint_inline(client):
    points, _ = _load_fixture()
    res = client.post("/api/segment/trees", json={"points": points.tolist()})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["success"] is True
    assert body["num_points"] == len(points)
    assert len(body["labels"]) == len(points)
    assert body["num_trees"] >= 2
    assert min(body["labels"]) == 1
    # ground-removed fixture -> no false ground warning
    assert body["ground_warning"] is False


@requires_treeiso
def test_endpoint_from_source(client):
    res = client.post(
        "/api/segment/trees",
        json={"source": {"source_path": str(FIXTURE), "ascii_format": "x y z treeiso_label"}},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["success"] is True
    points, _ = _load_fixture()
    assert body["num_points"] == len(points)
    assert body["num_trees"] >= 2


@requires_treeiso
def test_seed_points_yield_one_instance_per_seed(client):
    """Human-in-the-loop: N trunk seeds -> exactly N tree ids."""
    points, _ = _load_fixture()
    # Seed at the base (lowest 5%) centroid of each reference tree cluster.
    _, ref = _load_fixture()
    seeds = []
    for u in np.unique(ref):
        cluster = points[ref == u]
        base = cluster[cluster[:, 2] <= np.percentile(cluster[:, 2], 5)]
        seeds.append(base.mean(axis=0).tolist())
    res = client.post(
        "/api/segment/trees",
        json={"points": points.tolist(), "seed_points": seeds},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["success"] is True
    assert body["num_trees"] == len(seeds), (body["num_trees"], len(seeds))


@requires_treeiso
def test_ground_warning_fires_when_ground_present(client):
    points, _ = _load_fixture()
    rng = np.random.RandomState(0)
    lo = points.min(axis=0)
    span = np.ptp(points[:, :2], axis=0)
    ground = np.c_[
        lo[0] + rng.uniform(0, span[0], 6000),
        lo[1] + rng.uniform(0, span[1], 6000),
        lo[2] + rng.uniform(0, 0.05, 6000),
    ]
    withg = np.vstack([ground, points])
    res = client.post("/api/segment/trees", json={"points": withg.tolist()})
    assert res.status_code == 200, res.text
    assert res.json()["ground_warning"] is True


@requires_treeiso
def test_ground_class_labels_exclude_ground(client):
    """When `ground_class` labels accompany the points (ground segmented but
    kept, not deleted), TreeIso runs only on the plant points: ground points
    come back as tree id 0, `labels` stays aligned 1:1 with the input, and the
    ground heuristic warning is suppressed."""
    points, _ = _load_fixture()
    rng = np.random.RandomState(0)
    lo = points.min(axis=0)
    span = np.ptp(points[:, :2], axis=0)
    ground = np.c_[
        lo[0] + rng.uniform(0, span[0], 6000),
        lo[1] + rng.uniform(0, span[1], 6000),
        lo[2] + rng.uniform(0, 0.05, 6000),
    ]
    withg = np.vstack([ground, points])
    gc = np.concatenate([
        np.full(len(ground), main.GROUND_CLASS_GROUND),
        np.full(len(points), main.GROUND_CLASS_PLANT),
    ]).tolist()
    res = client.post(
        "/api/segment/trees",
        json={"points": withg.tolist(), "ground_class": gc},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["success"] is True
    labels = np.asarray(body["labels"])
    assert len(labels) == len(withg)              # aligned 1:1 with the input
    assert np.all(labels[: len(ground)] == 0)     # ground excluded → unassigned
    assert int((labels[len(ground):] > 0).sum()) > 0  # plant points segmented
    assert body["num_trees"] >= 2
    assert body["ground_warning"] is False        # heuristic suppressed


def test_too_few_points(client):
    res = client.post("/api/segment/trees", json={"points": [[0, 0, 0], [1, 1, 1]]})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["success"] is False
    assert "at least 10" in body["error"]


def test_requires_input(client):
    res = client.post("/api/segment/trees", json={})
    # _resolve_segmentation_points raises HTTPException(400) when neither given
    assert res.status_code == 400


def test_oversize_cloud_rejected_with_actionable_error(client, monkeypatch):
    """A cloud above the TreeIso point cap fails fast with a clear message,
    not an apparent hang. Lower the cap so the test stays tiny."""
    monkeypatch.setattr(main, "_TREEISO_MAX_POINTS", 50)
    points, _ = _load_fixture()
    res = client.post("/api/segment/trees", json={"points": points[:200].tolist()})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["success"] is False
    assert "exceeds" in body["error"] and "limit" in body["error"]


# --- Auto-scaled decimation (the hang fix) ----------------------------------
# TreeIso's paper defaults (decimate_res1 0.05 m, res2 0.1 m) are tuned for ~1 m
# TLS scans. On a large/sparse cloud whose spacing is coarser than 5 cm,
# decimation becomes a no-op and cut-pursuit runs over the full N — the
# 15-20 min hang. `_auto_treeiso_decimation` self-scales the voxel sizes from the
# cloud's actual median spacing so the inline / eval path can't hang un-seeded.


def _treeiso_params_defaults():
    """A TreeIsoParams-like object carrying the paper decimation defaults.

    Uses a plain namespace so this test runs without the TreeIso C-extension —
    `_auto_treeiso_decimation` only reads/writes `decimate_res1` / `decimate_res2`."""
    from types import SimpleNamespace
    return SimpleNamespace(decimate_res1=0.05, decimate_res2=0.1)


def test_auto_decimation_leaves_small_dense_cloud_at_paper_defaults():
    """A small, dense (TLS-scale) cloud decimates fine — params stay untouched,
    so close-range behaviour is bit-for-bit unchanged."""
    rng = np.random.default_rng(0)
    # 20k points in a 1 m box, ~few-mm spacing — well under the 50k early-out.
    pts = rng.uniform(0, 1.0, size=(20_000, 3))
    p = _treeiso_params_defaults()
    main._auto_treeiso_decimation(pts, p)
    assert p.decimate_res1 == 0.05
    assert p.decimate_res2 == 0.1


def test_auto_decimation_coarsens_large_sparse_cloud():
    """A large, sparse (ALS-scale) cloud whose spacing exceeds the 5 cm voxel gets
    its decimation bumped to ~3× spacing, with res2 = 2× res1."""
    rng = np.random.default_rng(1)
    # 120k points over a ~70 m tile, ~0.3 m horizontal grid + 20 m random Z →
    # median 3D NN spacing ~0.4 m, far coarser than the 0.05 m default voxel (the
    # BR04 failure mode in miniature). Measure the actual spacing so the assertion
    # tracks the cKDTree result rather than a hand-guessed number.
    from scipy.spatial import cKDTree
    side = int(np.ceil(120_000 ** 0.5))
    gx, gy = np.meshgrid(np.arange(side), np.arange(side))
    grid = np.c_[gx.ravel(), gy.ravel()][:120_000].astype(np.float64) * 0.3
    pts = np.c_[grid, rng.uniform(0, 20.0, len(grid))]
    pts[:, :2] += rng.uniform(-0.02, 0.02, size=(len(pts), 2))  # light jitter
    d, _ = cKDTree(pts).query(pts, k=2, workers=-1)
    spacing = float(np.median(d[:, 1]))
    p = _treeiso_params_defaults()
    main._auto_treeiso_decimation(pts, p)
    assert p.decimate_res1 > 0.05, "decimation must coarsen for a sparse tile"
    assert p.decimate_res1 == pytest.approx(3 * spacing, rel=0.01)  # ~3 × spacing
    assert p.decimate_res2 == pytest.approx(2 * p.decimate_res1, rel=1e-6)


def test_auto_decimation_leaves_user_coarsened_value_alone():
    """A request already carrying a coarse decimate (UI-seeded for a big tile, or
    a power-user choice) is left untouched — idempotent with the frontend seed."""
    rng = np.random.default_rng(2)
    side = int(np.ceil(120_000 ** 0.5))
    gx, gy = np.meshgrid(np.arange(side), np.arange(side))
    grid = np.c_[gx.ravel(), gy.ravel()][:120_000].astype(np.float64) * 0.15
    pts = np.c_[grid, rng.uniform(0, 20.0, len(grid))]
    from types import SimpleNamespace
    p = SimpleNamespace(decimate_res1=0.5, decimate_res2=1.0)  # already coarse
    main._auto_treeiso_decimation(pts, p)
    assert p.decimate_res1 == 0.5  # gate (<= 0.051) excludes it → no change
    assert p.decimate_res2 == 1.0


@requires_treeiso
def test_large_sparse_cloud_segments_in_bounded_time():
    """Regression for the hang: a large, sparse multi-tree cloud must segment in
    well under a minute (it ran 15-20+ min before the auto-decimation fix) and
    recover a plausible number of trees — asserting correctness AND bounded time,
    not merely "didn't throw"."""
    import time
    from treeiso.treeiso_core import segment_trees, TreeIsoParams

    rng = np.random.default_rng(3)
    # 9 well-separated "trees" on a 3×3 grid over a ~120 m plot (40 m spacing),
    # each ~22k points: a vertical trunk + a Gaussian crown ball. Trees are far
    # apart relative to their crown radius so they're genuinely separable, while
    # the overall extent is coarse enough (~0.1-0.3 m spacing) to exercise the
    # auto-decimation path. ~200k points total — the BR04 scale in miniature.
    n_trees = 9
    spacing_m = 40.0
    centers = np.array([(i * spacing_m, j * spacing_m)
                        for i in range(3) for j in range(3)], dtype=np.float64)
    clouds, truth = [], []
    for i, (cx, cy) in enumerate(centers):
        # Trunk: a thin vertical column 0-8 m.
        kt = 4_000
        trunk = np.c_[
            cx + rng.normal(0, 0.1, kt),
            cy + rng.normal(0, 0.1, kt),
            rng.uniform(0, 8.0, kt),
        ]
        # Crown: a 3 m-radius ball centred at ~11 m.
        kc = 18_000
        crown = np.c_[
            cx + rng.normal(0, 3.0, kc),
            cy + rng.normal(0, 3.0, kc),
            11.0 + rng.normal(0, 2.5, kc),
        ]
        clouds.append(np.vstack([trunk, crown]))
        truth.append(np.full(kt + kc, i))
    pts = np.vstack(clouds)
    truth = np.concatenate(truth)
    # Sanity: spacing is genuinely coarser than the paper voxel (else the test
    # wouldn't exercise the bug).
    p = TreeIsoParams()
    main._auto_treeiso_decimation(pts, p)
    assert p.decimate_res1 > 0.05, "test cloud must trigger the coarsening path"

    t0 = time.perf_counter()
    labels = segment_trees(pts, p)
    elapsed = time.perf_counter() - t0
    print(f"\nbounded-time: {len(pts)} pts, res1={p.decimate_res1} -> "
          f"{len(np.unique(labels))} trees in {elapsed:.1f}s")
    assert elapsed < 60.0, f"segmentation took {elapsed:.1f}s (regression: was hanging)"
    n_found = len(np.unique(labels))
    assert 5 <= n_found <= 20, f"expected ~{n_trees} trees, got {n_found}"


# --- Off-loop execution + client-disconnect handling ------------------------
# The TreeIso pipeline is CPU-bound and runs for tens of seconds on a large tile.
# `_run_blocking_until_disconnect` runs it off the event loop so the server stays
# responsive and a client disconnect (panel closed / fetch timeout) returns
# promptly instead of holding the request open while the worker grinds on.


def test_run_blocking_returns_worker_result_when_connected():
    """With a still-connected client, the helper returns the worker's value."""
    import asyncio

    class _Connected:
        async def is_disconnected(self):
            return False

    def work():
        return 1234

    out = asyncio.run(main._run_blocking_until_disconnect(work, _Connected(), poll=0.01))
    assert out == 1234


def test_run_blocking_raises_on_client_disconnect_without_awaiting_worker():
    """When the client disconnects mid-run, the helper raises ClientDisconnected
    PROMPTLY — it must NOT block until the (slow) worker finishes. We prove both:
    the exception type, and that we returned long before the worker's own runtime."""
    import asyncio
    import time

    def slow_work():
        # Simulates the uninterruptible TreeIso pipeline: a long blocking call
        # with no cancel hook. 5 s is far longer than the ~0.02 s it should take
        # the helper to notice the disconnect and bail.
        time.sleep(5.0)
        return "should-be-discarded"

    class _DisconnectsImmediately:
        async def is_disconnected(self):
            return True

    async def run():
        t0 = time.perf_counter()
        with pytest.raises(main.ClientDisconnected):
            await main._run_blocking_until_disconnect(slow_work, _DisconnectsImmediately(), poll=0.01)
        return time.perf_counter() - t0

    # Returned promptly on disconnect — did NOT wait out the 5 s worker. (The
    # orphaned worker thread keeps running and is GC'd; Python can't kill it —
    # that's the documented limitation. The point is the request didn't hang.)
    elapsed = asyncio.run(run())
    assert elapsed < 1.0, f"helper blocked for {elapsed:.2f}s waiting on the worker"


# --- PLY support (the benchmark format) -------------------------------------
# The Cherlet TLS benchmark ships as PLY with `instance` / `semantic` fields.
# These tests cover that the segmentation path reads PLY and CARRIES the GT
# fields through, so the earlier XYZ-only gap can't silently regress.

@requires_plyfile
def test_ply_fixture_exists_with_gt_fields():
    """The committed PLY fixture must carry instance + semantic vertex fields."""
    from plyfile import PlyData
    assert PLY_FIXTURE.is_file(), f"missing {PLY_FIXTURE} (regenerate from the .xyz)"
    names = PlyData.read(str(PLY_FIXTURE))["vertex"].data.dtype.names
    assert {"x", "y", "z", "instance", "semantic"}.issubset(set(names)), names


@requires_plyfile
def test_loader_carries_ply_scalar_fields():
    """_load_cloud_for_segmentation reads PLY xyz and carries instance/semantic."""
    xyz, scalars, extra = main._load_cloud_for_segmentation(PLY_FIXTURE, None)
    points, _ = _load_fixture()
    assert xyz.shape == (len(points), 3)
    slugs = {e["slug"] for e in extra}
    assert "instance" in slugs and "semantic" in slugs
    assert "instance" in scalars and "semantic" in scalars


@requires_treeiso
@requires_plyfile
def test_endpoint_inline_from_ply_source(client):
    """/api/segment/trees with a PLY `source` returns per-point labels."""
    res = client.post(
        "/api/segment/trees",
        json={"source": {"source_path": str(PLY_FIXTURE)}},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["success"] is True
    points, _ = _load_fixture()
    assert body["num_points"] == len(points)
    assert body["num_trees"] >= 2
