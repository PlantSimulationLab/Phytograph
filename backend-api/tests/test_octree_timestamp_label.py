"""The time column must READ as "Timestamp" everywhere in the UI.

The column has two correct names at two layers, and conflating them has caused
a regression in each direction:

  `gps-time`  is the octree BUFFER KEY. PotreeConverter writes it from the LAS
              `gps_time` dimension, and the renderer looks the GPU buffer up by
              that exact string (`geometry.attributes[field]`). Renaming it in
              the octree made the lookup miss, the swap silently no-op, and the
              shader keep the previous buffer — the legend showed the timestamp
              range while the points stayed coloured by intensity.

  `Timestamp` is what the user should READ. Phytograph calls the quantity
              `timestamp` in the import wizard, the export picker and every tool
              gate, so showing the raw LAS spelling in the Scans panel and the
              Color-by picker made one column look like two different fields
              depending on where you looked.

The label sidecar reconciles them: it maps the buffer key to a display name and
leaves the key itself untouched. These tests pin both halves.
"""

import json

import pytest

import main


def test_sidecar_labels_the_time_column(tmp_path):
    main._write_octree_labels(tmp_path, [{"slug": "reflectance", "label": "Reflectance"}])
    mapping = json.loads((tmp_path / main._OCTREE_LABELS_FILENAME).read_text())
    assert mapping["gps-time"] == "Timestamp"
    # Existing labels are untouched.
    assert mapping["reflectance"] == "Reflectance"


def test_sidecar_is_written_even_with_no_extra_dims(tmp_path):
    """A LAS/LAZ import can have zero extra dims and still carry gps_time. The
    old code returned early on an empty list, so those octrees got no sidecar
    at all and the picker fell back to the raw `gps-time` slug."""
    main._write_octree_labels(tmp_path, [])
    mapping = json.loads((tmp_path / main._OCTREE_LABELS_FILENAME).read_text())
    assert mapping == {"gps-time": "Timestamp"}


def test_sidecar_does_not_override_an_explicit_label(tmp_path):
    """A source that already names the column keeps its own label."""
    main._write_octree_labels(tmp_path, [{"slug": "gps-time", "label": "Shot time"}])
    mapping = json.loads((tmp_path / main._OCTREE_LABELS_FILENAME).read_text())
    assert mapping["gps-time"] == "Shot time"


def test_metadata_response_carries_the_label(tmp_path):
    """The end of the chain: `_read_octree_metadata` attaches the sidecar label
    to the attribute entry the renderer reads. Keyed on the BUFFER name, so the
    value the picker submits still resolves to a real GPU buffer."""
    (tmp_path / "metadata.json").write_text(json.dumps({
        "points": 10,
        "boundingBox": {"min": [0, 0, 0], "max": [1, 1, 1]},
        "attributes": [
            {"name": "position", "size": 12, "numElements": 3, "elementSize": 4,
             "type": "int32", "min": [0, 0, 0], "max": [1, 1, 1]},
            {"name": "gps-time", "size": 8, "numElements": 1, "elementSize": 8,
             "type": "double", "min": [85.15], "max": [233.57]},
        ],
        "hierarchy": {"firstChunkSize": 0, "stepSize": 0, "depth": 0},
        "spacing": 1.0, "scale": [0.001] * 3, "offset": [0, 0, 0],
    }))
    main._write_octree_labels(tmp_path, [])

    meta = main._read_octree_metadata(tmp_path)
    entry = next(a for a in meta["attributes"] if a["name"] == "gps-time")
    assert entry["label"] == "Timestamp"
    # The KEY must survive unchanged — it indexes the GPU buffer.
    assert entry["name"] == "gps-time"


# ── The cache is why the write-time fix appeared to do nothing ──────────────

def _write_metadata(d, names=("position", "gps-time")):
    attrs = []
    for n in names:
        if n == "position":
            attrs.append({"name": "position", "size": 12, "numElements": 3,
                          "elementSize": 4, "type": "int32",
                          "min": [0, 0, 0], "max": [1, 1, 1]})
        else:
            attrs.append({"name": n, "size": 8, "numElements": 1,
                          "elementSize": 8, "type": "double",
                          "min": [85.15], "max": [233.57]})
    (d / "metadata.json").write_text(json.dumps({
        "points": 10, "boundingBox": {"min": [0, 0, 0], "max": [1, 1, 1]},
        "attributes": attrs,
        "hierarchy": {"firstChunkSize": 0, "stepSize": 0, "depth": 0},
        "spacing": 1.0, "scale": [0.001] * 3, "offset": [0, 0, 0],
    }))


def test_label_reaches_an_octree_built_before_the_fix(tmp_path):
    """THE BUG THIS FILE EXISTS FOR.

    Octrees are cached by CONTENT HASH: re-importing the same file reuses the
    existing directory and never re-runs `_write_octree_labels`. So a label
    added only at write time never reaches a cloud the user already imported —
    the fix ships, the user re-imports, and nothing changes.

    Simulates a sidecar written by the OLD code: every scalar labelled EXCEPT
    the time column.
    """
    _write_metadata(tmp_path)
    (tmp_path / main._OCTREE_LABELS_FILENAME).write_text(json.dumps({
        "reflectance": "Reflectance", "target_index": "Target Index",
    }))

    meta = main._read_octree_metadata(tmp_path)
    entry = next(a for a in meta["attributes"] if a["name"] == "gps-time")
    assert entry["label"] == "Timestamp"


def test_label_reaches_an_octree_with_no_sidecar_at_all(tmp_path):
    """A LAS/LAZ import with zero extra dims wrote no sidecar under the old
    code, so there is nothing on disk to read."""
    _write_metadata(tmp_path)
    assert not (tmp_path / main._OCTREE_LABELS_FILENAME).exists()

    meta = main._read_octree_metadata(tmp_path)
    entry = next(a for a in meta["attributes"] if a["name"] == "gps-time")
    assert entry["label"] == "Timestamp"


def test_read_does_not_override_an_explicit_label(tmp_path):
    """A source that names the column itself keeps its own label."""
    _write_metadata(tmp_path)
    (tmp_path / main._OCTREE_LABELS_FILENAME).write_text(
        json.dumps({"gps-time": "Shot time"}))
    meta = main._read_octree_metadata(tmp_path)
    entry = next(a for a in meta["attributes"] if a["name"] == "gps-time")
    assert entry["label"] == "Shot time"


def test_no_phantom_entry_when_the_cloud_has_no_time_column(tmp_path):
    """The label map is keyed by name and only attaches to attributes that
    exist, so a cloud with no time column must not sprout a "Timestamp" entry
    in the Color-by picker."""
    _write_metadata(tmp_path, names=("position",))
    meta = main._read_octree_metadata(tmp_path)
    assert all(a["name"] != "gps-time" for a in meta["attributes"])
    assert all(a.get("label") != "Timestamp" for a in meta["attributes"])
