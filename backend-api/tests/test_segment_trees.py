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


@requires_treeiso
def test_drops_non_finite_points(tmp_path):
    """NaN/inf coords (which arrive via a file, not JSON) are dropped before
    TreeIso's cKDTree, which would otherwise raise. Exercised through the
    file/loader path used by /apply, where bad coordinates can realistically
    occur (JSON can't even carry NaN)."""
    import laspy
    points, _ = _load_fixture()
    bad = points.copy()
    bad[0] = [np.nan, 0.0, 0.0]
    bad[1] = [np.inf, 0.0, 0.0]
    src = tmp_path / "withnan.xyz"
    np.savetxt(src, bad, fmt="%.4f")  # NaN/inf serialise as text fine

    fields = main.TreeSegmentationApplyRequest.model_fields
    ti = {k: fields[k].default for k in (
        "reg_strength1", "min_nn1", "decimate_res1", "reg_strength2", "min_nn2",
        "decimate_res2", "max_gap", "rel_height_length_ratio", "vertical_weight",
        "min_nn3", "score_candidate_thresh", "init_stem_rel_length_thresh",
        "max_outlier_gap")}
    out = tmp_path / "out.las"
    n, _carried, _gw = main._tree_segmented_xyz_to_las(src, None, out, ti, None, None)
    # The two non-finite rows are dropped; the rest segment normally.
    assert n == len(points) - 2
    las = laspy.read(str(out))
    assert len(np.asarray(las.x)) == len(points) - 2


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
def test_apply_las_from_ply_carries_tree_instance_and_gt(tmp_path):
    """_tree_segmented_xyz_to_las on a PLY runs TreeIso and writes a LAS with the
    new tree_instance dim PLUS the source instance/semantic GT dims."""
    import laspy
    # Harvest TreeIso param defaults from the model's field defaults (the model
    # requires source_path, so don't instantiate it bare).
    fields = main.TreeSegmentationApplyRequest.model_fields
    ti = {k: fields[k].default for k in (
        "reg_strength1", "min_nn1", "decimate_res1", "reg_strength2", "min_nn2",
        "decimate_res2", "max_gap", "rel_height_length_ratio", "vertical_weight",
        "min_nn3", "score_candidate_thresh", "init_stem_rel_length_thresh",
        "max_outlier_gap")}
    out = tmp_path / "trees.las"
    n, carried, ground_warning = main._tree_segmented_xyz_to_las(
        PLY_FIXTURE, None, out, ti, None, None)
    assert n > 0
    assert ground_warning is False  # fixture is ground-removed
    slugs = {c["slug"] for c in carried}
    assert {"tree_instance", "instance", "semantic"}.issubset(slugs), slugs

    las = laspy.read(str(out))
    dims = set(las.point_format.dimension_names)
    assert {"tree_instance", "instance", "semantic"}.issubset(dims), dims
    tree_ids = np.asarray(las["tree_instance"])
    assert len(np.unique(tree_ids[tree_ids > 0])) >= 2  # multiple trees found


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


# --- End-to-end apply + filter (needs PotreeConverter) ----------------------

def _converter_available() -> bool:
    try:
        main._resolve_potree_converter_path()
        return True
    except Exception:
        return False


requires_converter = pytest.mark.skipif(
    not _converter_available(),
    reason="PotreeConverter binary not found; build it via npm run build:potree-converter",
)


@pytest.fixture
def cache_root(tmp_path, monkeypatch) -> Path:
    root = tmp_path / "octree_cache"
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(root))
    return root


@requires_treeiso
@requires_converter
def test_segment_trees_apply_then_filter_by_instance(client, cache_root):
    """Regression: after tree segmentation bakes `tree_instance`, the apply
    persists a segmented LAS carrying that dim, and filtering it on
    `tree_instance` via crop_octree succeeds (it used to 400 because the filter
    re-read the original source, which has no tree_instance column)."""
    apply_body = client.post(
        "/api/segment/trees/apply",
        json={"source_path": str(FIXTURE), "ascii_format": "x y z treeiso_label"},
    ).json()
    seg_path = apply_body["segmented_source_path"]
    assert Path(seg_path).is_file(), f"segmented source not persisted at {seg_path}"

    # Keep only tree instance 1 — the renderer routes this through crop_octree
    # on the persisted LAS (ascii_format=None for LAS).
    res = client.post(
        "/api/pointcloud/crop_octree",
        json={
            "source_path": seg_path,
            "scalar_filters": [{"slug": main.TREE_INSTANCE_SLUG, "min": 1, "max": 1}],
        },
    )
    assert res.status_code == 200, res.text  # <-- the bug surfaced as 400 here
    kept = res.json()["point_count"]
    assert 0 < kept < apply_body["point_count"]
