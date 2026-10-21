"""Row ids in session octrees, and columns shown by row lookup ("overlay").

Every session octree carries each point's session row (`_OCTREE_ROW_ATTRS`), so
a tool that only ADDS a column — ground and wood/leaf segmentation — no longer
rebuilds the octree to show it: the renderer looks each tile point's value up
in the session column (`/column/{slug}`). These tests pin the backend half:

  * the row ids decode to exactly the session rows of the octree's points,
    every hit once, also after a compacting bake renumbers the rows;
  * segmentation registers the column as an overlay and converts nothing;
  * the column endpoint serves the values in row order, guarded by a token;
  * any later rebuild bakes the column in and drops it from the overlay;
  * a split can draw its children from an overlay column, converting nothing.
"""
import json
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
def ground_scene(tmp_path) -> Path:
    """A flat 30x30 ground grid plus a raised blob: CSF separates them."""
    rows = [f"{i * 0.05:.4f} {j * 0.05:.4f} 0.0" for i in range(30) for j in range(30)]
    rows += [f"{0.5 + i * 0.01:.4f} 0.5 {0.3 + i * 0.01:.4f}" for i in range(40)]
    f = tmp_path / "ground.xyz"
    f.write_text("\n".join(rows) + "\n")
    return f


def _create(client, path) -> dict:
    return decode_streamed_json(client.post(
        "/api/cloud/session/create", json={"source_path": str(path), "ascii_format": "x y z"},
    ).content)


def _octree_rows(cache_root: Path, cid: str):
    """(rows, positions) of every point stored in an octree, decoded from octree.bin."""
    md = json.loads((cache_root / cid / "metadata.json").read_text())
    off, layout = 0, {}
    for a in md["attributes"]:
        layout[a["name"]] = (off, a["size"])
        off += a["size"]
    raw = np.fromfile(cache_root / cid / "octree.bin", dtype=np.uint8)
    rec = raw[: (raw.size // off) * off].reshape(-1, off)

    def u16(name):
        o, _ = layout[name]
        return rec[:, o:o + 2].copy().view("<u2").ravel().astype(np.int64)

    rows = u16("__row_hi") * 65536 + u16("__row_lo")
    pos = rec[:, 0:12].copy().view("<i4").reshape(-1, 3) * np.array(md["scale"]) + np.array(md["offset"])
    return rows, pos


def test_octree_row_ids_name_each_point_s_session_row(client, cache_root, ground_scene):
    created = _create(client, ground_scene)
    sess = main._cloud_sessions[created["session_id"]]
    rows, pos = _octree_rows(cache_root, created["cache_id"])
    # Every row exactly once, and each stored point IS that row's point (to the
    # octree's 1 mm quantization).
    assert np.array_equal(np.sort(rows), np.arange(len(sess.positions)))
    assert np.abs(pos - np.asarray(sess.positions)[rows]).max() < 2e-3
    # An index, not a field: no attribute list offers it.
    assert not {a["name"] for a in created["attributes"]} & set(main._OCTREE_ROW_ATTRS)
    assert created["row_ids"] is True


def test_a_compacting_bake_writes_the_rows_after_compaction(client, cache_root, ground_scene):
    sid = _create(client, ground_scene)["session_id"]
    res = client.post(f"/api/cloud/session/{sid}/delete_region", json={"region": {
        "kind": "box", "min": [-1, -1, -1], "max": [0.52, 2, 2], "invert": False}})
    assert res.status_code == 200, res.text
    baked = decode_streamed_json(client.post(f"/api/cloud/session/{sid}/bake").content)
    sess = main._cloud_sessions[sid]
    assert not sess.deleted.any()
    rows, pos = _octree_rows(cache_root, baked["cache_id"])
    assert np.array_equal(np.sort(rows), np.arange(len(sess.positions)))
    assert np.abs(pos - np.asarray(sess.positions)[rows]).max() < 2e-3


def _count_conversions(monkeypatch) -> list:
    calls: list = []
    orig = main._run_potree_converter
    monkeypatch.setattr(main, "_run_potree_converter",
                        lambda *a, **k: (calls.append(1), orig(*a, **k))[1])
    return calls


def test_ground_segmentation_shows_its_column_without_a_rebuild(
        client, cache_root, ground_scene, monkeypatch):
    created = _create(client, ground_scene)
    sid, cid = created["session_id"], created["cache_id"]
    conversions = _count_conversions(monkeypatch)

    res = client.post(f"/api/cloud/session/{sid}/segment_ground", json={"cloth_resolution": 0.1})
    assert res.status_code == 200, res.text
    body = res.json()
    assert conversions == []
    # The same octree, still current, now with the column as an overlay.
    assert body["cache_id"] == cid and body["octree_stale"] is False
    sess = main._cloud_sessions[sid]
    assert sess.octree_cache_id == cid
    [ov] = body["overlay_columns"]
    assert ov["slug"] == "ground_class" and ov["session_id"] == sid
    assert ov["token"] == sess.column_tokens["ground_class"]
    assert (ov["min"], ov["max"]) == (1.0, 2.0)

    # The values, in session row order, in the column's own (1-byte) type.
    col = client.get(f"/api/cloud/session/{sid}/column/ground_class", params={"token": ov["token"]})
    assert col.status_code == 200, col.text
    assert col.headers["X-Column-Dtype"] == "uint8"
    vals = np.frombuffer(col.content, dtype="<u1")
    assert np.array_equal(vals, np.asarray(sess.extras["ground_class"]))
    # Each tile point's value is the session column at its row: the lookup the
    # renderer does. Ground points (z = 0) read ground, the blob reads plant.
    rows, pos = _octree_rows(cache_root, cid)
    looked_up = vals[rows]
    assert set(looked_up[pos[:, 2] < 0.01].tolist()) == {main.GROUND_CLASS_GROUND}
    assert set(looked_up[pos[:, 2] > 0.25].tolist()) == {2}

    # A rerun replaces the column: the old token now says so.
    client.post(f"/api/cloud/session/{sid}/segment_ground", json={"cloth_resolution": 0.1})
    stale = client.get(f"/api/cloud/session/{sid}/column/ground_class", params={"token": ov["token"]})
    assert stale.status_code == 409
    assert client.get(f"/api/cloud/session/{sid}/column/nope").status_code == 404


def test_a_rebuild_bakes_the_overlay_column_in(client, cache_root, ground_scene):
    sid = _create(client, ground_scene)["session_id"]
    client.post(f"/api/cloud/session/{sid}/segment_ground", json={"cloth_resolution": 0.1})
    assert set(main._cloud_sessions[sid].overlay_columns) == {"ground_class"}
    out = decode_streamed_json(client.post(f"/api/cloud/session/{sid}/rebuild_octree", json={}).content)
    assert "ground_class" in {a["name"] for a in out["attributes"]}
    assert out["overlay_columns"] == []
    assert main._cloud_sessions[sid].overlay_columns == {}


def test_an_octree_without_row_ids_still_rebuilds(client, cache_root, ground_scene, monkeypatch):
    """An octree built before row ids existed (a cache or project from an older
    version) cannot show a column by lookup, so the tool rebuilds as before."""
    created = _create(client, ground_scene)
    sid = created["session_id"]
    monkeypatch.setattr(main, "_octree_has_row_ids", lambda root, cid: False)
    body = client.post(f"/api/cloud/session/{sid}/segment_ground",
                       json={"cloth_resolution": 0.1}).json()
    assert body["cache_id"] != created["cache_id"]
    assert "ground_class" in {a["name"] for a in body["attributes"]}
    assert body["overlay_columns"] == []


def test_a_split_draws_its_children_from_an_overlay_column_converting_nothing(
        client, cache_root, ground_scene, monkeypatch):
    created = _create(client, ground_scene)
    sid, cid = created["session_id"], created["cache_id"]
    client.post(f"/api/cloud/session/{sid}/segment_ground",
                json={"cloth_resolution": 0.1, "defer_octree": True})
    conversions = _count_conversions(monkeypatch)
    body = decode_streamed_json(client.post(
        f"/api/cloud/session/{sid}/extract_by_column",
        json={"slug": "ground_class", "include_misses": True,
              "rebuild_parent": True, "build_children": False}).content)
    assert conversions == []
    assert body["parent"]["cache_id"] == cid
    sess = main._cloud_sessions[sid]
    ground = int((np.asarray(sess.extras["ground_class"]) == 1).sum())
    assert [c["point_count"] for c in body["children"]] == [ground, len(sess.positions) - ground]
    for c in body["children"]:
        assert c["drawn_from_parent"] is True and c["cache_id"] == cid
        # The mask looks the class up in the PARENT's session: tile rows are
        # the parent's rows, not the child's.
        [ov] = c["overlay_columns"]
        assert ov["session_id"] == sid and ov["slug"] == "ground_class"
