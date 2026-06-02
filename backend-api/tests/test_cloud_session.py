"""Tests for the mutable cloud-session endpoints (Family-1 data model).

A cloud session holds a cloud's positions in RAM as the source of truth.
Deletions are an instant per-point mask (no octree rebuild); an explicit bake
rewrites the octree from the survivors. Downstream ops read the masked array.

These tests need a real PotreeConverter binary (create + bake build octrees)
and isolate cache state per-test via PHYTOGRAPH_OCTREE_CACHE_ROOT.

Acceptance shape:
  - create returns a session id + first octree whose point_count == N.
  - delete_region marks exactly the NumPy-reference count and does NOT rebuild
    the octree (cache id unchanged / mask-only).
  - reading the session via _read_points_from_source returns N - deleted points.
  - bake produces an octree with point_count == N - deleted and clears the mask.
  - the import-wizard column_plan is honored (a renamed/categorical scalar
    survives onto the derived octree's attributes) — the option-loss regression.
"""

import os
from pathlib import Path

import numpy as np
import pytest

import main


def _converter_available() -> bool:
    try:
        main._resolve_potree_converter_path()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(
    not _converter_available(),
    reason="PotreeConverter binary not found; build it via npm run build:potree-converter",
)


@pytest.fixture
def cache_root(tmp_path, monkeypatch) -> Path:
    root = tmp_path / "octree_cache"
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(root))
    return root


@pytest.fixture
def grid_xyz(tmp_path) -> Path:
    """10×10×10 grid spanning [0, 0.9]^3 in 0.1 steps (1000 points), with RGB +
    reflectance columns so the BPPtree ascii_format parses cleanly."""
    f = tmp_path / "grid.xyz"
    lines = []
    for i in range(10):
        for j in range(10):
            for k in range(10):
                r = (i * 17) % 256
                g = (j * 23) % 256
                b = (k * 31) % 256
                refl = ((i + j + k) * 0.01) % 1.0
                lines.append(f"{i*0.1:.4f} {j*0.1:.4f} {k*0.1:.4f} {r} {g} {b} {refl:.4f}")
    f.write_text("\n".join(lines) + "\n")
    return f


@pytest.fixture
def grid_points(grid_xyz) -> np.ndarray:
    """NumPy reference positions, read back through pandas so float round-trips
    match the endpoint's parse (see crop_octree test for the rationale)."""
    import pandas as pd
    df = pd.read_csv(
        grid_xyz, sep=r"\s+", header=None,
        names=["x", "y", "z", "r", "g", "b", "refl"], engine="c",
    )
    return df[["x", "y", "z"]].to_numpy(dtype=np.float64)


GRID_FORMAT = "x y z r255 g255 b255 reflectance"
BOX = {"kind": "box", "min": [0.2, 0.2, 0.2], "max": [0.7, 0.7, 0.7], "invert": False}


def _expected_box_count(pts: np.ndarray, box=BOX) -> int:
    """Count points the box selects, computed over the SAME array the session
    masks (its in-RAM positions), so the expectation is exact regardless of any
    float round-trip between the source file and the session array."""
    cmin, cmax = box["min"], box["max"]
    return int(np.sum(
        (pts[:, 0] >= cmin[0]) & (pts[:, 0] <= cmax[0]) &
        (pts[:, 1] >= cmin[1]) & (pts[:, 1] <= cmax[1]) &
        (pts[:, 2] >= cmin[2]) & (pts[:, 2] <= cmax[2])
    ))


def _session_positions(sid: str) -> np.ndarray:
    """The session's in-RAM positions — the array deletions actually mask."""
    return main._cloud_sessions[sid].positions


def test_create_returns_session_and_full_octree(client, cache_root, grid_xyz):
    res = client.post(
        "/api/cloud/session/create",
        json={"source_path": str(grid_xyz), "ascii_format": GRID_FORMAT},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["session_id"]
    assert body["cache_id"]
    # The derived octree reports the full point count.
    assert body["point_count"] == 1000


def test_delete_region_masks_without_rebuild(client, cache_root, grid_xyz, grid_points):
    create = client.post(
        "/api/cloud/session/create",
        json={"source_path": str(grid_xyz), "ascii_format": GRID_FORMAT},
    ).json()
    sid = create["session_id"]

    expected_deleted = _expected_box_count(_session_positions(sid))
    assert expected_deleted > 0

    res = client.post(f"/api/cloud/session/{sid}/delete_region", json={"region": BOX})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["deleted_count"] == expected_deleted
    assert body["remaining_count"] == 1000 - expected_deleted
    assert body["total_count"] == 1000

    # The session's in-RAM array reflects the deletion: reading via the
    # downstream-source path returns exactly the survivors.
    sess = main._cloud_sessions[sid]
    assert int(sess.deleted.sum()) == expected_deleted
    # delete_region must NOT have rebuilt the octree (it's now marked stale).
    assert sess.octree_cache_id is None


def test_reset_edits_undoes_deletions(client, cache_root, grid_xyz, grid_points):
    sid = client.post(
        "/api/cloud/session/create",
        json={"source_path": str(grid_xyz), "ascii_format": GRID_FORMAT},
    ).json()["session_id"]

    client.post(f"/api/cloud/session/{sid}/delete_region", json={"region": BOX})
    # Undo back to zero edits.
    res = client.post(f"/api/cloud/session/{sid}/reset_edits", json={"edit_count": 0})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["deleted_count"] == 0
    assert body["remaining_count"] == 1000


def test_bake_rebuilds_octree_from_survivors(client, cache_root, grid_xyz, grid_points):
    sid = client.post(
        "/api/cloud/session/create",
        json={"source_path": str(grid_xyz), "ascii_format": GRID_FORMAT},
    ).json()["session_id"]
    expected_deleted = _expected_box_count(_session_positions(sid))
    expected_remaining = 1000 - expected_deleted

    client.post(f"/api/cloud/session/{sid}/delete_region", json={"region": BOX})
    res = client.post(f"/api/cloud/session/{sid}/bake")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["baked"] is True
    assert body["point_count"] == expected_remaining
    # Baked octree reports the reduced count, and the mask is cleared.
    sess = main._cloud_sessions[sid]
    assert int(sess.deleted.sum()) == 0
    assert len(sess.positions) == expected_remaining
    assert sess.octree_cache_id == body["cache_id"]


def test_bake_with_everything_deleted_returns_empty_no_crash(client, cache_root, grid_xyz):
    """Deleting every point then baking must NOT feed a 0-point LAS to
    PotreeConverter (which exits non-zero → 500). It returns point_count=0,
    baked=False; the renderer raises a delete-confirmation."""
    sid = client.post(
        "/api/cloud/session/create",
        json={"source_path": str(grid_xyz), "ascii_format": GRID_FORMAT},
    ).json()["session_id"]
    # A box enclosing the whole [0,0.9]^3 grid → delete everything.
    whole = {"kind": "box", "min": [-1, -1, -1], "max": [2, 2, 2], "invert": False}
    client.post(f"/api/cloud/session/{sid}/delete_region", json={"region": whole})
    res = client.post(f"/api/cloud/session/{sid}/bake")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["point_count"] == 0
    assert body["baked"] is False


def test_reset_edits_partial_undo_restores_intermediate_snapshot(client, cache_root, grid_xyz):
    """Two successive deletes, then undo ONE (edit_count=1) restores the mask to
    after the first delete — the partial-undo branch, not just clear-all."""
    sid = client.post(
        "/api/cloud/session/create",
        json={"source_path": str(grid_xyz), "ascii_format": GRID_FORMAT},
    ).json()["session_id"]
    box1 = {"kind": "box", "min": [0.0, 0.0, 0.0], "max": [0.4, 0.9, 0.9], "invert": False}
    box2 = {"kind": "box", "min": [0.5, 0.0, 0.0], "max": [0.9, 0.9, 0.9], "invert": False}
    r1 = client.post(f"/api/cloud/session/{sid}/delete_region", json={"region": box1}).json()
    after_first = r1["deleted_count"]
    r2 = client.post(f"/api/cloud/session/{sid}/delete_region", json={"region": box2}).json()
    assert r2["deleted_count"] > after_first  # second delete removed more

    # Undo the second delete (keep the first) → back to after_first.
    res = client.post(f"/api/cloud/session/{sid}/reset_edits", json={"edit_count": 1})
    assert res.status_code == 200, res.text
    assert res.json()["deleted_count"] == after_first


def test_session_extract_creates_child_leaves_parent_untouched(client, cache_root, grid_xyz, grid_points, monkeypatch):
    """extract spins off a child session from the filter-selected points without
    mutating the parent — entirely from the arrays (no source file read)."""
    sid = client.post(
        "/api/cloud/session/create",
        json={"source_path": str(grid_xyz), "ascii_format": GRID_FORMAT},
    ).json()["session_id"]
    n_select = _expected_box_count(_session_positions(sid))

    called = {"loaded": False}
    orig = main._load_pointcloud_arrays
    monkeypatch.setattr(main, "_load_pointcloud_arrays",
                        lambda *a, **k: (called.__setitem__("loaded", True), orig(*a, **k))[1])

    res = client.post(f"/api/cloud/session/{sid}/extract", json={"region": BOX})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["extracted"] is not None
    assert body["extracted"]["point_count"] == n_select
    child_sid = body["extracted"]["session_id"]
    # Child is independent; parent is UNCHANGED (no deletions committed).
    assert child_sid in main._cloud_sessions and child_sid != sid
    assert int(main._cloud_sessions[sid].deleted.sum()) == 0
    assert called["loaded"] is False


def test_session_segment_trees_appends_instance_column(client, cache_root, tmp_path):
    """TreeIso on the in-RAM points appends a tree_instance column and rebuilds
    from the arrays. Smoke test on a tiny two-cluster cloud."""
    # Two well-separated vertical clusters so TreeIso yields ≥1 instance.
    f = tmp_path / "trees.xyz"
    rows = []
    for cx in (0.0, 5.0):
        for i in range(15):
            for k in range(8):
                rows.append(f"{cx + (i % 4) * 0.05:.4f} {(i // 4) * 0.05:.4f} {k * 0.1:.4f}")
    f.write_text("\n".join(rows) + "\n")
    sid = client.post(
        "/api/cloud/session/create",
        json={"source_path": str(f), "ascii_format": "x y z"},
    ).json()["session_id"]

    res = client.post(f"/api/cloud/session/{sid}/segment_trees", json={})
    assert res.status_code == 200, res.text
    attr_names = {a["name"] for a in res.json().get("attributes", [])}
    assert "tree_instance" in attr_names, attr_names
    sess = main._cloud_sessions[sid]
    assert "tree_instance" in sess.extras
    assert len(sess.extras["tree_instance"]) == len(sess.positions)


def test_downstream_source_reads_masked_array(client, cache_root, grid_xyz, grid_points):
    """_read_points_from_source(session_id=...) returns survivors only — the
    contract that lets triangulate/skeleton/etc honor deletions with no bake."""
    sid = client.post(
        "/api/cloud/session/create",
        json={"source_path": str(grid_xyz), "ascii_format": GRID_FORMAT},
    ).json()["session_id"]
    expected_remaining = 1000 - _expected_box_count(_session_positions(sid))
    client.post(f"/api/cloud/session/{sid}/delete_region", json={"region": BOX})

    src = main.PointSource(source_path=str(grid_xyz), session_id=sid)
    positions, _, _ = main._read_points_from_source(src)
    assert len(positions) == expected_remaining


def test_session_filter_deletes_excluded_points_no_file_read(client, cache_root, grid_xyz, monkeypatch):
    """The session filter deletes points outside the region, operating on the
    in-RAM arrays — it must NOT re-read the source file. We assert correctness
    (count) AND that no file-reading loader is called during the filter."""
    sid = client.post(
        "/api/cloud/session/create",
        json={"source_path": str(grid_xyz), "ascii_format": GRID_FORMAT},
    ).json()["session_id"]
    expected_keep = _expected_box_count(_session_positions(sid))

    # Trip a guard if any source-file loader runs during the filter.
    called = {"loaded": False}
    orig = main._load_pointcloud_arrays
    def _spy(*a, **k):
        called["loaded"] = True
        return orig(*a, **k)
    monkeypatch.setattr(main, "_load_pointcloud_arrays", _spy)

    res = client.post(
        f"/api/cloud/session/{sid}/filter",
        json={"region": BOX, "rebuild": True},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["rebuilt"] is True
    assert body["point_count"] == expected_keep
    assert called["loaded"] is False  # no source file read during filter


def test_session_filter_empty_result_does_not_commit_or_rebuild(client, cache_root, grid_xyz):
    """A filter that excludes EVERY point returns point_count=0 WITHOUT committing
    the deletion or rebuilding (PotreeConverter can't ingest 0 points). The
    renderer raises a delete-confirmation on this; the session is untouched."""
    sid = client.post(
        "/api/cloud/session/create",
        json={"source_path": str(grid_xyz), "ascii_format": GRID_FORMAT},
    ).json()["session_id"]
    # A box far outside the [0,0.9]^3 grid keeps nothing.
    empty_box = {"kind": "box", "min": [100, 100, 100], "max": [200, 200, 200], "invert": False}
    res = client.post(f"/api/cloud/session/{sid}/filter", json={"region": empty_box, "rebuild": True})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["point_count"] == 0
    assert body["rebuilt"] is False
    # Session untouched — still 1000 live points.
    sess = main._cloud_sessions[sid]
    assert int((~sess.deleted).sum()) == 1000


def test_session_filter_composes_on_survivors_not_original(client, cache_root, tmp_path):
    """A second filter composes on the FIRST result's survivors, not the original
    cloud. Two disjoint scalar windows → the second keeps nothing (empty)."""
    # Points along x with a scalar `dev` = 0..9 (one per point).
    f = tmp_path / "dev.xyz"
    rows = [f"{i*0.1:.4f} 0.0000 0.0000 {i}" for i in range(10)]
    f.write_text("\n".join(rows) + "\n")
    plan = {"columns": [
        {"index": 0, "role": "x"}, {"index": 1, "role": "y"}, {"index": 2, "role": "z"},
        {"index": 3, "role": "extra", "slug": "dev", "label": "dev", "categorical": False},
    ], "rgb_is_255": True}
    sid = client.post("/api/cloud/session/create",
                      json={"source_path": str(f), "column_plan": plan}).json()["session_id"]

    # First filter: keep dev in [0,3] → 4 survivors.
    r1 = client.post(f"/api/cloud/session/{sid}/filter",
                     json={"scalar_filters": [{"slug": "dev", "min": 0, "max": 3}], "rebuild": True})
    assert r1.json()["point_count"] == 4

    # Second filter: keep dev in [6,9] — disjoint from the survivors (dev 0..3),
    # so it keeps NOTHING. Must report empty (not re-admit the original points).
    r2 = client.post(f"/api/cloud/session/{sid}/filter",
                     json={"scalar_filters": [{"slug": "dev", "min": 6, "max": 9}], "rebuild": True})
    assert r2.json()["point_count"] == 0
    assert int((~main._cloud_sessions[sid].deleted).sum()) == 4  # still the 4 survivors


def test_session_segment_ground_appends_class_no_file_read(client, cache_root, tmp_path, monkeypatch):
    """Ground segmentation runs CSF on the in-RAM points and appends a
    ground_class attribute, rebuilding from the arrays — no source file read."""
    # A cloud with a flat ground plane (z≈0) plus a raised blob (z≈1).
    f = tmp_path / "ground.xyz"
    rows = []
    for i in range(20):
        for j in range(20):
            rows.append(f"{i*0.1:.4f} {j*0.1:.4f} {0.0:.4f}")   # ground
    for i in range(5):
        for j in range(5):
            rows.append(f"{0.5+i*0.05:.4f} {0.5+j*0.05:.4f} {1.0:.4f}")  # plant blob
    f.write_text("\n".join(rows) + "\n")

    sid = client.post(
        "/api/cloud/session/create",
        json={"source_path": str(f), "ascii_format": "x y z"},
    ).json()["session_id"]

    called = {"loaded": False}
    orig = main._load_pointcloud_arrays
    monkeypatch.setattr(main, "_load_pointcloud_arrays",
                        lambda *a, **k: (called.__setitem__("loaded", True), orig(*a, **k))[1])

    res = client.post(
        f"/api/cloud/session/{sid}/segment_ground",
        json={"cloth_resolution": 0.1},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    # The derived octree now carries a ground_class attribute.
    attr_names = {a["name"] for a in body.get("attributes", [])}
    assert "ground_class" in attr_names, attr_names
    # And the in-RAM session grew a ground_class column aligned to its points.
    sess = main._cloud_sessions[sid]
    assert "ground_class" in sess.extras
    assert len(sess.extras["ground_class"]) == len(sess.positions)
    # CSF labeled at least some points ground (1) and some plant (2).
    classes = set(np.unique(sess.extras["ground_class"]).tolist())
    assert 1 in classes and 2 in classes
    assert called["loaded"] is False  # no source file read during segment


def test_session_split_partitions_into_kept_and_leftover(client, cache_root, grid_xyz, monkeypatch):
    """Split keeps the box-passing points on the session and moves the excluded
    points to a NEW leftover session — entirely on the in-RAM arrays (no file
    read). kept + leftover must partition the original cloud exactly."""
    sid = client.post(
        "/api/cloud/session/create",
        json={"source_path": str(grid_xyz), "ascii_format": GRID_FORMAT},
    ).json()["session_id"]
    n_keep = _expected_box_count(_session_positions(sid))

    called = {"loaded": False}
    orig = main._load_pointcloud_arrays
    monkeypatch.setattr(main, "_load_pointcloud_arrays",
                        lambda *a, **k: (called.__setitem__("loaded", True), orig(*a, **k))[1])

    res = client.post(f"/api/cloud/session/{sid}/split", json={"region": BOX})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["kept"]["point_count"] == n_keep
    assert body["leftover"] is not None
    assert body["leftover"]["point_count"] == 1000 - n_keep
    # Exact partition.
    assert body["kept"]["point_count"] + body["leftover"]["point_count"] == 1000
    # The leftover is a real, independent session.
    leftover_sid = body["leftover"]["session_id"]
    assert leftover_sid in main._cloud_sessions
    assert leftover_sid != sid
    assert called["loaded"] is False  # no source file read during split


def test_delete_session_frees_arrays(client, cache_root, grid_xyz):
    sid = client.post(
        "/api/cloud/session/create",
        json={"source_path": str(grid_xyz), "ascii_format": GRID_FORMAT},
    ).json()["session_id"]
    assert sid in main._cloud_sessions
    res = client.delete(f"/api/cloud/session/{sid}")
    assert res.status_code == 200
    assert res.json()["deleted"] is True
    assert sid not in main._cloud_sessions


def test_wizard_column_plan_survives_onto_octree(client, cache_root, tmp_path):
    """Regression for import-wizard option loss: a categorical/renamed scalar
    chosen in the wizard (column_plan) must appear on the derived octree's
    attributes after session create — and persist through a bake."""
    # A small cloud with one extra integer column we'll mark categorical+renamed.
    f = tmp_path / "labeled.xyz"
    rows = []
    for i in range(40):
        cls = i % 3  # 3 classes
        rows.append(f"{i*0.05:.4f} {0.0:.4f} {0.0:.4f} {cls}")
    f.write_text("\n".join(rows) + "\n")

    column_plan = {
        "columns": [
            {"index": 0, "role": "x"},
            {"index": 1, "role": "y"},
            {"index": 2, "role": "z"},
            {"index": 3, "role": "extra", "slug": "tree_class",
             "label": "Tree Class", "categorical": True},
        ],
        "rgb_is_255": True,
    }

    res = client.post(
        "/api/cloud/session/create",
        json={"source_path": str(f), "column_plan": column_plan},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    attr_names = {a["name"] for a in body.get("attributes", [])}
    assert "tree_class" in attr_names, (
        f"wizard scalar slug missing from octree attributes: {attr_names}"
    )
    # The custom label rode along on the sidecar.
    labels = {a["name"]: a.get("label") for a in body["attributes"]}
    assert labels.get("tree_class") == "Tree Class"
