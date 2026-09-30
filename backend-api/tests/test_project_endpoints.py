"""/api/project/{scene,save,open}: a real session saved and reopened.

The reopened session must be the same cloud: every point, column, pending
deletion and undo step, under a NEW session id, with its display octree
already in the cache - both for an in-RAM session and a memory-mapped one.
"""
import json
import zipfile

import numpy as np
import pytest

import main
from tests.binframe import decode_streamed_json


@pytest.fixture
def cache_root(tmp_path, monkeypatch):
    root = tmp_path / "octree_cache"
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(root))
    return root


def _cloud_file(tmp_path, n=2000):
    rng = np.random.default_rng(0)
    pts = rng.uniform(0, 10, size=(n, 3))
    refl = rng.uniform(-20, 0, n)
    f = tmp_path / "cloud.xyz"
    np.savetxt(f, np.column_stack([pts, refl]), fmt="%.4f")
    return f, pts


def _post_stream(client, url, body):
    return decode_streamed_json(client.post(url, json=body).content)


@pytest.mark.parametrize("store_backed", [False, True])
def test_save_then_open_restores_the_session(client, cache_root, tmp_path, monkeypatch, store_backed):
    monkeypatch.setenv("PHYTOGRAPH_SESSION_STORE_MIN_POINTS", "1" if store_backed else "100000000")
    f, _pts = _cloud_file(tmp_path)
    created = decode_streamed_json(client.post(
        "/api/cloud/session/create", json={"source_path": str(f), "ascii_format": "x y z reflectance"},
    ).content)
    sid = created["session_id"]
    # Edits the project must carry: a pending deletion (with its undo step)
    # and a computed column.
    res = client.post(f"/api/cloud/session/{sid}/delete_region",
                      json={"region": {"kind": "box", "min": [0, 0, 0], "max": [3, 3, 10]}})
    assert res.status_code == 200, res.text
    sess = main._cloud_sessions[sid]
    with main._cloud_session_lock:
        main._session_add_extra_column(sess, "twice_z", "Twice z",
                                       np.asarray(sess.positions)[~np.asarray(sess.deleted), 2] * 2)
    before = {
        "positions": np.array(sess.positions), "deleted": np.array(sess.deleted),
        "extras": {k: np.array(v) for k, v in sess.extras.items()},
        "history": [np.array(h) for h in sess.deleted_history],
        "cache": created["cache_id"],   # the octree the renderer displays
        "octree_cache_id": sess.octree_cache_id,
    }
    assert before["deleted"].any() and len(before["history"]) == 1

    scene = b"PSC1-opaque-renderer-bytes\x00\x01\x02" * 1000
    up = client.post("/api/project/scene", content=scene,
                     headers={"Content-Type": "application/octet-stream"})
    assert up.status_code == 200 and up.json()["bytes"] == len(scene)
    target = tmp_path / "plot.phyto"
    saved = _post_stream(client, "/api/project/save",
                         {"path": str(target), "scene_token": up.json()["token"], "session_ids": [sid],
                          "octree_ids": [before["cache"]]})
    assert saved["success"], saved
    assert target.is_file() and not (tmp_path / "plot.phyto.partial").exists()
    with zipfile.ZipFile(target) as zf:
        manifest = json.loads(zf.read("manifest.json"))
        assert manifest["format"] == "phytograph-project"
        assert before["cache"] in manifest["octrees"]

    # Close the cloud and empty the octree cache: everything must come back
    # from the file alone.
    client.delete(f"/api/cloud/session/{sid}")
    main._cloud_sessions.pop(sid, None)
    import shutil
    shutil.rmtree(cache_root / before["cache"], ignore_errors=True)

    opened = _post_stream(client, "/api/project/open", {"path": str(target)})
    assert opened["success"], opened
    new_sid = opened["session_map"][sid]
    assert new_sid != sid
    s2 = main._cloud_sessions[new_sid]
    assert np.array_equal(np.asarray(s2.positions), before["positions"])
    assert np.array_equal(np.asarray(s2.deleted), before["deleted"])
    assert list(s2.extras) == list(before["extras"])
    for k, v in before["extras"].items():
        assert np.array_equal(np.asarray(s2.extras[k]), v)
    assert [h.tolist() for h in s2.deleted_history] == [h.tolist() for h in before["history"]]
    assert s2.octree_cache_id == before["octree_cache_id"]
    assert (cache_root / before["cache"] / "metadata.json").is_file()
    if store_backed:
        assert s2.store is not None and isinstance(s2.positions, np.memmap)
    # The scene blob comes back verbatim, once.
    blob = client.get(f"/api/project/scene/{opened['scene_token']}")
    assert blob.status_code == 200 and blob.content == scene
    assert client.get(f"/api/project/scene/{opened['scene_token']}").status_code == 404
    # The reopened session still works: undo restores the deleted points.
    res = client.post(f"/api/cloud/session/{new_sid}/reset_edits", json={"count": 0})
    assert res.status_code == 200, res.text
    assert not np.asarray(main._cloud_sessions[new_sid].deleted).any()


def test_open_refuses_a_foreign_file_and_leaves_nothing(client, cache_root, tmp_path):
    bad = tmp_path / "not.phyto"
    bad.write_bytes(b"hello")
    before = set(main._cloud_sessions)
    r = _post_stream(client, "/api/project/open", {"path": str(bad)})
    assert not r["success"] and "cannot read project" in r["error"]
    assert set(main._cloud_sessions) == before


def test_failed_save_keeps_the_existing_file(client, cache_root, tmp_path):
    target = tmp_path / "keep.phyto"
    target.write_bytes(b"previous project")
    up = client.post("/api/project/scene", content=b"x",
                     headers={"Content-Type": "application/octet-stream"})
    with pytest.raises(Exception):
        _post_stream(client, "/api/project/save",
                     {"path": str(target), "scene_token": up.json()["token"], "session_ids": ["nope"]})
    assert target.read_bytes() == b"previous project"
    assert not (tmp_path / "keep.phyto.partial").exists()


def test_endpoints_are_plain_def():
    import inspect
    assert not inspect.iscoroutinefunction(main.project_save)
    assert not inspect.iscoroutinefunction(main.project_open)


# ---- octrees the project leaves out and rebuilds -------------------------

from pathlib import Path

LEAFCUBE_XYZ = (Path(__file__).resolve().parent
                / "fixtures" / "lad-leafcube-multi" / "leafcube_multi.xyz")


def _octree_points(root, cid):
    return int(json.loads((root / cid / "metadata.json").read_text())["points"])


def _save(client, tmp_path, sid, octree_ids, name="p.phyto"):
    up = client.post("/api/project/scene", content=b"scene",
                     headers={"Content-Type": "application/octet-stream"})
    target = tmp_path / name
    saved = _post_stream(client, "/api/project/save",
                         {"path": str(target), "scene_token": up.json()["token"],
                          "session_ids": [sid], "octree_ids": octree_ids})
    assert saved["success"], saved
    return target


def test_unedited_cloud_octrees_are_rebuilt_not_embedded(client, cache_root, tmp_path):
    """A display octree is a second full copy of the cloud, and for a cloud
    whose octree matches its session the session rebuilds it exactly - so the
    project leaves it (and the miss octree) out, and open rebuilds both and
    tells the renderer the new ids."""
    created = decode_streamed_json(client.post(
        "/api/cloud/session/create",
        json={"source_path": str(LEAFCUBE_XYZ), "ascii_format": "x y z timestamp target_index target_count"},
    ).content)
    sid, hits, miss = created["session_id"], created["cache_id"], created["miss_octree_cache_id"]
    assert hits and miss
    n_hits, n_miss = _octree_points(cache_root, hits), _octree_points(cache_root, miss)
    target = _save(client, tmp_path, sid, [hits, miss])
    with zipfile.ZipFile(target) as zf:
        manifest = json.loads(zf.read("manifest.json"))
        assert manifest["version"] == 2
        assert manifest["octrees"] == [] and set(manifest["regenerate"]) == {hits, miss}
        assert not [n for n in zf.namelist() if n.startswith("octrees/")]
        assert all(n.endswith((".pz", ".json")) for n in zf.namelist() if n.startswith("sessions/"))

    # Same machine, cache intact: nothing is rebuilt.
    same = _post_stream(client, "/api/project/open", {"path": str(target)})
    assert same["success"] and same["octree_map"] == {}

    # Another machine: no cache. Both octrees come back from the session.
    client.delete(f"/api/cloud/session/{sid}")
    import shutil
    shutil.rmtree(cache_root)
    opened = _post_stream(client, "/api/project/open", {"path": str(target)})
    assert opened["success"], opened
    m = opened["octree_map"]
    assert set(m) == {hits, miss}
    s2 = main._cloud_sessions[opened["session_map"][sid]]
    assert s2.octree_cache_id == m[hits] and s2.miss_octree_cache_id == m[miss]
    assert _octree_points(cache_root, m[hits]) == n_hits
    assert _octree_points(cache_root, m[miss]) == n_miss


def test_stale_octree_is_still_embedded(client, cache_root, tmp_path):
    """A pending deletion leaves the drawn octree BEHIND the session (the
    renderer masks the deleted points), so a rebuild is a different picture:
    that octree must travel in the file."""
    f, _pts = _cloud_file(tmp_path)
    created = decode_streamed_json(client.post(
        "/api/cloud/session/create", json={"source_path": str(f), "ascii_format": "x y z reflectance"},
    ).content)
    sid = created["session_id"]
    client.post(f"/api/cloud/session/{sid}/delete_region",
                json={"region": {"kind": "box", "min": [0, 0, 0], "max": [3, 3, 10]}})
    target = _save(client, tmp_path, sid, [created["cache_id"]])
    with zipfile.ZipFile(target) as zf:
        manifest = json.loads(zf.read("manifest.json"))
    assert created["cache_id"] in manifest["octrees"]
    assert created["cache_id"] not in manifest["regenerate"]
