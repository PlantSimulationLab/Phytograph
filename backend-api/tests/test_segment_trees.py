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

    # agrees with the stored reference partition (same trees, same points).
    # Bar is 0.85, not 0.95, for cross-platform tolerance: the cut-pursuit
    # graph-cut runs on float32, so clang (macOS) vs gcc (Linux) last-bit
    # rounding flips a handful of ambiguous boundary points between clusters,
    # moving purity within a measured ~0.90-0.99 band (macOS ~0.99, Linux ~0.90)
    # even though the gross structure — number of trees and their cores — is
    # identical. The within-platform determinism (array_equal above) and the
    # structural assertions (n_trees >= 2, 1-based ids) are platform-stable and
    # carry the real signal; this bound just admits the benign float32 spread.
    if ref is not None:
        assert _purity(labels, ref) > 0.85


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
def test_endpoint_from_source(client, make_file_session):
    res = client.post(
        "/api/segment/trees",
        json={"source": {"session_id": make_file_session(str(FIXTURE), "x y z treeiso_label")}},
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
    """A cloud above the raw-input backstop fails fast with a clear message,
    not an apparent hang. Lower the cap so the test stays tiny."""
    monkeypatch.setattr(main, "_TREEISO_MAX_POINTS", 50)
    points, _ = _load_fixture()
    res = client.post("/api/segment/trees", json={"points": points[:200].tolist()})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["success"] is False
    assert "exceeds" in body["error"] and "limit" in body["error"]


# --- Node-count cost gate ---------------------------------------------------
# TreeIso's cost is driven by the POST-DECIMATION node count, not raw input size:
# `_process_point_cloud` voxel-decimates first, then runs cut-pursuit and the
# O(nGroups²) merge over the decimated cloud only. So the gate counts voxels at
# the resolved voxel size (`_count_treeiso_nodes`) rather than capping raw
# points — otherwise a big-but-sparse cloud that collapses to well under a
# million nodes gets refused for no reason.


def test_node_count_matches_treeiso_decimation_exactly():
    """`_count_treeiso_nodes` must agree BIT-FOR-BIT with the vendored
    `decimate_pcd` it stands in for — including the mean-centring
    `_process_point_cloud` applies first, which shifts voxel boundaries (skipping
    it mis-counts by a few percent). An estimate here would be unsafe: a density
    model was tried and ranged from 0.1× to 49× the true count."""
    from treeiso.treeiso_core import decimate_pcd
    from types import SimpleNamespace

    rng = np.random.default_rng(0)
    # Canopy-like (clustered crowns — where a uniform-density model fails worst)
    # and a volume-filling cube, at voxel sizes spanning no-op → heavy decimation.
    clouds = []
    for _ in range(12):
        cx, cy = rng.uniform(0, 60, 2)
        clouds.append(np.vstack([
            np.c_[cx + rng.normal(0, .1, 1500), cy + rng.normal(0, .1, 1500),
                  rng.uniform(0, 8, 1500)],
            np.c_[cx + rng.normal(0, 3, 4500), cy + rng.normal(0, 3, 4500),
                  11 + rng.normal(0, 2.5, 4500)]]))
    canopy = np.vstack(clouds)
    cube = rng.uniform(0, 50, size=(60_000, 3))

    for name, pts in (("canopy", canopy), ("cube", cube)):
        for res in (0.05, 0.5, 1.5):
            p = SimpleNamespace(decimate_res1=res, decimate_res2=2 * res)
            truth = len(decimate_pcd(pts - np.mean(pts, axis=0), res)[0])
            assert main._count_treeiso_nodes(pts, p) == truth, f"{name} @ {res} m"


def test_auto_decimation_converges_under_node_target():
    """The (spacing/res)³ law assumes volume-filling density and under-shoots at
    scale, so the auto-scaler verifies against the EXACT voxel count and keeps
    coarsening. Regression: a 13.5 M-point plot landed on res1=0.307 m and still
    produced 4.3 M voxels — 4× the 1 M target — before this convergence loop.

    Needs a multi-million-point fixture: the cube law is accurate on small clouds
    and only compounds its error at scale, so a smaller fixture passes with the
    loop deleted (verified) and would be a rubber stamp. 4 M points is the
    smallest size that still reproduces the overshoot; it runs in ~2 s."""
    from types import SimpleNamespace

    rng = np.random.default_rng(7)
    # Dense thin trunks + broad crowns over a 150 m plot — the mixed local
    # density that skews median spacing and makes the cube law over-fine.
    n, clouds = 4_000_000, []
    per = n // 200
    for _ in range(200):
        cx, cy = rng.uniform(0, 150, 2)
        kt = per // 4
        clouds.append(np.vstack([
            np.c_[cx + rng.normal(0, .15, kt), cy + rng.normal(0, .15, kt),
                  rng.uniform(0, 9, kt)],
            np.c_[cx + rng.normal(0, 2.5, per - kt), cy + rng.normal(0, 2.5, per - kt),
                  12 + rng.normal(0, 3, per - kt)]]))
    pts = np.vstack(clouds)

    # The cube-law guess ALONE (what the loop corrects) overshoots the target —
    # asserted so this test fails loudly if the fixture ever stops exercising it.
    spacing, n_finite = main._treeiso_spacing_probe(pts)
    target = 1_000_000  # TARGET_DECIMATED_NODES
    cube_res = max(3.0 * spacing,
                   spacing * (n_finite / target) ** (1.0 / 3.0))
    cube_nodes = main._count_treeiso_nodes(
        pts, SimpleNamespace(decimate_res1=round(cube_res, 3)))
    assert cube_nodes > target, (
        f"fixture no longer exercises the overshoot (cube law gave {cube_nodes:,})")

    p = SimpleNamespace(decimate_res1=0.05, decimate_res2=0.1)
    main._auto_treeiso_decimation(pts, p)
    nodes = main._count_treeiso_nodes(pts, p)
    assert nodes <= target, (
        f"auto-decimation left {nodes:,} nodes at res1={p.decimate_res1}")


def test_large_sparse_cloud_runs_without_warning(monkeypatch):
    """A cloud far above the OLD 5 M raw-point cap runs with no prompt at all,
    because it decimates to well under the node guideline — the raw point count
    was never the right cost signal."""
    rng = np.random.default_rng(12)
    # ~600k points over a 200 m plot. Pin the raw backstop low enough that the
    # OLD point-count rule would have rejected this outright, proving the gate
    # now keys on nodes rather than raw size.
    clouds = []
    for _ in range(120):
        cx, cy = rng.uniform(0, 200, 2)
        clouds.append(np.vstack([
            np.c_[cx + rng.normal(0, .15, 1000), cy + rng.normal(0, .15, 1000),
                  rng.uniform(0, 9, 1000)],
            np.c_[cx + rng.normal(0, 2.5, 4000), cy + rng.normal(0, 2.5, 4000),
                  12 + rng.normal(0, 3, 4000)]]))
    pts = np.vstack(clouds)
    assert len(pts) > 500_000
    params = {k: getattr(main.TreeSegmentationRequest(), k)
              for k in main._TREEISO_PARAM_FIELDS}
    assert main._treeiso_size_error(pts, params) is None, (
        "a decimatable cloud must not be refused for its raw point count")
    assert main._treeiso_cost_warning(pts, params) is None, (
        "a decimatable cloud must not even prompt")


def test_pathological_fine_voxel_warns(monkeypatch):
    """The advisory must still fire on the genuine hang case: a user-pinned voxel
    far finer than the spacing makes decimation a no-op, so the node count stays
    at full N. `_auto_treeiso_decimation` deliberately leaves a coarsened/pinned
    value alone, so only the node check can catch this.

    The guideline is lowered rather than the fixture grown to millions of points,
    so the test stays fast; the code path is identical."""
    monkeypatch.setattr(main, "_TREEISO_MAX_NODES", 100_000)
    rng = np.random.default_rng(13)
    pts = rng.uniform(0, 200, size=(300_000, 3))
    params = {k: getattr(main.TreeSegmentationRequest(), k)
              for k in main._TREEISO_PARAM_FIELDS}
    # >0.051 so the auto-scaler treats it as a deliberate choice and no-ops,
    # yet still far finer than this cloud's ~1 m spacing → decimation is a no-op.
    params["decimate_res1"] = 0.06
    warning = main._treeiso_cost_warning(pts, params)
    assert warning is not None, "a no-op decimation on a big cloud must warn"
    assert warning["nodes"] > warning["node_guideline"]
    assert "cancel" in warning["message"].lower()  # tells them it's interruptible


# --- The cost check WARNS, it does not block --------------------------------
# A user willing to wait must always be able to run TreeIso (Cancel is available
# mid-run), so the node check is a confirmation prompt: the endpoint answers with
# a `cost_warning` and runs on the retry that carries `acknowledge_cost`.


def test_expensive_run_warns_then_proceeds_when_acknowledged(client, monkeypatch):
    """First call returns a cost_warning WITHOUT running; the same call with
    `acknowledge_cost` runs to completion. This is the whole point of the
    warning-not-blocker design — assert both halves."""
    monkeypatch.setattr(main, "_TREEISO_MAX_NODES", 10)  # force the advisory
    points, _ = _load_fixture()
    body = {"points": points.tolist()}

    first = client.post("/api/segment/trees", json=body)
    assert first.status_code == 200, first.text
    warned = first.json()
    assert warned["success"] is False
    assert warned["error"] is None, "a cost advisory is not an error"
    assert warned["cost_warning"] is not None
    assert warned["cost_warning"]["nodes"] > warned["cost_warning"]["node_guideline"]
    assert warned["labels"] == [], "must NOT have run yet"

    second = client.post("/api/segment/trees", json={**body, "acknowledge_cost": True})
    assert second.status_code == 200, second.text
    ran = second.json()
    assert ran["success"] is True, ran.get("error")
    assert ran["cost_warning"] is None
    assert len(ran["labels"]) == len(points), "acknowledged run must segment fully"
    assert ran["num_trees"] >= 1


def test_no_warning_for_an_ordinary_cloud(client):
    """The advisory must not fire on a normal cloud — otherwise every run grows a
    spurious confirmation click."""
    points, _ = _load_fixture()
    res = client.post("/api/segment/trees", json={"points": points.tolist()})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body.get("cost_warning") is None
    assert body["success"] is True, body.get("error")


def test_session_endpoint_warns_with_409_then_proceeds(monkeypatch):
    """The session endpoint signals the advisory as 409 + a structured body (so
    the renderer can tell 'needs confirmation' from a bad request), and runs when
    the retry acknowledges it."""
    from fastapi import HTTPException

    monkeypatch.setattr(main, "_TREEISO_MAX_NODES", 10)
    points, _ = _load_fixture()
    params = {k: getattr(main.TreeSegmentationRequest(), k)
              for k in main._TREEISO_PARAM_FIELDS}

    warning = main._treeiso_cost_warning(points, params)
    assert warning is not None
    # Mirror the endpoint's raise so the 409 contract is pinned without needing a
    # live session fixture.
    exc = HTTPException(status_code=409,
                        detail={"cost_warning": warning, "message": warning["message"]})
    assert exc.status_code == 409
    assert exc.detail["cost_warning"]["nodes"] > 10

    # Acknowledged: the endpoint skips the check entirely.
    req = main.SessionTreeSegmentRequest(acknowledge_cost=True)
    assert req.acknowledge_cost is True


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


# --- Killable subprocess + client-disconnect handling -----------------------
# The TreeIso pipeline is CPU-bound and runs for tens of seconds on a large tile,
# so it runs in a KILLABLE subprocess (`_run_killable`): the server stays
# responsive, and a client disconnect (panel closed / Cancel / fetch timeout)
# SIGKILLs the worker and returns promptly. See tests/test_seg_kill.py for the
# tool-agnostic coverage; these two pin the tree-specific path.


def _small_three_trees(per_tree=400, seed=0):
    """Three well-separated trunk+crown blobs — small + cheap, enough for TreeIso
    to find ≥1 instance. Returns an (N, 3) float64 array."""
    rng = np.random.default_rng(seed)
    clouds = []
    for i, (cx, cy) in enumerate([(0.0, 0.0), (10.0, 0.0), (0.0, 10.0)]):
        trunk = np.c_[cx + rng.normal(0, 0.1, per_tree // 4),
                      cy + rng.normal(0, 0.1, per_tree // 4),
                      rng.uniform(0, 3.0, per_tree // 4)]
        crown = np.c_[cx + rng.normal(0, 1.0, per_tree),
                      cy + rng.normal(0, 1.0, per_tree),
                      4.0 + rng.normal(0, 1.0, per_tree)]
        clouds.append(np.vstack([trunk, crown]))
    return np.vstack(clouds).astype(np.float64)


@pytest.mark.skipif(not _treeiso_available(), reason="treeiso not installed")
def test_run_killable_trees_returns_labels_when_connected():
    """With a still-connected client, the killable subprocess returns TreeIso's
    per-point labels for the tree path."""
    import asyncio

    pts = _small_three_trees()
    labels = asyncio.run(main._run_killable("trees", pts, {}, http_request=None))
    assert labels.shape == (len(pts),)
    assert len(np.unique(labels[labels > 0])) >= 1
    assert len(main._SEG_WORKERS) == 0


@pytest.mark.skipif(not _treeiso_available(), reason="treeiso not installed")
def test_run_killable_trees_kills_worker_on_disconnect():
    """When the client disconnects mid-run, the helper raises ClientDisconnected
    PROMPTLY (it does NOT wait out the worker) AND the worker process is actually
    killed — no entry survives in the registry. This is the true-kill guarantee
    the old thread-based path could not provide."""
    import asyncio
    import time

    # A larger multi-tree cloud so cut-pursuit takes well over the disconnect poll.
    pts = np.vstack([_small_three_trees(per_tree=4000)] * 8).astype(np.float64)
    pts += np.random.default_rng(7).normal(0, 1e-4, pts.shape)

    class _DisconnectsImmediately:
        async def is_disconnected(self):
            return True

    async def run():
        t0 = time.perf_counter()
        with pytest.raises(main.ClientDisconnected):
            await main._run_killable("trees", pts, {},
                                     http_request=_DisconnectsImmediately(), poll=0.05)
        return time.perf_counter() - t0

    elapsed = asyncio.run(run())
    assert elapsed < 10.0, f"helper blocked for {elapsed:.2f}s waiting on the worker"
    assert len(main._SEG_WORKERS) == 0, "the worker subprocess was not reaped"


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
def test_endpoint_inline_from_ply_source(client, make_file_session):
    """/api/segment/trees with a PLY `source` returns per-point labels."""
    res = client.post(
        "/api/segment/trees",
        json={"source": {"session_id": make_file_session(str(PLY_FIXTURE))}},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["success"] is True
    points, _ = _load_fixture()
    assert body["num_points"] == len(points)
    assert body["num_trees"] >= 2
