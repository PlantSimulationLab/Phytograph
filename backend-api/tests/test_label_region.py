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
    body = decode_streamed_json(res.content)
    assert body["cache_id"] != before, "commit should rebuild the octree"
    # The label column reaches the octree as a colourable attribute.
    assert any(a.get("name") == SLUG for a in body.get("attributes", []))
    # A commit is an undo boundary: the column's history is gone.
    assert sess.label_history.get(SLUG, []) == []


@pytest.mark.parametrize("undo", ["stroke_ids", "edit_count"])
def test_undo_after_a_commit_keeps_the_committed_labels(
    client, cache_root, grid_xyz, undo,
):
    """Paint s1, s2, commit, paint s3, undo: s1 and s2 must survive.

    The renderer clears its stroke list at commit, so after s3 it holds only
    [s3] and an undo keeps nothing. While the backend still held s1/s2 in its
    history, "keep nothing" reverse-applied them too and the committed labels
    vanished. Both undo paths the renderer uses: by stroke id (Cmd+Z) and by
    count (the panel button).
    """
    sid = _create(client, grid_xyz)
    _paint(client, sid, [_stroke(BOX_BIG, 64, "s1")])
    _paint(client, sid, [_stroke(BOX_SMALL, 65, "s2")])
    committed = _labels(sid).copy()
    assert set(np.unique(committed)) == {0.0, 64.0, 65.0}

    res = client.post(f"/api/cloud/session/{sid}/commit_labels", json={})
    assert res.status_code == 200, res.text

    far = {"kind": "box", "min": [0.75, 0.75, 0.75], "max": [0.95, 0.95, 0.95],
           "invert": False}
    _paint(client, sid, [_stroke(far, 255, "s3")])
    assert (_labels(sid) == 255).any()

    body = ({"undo_after_stroke_ids": []} if undo == "stroke_ids"
            else {"edit_count": 0})
    res = client.post(f"/api/cloud/session/{sid}/reset_label_edits", json=body)
    assert res.status_code == 200, res.text
    np.testing.assert_array_equal(_labels(sid), committed)
    assert res.json()["class_counts"].get("64", 0) > 0


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


@pytest.mark.parametrize("fmt", ["las", "laz"])
@pytest.mark.parametrize("to_file", [True, False], ids=["streamed", "generic"])
def test_export_writes_user_classes_above_31(
    client, cache_root, grid_xyz, tmp_path, fmt, to_file,
):
    """User classes start at 64, and the legacy point formats (0-5) hold only a
    5-bit classification: exporting any painted cloud raised OverflowError.

    Classes 64 and 255 deliberately, not 5 — the test above uses a class below
    32 and so could never see this. Both writers: `dest_path` streams through
    `_export_session_to_las`, while no `dest_path` takes the generic path.
    """
    import base64
    import io
    import laspy

    sid = _create(client, grid_xyz)
    sess = main._cloud_sessions[sid]
    big = _box_mask(sess.positions, BOX_BIG)
    small = _box_mask(sess.positions, BOX_SMALL)
    _paint(client, sid, [_stroke(BOX_BIG, 64, "s1"), _stroke(BOX_SMALL, 255, "s2")])
    n64 = int((big & ~small).sum())
    n255 = int(small.sum())
    assert n64 > 0 and n255 > 0

    body = {"source": {"kind": "session", "session_id": sid}, "format": fmt}
    out = tmp_path / f"labelled.{fmt}"
    if to_file:
        body["dest_path"] = str(out)
    res = client.post("/api/pointcloud/export", json=body)
    assert res.status_code == 200, res.text
    payload = decode_streamed_json(res.content)
    assert payload["success"] is True, payload.get("error")
    if not to_file:
        out.write_bytes(base64.b64decode(payload["data"]))

    las = laspy.read(io.BytesIO(out.read_bytes()))
    assert las.point_format.id in (6, 7)
    written = np.asarray(las.classification)
    assert int((written == 64).sum()) == n64
    assert int((written == 255).sum()) == n255
    assert int((written == 0).sum()) == len(written) - n64 - n255
    # The full label value still rides its extra dim.
    np.testing.assert_array_equal(np.rint(np.asarray(las[SLUG])), written)

    # Our own importer (and PotreeConverter behind it) accepts format 6/7.
    sid2 = _create(client, out, fmt=None)
    counts = client.get(
        f"/api/cloud/session/{sid2}/label_summary?slug=las_classification"
    ).json()["class_counts"]
    assert counts.get("64") == n64 and counts.get("255") == n255


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


# ── Undo by stroke id (the global Cmd+Z path) ────────────────────────────────
#
# A count cannot express the renderer's undo. Its stroke list counts USER
# GESTURES; this history counts RECORDED CHANGES, and a gesture whose
# from-class gate matched nothing is never recorded. So after one no-op stroke
# the two are off by one, and `edit_count` silently rolls back the wrong edit
# (`min(k, len(hist))` clamps rather than complaining). `stroke_id` is the
# documented join key between the two lists, so resolving it server-side is the
# only exact answer.

def test_undo_by_stroke_id_is_exact_when_a_no_op_gesture_diverged_the_counts(
    client, cache_root, grid_xyz,
):
    sid = _create(client, grid_xyz)
    # s_noop repaints class 5 -> 9, but nothing is class 5 yet, so it records
    # NOTHING. The renderer still holds it as a gesture.
    _paint(client, sid, [
        _stroke(BOX_BIG, 1, "s1"),
        _stroke(BOX_BIG, 9, "s_noop", from_classes=[5]),
        _stroke(BOX_SMALL, 2, "s2"),
    ])
    hist = main._cloud_sessions[sid].label_history[SLUG]
    assert [d.stroke_id for d in hist] == ["s1", "s2"], "precondition: s_noop unrecorded"

    # The user undoes their last gesture, so the renderer still holds
    # ["s1", "s_noop"] -> newest-first ["s_noop", "s1"]. By COUNT that is keep=2,
    # which would keep s1 AND s2 and undo nothing at all.
    res = client.post(f"/api/cloud/session/{sid}/reset_label_edits",
                      json={"undo_after_stroke_ids": ["s_noop", "s1"]})
    assert res.status_code == 200, res.text
    assert res.json()["label_edit_count"] == 1, "must keep s1 only"

    ref = _create(client, grid_xyz)
    _paint(client, ref, [_stroke(BOX_BIG, 1, "s1")])
    assert np.array_equal(_labels(sid), _labels(ref))


def test_undo_by_stroke_id_empty_list_clears_every_edit(client, cache_root, grid_xyz):
    sid = _create(client, grid_xyz)
    _paint(client, sid, [_stroke(BOX_BIG, 1, "s1"), _stroke(BOX_SMALL, 2, "s2")])
    res = client.post(f"/api/cloud/session/{sid}/reset_label_edits",
                      json={"undo_after_stroke_ids": []})
    assert res.status_code == 200, res.text
    assert np.all(_labels(sid) == main.MANUAL_CLASS_UNLABELED)
    assert main._cloud_sessions[sid].label_history[SLUG] == []


def test_undo_walks_back_past_several_unrecorded_gestures(client, cache_root, grid_xyz):
    """Several no-op gestures in a row must not stop the walk at the first miss."""
    sid = _create(client, grid_xyz)
    _paint(client, sid, [
        _stroke(BOX_BIG, 1, "s1"),
        _stroke(BOX_BIG, 9, "n1", from_classes=[7]),
        _stroke(BOX_BIG, 9, "n2", from_classes=[7]),
    ])
    assert [d.stroke_id for d in main._cloud_sessions[sid].label_history[SLUG]] == ["s1"]
    res = client.post(f"/api/cloud/session/{sid}/reset_label_edits",
                      json={"undo_after_stroke_ids": ["n2", "n1", "s1"]})
    assert res.status_code == 200, res.text
    assert res.json()["label_edit_count"] == 1


def test_stroke_ids_take_precedence_over_edit_count(client, cache_root, grid_xyz):
    sid = _create(client, grid_xyz)
    _paint(client, sid, [_stroke(BOX_BIG, 1, "s1"), _stroke(BOX_SMALL, 2, "s2")])
    res = client.post(f"/api/cloud/session/{sid}/reset_label_edits",
                      json={"edit_count": 2, "undo_after_stroke_ids": ["s1"]})
    assert res.status_code == 200, res.text
    assert res.json()["label_edit_count"] == 1


# ── Labelling a column the file already carries ──────────────────────────────
#
# The renderer feature these back: the labelling tool can now paint into ANY
# classification column, not just the four its presets named. That rests
# entirely on `_ensure_label_column_locked` REUSING a pre-existing column rather
# than creating a parallel one — behaviour the backend already had and nothing
# pinned. Without these, a refactor could break the whole feature with every
# frontend test still green.

TREE_SLUG = "tree_instance"
TREE_FORMAT = "x y z tree_instance"


@pytest.fixture
def tree_instance_xyz(tmp_path) -> Path:
    """The grid fixture plus a tree_instance column holding only 1 and 3.

    Shaped after a REAL failed tree segmentation
    (example-datasets/almond_treseg_failure.laz holds exactly {1, 2}):

      * no 0 — so a synthesised "unassigned" class is the only way to
        un-assign a mis-grabbed point, and
      * a GAP at 2 — so a class list built from the column's [min,max] is
        distinguishable from one built from its exact surviving values.
    """
    f = tmp_path / "grid_tree.xyz"
    lines = []
    for i in range(10):
        for j in range(10):
            for k in range(10):
                # Split on x so a box region can straddle the two instances.
                tree = 1 if i < 4 else 3
                lines.append(f"{i*0.1:.4f} {j*0.1:.4f} {k*0.1:.4f} {tree}")
    f.write_text("\n".join(lines) + "\n")
    return f


def test_label_region_reuses_an_imported_column_in_place(
    client, cache_root, tree_instance_xyz,
):
    """Painting an existing column EDITS it; it does not shadow it.

    If this regressed to creating a fresh zero-filled column, every count in
    the UI would start at "all unclassified" and the user's correction would be
    written somewhere the rest of the app never reads.
    """
    sid = _create(client, tree_instance_xyz, fmt=TREE_FORMAT)
    sess = main._cloud_sessions[sid]
    before = sess.extras[TREE_SLUG].copy()
    assert set(np.unique(before)) == {1.0, 3.0}

    expected = _box_mask(sess.positions, BOX_SMALL)
    assert expected.sum() > 0

    res = client.post(f"/api/cloud/session/{sid}/label_region",
                      json={"strokes": [_stroke(BOX_SMALL, 1, "s1")],
                            "slug": TREE_SLUG})
    assert res.status_code == 200, res.text
    body = res.json()

    # The column was ALREADY there, so nothing was created.
    assert body["created_column"] is False

    after = sess.extras[TREE_SLUG]
    assert np.all(after[expected] == 1)
    # Everything the stroke did not cover keeps the FILE's value — not 0, which
    # is what a freshly-created column would have left behind.
    assert np.array_equal(after[~expected], before[~expected])
    assert 3.0 in set(np.unique(after))


def test_label_summary_reports_an_imported_column_real_classes(
    client, cache_root, tree_instance_xyz,
):
    """Before any paint, the summary is the FILE's classes — not {0: N}.

    This is the single assertion that distinguishes "reused the column" from
    "created a new one", and it is what the panel's opening class counts are
    read from.
    """
    sid = _create(client, tree_instance_xyz, fmt=TREE_FORMAT)
    res = client.get(f"/api/cloud/session/{sid}/label_summary",
                     params={"slug": TREE_SLUG})
    assert res.status_code == 200, res.text
    counts = {int(k): v for k, v in res.json()["class_counts"].items()}
    assert counts == {1: 400, 3: 600}
    assert main.MANUAL_CLASS_UNLABELED not in counts


def test_observed_classes_keeps_the_gap(client, cache_root, tree_instance_xyz):
    """The session reports the EXACT surviving values, gap included.

    The renderer derives its class list from these. A [min,max] pair cannot
    express the gap, so a range-derived list would invent a "Tree 2" owning no
    points — which is why the fixture skips 2.
    """
    sid = _create(client, tree_instance_xyz, fmt=TREE_FORMAT)
    with main._cloud_session_lock:
        observed = main._session_observed_classes_locked(main._cloud_sessions[sid])
    assert observed[TREE_SLUG] == [1, 3]


def test_a_custom_slug_creates_a_column_with_the_requested_label(
    client, cache_root, grid_xyz,
):
    """A brand-new classification is named by the USER, not "Manual Class"."""
    sid = _create(client, grid_xyz)
    res = client.post(f"/api/cloud/session/{sid}/label_region",
                      json={"strokes": [_stroke(BOX_BIG, 64, "s1")],
                            "slug": "row_qc", "label": "Row QC"})
    assert res.status_code == 200, res.text
    assert res.json()["created_column"] is True

    sess = main._cloud_sessions[sid]
    assert "row_qc" in sess.extras
    meta = {d["slug"]: d.get("label") for d in sess.extra_dims_meta}
    assert meta["row_qc"] == "Row QC"


def test_two_label_columns_keep_independent_histories(
    client, cache_root, tree_instance_xyz,
):
    """Undo on one column must not disturb another.

    The renderer holds ONE stroke list and blocks a column switch while it is
    non-empty; that guard is a convenience only because the backend genuinely
    keys its history per slug. If it did not, the block would be load-bearing
    and a stale UI could silently corrupt the wrong column.
    """
    sid = _create(client, tree_instance_xyz, fmt=TREE_FORMAT)
    sess = main._cloud_sessions[sid]

    _paint(client, sid, [_stroke(BOX_BIG, 2, "m1")])          # manual_class
    manual_after = sess.extras[SLUG].copy()

    res = client.post(f"/api/cloud/session/{sid}/label_region",
                      json={"strokes": [_stroke(BOX_BIG, 1, "t1")],
                            "slug": TREE_SLUG})
    assert res.status_code == 200, res.text

    # Undo the tree_instance stroke only.
    res = client.post(f"/api/cloud/session/{sid}/reset_label_edits",
                      json={"edit_count": 0, "slug": TREE_SLUG,
                            "undo_after_stroke_ids": ["t1"]})
    assert res.status_code == 200, res.text

    # tree_instance is back to the file's values; manual_class is untouched.
    assert set(np.unique(sess.extras[TREE_SLUG])) == {1.0, 3.0}
    assert np.array_equal(sess.extras[SLUG], manual_after)


def test_a_reserved_slug_is_refused_rather_than_crashing_the_writer(
    client, cache_root, grid_xyz,
):
    """`classification` would make laspy bit-pack a float column into the
    classification-flags byte and hard-crash the process. The renderer mirrors
    this list to keep it out of the picker; the backend is the real guard."""
    sid = _create(client, grid_xyz)
    res = client.post(f"/api/cloud/session/{sid}/label_region",
                      json={"strokes": [_stroke(BOX_BIG, 1, "s1")],
                            "slug": "classification"})
    assert res.status_code == 400


def test_an_edit_during_a_commit_build_leaves_the_octree_stale(
    client, cache_root, grid_xyz, monkeypatch,
):
    """A commit's octree build must not claim to be current if an edit landed
    while it ran.

    `_session_rebuild` set `octree_cache_id` unconditionally when the converter
    returned. A delete arriving mid-build had already cleared it (the octree is
    behind the mask), and the rebuild then put the pre-delete octree back as
    current, so the renderer's follow-up refresh (`bake?compact=false`) took the
    no-rebuild fast path and kept the deleted points in the octree for good.
    """
    import threading

    sid = _create(client, grid_xyz)
    sess = main._cloud_sessions[sid]
    _paint(client, sid, [_stroke(BOX_BIG, 64, "s1")])

    entered, release = threading.Event(), threading.Event()
    real_build = main._build_octree_from_las

    def held_build(*a, **k):
        entered.set()
        assert release.wait(30), "test never released the build"
        return real_build(*a, **k)

    monkeypatch.setattr(main, "_build_octree_from_las", held_build)
    result = {}
    t = threading.Thread(target=lambda: result.update(
        res=client.post(f"/api/cloud/session/{sid}/commit_labels", json={})))
    t.start()
    assert entered.wait(30), "commit never reached the converter"

    res = client.post(f"/api/cloud/session/{sid}/delete_region", json={"region": BOX_SMALL})
    assert res.status_code == 200 and res.json()["deleted_count"] > 0
    release.set()
    t.join(60)
    assert result["res"].status_code == 200, result["res"].text
    committed = decode_streamed_json(result["res"].content)
    assert committed["octree_stale"] is True
    monkeypatch.setattr(main, "_build_octree_from_las", real_build)

    # The session is still behind: nothing claims the pre-delete octree...
    assert sess.octree_cache_id is None
    # ...but it is pinned as the one on screen.
    assert sess.rendered_octree_cache_id == committed["cache_id"]

    # So the refresh really rebuilds, and its octree excludes the deleted points.
    res = client.post(f"/api/cloud/session/{sid}/bake?compact=false")
    assert res.status_code == 200, res.text
    body = decode_streamed_json(res.content)
    assert body["cache_id"] != committed["cache_id"]
    survivors = int((~sess.deleted).sum())
    assert body["point_count"] == survivors < 1000


@pytest.mark.parametrize("undo", ["stroke_ids", "edit_count"])
def test_rerunning_a_segmentation_ends_that_columns_undo(
    client, cache_root, grid_xyz, undo,
):
    """Hand-correct `wood_class`, re-run wood segmentation, Undo: the NEW
    segmentation must be untouched.

    The re-run overwrites the whole column but left its label history in place,
    so the undo reverse-applied the old stroke's deltas (the values from BEFORE
    the hand-correction) onto the fresh segmentation.
    """
    wood = main.WOOD_CLASS_SLUG
    body = {"method": "geometric", "wood_bias": 0.6, "k_max": 40, "reg_iters": 1}
    # The re-run uses different settings: an identical re-run reproduces the
    # first result, and reverse-applying its deltas would then change nothing.
    body2 = {"method": "geometric", "wood_bias": 0.05, "k_max": 10, "reg_iters": 1}
    sid = _create(client, grid_xyz)
    res = client.post(f"/api/cloud/session/{sid}/segment_wood", json=body)
    assert res.status_code == 200, res.text
    assert decode_streamed_json(res.content).get("error") is None
    first = main._cloud_sessions[sid].extras[wood].copy()

    # Hand-correct: a class the segmentation never writes, so any reversal shows.
    res = client.post(f"/api/cloud/session/{sid}/label_region",
                      json={"strokes": [_stroke(BOX_BIG, 64, "fix")], "slug": wood})
    assert res.status_code == 200, res.text
    assert main._cloud_sessions[sid].label_history.get(wood)

    res = client.post(f"/api/cloud/session/{sid}/segment_wood", json=body2)
    assert res.status_code == 200, res.text
    fresh = main._cloud_sessions[sid].extras[wood].copy()
    assert not (fresh == 64).any()
    box = _box_mask(main._cloud_sessions[sid].positions, BOX_BIG)
    assert (fresh[box] != first[box]).sum() > 50, "re-run must differ where corrected"

    req = ({"undo_after_stroke_ids": [], "slug": wood} if undo == "stroke_ids"
           else {"edit_count": 0, "slug": wood})
    res = client.post(f"/api/cloud/session/{sid}/reset_label_edits", json=req)
    assert res.status_code == 200, res.text
    np.testing.assert_array_equal(main._cloud_sessions[sid].extras[wood], fresh)


def test_instance_columns_take_ids_above_255(client, cache_root, tree_instance_xyz):
    """A plot holds more than 255 trees, but every column was capped at one
    byte, so tree 300 could not be painted at all (400). Instance columns now
    run to the float32 column's exact-integer limit; the undo round-trips."""
    slug = "tree_instance"
    sid = _create(client, tree_instance_xyz, fmt=TREE_FORMAT)
    sess = main._cloud_sessions[sid]
    before = sess.extras[slug].copy()
    big = _box_mask(sess.positions, BOX_BIG)
    small = _box_mask(sess.positions, BOX_SMALL)

    res = client.post(f"/api/cloud/session/{sid}/label_region",
                      json={"strokes": [_stroke(BOX_BIG, 300, "a")], "slug": slug})
    assert res.status_code == 200, res.text
    # Split tree 300: the From gate on 300 repaints only what is already 300.
    res = client.post(f"/api/cloud/session/{sid}/label_region", json={
        "strokes": [_stroke(BOX_SMALL, 301, "b", from_classes=[300])], "slug": slug})
    assert res.status_code == 200, res.text
    col = sess.extras[slug]
    assert int((col == 301).sum()) == int(small.sum())
    assert int((col == 300).sum()) == int((big & ~small).sum())
    assert res.json()["class_counts"]["301"] == int(small.sum())

    res = client.post(f"/api/cloud/session/{sid}/reset_label_edits",
                      json={"undo_after_stroke_ids": ["a"], "slug": slug})
    assert res.status_code == 200, res.text
    assert int((sess.extras[slug] == 300).sum()) == int(big.sum())
    res = client.post(f"/api/cloud/session/{sid}/reset_label_edits",
                      json={"undo_after_stroke_ids": [], "slug": slug})
    np.testing.assert_array_equal(sess.extras[slug], before)


@pytest.mark.parametrize("slug,cls,ok", [
    ("tree_instance", main.LABEL_INSTANCE_CLASS_MAX, True),
    ("tree_instance", main.LABEL_INSTANCE_CLASS_MAX + 1, False),
    ("organ_instance", 70_000, True),
    ("manual_class", 300, False),
    ("row_qc", 256, False),
])
def test_class_range_is_per_column(client, cache_root, grid_xyz, slug, cls, ok):
    sid = _create(client, grid_xyz)
    res = client.post(f"/api/cloud/session/{sid}/label_region",
                      json={"strokes": [_stroke(BOX_BIG, cls, "s1")], "slug": slug})
    assert (res.status_code == 200) == ok, res.text
    if ok:
        assert float(main._cloud_sessions[sid].extras[slug].max()) == cls


def test_commit_labels_is_cancellable_and_leaves_the_octree_alone(
    client, cache_root, grid_xyz, monkeypatch,
):
    """The renderer runs a label commit in its background refresh queue, whose
    Cancel stopped the bake after it but not the commit's own converter run:
    the route minted no run_id and passed no cancel event down. Now the route
    streams a run_id, the converter gets that run's live event, and a cancelled
    commit claims nothing: the session keeps the octree it had."""
    import json as _json
    import queue
    import threading

    sid = _create(client, grid_xyz)
    sess = main._cloud_sessions[sid]
    _paint(client, sid, [_stroke(BOX_BIG, 64, "s1")])
    before = sess.octree_cache_id

    # 1. The streamed route names its run.
    raw = client.post(f"/api/cloud/session/{sid}/commit_labels", json={}).content
    assert b'"run_id"' in raw[:raw.index(b'{"session_id"')]
    assert decode_streamed_json(raw)["cache_id"]

    # 2. The converter polls THIS run's event, and a cancel stops the commit.
    _paint(client, sid, [_stroke(BOX_SMALL, 65, "s2")])
    current = sess.octree_cache_id
    seen = {}

    def cancelled_converter(input_las, out_dir, cancel_event=None, poll=0.2):
        seen["event"] = cancel_event
        raise main.ScanCancelled()

    monkeypatch.setattr(main, "_run_potree_converter", cancelled_converter)
    run_id, cancel_event = main._new_cancel_token()
    reporter = main._ProgressReporter(queue.Queue(), cancel_event)
    with pytest.raises(main.ScanCancelled):
        main._do_commit_labels(sess, sid, SLUG, reporter)
    assert seen["event"] is cancel_event, "the converter got no live cancel event"
    assert sess.octree_cache_id == current, "a cancelled commit claimed an octree"
    assert current != before


@pytest.mark.parametrize("region", [
    {"kind": "spheres_union", "centers": [[0.3, 0.3, 0.3], [0.62, 0.5, 0.41]],
     "radii": [0.17, 0.2], "invert": False},
    {"kind": "box", "min": [0.15, 0.2, 0.0], "max": [0.55, 0.9, 0.35], "invert": False},
    {"kind": "box", "min": [0.15, 0.2, 0.0], "max": [0.55, 0.9, 0.35], "invert": True},
    {"kind": "spheres_union", "centers": [], "radii": [], "invert": False},
])
def test_region_candidates_equal_the_full_mask(region):
    """The culled selection a stroke now uses must be exactly the full mask's."""
    rng = np.random.default_rng(3)
    pts = rng.uniform(0, 1, size=(20_000, 3))
    want = np.flatnonzero(main._region_mask(pts, region))
    got = main._region_candidates(pts, region)
    np.testing.assert_array_equal(got, want)


def test_a_compaction_during_the_unlocked_selection_is_respected(
    client, cache_root, grid_xyz, monkeypatch,
):
    """A stroke's selection is computed outside the session lock, as indices
    into the arrays it captured. A bake that compacts the session in that window
    replaces those arrays and shifts every index after the removed rows, so
    writing the stale selection would paint the wrong points. The stroke must
    re-select under the lock when the geometry moved."""
    sid = _create(client, grid_xyz)
    sess = main._cloud_sessions[sid]
    real = main._region_candidates
    fired = []

    def candidates_then_compact(*a, **k):
        out = real(*a, **k)
        if not fired:
            fired.append(1)
            assert client.post(f"/api/cloud/session/{sid}/delete_region",
                               json={"region": BOX_SMALL}).status_code == 200
            assert client.post(f"/api/cloud/session/{sid}/bake").status_code == 200
        return out

    monkeypatch.setattr(main, "_region_candidates", candidates_then_compact)
    _paint(client, sid, [_stroke(BOX_BIG, 64, "s1")])
    assert fired and len(sess.positions) < 1000, "the bake did not compact"
    want = _box_mask(sess.positions, BOX_BIG)
    np.testing.assert_array_equal(_labels(sid) == 64, want)


def test_excluded_classes_are_never_repainted(client, cache_root, grid_xyz):
    """Hidden and locked classes arrive as `exclude_classes`: a stroke over them
    leaves them alone even with no From gate ("any visible class")."""
    sid = _create(client, grid_xyz)
    sess = main._cloud_sessions[sid]
    _paint(client, sid, [_stroke(BOX_SMALL, 64, "s1")])
    small = _box_mask(sess.positions, BOX_SMALL)
    big = _box_mask(sess.positions, BOX_BIG)
    stroke = _stroke(BOX_BIG, 65, "s2")
    stroke["exclude_classes"] = [64]
    body = _paint(client, sid, [stroke])
    assert (_labels(sid)[small] == 64).all()
    assert (_labels(sid)[big & ~small] == 65).all()
    assert body["applied"][0]["selected_count"] == int((big & ~small).sum())
    # And the undo of that stroke leaves the excluded class as it was.
    client.post(f"/api/cloud/session/{sid}/reset_label_edits",
                json={"undo_after_stroke_ids": ["s1"]})
    assert (_labels(sid)[small] == 64).all() and not (_labels(sid) == 65).any()


def test_unlabelled_clusters_find_the_gaps_largest_first(client, cache_root, tmp_path):
    """Two separate blobs of points, one of them labelled: the finder reports
    only the unlabelled blob, and ranks separate blobs by size."""
    rng = np.random.default_rng(1)
    a = rng.uniform(0, 0.2, size=(300, 3))                 # big blob near origin
    b = rng.uniform(0, 0.2, size=(100, 3)) + [3, 3, 3]     # small blob far away
    c = rng.uniform(0, 0.2, size=(200, 3)) + [0, 3, 0]     # medium blob
    f = tmp_path / "blobs.xyz"
    np.savetxt(f, np.vstack([a, b, c]), fmt="%.5f")
    sid = _create(client, f)
    body = client.get(f"/api/cloud/session/{sid}/unlabelled_clusters").json()
    assert body["total"] == 600
    assert [cl["count"] for cl in body["clusters"]] == [300, 200, 100]
    assert np.allclose(body["clusters"][2]["center"], b.mean(axis=0), atol=1e-3)

    # Label the big blob: it drops out, the others remain in order.
    box = {"kind": "box", "min": [-1, -1, -1], "max": [0.5, 0.5, 0.5], "invert": False}
    _paint(client, sid, [_stroke(box, 64, "s1")])
    body = client.get(f"/api/cloud/session/{sid}/unlabelled_clusters").json()
    assert body["total"] == 300
    assert [cl["count"] for cl in body["clusters"]] == [200, 100]


def test_unlabelled_clusters_do_not_splinter_a_sparse_blob():
    """Points further apart than a grid cell must still form one area: cells
    are never finer than twice the typical point spacing."""
    pts = np.loadtxt(Path(__file__).resolve().parents[2] / "tests/e2e/fixtures/two-blobs.xyz")
    clusters = main._unlabelled_clusters(pts, np.ones(len(pts), dtype=bool))
    assert [c["count"] for c in clusters] == [40, 20]
