"""Label tool F7-F9 on the backend:

- F7 `label_extent`: where an instance's points are, to frame it.
- F8 `from_column`: pre-label a column from another, through a class map, as
  one undoable stroke.
- F9 LAS output: flag columns become the record's flag bits (and come back),
  the classification byte is taken from a chosen column (refused above 255),
  and class names/colors travel in the file and come back as palettes.
"""
from pathlib import Path

import numpy as np
import pytest

import main
from tests.binframe import decode_streamed_json


def _converter_available() -> bool:
    try:
        main._resolve_potree_converter_path()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _converter_available(), reason="PotreeConverter binary not found")

EVERYTHING = {"kind": "box", "min": [-1e30, -1e30, -1e30], "max": [1e30, 1e30, 1e30]}


@pytest.fixture
def cloud(client, tmp_path, monkeypatch) -> str:
    """40 points: x = 0..39, with a 4th column `tree_instance` of 3 (x < 10),
    7 (10 <= x < 25) and 0 (the rest) — non-contiguous ids on purpose."""
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "octree_cache"))
    f = tmp_path / "trees.xyz"
    rows = []
    for i in range(40):
        tid = 3 if i < 10 else 7 if i < 25 else 0
        rows.append(f"{i:.1f} {i % 3:.1f} {0.5 * (i % 5):.1f} {tid}")
    f.write_text("\n".join(rows) + "\n")
    res = client.post("/api/cloud/session/create", json={
        "source_path": str(f), "ascii_format": "x y z tree_instance"})
    assert res.status_code == 200, res.text
    return decode_streamed_json(res.content)["session_id"]


def _paint(client, sid, strokes, slug):
    res = client.post(f"/api/cloud/session/{sid}/label_region", json={"strokes": strokes, "slug": slug})
    assert res.status_code == 200, res.text
    return res.json()


# ── F7 ───────────────────────────────────────────────────────────────────────

def test_label_extent_frames_one_instance(client, cloud):
    body = client.get(f"/api/cloud/session/{cloud}/label_extent?slug=tree_instance&value=7").json()
    assert body["count"] == 15
    assert body["min"][0] == pytest.approx(10) and body["max"][0] == pytest.approx(24)
    empty = client.get(f"/api/cloud/session/{cloud}/label_extent?slug=tree_instance&value=5").json()
    assert empty["count"] == 0


# ── F8 ───────────────────────────────────────────────────────────────────────

def test_from_column_maps_classes_and_leaves_unmapped_alone(client, cloud):
    # tree 3 -> class 64, tree 7 -> class 65; 0 is unmapped, so untouched.
    body = _paint(client, cloud, [{
        "region": EVERYTHING, "to_class": 0, "stroke_id": "pre1",
        "from_column": {"slug": "tree_instance", "map": {"3": 64, "7": 65}},
    }], "manual_class")
    assert body["class_counts"] == {"0": 15, "64": 10, "65": 15}
    # One stroke, so one undo restores the empty column.
    res = client.post(f"/api/cloud/session/{cloud}/reset_label_edits",
                      json={"slug": "manual_class", "keep_stroke_ids": []})
    assert res.status_code == 200, res.text
    assert res.json()["class_counts"] == {"0": 40}


def test_from_column_identity_copy_honors_the_from_gate(client, cloud):
    # Paint x < 5 as 9 first; an identity copy gated to Unclassified must not
    # overwrite it.
    _paint(client, cloud, [{"region": {"kind": "box", "min": [-1, -1, -1], "max": [4.5, 9, 9]},
                            "to_class": 9, "stroke_id": "a"}], "plant_instance")
    body = _paint(client, cloud, [{
        "region": EVERYTHING, "to_class": 0, "stroke_id": "b", "from_classes": [0],
        "from_column": {"slug": "tree_instance"},
    }], "plant_instance")
    assert body["class_counts"] == {"0": 15, "3": 5, "7": 15, "9": 5}


@pytest.mark.parametrize("fc, message", [
    ({"slug": "nope"}, "no column"),
    ({"slug": "manual_class"}, "ANOTHER column"),
    ({"slug": "tree_instance", "map": {"3": 999}}, "targets must be"),
    ({"slug": "tree_instance", "map": {"x": 1}}, "map class values"),
])
def test_bad_from_column_is_400(client, cloud, fc, message):
    res = client.post(f"/api/cloud/session/{cloud}/label_region", json={"slug": "manual_class", "strokes": [
        {"region": EVERYTHING, "to_class": 0, "stroke_id": "x", "from_column": fc}]})
    assert res.status_code == 400
    assert message in res.text


# ── F9 ───────────────────────────────────────────────────────────────────────

PALETTES = {
    "manual_class": {"id": "p", "name": "Organs", "slug": "manual_class", "updatedAt": 0, "classes": [
        {"value": 0, "label": "Unclassified", "color": [0.5, 0.5, 0.5]},
        {"value": 64, "label": "Stem", "color": [0.4, 0.2, 0.1]},
        {"value": 65, "label": "Leaf", "color": [0.1, 0.8, 0.2]}]},
}


def _export(client, sid, out: Path, **extra):
    res = client.post("/api/pointcloud/export", json={
        "source": {"kind": "session", "session_id": sid},
        "dest_path": str(out), "format": "las", **extra})
    return res


def test_las_round_trip_flags_class_byte_and_palettes(client, cloud, tmp_path):
    import laspy
    _paint(client, cloud, [
        {"region": {"kind": "box", "min": [-1, -1, -1], "max": [9.5, 9, 9]}, "to_class": 64, "stroke_id": "s"},
        {"region": {"kind": "box", "min": [9.5, -1, -1], "max": [99, 9, 9]}, "to_class": 65, "stroke_id": "l"},
    ], "manual_class")
    # Withhold x >= 30.
    _paint(client, cloud, [{"region": {"kind": "box", "min": [29.5, -1, -1], "max": [99, 9, 9]},
                            "to_class": 1, "stroke_id": "w"}], "flag_withheld")

    out = tmp_path / "out.las"
    res = _export(client, cloud, out, class_palettes=PALETTES)
    assert res.status_code == 200, res.text
    las = laspy.read(str(out))
    x = np.asarray(las.x)
    # The flag is the record's bit, not an extra dimension.
    assert np.array_equal(np.asarray(las.withheld).astype(bool), x > 29.5)
    assert "flag_withheld" not in las.point_format.extra_dimension_names
    # Automatic byte: the hand labels.
    assert np.array_equal(np.asarray(las.classification), np.where(x < 9.5, 64, 65))
    # The LAS classification lookup names the byte's classes.
    lookup = next(v for v in las.header.vlrs if v.user_id.rstrip("\x00") == "LASF_Spec" and v.record_id == 0)
    names = getattr(lookup, "lookups", None)
    if names is None:
        raw = bytes(lookup.record_data)
        names = {raw[i]: raw[i + 1:i + 16].split(b"\x00")[0].decode() for i in range(0, len(raw), 16)}
    assert names[64] == "Stem" and names[65] == "Leaf"

    # Re-import: the flag comes back as its column, and the palette with it.
    res = client.post("/api/cloud/session/create", json={"source_path": str(out)})
    assert res.status_code == 200, res.text
    meta = decode_streamed_json(res.content)
    sid2 = meta["session_id"]
    flags = main._cloud_sessions[sid2].extras["flag_withheld"]
    x2 = main._cloud_sessions[sid2].positions[:, 0]
    assert np.array_equal(flags > 0.5, x2 > 29.5)
    assert meta["class_palettes"]["manual_class"]["classes"][1]["label"] == "Stem"


def test_classification_byte_from_a_chosen_column(client, cloud, tmp_path):
    import laspy
    out = tmp_path / "trees.las"
    res = _export(client, cloud, out, classification_column="tree_instance")
    assert res.status_code == 200, res.text
    las = laspy.read(str(out))
    x = np.asarray(las.x)
    assert np.array_equal(np.asarray(las.classification), np.where(x < 10, 3, np.where(x < 25, 7, 0)))
    # None: the byte is left at 0.
    out0 = tmp_path / "none.las"
    assert _export(client, cloud, out0, classification_column="").status_code == 200
    assert not np.asarray(laspy.read(str(out0)).classification).any()


def test_classification_byte_refuses_values_above_255(client, cloud, tmp_path):
    _paint(client, cloud, [{"region": EVERYTHING, "to_class": 300, "stroke_id": "big"}], "plant_instance")
    res = _export(client, cloud, tmp_path / "x.las", classification_column="plant_instance")
    assert res.status_code == 400 or not decode_streamed_json(res.content).get("success")
    assert "0-255" in res.text
