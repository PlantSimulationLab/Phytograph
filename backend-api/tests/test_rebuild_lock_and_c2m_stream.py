"""Two point-local streaming paths and one lock-hold removal.

1. `_session_rebuild` no longer holds the global session lock across the
   octree LAS write: `_session_to_las` takes the lock per block instead. A
   request on ANOTHER session must be served while a rebuild's write is in
   progress - pinned by racing a slow write against a session read.
2. `_session_to_las` with `block_lock` writes exactly what it wrote before.
3. C2M distance streams a session source block by block and reports the
   same statistics as the whole-array path.
"""
import threading
import time

import numpy as np
import pytest

import main
from tests.binframe import decode_streamed_json

XYZ_FORMAT = "x y z"


def _session(client, tmp_path, name, n=6000, seed=0):
    rng = np.random.default_rng(seed)
    pts = np.column_stack([rng.uniform(0, 4, n), rng.uniform(0, 4, n), rng.uniform(0, 1, n)])
    src = tmp_path / f"{name}.xyz"
    np.savetxt(src, pts, fmt="%.4f")
    res = client.post("/api/cloud/session/create", json={"source_path": str(src), "ascii_format": XYZ_FORMAT})
    assert res.status_code == 200, res.text
    return decode_streamed_json(res.content)["session_id"]


def test_block_locked_write_matches_the_locked_write(client, tmp_path, monkeypatch):
    import laspy

    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "octrees"))
    sid = _session(client, tmp_path, "a")
    client.post(f"/api/cloud/session/{sid}/delete_region",
                json={"region": {"kind": "box", "min": [0, 0, 0], "max": [1, 1, 1], "invert": False}})
    sess = main._get_cloud_session(sid)
    monkeypatch.setattr(main, "_LAS_WRITE_CHUNK", 1000)      # several blocks
    with main._cloud_session_lock:
        n1 = main._session_to_las(sess, tmp_path / "locked.las", exclude_misses=True)
    n2 = main._session_to_las(sess, tmp_path / "blocks.las", exclude_misses=True,
                              block_lock=main._cloud_session_lock)
    assert n1 == n2 == int((~sess.deleted).sum())
    a, b = laspy.read(str(tmp_path / "locked.las")), laspy.read(str(tmp_path / "blocks.las"))
    for ax in "xyz":
        np.testing.assert_array_equal(np.asarray(getattr(a, ax)), np.asarray(getattr(b, ax)))
    assert list(a.header.mins) == list(b.header.mins) and list(a.header.maxs) == list(b.header.maxs)


def test_rebuild_does_not_hold_the_session_lock_across_the_write(client, tmp_path, monkeypatch):
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "octrees"))
    sid = _session(client, tmp_path, "b")
    other = _session(client, tmp_path, "c")
    sess = main._get_cloud_session(sid)

    # Make the LAS encode slow WITHOUT the lock: laspy's write_points is called
    # per block outside the per-block lock, so a sleep inside it is time during
    # which the lock must be free.
    import laspy
    real_write = laspy.LasWriter.write_points

    def slow_write(self, record):
        time.sleep(0.4)
        return real_write(self, record)

    monkeypatch.setattr(laspy.LasWriter, "write_points", slow_write)
    monkeypatch.setattr(main, "_LAS_WRITE_CHUNK", 2000)      # three blocks -> ~1.2 s of write

    done = threading.Event()
    err: list = []

    def rebuild():
        try:
            main._session_rebuild(sess)
        except Exception as e:      # pragma: no cover - surfaced below
            err.append(e)
        finally:
            done.set()

    t = threading.Thread(target=rebuild)
    t.start()
    time.sleep(0.15)                 # the writer is inside its first sleep
    started = time.perf_counter()
    res = client.post(f"/api/cloud/session/{other}/delete_region",
                      json={"region": {"kind": "box", "min": [0, 0, 0], "max": [0.5, 0.5, 0.5], "invert": False}})
    waited = time.perf_counter() - started
    assert res.status_code == 200, res.text
    done.wait(60)
    t.join(5)
    assert not err, err
    # Served while the write was still running, not after it (three 0.4 s sleeps).
    assert waited < 0.3, f"another session's request waited {waited:.2f}s behind the rebuild's write"


def test_c2m_streams_a_session_and_matches_the_whole_array_path(client, tmp_path, monkeypatch):
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "octrees"))
    sid = _session(client, tmp_path, "d", n=8000)
    # A horizontal quad at z = 0.5 covering the cloud.
    verts = [0, 0, 0.5, 4, 0, 0.5, 4, 4, 0.5, 0, 4, 0.5]
    tris = [0, 1, 2, 0, 2, 3]
    body = {"source": {"session_id": sid, "source_path": "x", "translation": [0.0, 0.0, 0.1]},
            "mesh_vertices": verts, "mesh_indices": tris}
    calls = []
    real = main._read_points_from_source
    monkeypatch.setattr(main, "_read_points_from_source",
                        lambda src, *a, **k: (calls.append(1), real(src, *a, **k))[1])
    monkeypatch.setattr(main, "_LAS_WRITE_CHUNK", 1000)       # eight blocks
    streamed = main._do_c2m_distance(main.C2MDistanceRequest(**body))
    assert streamed["success"], streamed
    assert calls == [], "a session source must stream, not copy"
    assert streamed["point_count"] == 8000
    # Reference through the whole-array path (max_points disables streaming).
    ref_body = {**body, "source": {**body["source"], "max_points": 10 ** 9}}
    ref = main._do_c2m_distance(main.C2MDistanceRequest(**ref_body))
    assert ref["success"] and calls == [1]
    for k in ("mean_distance", "rmse", "median_distance", "percentile_95", "max_distance",
              "points_within_5mm"):
        assert streamed[k] == pytest.approx(ref[k], rel=1e-4, abs=1e-6), k
    # Translation reached the query: the mean distance to z=0.5 of z~U(0,1)+0.1 is ~0.26.
    assert 0.2 < streamed["mean_distance"] < 0.32
