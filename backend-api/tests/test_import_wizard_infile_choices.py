"""The import wizard's IN-FILE choices must survive `/api/cloud/session/create-multi`.

Every path-backed import in the app goes through create-multi. For a fixed-
layout format (LAS/LAZ/PLY/E57) the wizard expresses two choices by slug rather
than in a positional column plan:

  - `role_overrides` — "the column my file calls `shot_time` is the Timestamp".
    The backend always accepted it, but the renderer's create-multi call never
    sent it, so the choice was silently dropped on every octree import.
  - `scalar_labels` — the rename box. It was sent nowhere at all.

Both are asserted on the real endpoint's response, not on the helpers alone,
because the gap was in the wiring, not the helpers.
"""

import laspy
import numpy as np

import main
from tests.binframe import decode_streamed_json


def _write_las(path, **extras):
    header = laspy.LasHeader(point_format=3, version="1.4")
    header.scales = np.array([0.001, 0.001, 0.001], dtype=np.float64)
    header.offsets = np.zeros(3, dtype=np.float64)
    for name in extras:
        header.add_extra_dim(laspy.ExtraBytesParams(name=name, type=np.float32))
    las = laspy.LasData(header)
    n = 50
    rng = np.random.default_rng(0)
    las.x = rng.uniform(0, 2, n)
    las.y = rng.uniform(0, 2, n)
    las.z = rng.uniform(0, 2, n)
    for k, v in extras.items():
        setattr(las, k, np.full(n, v, dtype=np.float32))
    las.write(str(path))
    return path


def _attributes(client, path, **body):
    res = client.post("/api/cloud/session/create-multi",
                      json={"source_path": str(path), **body})
    assert res.status_code == 200, res.text
    out = decode_streamed_json(res.content)
    scans = out["scans"]
    assert len(scans) == 1 and not scans[0].get("error"), scans
    sess = scans[0]["session"]
    try:
        return {a["name"]: a for a in sess["attributes"]}, sess
    finally:
        main._cloud_sessions.pop(sess["session_id"], None)


def test_scalar_labels_rename_an_in_file_column_display_only(client, tmp_path):
    p = _write_las(tmp_path / "rename.las", Deviation=3.0, Amplitude=7.0)

    before, _ = _attributes(client, p)
    assert before["Deviation"].get("label") != "Leaf wetness"   # precondition

    after, _ = _attributes(client, p, scalar_labels={"deviation": "Leaf wetness"})
    # The slug is the file's own and must not move: drops, keeps and role
    # overrides all name the column by it.
    assert "Deviation" in after, sorted(after)
    assert after["Deviation"]["label"] == "Leaf wetness"
    # Only the named column is relabeled.
    assert after["Amplitude"].get("label") == before["Amplitude"].get("label")


def test_scalar_labels_do_not_resurrect_a_dropped_column(client, tmp_path):
    p = _write_las(tmp_path / "drop.las", Deviation=3.0, Amplitude=7.0)
    attrs, _ = _attributes(client, p, drop_slugs=["Deviation"],
                           scalar_labels={"Deviation": "Leaf wetness"})
    assert "Deviation" not in attrs
    assert all(a.get("label") != "Leaf wetness" for a in attrs.values())


def test_role_overrides_reach_create_multi(client, tmp_path):
    # `shot_count` is not a spelling auto-detection recognizes, so without the
    # override it stays an anonymous scalar.
    p = _write_las(tmp_path / "role.las", shot_count=2.0)

    plain, _ = _attributes(client, p)
    assert "shot_count" in plain and "target_count" not in plain  # precondition

    overridden, _ = _attributes(client, p, role_overrides={"shot_count": "target_count"})
    assert "target_count" in overridden, sorted(overridden)
    assert "shot_count" not in overridden
