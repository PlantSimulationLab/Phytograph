"""Large sessions live in a memory-mapped columnar store, from import onward.

Above `_session_store_min_points()` (forced to 0 here) an import allocates
its columns in a `SessionStore` and the session holds memmaps, so the cloud
is disk-backed from the first chunk; edits through the maps persist on their
own; eviction writes back only what is not a map yet plus a small pickle;
restore hands the maps back; delete removes the directory. Sessions born
with RAM arrays (a split child) get a store at their first eviction. Every
behaviour is driven through the real HTTP API.
"""
import json
from pathlib import Path

import numpy as np
import pytest

import main
from tests.binframe import decode_streamed_json


def _write_las(path, n=3000, seed=0):
    import laspy

    rng = np.random.default_rng(seed)
    hdr = laspy.LasHeader(point_format=3, version="1.4")
    hdr.scales = [0.001] * 3
    hdr.add_extra_dim(laspy.ExtraBytesParams(name="Reflectance", type=np.float32))
    with laspy.open(str(path), mode="w", header=hdr) as w:
        rec = laspy.ScaleAwarePointRecord.zeros(n, header=hdr)
        rec.x = rng.uniform(0, 5, n)
        rec.y = rng.uniform(0, 5, n)
        rec.z = rng.uniform(0, 2, n)
        rec.intensity = rng.integers(1, 1000, n).astype(np.uint16)
        rec.classification = rng.integers(1, 4, n).astype(np.uint8)
        rec.Reflectance = rng.uniform(-10, 0, n).astype(np.float32)
        w.write_points(rec)
    return path


@pytest.fixture
def stored(client, tmp_path, monkeypatch):
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "octrees"))
    monkeypatch.setenv("PHYTOGRAPH_SESSION_SPILL_ROOT", str(tmp_path / "sessions"))
    monkeypatch.setenv("PHYTOGRAPH_SESSION_STORE_MIN_POINTS", "0")
    monkeypatch.setattr(main, "_cloud_sessions", {})
    monkeypatch.setattr(main, "_spilled_sessions", {})
    las = _write_las(tmp_path / "a.las")
    res = client.post("/api/cloud/session/create", json={"source_path": str(las)})
    assert res.status_code == 200, res.text
    out = decode_streamed_json(res.content)
    return out["session_id"], las, tmp_path


def test_import_lands_in_a_store_and_the_session_holds_memmaps(stored):
    sid, las, tmp = stored
    sess = main._get_cloud_session(sid)
    assert sess.store is not None
    store_dir = Path(sess.store.root)
    assert store_dir.parent == tmp / "sessions"
    for f in ("positions", "intensity", "deleted"):
        arr = getattr(sess, f)
        assert isinstance(arr, np.memmap), f
        assert sess.store.is_own(f, arr), f
    assert sess.colors is not None and isinstance(sess.colors, np.memmap)
    for slug in ("reflectance", "las_classification"):
        assert isinstance(sess.extras[slug], np.memmap), slug
    meta = json.loads((store_dir / "meta.json").read_text())
    assert set(meta["attrs"]["extras"].values()) == set(sess.extras)
    assert meta["attrs"]["extras_order"] == list(sess.extras)
    # gps_time was constant (zero) in the file: no timestamps column was kept.
    assert sess.timestamps is None and not sess.store.has_column("timestamps")


def test_edits_persist_through_the_maps_and_survive_eviction(stored, client, monkeypatch):
    sid, las, tmp = stored
    res = client.post(f"/api/cloud/session/{sid}/delete_region",
                      json={"region": {"kind": "box", "min": [0, 0, 0], "max": [2.5, 2.5, 5],
                                       "invert": False}})
    assert res.status_code == 200, res.text
    deleted = res.json()["deleted_count"]
    assert deleted > 0
    sess = main._get_cloud_session(sid)
    store_dir = Path(sess.store.root)
    # The mask edit went straight to disk through the map.
    sess.store.flush()
    on_disk = np.load(store_dir / "columns" / "deleted.npy", mmap_mode="r")
    assert int(on_disk.sum()) == deleted

    # Evict: a store-backed spill is a small pickle beside the store, not a
    # copy of the cloud.
    monkeypatch.setattr(main, "_MAX_CLOUD_SESSIONS", 0)
    main._sweep_cloud_sessions()
    assert sid not in main._cloud_sessions and sid in main._spilled_sessions
    entry = main._spilled_sessions[sid]
    assert entry["store_dir"] == str(store_dir)
    assert Path(entry["path"]).stat().st_size < 64 * 1024
    assert store_dir.is_dir()

    # Restore: maps again, edit intact, and the undo stack (kept in the pickle)
    # still works through the API.
    monkeypatch.setattr(main, "_MAX_CLOUD_SESSIONS", 8)
    back = main._get_cloud_session(sid)
    assert back.store is not None and isinstance(back.positions, np.memmap)
    assert int(back.deleted.sum()) == deleted
    assert len(back.deleted_history) == 1
    res = client.post(f"/api/cloud/session/{sid}/reset_edits", json={"edit_count": 0})
    assert res.json()["deleted_count"] == 0
    # Export still round-trips from the store.
    dest = tmp / "out.las"
    res = client.post("/api/pointcloud/export",
                      json={"source": {"session_id": sid, "source_path": str(las)},
                            "format": "las", "dest_path": str(dest)})
    assert res.status_code == 200, res.text
    import laspy
    assert len(laspy.read(str(dest)).points) == 3000


def test_a_new_column_and_a_compacted_bake_are_written_back_on_spill(stored, client, monkeypatch):
    sid, las, tmp = stored
    # A segmentation appends a RAM column via _session_add_extra_column.
    res = client.post(f"/api/cloud/session/{sid}/segment_ground",
                      json={"cloth_resolution": 0.5, "class_threshold": 0.2})
    assert res.status_code == 200, res.text
    sess = main._get_cloud_session(sid)
    assert main.GROUND_CLASS_SLUG in sess.extras
    assert not isinstance(sess.extras[main.GROUND_CLASS_SLUG], np.memmap)   # RAM until spill
    store_dir = Path(sess.store.root)
    monkeypatch.setattr(main, "_MAX_CLOUD_SESSIONS", 0)
    main._sweep_cloud_sessions()
    meta = json.loads((store_dir / "meta.json").read_text())
    assert main.GROUND_CLASS_SLUG in meta["attrs"]["extras"].values()
    monkeypatch.setattr(main, "_MAX_CLOUD_SESSIONS", 8)
    back = main._get_cloud_session(sid)
    assert isinstance(back.extras[main.GROUND_CLASS_SLUG], np.memmap)
    assert list(back.extras) == [m["slug"] for m in back.extra_dims_meta]
    assert int((back.extras[main.GROUND_CLASS_SLUG] == main.GROUND_CLASS_GROUND).sum()) > 0


def test_a_ram_born_session_gets_a_store_at_first_eviction(client, tmp_path, monkeypatch):
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "octrees"))
    monkeypatch.setenv("PHYTOGRAPH_SESSION_SPILL_ROOT", str(tmp_path / "sessions"))
    monkeypatch.setenv("PHYTOGRAPH_SESSION_STORE_MIN_POINTS", "10**9")   # unparsable -> default
    monkeypatch.setenv("PHYTOGRAPH_SESSION_STORE_MIN_POINTS", "1000000000")
    monkeypatch.setattr(main, "_cloud_sessions", {})
    monkeypatch.setattr(main, "_spilled_sessions", {})
    las = _write_las(tmp_path / "b.las", n=2000)
    res = client.post("/api/cloud/session/create", json={"source_path": str(las)})
    sid = decode_streamed_json(res.content)["session_id"]
    sess = main._get_cloud_session(sid)
    assert sess.store is None and not isinstance(sess.positions, np.memmap)
    before = np.array(sess.positions)
    # Now pretend the budget shrank: this session is over the store threshold.
    monkeypatch.setenv("PHYTOGRAPH_SESSION_STORE_MIN_POINTS", "0")
    monkeypatch.setattr(main, "_MAX_CLOUD_SESSIONS", 0)
    main._sweep_cloud_sessions()
    entry = main._spilled_sessions[sid]
    assert entry["store_dir"] and Path(entry["store_dir"]).is_dir()
    monkeypatch.setattr(main, "_MAX_CLOUD_SESSIONS", 8)
    back = main._get_cloud_session(sid)
    assert isinstance(back.positions, np.memmap)
    np.testing.assert_array_equal(back.positions, before)


def test_delete_removes_the_store_directory(stored, client):
    sid, las, tmp = stored
    store_dir = Path(main._get_cloud_session(sid).store.root)
    assert store_dir.is_dir()
    res = client.delete(f"/api/cloud/session/{sid}")
    assert res.json()["deleted"] is True
    assert not store_dir.exists()
    assert not list((tmp / "sessions").rglob("*.store"))


def test_memory_pressure_evicts_ram_resident_sessions(client, tmp_path, monkeypatch):
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "octrees"))
    monkeypatch.setenv("PHYTOGRAPH_SESSION_SPILL_ROOT", str(tmp_path / "sessions"))
    monkeypatch.setenv("PHYTOGRAPH_SESSION_STORE_MIN_POINTS", "1000000000")
    monkeypatch.setattr(main, "_cloud_sessions", {})
    monkeypatch.setattr(main, "_spilled_sessions", {})
    las = _write_las(tmp_path / "c.las", n=2000)
    ids = []
    for _ in range(3):
        res = client.post("/api/cloud/session/create", json={"source_path": str(las)})
        ids.append(decode_streamed_json(res.content)["session_id"])
    assert all(i in main._cloud_sessions for i in ids)
    one = main._session_ram_bytes(main._cloud_sessions[ids[0]])
    assert one > 0
    # Budget so small that only one RAM-resident session fits: the two oldest go.
    monkeypatch.setenv("PHYTOGRAPH_MEMORY_BUDGET_BYTES", str(int(one * 1.5 / main._SESSION_RAM_FRACTION)))
    main._sweep_cloud_sessions()
    assert ids[2] in main._cloud_sessions
    assert ids[0] in main._spilled_sessions and ids[1] in main._spilled_sessions
