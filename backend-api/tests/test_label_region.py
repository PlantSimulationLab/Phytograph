"""Tests for manual point labelling (label_region / reset_label_edits /
commit_labels).

A label edit repaints a per-point class column in place. Unlike a deletion it
is NOT expressible as a GPU clip volume, so `label_region` deliberately leaves
`octree_cache_id` alone and the renderer overlays the change client-side until
an explicit commit rebuilds the octree.

Acceptance shape:
  - label_region writes exactly the NumPy-reference point set and does NOT
    touch the octree cache id.
  - a label survives delete → undo-delete (the `_session_add_extra_column`
    trap: that helper zero-fills deleted rows and would silently destroy it).
  - sky/miss points are never labelled, even when a region covers them.
  - the From-class gate only repaints the classes it names.
  - strokes are order-dependent and undo is exact against a from-scratch replay.
  - bake compacts the column with the survivors and clears the undo history.
"""

import numpy as np
import pytest

import main
from pathlib import Path
from tests.binframe import decode_streamed_json


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
    """10x10x10 grid spanning [0, 0.9]^3 in 0.1 steps (1000 points)."""
    f = tmp_path / "grid.xyz"
    lines = []
    for i in range(10):
        for j in range(10):
            for k in range(10):
                lines.append(f"{i*0.1:.4f} {j*0.1:.4f} {k*0.1:.4f}")
    f.write_text("\n".join(lines) + "\n")
    return f


GRID_FORMAT = "x y z"
SLUG = main.MANUAL_CLASS_SLUG

# Two nested boxes, so an A-then-B pair can prove order dependence.
BOX_BIG = {"kind": "box", "min": [0.15, 0.15, 0.15], "max": [0.75, 0.75, 0.75],
           "invert": False}
BOX_SMALL = {"kind": "box", "min": [0.35, 0.35, 0.35], "max": [0.55, 0.55, 0.55],
             "invert": False}


def _box_mask(pts: np.ndarray, box) -> np.ndarray:
    cmin, cmax = box["min"], box["max"]
    return (
        (pts[:, 0] >= cmin[0]) & (pts[:, 0] <= cmax[0]) &
        (pts[:, 1] >= cmin[1]) & (pts[:, 1] <= cmax[1]) &
        (pts[:, 2] >= cmin[2]) & (pts[:, 2] <= cmax[2])
    )


def _stroke(box, to_class, stroke_id, from_classes=None):
    s = {"region": box, "to_class": to_class, "stroke_id": stroke_id}
    if from_classes is not None:
        s["from_classes"] = from_classes
    return s


def _create(client, path, fmt=GRID_FORMAT) -> str:
    payload = {"source_path": str(path)}
    if fmt is not None:
        payload["ascii_format"] = fmt
    res = client.post("/api/cloud/session/create", json=payload)
    assert res.status_code == 200, res.text
    return decode_streamed_json(res.content)["session_id"]


def _paint(client, sid, strokes):
    res = client.post(f"/api/cloud/session/{sid}/label_region",
                      json={"strokes": strokes})
    assert res.status_code == 200, res.text
    return res.json()


def _labels(sid) -> np.ndarray:
    return main._cloud_sessions[sid].extras[SLUG]


# ── The bug-catchers ─────────────────────────────────────────────────────────

def test_label_region_writes_expected_points_without_touching_the_octree(
    client, cache_root, grid_xyz,
):
    sid = _create(client, grid_xyz)
    sess = main._cloud_sessions[sid]
    cache_before = sess.octree_cache_id
    assert cache_before, "session should have built an octree at create"

    expected = _box_mask(sess.positions, BOX_BIG)
    assert expected.sum() > 0

    body = _paint(client, sid, [_stroke(BOX_BIG, 3, "s1")])
    assert body["created_column"] is True
    assert body["applied"][0]["changed_count"] == int(expected.sum())

    labels = _labels(sid)
    assert np.all(labels[expected] == 3)
    assert np.all(labels[~expected] == main.MANUAL_CLASS_UNLABELED)

    # The divergence from delete_region: a label edit leaves the derived octree
    # ALONE (it is behind, not stale) so the renderer keeps streaming tiles.
    assert sess.octree_cache_id == cache_before
    assert sess.label_dirty.get(SLUG) is True


def test_labels_survive_a_delete_and_its_undo(client, cache_root, grid_xyz):
    """The `_session_add_extra_column` trap.

    That helper rebuilds the column as `np.zeros(N); full[~deleted] = values`,
    zeroing every DELETED row. Deleted rows come back via reset_edits, so a
    label write performed WHILE rows are deleted silently destroys their labels.

    The stroke order here matters and is the whole point of the test: paint,
    delete, then PAINT AGAIN (the second write is what would trigger the
    zero-fill), then undo the delete and check the first stroke's labels
    survived on the restored rows. Painting only before the delete would not
    exercise the trap at all — the zero-fill needs deleted rows to exist at
    write time.
    """
    sid = _create(client, grid_xyz)
    sess = main._cloud_sessions[sid]
    painted = _box_mask(sess.positions, BOX_BIG)
    _paint(client, sid, [_stroke(BOX_BIG, 3, "s1")])

    # Delete a chunk that overlaps the painted region.
    res = client.post(f"/api/cloud/session/{sid}/delete_region",
                      json={"region": BOX_SMALL})
    assert res.status_code == 200, res.text
    deleted = sess.deleted.copy()
    assert (deleted & painted).sum() > 0, "fixture must overlap for this to test anything"

    # A SECOND label write while those rows are deleted. Under the trap this is
    # the call that zeroes them.
    far = {"kind": "box", "min": [0.8, 0.8, 0.8], "max": [1.0, 1.0, 1.0],
           "invert": False}
    _paint(client, sid, [_stroke(far, 5, "s2")])

    res = client.post(f"/api/cloud/session/{sid}/reset_edits", json={"edit_count": 0})
    assert res.status_code == 200, res.text
    assert int(sess.deleted.sum()) == 0

    # Every originally-painted point — including the ones that were deleted and
    # then restored — must still carry its class.
    restored = deleted & painted
    assert np.all(_labels(sid)[restored] == 3), \
        "labels on deleted-then-restored points were destroyed"
    assert np.all(_labels(sid)[painted] == 3)


def test_misses_are_never_labelled(client, cache_root, tmp_path, monkeypatch):
    """A sky/miss point is a ray that hit nothing, projected ~1 km out. It can
    fall inside a region by coordinate accident; labelling it would poison the
    class counts and any split-by-class child cloud."""
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "cache"))
    # Grid of hits, plus miss points INSIDE the painted box's footprint.
    f = tmp_path / "with_misses.xyz"
    lines = []
    for i in range(6):
        for j in range(6):
            lines.append(f"{i*0.1:.4f} {j*0.1:.4f} 0.3000 0")   # hits
    for i in range(6):
        lines.append(f"{i*0.1:.4f} 0.2000 0.3000 1")            # misses, in-box
    f.write_text("\n".join(lines) + "\n")

    sid = _create(client, f, "x y z is_miss")
    sess = main._cloud_sessions[sid]
    miss = sess.extras[main._MISS_SLUG] != 0
    assert miss.sum() == 6, "fixture should carry 6 miss points"

    box = {"kind": "box", "min": [-1, -1, -1], "max": [1, 1, 1], "invert": False}
    body = _paint(client, sid, [_stroke(box, 5, "s1")])

    labels = _labels(sid)
    assert np.all(labels[miss] == main.MANUAL_CLASS_UNLABELED), \
        "misses inside the region must stay unlabelled"
    assert np.all(labels[~miss] == 5)
    assert body["applied"][0]["changed_count"] == int((~miss).sum())
    # ...and they must not appear in the summary either, or the "how much have
    # I laballed?" readout counts sky.
    assert body["class_counts"] == {"5": int((~miss).sum())} or \
           body["class_counts"] == {5: int((~miss).sum())}


def test_deleted_points_are_not_labelled(client, cache_root, grid_xyz):
    """Deleted rows are excluded from selection, so a stroke over a deleted
    region is a no-op there rather than painting hidden points."""
    sid = _create(client, grid_xyz)
    sess = main._cloud_sessions[sid]
    client.post(f"/api/cloud/session/{sid}/delete_region", json={"region": BOX_SMALL})
    deleted = sess.deleted.copy()
    assert deleted.sum() > 0

    _paint(client, sid, [_stroke(BOX_BIG, 4, "s1")])
    assert np.all(_labels(sid)[deleted] == main.MANUAL_CLASS_UNLABELED)


# ── Semantics ────────────────────────────────────────────────────────────────

def test_from_class_gate_only_repaints_named_classes(client, cache_root, grid_xyz):
    sid = _create(client, grid_xyz)
    sess = main._cloud_sessions[sid]
    big = _box_mask(sess.positions, BOX_BIG)
    _paint(client, sid, [_stroke(BOX_BIG, 1, "s1")])

    # from_classes=[2] matches nothing -> no-op.
    body = _paint(client, sid, [_stroke(BOX_BIG, 9, "s2", from_classes=[2])])
    assert body["applied"][0]["changed_count"] == 0
    assert np.all(_labels(sid)[big] == 1)

    # from_classes=[1] matches everything painted -> full repaint.
    body = _paint(client, sid, [_stroke(BOX_BIG, 9, "s3", from_classes=[1])])
    assert body["applied"][0]["changed_count"] == int(big.sum())
    assert np.all(_labels(sid)[big] == 9)


def test_strokes_are_order_dependent(client, cache_root, grid_xyz):
    """Labelling is not commutative — paint-all-A then subregion-B differs from
    the reverse. This is why the stroke list is never sorted or deduped."""
    sid_a = _create(client, grid_xyz)
    _paint(client, sid_a, [_stroke(BOX_BIG, 1, "a1"), _stroke(BOX_SMALL, 2, "a2")])
    labels_a = _labels(sid_a).copy()

    sid_b = _create(client, grid_xyz)
    _paint(client, sid_b, [_stroke(BOX_SMALL, 2, "b1"), _stroke(BOX_BIG, 1, "b2")])
    labels_b = _labels(sid_b)

    assert not np.array_equal(labels_a, labels_b)
    small = _box_mask(main._cloud_sessions[sid_a].positions, BOX_SMALL)
    assert np.all(labels_a[small] == 2)   # B ran last, so B wins
    assert np.all(labels_b[small] == 1)   # A ran last, so A wins


def test_batched_strokes_apply_in_one_call(client, cache_root, grid_xyz):
    """A brush drag flushes many stamps as one request; each reports its own
    counts and they apply in order."""
    sid = _create(client, grid_xyz)
    body = _paint(client, sid, [
        _stroke(BOX_BIG, 1, "s1"), _stroke(BOX_SMALL, 2, "s2"),
    ])
    assert [a["stroke_id"] for a in body["applied"]] == ["s1", "s2"]
    assert body["label_edit_count"] == 2


def test_repainting_the_same_class_is_a_no_op(client, cache_root, grid_xyz):
    sid = _create(client, grid_xyz)
    _paint(client, sid, [_stroke(BOX_BIG, 3, "s1")])
    body = _paint(client, sid, [_stroke(BOX_BIG, 3, "s2")])
    assert body["applied"][0]["selected_count"] > 0
    assert body["applied"][0]["changed_count"] == 0


# ── Undo ─────────────────────────────────────────────────────────────────────

def test_undo_is_exact_against_a_from_scratch_replay(client, cache_root, grid_xyz):
    """Overlapping strokes then rollback to k must equal painting only 1..k on a
    fresh session — the property reverse-applied deltas exist to guarantee."""
    strokes = [
        _stroke(BOX_BIG, 1, "s1"),
        _stroke(BOX_SMALL, 2, "s2"),
        _stroke(BOX_BIG, 3, "s3"),      # repaints over both
    ]
    sid = _create(client, grid_xyz)
    _paint(client, sid, strokes)

    res = client.post(f"/api/cloud/session/{sid}/reset_label_edits",
                      json={"edit_count": 2})
    assert res.status_code == 200, res.text
    assert res.json()["label_edit_count"] == 2
    rolled_back = _labels(sid).copy()

    ref = _create(client, grid_xyz)
    _paint(client, ref, strokes[:2])
    assert np.array_equal(rolled_back, _labels(ref))


def test_undo_to_zero_restores_an_unlabelled_column(client, cache_root, grid_xyz):
    sid = _create(client, grid_xyz)
    _paint(client, sid, [_stroke(BOX_BIG, 1, "s1"), _stroke(BOX_SMALL, 2, "s2")])
    res = client.post(f"/api/cloud/session/{sid}/reset_label_edits", json={})
    assert res.status_code == 200, res.text
    assert np.all(_labels(sid) == main.MANUAL_CLASS_UNLABELED)
    assert main._cloud_sessions[sid].label_history[SLUG] == []


def test_history_is_trimmed_by_byte_budget_oldest_first(
    client, cache_root, grid_xyz, monkeypatch,
):
    """Entry sizes span orders of magnitude, so the cap is on BYTES. Truncation
    must be reported so the renderer can trim its parallel stroke list."""
    monkeypatch.setattr(main, "_MAX_LABEL_HISTORY", 3)
    sid = _create(client, grid_xyz)
    _paint(client, sid, [_stroke(BOX_BIG, i + 1, f"s{i}") for i in range(6)])
    body = _paint(client, sid, [_stroke(BOX_BIG, 9, "s9")])
    assert body["label_edit_count"] <= 3
    assert len(main._cloud_sessions[sid].label_history[SLUG]) <= 3


# ── Summary (the tool's initial readout) ─────────────────────────────────────

def test_label_summary_reports_all_points_unclassified_before_any_paint(
    client, cache_root, grid_xyz,
):
    """A fresh cloud has no label column at all. The summary must still report
    every point as Unclassified — the panel showing 0 for every class reads as
    "nothing here" when in fact nothing has been painted yet."""
    sid = _create(client, grid_xyz)
    assert SLUG not in main._cloud_sessions[sid].extras

    res = client.get(f"/api/cloud/session/{sid}/label_summary")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["class_counts"] == {str(main.MANUAL_CLASS_UNLABELED): 1000}
    assert body["label_edit_count"] == 0


def test_label_summary_excludes_deleted_and_miss_points(
    client, cache_root, tmp_path, monkeypatch,
):
    """The count is over EDITABLE points, which is exactly why the renderer
    cannot derive it from its own point count."""
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "cache"))
    f = tmp_path / "mixed.xyz"
    lines = [f"{i*0.1:.4f} 0.0000 0.0000 0" for i in range(20)]
    lines += [f"{i*0.1:.4f} 1.0000 0.0000 1" for i in range(5)]   # misses
    f.write_text("\n".join(lines) + "\n")

    sid = _create(client, f, "x y z is_miss")
    body = client.get(f"/api/cloud/session/{sid}/label_summary").json()
    # 20 hits, not 25 — the 5 misses are never labellable.
    assert body["class_counts"] == {str(main.MANUAL_CLASS_UNLABELED): 20}


def test_label_summary_tracks_painting_and_is_read_only(client, cache_root, grid_xyz):
    sid = _create(client, grid_xyz)
    sess = main._cloud_sessions[sid]
    painted = int(_box_mask(sess.positions, BOX_BIG).sum())
    _paint(client, sid, [_stroke(BOX_BIG, 4, "s1")])

    body = client.get(f"/api/cloud/session/{sid}/label_summary").json()
    assert body["class_counts"][str(4)] == painted
    assert body["class_counts"][str(main.MANUAL_CLASS_UNLABELED)] == 1000 - painted
    assert body["label_edit_count"] == 1

    # Reading must not disturb anything — it is a GET, not reset_label_edits
    # pressed into service as a getter.
    labels_before = _labels(sid).copy()
    client.get(f"/api/cloud/session/{sid}/label_summary")
    assert np.array_equal(_labels(sid), labels_before)
    assert len(sess.label_history[SLUG]) == 1


def test_label_summary_rejects_a_reserved_slug(client, cache_root, grid_xyz):
    sid = _create(client, grid_xyz)
    res = client.get(f"/api/cloud/session/{sid}/label_summary?slug=classification")
    assert res.status_code == 400


# ── Lifecycle ────────────────────────────────────────────────────────────────

def test_bake_compacts_labels_and_clears_history(client, cache_root, grid_xyz):
    sid = _create(client, grid_xyz)
    sess = main._cloud_sessions[sid]
    painted = _box_mask(sess.positions, BOX_BIG)
    _paint(client, sid, [_stroke(BOX_BIG, 7, "s1")])

    client.post(f"/api/cloud/session/{sid}/delete_region", json={"region": BOX_SMALL})
    survivors = ~sess.deleted.copy()
    expected_after = _labels(sid)[survivors].copy()

    res = client.post(f"/api/cloud/session/{sid}/bake")
    assert res.status_code == 200, res.text

    # The column rides the extras compaction loop; the history cannot, because
    # compaction invalidates every absolute index it holds.
    assert np.array_equal(_labels(sid), expected_after)
    assert sess.label_history == {}
    assert int(painted.sum()) > 0


def test_commit_labels_rebuilds_and_exposes_the_column(client, cache_root, grid_xyz):
    sid = _create(client, grid_xyz)
    sess = main._cloud_sessions[sid]
    before = sess.octree_cache_id
    _paint(client, sid, [_stroke(BOX_BIG, 2, "s1")])

    res = client.post(f"/api/cloud/session/{sid}/commit_labels", json={})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["cache_id"] != before, "commit should rebuild the octree"
    assert sess.label_dirty.get(SLUG) is False
    # The label column reaches the octree as a colourable attribute.
    assert any(a.get("name") == SLUG for a in body.get("attributes", []))
    # Commit does NOT clear the undo history (unlike bake).
    assert len(sess.label_history[SLUG]) == 1


def test_commit_without_a_label_column_is_a_400(client, cache_root, grid_xyz):
    sid = _create(client, grid_xyz)
    res = client.post(f"/api/cloud/session/{sid}/commit_labels", json={})
    assert res.status_code == 400


# ── LAS classification round-trip ────────────────────────────────────────────

def test_export_writes_classes_into_the_las_classification_byte(
    client, cache_root, grid_xyz, tmp_path,
):
    """Export -> re-import must preserve classes in the STANDARD byte.

    Reported: ground-segment a cloud, export to LAZ, re-import, open the label
    tool on the ASPRS set — everything showed as unclassified. The classes were
    written only to an ExtraBytes dimension, so the LAS classification byte was
    all zeros: our own importer drops it as constant, and every other LiDAR tool
    saw an unclassified file too.
    """
    import laspy

    sid = _create(client, grid_xyz)
    sess = main._cloud_sessions[sid]
    painted = int(_box_mask(sess.positions, BOX_BIG).sum())
    assert painted > 0
    _paint(client, sid, [_stroke(BOX_BIG, 5, "s1")])

    out = tmp_path / "labelled.laz"
    res = client.post("/api/pointcloud/export", json={
        "source": {"kind": "session", "session_id": sid},
        "dest_path": str(out), "format": "laz",
    })
    assert res.status_code == 200, res.text
    assert decode_streamed_json(res.content)["success"] is True
    assert out.exists()

    las = laspy.read(str(out))
    written = np.asarray(las.classification)
    # The painted class reached the standard byte, not just an extra dim.
    assert int((written == 5).sum()) == painted
    # ...and the richer column is still there for our own round-trip.
    assert SLUG in las.point_format.dimension_names

    # Re-importing sees it as a real classification, not a constant to discard.
    sid2 = _create(client, out, fmt=None)
    body = client.get(
        f"/api/cloud/session/{sid2}/label_summary?slug=las_classification"
    ).json()
    assert body["class_counts"].get("5") == painted


# ── Validation ───────────────────────────────────────────────────────────────

@pytest.mark.parametrize("slug", ["classification", "intensity", "gps_time"])
def test_reserved_las_slugs_are_rejected(client, cache_root, grid_xyz, slug):
    """A slug colliding with a standard LAS dimension makes laspy bit-pack a
    float column into the classification-flags byte and HARD-CRASH the process
    on export. Reject it at the door, naming the reason."""
    sid = _create(client, grid_xyz)
    res = client.post(f"/api/cloud/session/{sid}/label_region",
                      json={"strokes": [_stroke(BOX_BIG, 1, "s1")], "slug": slug})
    assert res.status_code == 400
    assert "reserved" in res.json()["detail"].lower()


@pytest.mark.parametrize("slug", ["Classification", "CLASSIFICATION"])
def test_reserved_slugs_are_rejected_case_insensitively(
    client, cache_root, grid_xyz, slug,
):
    """laspy resolves standard dimension names case-blind, so a capitalised
    variant is just as fatal. These are caught by the lower-case-only slug
    regex first — what matters is that they never reach the LAS writer."""
    sid = _create(client, grid_xyz)
    res = client.post(f"/api/cloud/session/{sid}/label_region",
                      json={"strokes": [_stroke(BOX_BIG, 1, "s1")], "slug": slug})
    assert res.status_code == 400
    assert SLUG not in main._cloud_sessions[sid].extras


@pytest.mark.parametrize("slug", ["", "Bad-Slug", "9leading", "x" * 40])
def test_malformed_slugs_are_rejected(client, cache_root, grid_xyz, slug):
    sid = _create(client, grid_xyz)
    res = client.post(f"/api/cloud/session/{sid}/label_region",
                      json={"strokes": [_stroke(BOX_BIG, 1, "s1")], "slug": slug})
    assert res.status_code == 400


@pytest.mark.parametrize("cls", [-1, 256, 1000])
def test_out_of_range_classes_are_rejected(client, cache_root, grid_xyz, cls):
    sid = _create(client, grid_xyz)
    res = client.post(f"/api/cloud/session/{sid}/label_region",
                      json={"strokes": [_stroke(BOX_BIG, cls, "s1")]})
    assert res.status_code == 400


def test_empty_stroke_list_is_rejected(client, cache_root, grid_xyz):
    sid = _create(client, grid_xyz)
    res = client.post(f"/api/cloud/session/{sid}/label_region", json={"strokes": []})
    assert res.status_code == 400


def test_an_invalid_region_leaves_no_partial_batch(client, cache_root, grid_xyz):
    """Validation happens before the lock, so a bad stroke late in a batch must
    not leave the earlier ones applied."""
    sid = _create(client, grid_xyz)
    res = client.post(f"/api/cloud/session/{sid}/label_region", json={"strokes": [
        _stroke(BOX_BIG, 1, "ok"),
        {"region": {"kind": "nonsense"}, "to_class": 2, "stroke_id": "bad"},
    ]})
    assert res.status_code == 400
    assert SLUG not in main._cloud_sessions[sid].extras
