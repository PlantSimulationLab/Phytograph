"""Large sessions live in a memory-mapped columnar store, from import onward.

Above `_session_store_min_points()` (forced to 0 here) an import allocates
its columns in a `SessionStore` and the session holds memmaps, so the cloud
is disk-backed from the first chunk; edits through the maps persist on their
own; eviction writes back only what is not a map yet plus a small pickle;
restore hands the maps back; delete removes the directory. A split or
extract child over the threshold is gathered straight into its own store;
sessions born with RAM arrays get one at their first eviction. Every
behavior is driven through the real HTTP API.
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
    # Written straight into the store, not held in RAM until a spill.
    assert sess.store.column_name_of(sess.extras[main.GROUND_CLASS_SLUG]) is not None
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


def test_a_store_backed_import_in_feet_is_scaled_on_disk(client, tmp_path, monkeypatch):
    """Scaling a store-backed import to meters must happen in the store's own
    column: a RAM copy would put the whole cloud back in memory and leave the
    store holding unscaled coordinates."""
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "octrees"))
    monkeypatch.setenv("PHYTOGRAPH_SESSION_SPILL_ROOT", str(tmp_path / "sessions"))
    monkeypatch.setenv("PHYTOGRAPH_SESSION_STORE_MIN_POINTS", "0")
    monkeypatch.setattr(main, "_cloud_sessions", {})
    monkeypatch.setattr(main, "_spilled_sessions", {})
    monkeypatch.setattr(main, "_LAS_READ_CHUNK", 700)   # several blocks
    las = _write_las(tmp_path / "ft.las", n=2000)
    import laspy
    raw = laspy.read(str(las))
    source = np.column_stack([raw.x, raw.y, raw.z]).astype(np.float64)

    res = client.post("/api/cloud/session/create",
                      json={"source_path": str(las), "source_units": "ft"})
    assert res.status_code == 200, res.text
    sess = main._get_cloud_session(decode_streamed_json(res.content)["session_id"])
    assert sess.store is not None
    assert isinstance(sess.positions, np.memmap)
    assert sess.source_unit_scale == 0.3048
    shift = np.asarray(sess.world_shift if sess.world_shift is not None else [0, 0, 0])
    np.testing.assert_allclose(np.asarray(sess.positions) + shift, source * 0.3048, atol=1e-9)
    on_disk = np.load(Path(sess.store.root) / "columns" / "positions.npy", mmap_mode="r")
    np.testing.assert_array_equal(on_disk, np.asarray(sess.positions))


def test_scaling_a_memory_mapped_column_does_not_copy_it(tmp_path, monkeypatch):
    """The regression test for the import-time RAM spike: a store-backed
    positions column must be scaled where it lives and returned as itself.
    Returning `positions * f` held a second full copy of the cloud in RAM during
    import (the end state looked correct only because finalization wrote the copy
    back into the store)."""
    monkeypatch.setattr(main, "_LAS_READ_CHUNK", 3)
    path = tmp_path / "positions.npy"
    col = np.lib.format.open_memmap(str(path), mode="w+", dtype=np.float64, shape=(10, 3))
    col[:] = np.arange(30, dtype=np.float64).reshape(10, 3)
    out = main._scale_positions_to_meters(col, 0.3048)
    assert out is col, "a memory-mapped column was copied instead of scaled in place"
    np.testing.assert_allclose(np.load(path, mmap_mode="r"), np.arange(30).reshape(10, 3) * 0.3048)
    # A plain array is still returned as a new, scaled array.
    plain = np.ones((4, 3))
    scaled = main._scale_positions_to_meters(plain, 2.0)
    assert scaled is not plain and np.all(plain == 1.0) and np.all(scaled == 2.0)


def _decode(res):
    assert res.status_code == 200, res.text
    b = res.content
    return decode_streamed_json(b) if (b[:1].isspace() or b[:4] == b"PHP1") else res.json()


def test_a_split_child_is_gathered_into_its_own_store(stored, client):
    """Measured on a 45.7 M-point scan: split by ground class, the 39.3 M-point
    child held 1.95 GB of RAM for good while its store-backed parent held
    almost none. A child over the threshold is now born store-backed."""
    sid, las, tmp = stored
    parent = main._get_cloud_session(sid)
    cls = np.array(parent.extras["las_classification"])
    pos = np.array(parent.positions)
    refl = np.array(parent.extras["reflectance"])
    out = _decode(client.post(f"/api/cloud/session/{sid}/extract_by_column",
                              json={"slug": "las_classification"}))
    children = {int(c["value"]): c["session_id"] for c in out["children"]}
    assert set(children) == set(np.unique(cls).tolist())
    for value, cid in children.items():
        child = main._get_cloud_session(cid)
        assert child.store is not None and child.store.root.parent == tmp / "sessions"
        for f in ("positions", "intensity", "deleted"):
            assert child.store.is_own(f, getattr(child, f)), f
        for slug, arr in child.extras.items():
            assert child.store.column_name_of(arr) is not None, slug
        rows = np.flatnonzero(cls == value)
        np.testing.assert_array_equal(child.positions, pos[rows])
        np.testing.assert_array_equal(child.extras["reflectance"], refl[rows])
        assert not child.deleted.any()
        assert list(child.extras) == list(parent.extras)

    # The child edits and exports like any store-backed cloud, and deleting it
    # removes its store.
    cid = children[int(cls[0])]
    child = main._get_cloud_session(cid)
    n = len(child.positions)
    res = client.post(f"/api/cloud/session/{cid}/delete_region",
                      json={"region": {"kind": "box", "min": [0, 0, 0], "max": [2.5, 2.5, 5],
                                       "invert": False}})
    assert res.status_code == 200, res.text
    gone = res.json()["deleted_count"]
    assert 0 < gone < n
    _decode(client.post(f"/api/cloud/session/{cid}/bake"))
    child = main._get_cloud_session(cid)
    assert len(child.positions) == n - gone and child.store.n == n - gone
    dest = tmp / "child.las"
    _decode(client.post("/api/pointcloud/export", json={
        "source": {"session_id": cid, "source_path": str(las)}, "format": "las",
        "dest_path": str(dest)}))
    import laspy
    assert len(laspy.read(str(dest)).points) == n - gone
    store_root = child.store.root
    assert client.delete(f"/api/cloud/session/{cid}").json()["deleted"] is True
    assert not store_root.exists()


def test_a_small_split_child_stays_in_ram(stored, client, monkeypatch):
    sid, las, tmp = stored
    monkeypatch.setenv("PHYTOGRAPH_SESSION_STORE_MIN_POINTS", "1000000000")
    out = _decode(client.post(f"/api/cloud/session/{sid}/extract_by_column",
                              json={"slug": "las_classification"}))
    for c in out["children"]:
        child = main._get_cloud_session(c["session_id"])
        assert child.store is None and not isinstance(child.positions, np.memmap)


def test_tool_columns_go_straight_into_the_store(stored, client, monkeypatch):
    """On a store-backed cloud a tool's columns are written into the store,
    not held in RAM until the next spill (on a 45.7 M-point scan the five
    normals columns alone were ~0.9 GB of RAM). A recompute replaces the same
    store columns rather than adding new ones."""
    sid, las, tmp = stored
    sess = main._get_cloud_session(sid)
    store_dir = Path(sess.store.root)
    body = {"k": 10, "orientation": "up", "defer_octree": True, "acknowledge_cost": True}
    assert client.post(f"/api/cloud/session/{sid}/compute_normals", json=body).status_code == 200
    slugs = [s for s, _ in main.normals_mod.COLUMNS]
    cols = {s: sess.store.column_name_of(sess.extras[s]) for s in slugs}
    assert all(cols.values()), cols
    nz = np.array(sess.extras["nz"])
    n = np.column_stack([np.asarray(sess.extras[s], dtype=np.float64) for s in ("nx", "ny", "nz")])
    assert np.allclose(np.linalg.norm(n, axis=1), 1.0, atol=1e-4)   # real normals were stored
    assert (nz >= 0).all()                                          # 'up' orientation
    files_before = sorted(p.name for p in store_dir.glob("*.npy"))
    assert client.post(f"/api/cloud/session/{sid}/compute_normals", json=body).status_code == 200
    assert {s: sess.store.column_name_of(sess.extras[s]) for s in slugs} == cols
    assert sorted(p.name for p in store_dir.glob("*.npy")) == files_before
    meta = json.loads((store_dir / "meta.json").read_text())
    assert {cols[s]: s for s in slugs}.items() <= meta["attrs"]["extras"].items()
    # Spill and restore: the columns come back from the store unchanged.
    monkeypatch.setattr(main, "_MAX_CLOUD_SESSIONS", 0)
    main._sweep_cloud_sessions()
    monkeypatch.setattr(main, "_MAX_CLOUD_SESSIONS", 8)
    back = main._get_cloud_session(sid)
    np.testing.assert_array_equal(back.extras["nz"], nz)
    assert back.store.column_name_of(back.extras["nz"]) == cols["nz"]


EVERYWHERE = {"kind": "box", "min": [-100, -100, -100], "max": [100, 100, 100]}


def test_a_widening_paint_stays_in_the_store_and_undoes(stored, client, monkeypatch):
    sid, las, tmp = stored
    sess = main._get_cloud_session(sid)
    for to_class, stroke in ((3, "a"), (70000, "b")):
        res = client.post(f"/api/cloud/session/{sid}/label_region", json={
            "slug": "tree_instance", "strokes": [{"region": EVERYWHERE, "to_class": to_class,
                                                  "stroke_id": stroke}]})
        assert res.status_code == 200, res.text
        col = sess.extras["tree_instance"]
        assert sess.store.column_name_of(col) is not None
        assert np.all(np.asarray(col) == to_class)
    assert sess.extras["tree_instance"].dtype == np.uint32
    res = client.post(f"/api/cloud/session/{sid}/reset_label_edits",
                      json={"edit_count": 1, "slug": "tree_instance"})
    assert res.status_code == 200, res.text
    assert np.all(np.asarray(sess.extras["tree_instance"]) == 3)
    monkeypatch.setattr(main, "_MAX_CLOUD_SESSIONS", 0)
    main._sweep_cloud_sessions()
    monkeypatch.setattr(main, "_MAX_CLOUD_SESSIONS", 8)
    assert np.all(np.asarray(main._get_cloud_session(sid).extras["tree_instance"]) == 3)
