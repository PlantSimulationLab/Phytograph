"""`_cloud_session_lock` is one lock for every cloud, so what runs under it
stalls every other session request - and, from an `async def` handler, the
event loop itself. These pin the three long holds that were removed:

1. A bake / background display refresh wrote its whole LAS under the lock.
   It now takes the lock per block, as `_session_rebuild` does.
2. The display stats a bake and a rebuild attach (class lists, robust
   colorbar domains: a gather and percentiles over every column) were
   measured under the lock.
3. `delete_region` projected and tested every point under the lock, and the
   erase brush's square stamps cost stamps x N.

None of them may change an answer, which is the other half of each test.
"""
import threading
import time

import numpy as np
import pytest

import main
from tests.binframe import decode_streamed_json

XYZ_FORMAT = "x y z"
BOX = {"kind": "box", "min": [0, 0, 0], "max": [1, 1, 1], "invert": False}


def _session(client, tmp_path, name, n=6000, seed=0):
    rng = np.random.default_rng(seed)
    pts = np.column_stack([rng.uniform(0, 4, n), rng.uniform(0, 4, n), rng.uniform(0, 1, n)])
    src = tmp_path / f"{name}.xyz"
    np.savetxt(src, pts, fmt="%.4f")
    res = client.post("/api/cloud/session/create",
                      json={"source_path": str(src), "ascii_format": XYZ_FORMAT})
    assert res.status_code == 200, res.text
    return decode_streamed_json(res.content)["session_id"]


def _delete(client, sid, region=BOX):
    res = client.post(f"/api/cloud/session/{sid}/delete_region", json={"region": region})
    assert res.status_code == 200, res.text
    return res.json()


def _spy_lock_state(monkeypatch, name):
    """Wrap `main.<name>` to record whether THIS thread held the session lock
    each time it ran. `Lock.locked()` is process-wide, and these tests drive
    one request at a time, so True means the caller held it."""
    seen = []
    real = getattr(main, name)

    def spy(*a, **k):
        seen.append(main._cloud_session_lock.locked())
        return real(*a, **k)

    monkeypatch.setattr(main, name, spy)
    return seen


@pytest.mark.parametrize("compact", [False, True])
def test_bake_does_not_hold_the_session_lock_across_the_write(
        client, tmp_path, monkeypatch, compact):
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "octrees"))
    sid = _session(client, tmp_path, "a")
    other = _session(client, tmp_path, "b")
    _delete(client, sid)

    import laspy
    real_write = laspy.LasWriter.write_points

    def slow_write(self, record):
        time.sleep(0.4)
        return real_write(self, record)

    monkeypatch.setattr(laspy.LasWriter, "write_points", slow_write)
    monkeypatch.setattr(main, "_LAS_WRITE_CHUNK", 2000)      # several blocks

    out: dict = {}

    def bake():
        try:
            out["result"] = main._do_bake_cloud_session(sid, compact=compact)
        except Exception as e:      # pragma: no cover - surfaced below
            out["error"] = e

    t = threading.Thread(target=bake)
    t.start()
    time.sleep(0.15)                 # the writer is inside its first sleep
    started = time.perf_counter()
    _delete(client, other, {**BOX, "max": [0.5, 0.5, 0.5]})
    waited = time.perf_counter() - started
    t.join(120)
    assert "error" not in out, out.get("error")
    assert waited < 0.3, f"another session's request waited {waited:.2f}s behind the bake's write"
    # And the bake still did its job.
    sess = main._get_cloud_session(sid)
    assert out["result"]["baked"] is True
    assert out["result"]["point_count"] == int((~sess.deleted).sum())
    assert sess.octree_cache_id == out["result"]["cache_id"]


def test_refresh_is_not_claimed_current_when_an_edit_raced_the_write(
        client, tmp_path, monkeypatch):
    """The mask alone cannot tell: a delete and its undo landing while the
    block-locked write is in flight leave the mask equal, with the blocks
    written in between missing those points. The edit generation can."""
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "octrees"))
    sid = _session(client, tmp_path, "a")
    _delete(client, sid)
    sess = main._get_cloud_session(sid)
    real_build = main._build_octree_from_las

    def build_after_a_reverted_edit(*a, **k):
        with main._cloud_session_lock:
            main._mark_octree_stale_locked(sess)   # an edit landed; the mask is unchanged
        return real_build(*a, **k)

    monkeypatch.setattr(main, "_build_octree_from_las", build_after_a_reverted_edit)
    result = main._do_bake_cloud_session(sid, compact=False)
    assert sess.octree_cache_id is None, "a raced octree must leave the session stale"
    assert sess.rendered_octree_cache_id == result["cache_id"]


def test_display_stats_are_measured_outside_the_session_lock(client, tmp_path, monkeypatch):
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "octrees"))
    sid = _session(client, tmp_path, "a")
    sess = main._get_cloud_session(sid)
    with main._cloud_session_lock:
        expected = {
            "observed_classes": main._session_observed_classes_locked(sess),
            **main._session_robust_color_stats_locked(sess),
        }
    assert expected["robust_bounds"], "the fixture must produce stats worth comparing"

    seen = _spy_lock_state(monkeypatch, "_robust_aabb")
    # The rebuild chokepoint, the bake's no-op fast path, and a real bake.
    _, _, meta = main._session_rebuild(sess)
    fast = main._do_bake_cloud_session(sid, compact=False)
    assert fast["baked"] is False
    for got in (meta, fast):
        assert got["robust_bounds"] == expected["robust_bounds"]
        assert got.get("robust_attribute_ranges") == expected.get("robust_attribute_ranges")
        assert got["observed_classes"] == expected["observed_classes"]
    _delete(client, sid)
    baked = main._do_bake_cloud_session(sid, compact=True)
    assert baked["baked"] is True and "robust_bounds" in baked
    assert len(seen) == 3 and not any(seen), seen


def test_delete_region_selects_outside_the_session_lock(client, tmp_path, monkeypatch):
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "octrees"))
    sid = _session(client, tmp_path, "a")
    sess = main._get_cloud_session(sid)
    inside = main._region_mask(np.asarray(sess.positions), BOX)
    seen = _spy_lock_state(monkeypatch, "_region_mask")
    out = _delete(client, sid)
    assert seen == [False], seen
    assert out["deleted_count"] == int(inside.sum()) > 0
    np.testing.assert_array_equal(np.asarray(sess.deleted), inside)


def test_delete_region_reselects_under_the_lock_when_the_geometry_moved(
        client, tmp_path, monkeypatch):
    """A transform landing between the snapshot and the commit moves the
    points; a selection made against the old coordinates must not be applied."""
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "octrees"))
    sid = _session(client, tmp_path, "a")
    sess = main._get_cloud_session(sid)
    real = main._region_mask
    seen = []

    def spy(positions, region, *a, **k):
        seen.append(main._cloud_session_lock.locked())
        out = real(positions, region, *a, **k)
        if len(seen) == 1:
            with main._cloud_session_lock:      # the geometry moves under us
                sess.positions = np.asarray(sess.positions) + np.array([10.0, 0.0, 0.0])
                main._mark_octree_stale_locked(sess)
        return out

    monkeypatch.setattr(main, "_region_mask", spy)
    out = _delete(client, sid)
    assert seen == [False, True], seen
    assert out["deleted_count"] == 0, "the box no longer contains any point"


def test_squares_union_cull_matches_the_per_stamp_test():
    rng = np.random.default_rng(3)
    pixels = rng.uniform(-200, 1200, size=(50_000, 2))
    centers = rng.uniform(100, 900, size=(40, 2))
    half = rng.uniform(2, 30, size=40)
    # Points exactly on a stamp's edge and corner: the test is inclusive.
    # (Whole-number stamps, so center + half - center is exactly half.)
    centers[0], half[0] = [500.0, 500.0], 16.0
    centers[1], half[1] = [300.0, 700.0], 8.0
    pixels[0] = centers[0] + [half[0], 0.0]
    pixels[1] = centers[1] + [-half[1], half[1]]
    pixels[2] = [np.nan, np.nan]              # behind the camera: never selected
    expected = np.zeros(len(pixels), dtype=bool)
    for c, h in zip(centers, half):
        expected |= (np.abs(pixels[:, 0] - c[0]) <= h) & (np.abs(pixels[:, 1] - c[1]) <= h)
    got = main._squares_union_mask(pixels, centers, half)
    np.testing.assert_array_equal(got, expected)
    assert got[0] and got[1] and not got[2] and 0 < got.sum() < len(pixels)
    # No stamps, and stamps that miss everything.
    assert not main._squares_union_mask(pixels, np.zeros((0, 2)), np.zeros(0)).any()
    assert not main._squares_union_mask(pixels, np.array([[5000.0, 5000.0]]), np.array([1.0])).any()
