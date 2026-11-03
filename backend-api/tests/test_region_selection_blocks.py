"""Screen-space selection: block-wise, culled, and outside the global lock.

Membership must not change: the renderer previews with the same ray cast, so
`_reference_ray_cast` here is that algorithm written plainly, with no culling.
The rest pins what the rewrite was for: memory that stays one block, and a
selection that does not hold the lock every other cloud's requests need.
"""
import threading
import tracemalloc

import numpy as np
import pytest

import main
from tests.binframe import decode_streamed_json


def _reference_ray_cast(pixels, polygon):
    inside = np.zeros(len(pixels), dtype=bool)
    px, py = pixels[:, 0], pixels[:, 1]
    j = len(polygon) - 1
    for i in range(len(polygon)):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        straddles = (yi > py) != (yj > py)
        with np.errstate(divide="ignore", invalid="ignore"):
            cross = np.where(yj != yi, (xj - xi) * (py - yi) / (yj - yi) + xi, 0.0)
        inside = np.where(straddles & (px < cross), ~inside, inside)
        j = i
    return inside


POLYGONS = {
    "triangle": [[100, 100], [700, 150], [300, 500]],
    "concave": [[100, 100], [700, 100], [700, 500], [400, 200], [100, 500]],
    "self_crossing": [[100, 100], [700, 500], [700, 100], [100, 500]],
    "horizontal_edges": [[100, 100], [500, 100], [500, 300], [100, 300]],
    "tiny_lasso": [[400, 300], [410, 300], [405, 310]],
    "off_canvas": [[-500, -500], [-400, -500], [-450, -400]],
}


@pytest.mark.parametrize("name", POLYGONS)
def test_culled_polygon_test_matches_the_plain_ray_cast(name):
    rng = np.random.default_rng(3)
    polygon = np.array(POLYGONS[name], dtype=np.float64)
    pixels = rng.uniform(-100, 900, size=(50_000, 2))
    # Points exactly on vertices, on the bounding box and behind the camera:
    # where a sloppy cull would differ from the reference.
    lo, hi = polygon.min(axis=0), polygon.max(axis=0)
    edge = np.vstack([polygon, lo, hi, [lo[0], hi[1]], [hi[0], lo[1]], [-1e9, -1e9]])
    pixels = np.vstack([pixels, edge])
    np.testing.assert_array_equal(
        main._points_in_polygon_mask(pixels, polygon), _reference_ray_cast(pixels, polygon))


def _camera_region(kind, **fields):
    # An orthographic-like camera: x, y in [-1, 1] map straight to the canvas.
    identity = np.eye(4).flatten(order="F").tolist()
    return {"kind": kind, "projection": identity, "view": identity,
            "canvas": {"width": 800, "height": 600}, **fields}


@pytest.fixture
def small_blocks(monkeypatch):
    """Force several blocks without a multi-GB fixture."""
    monkeypatch.setattr(main, "_REGION_BLOCK_ROWS", 1000)


@pytest.mark.parametrize("region", [
    _camera_region("polygon", points=POLYGONS["concave"]),
    _camera_region("polygon", points=POLYGONS["concave"], invert=True),
    _camera_region("squares_union", centers=[[200, 200], [600, 400]], half_sizes=[50, 80]),
])
def test_block_boundaries_do_not_change_the_selection(region, small_blocks):
    positions = np.random.default_rng(1).uniform(-1, 1, size=(4321, 3))
    pixels = main._project_block_to_pixel(
        positions, np.asarray(region["projection"]), np.asarray(region["view"]), 800, 600)
    # `pixels=` is the whole-array path; no `pixels` is the block-wise one.
    np.testing.assert_array_equal(
        main._region_mask(positions, region), main._region_mask(positions, region, pixels=pixels))
    assert 0 < main._region_mask(positions, region).sum() < len(positions)


def test_project_world_to_pixel_blocks_agree_with_one_block(small_blocks):
    positions = np.random.default_rng(2).uniform(-1, 1, size=(4321, 3))
    region = _camera_region("polygon", points=POLYGONS["triangle"])
    whole = main._project_block_to_pixel(positions, np.asarray(region["projection"]), np.asarray(region["view"]), 800, 600)
    np.testing.assert_array_equal(main._region_pixels(positions, region), whole)


def test_selection_memory_is_one_block_not_the_cloud(monkeypatch):
    """The old path peaked at ~121 B/pt: 60 MB here, against a mask of 0.5 MB
    plus one 100 k-row block."""
    monkeypatch.setattr(main, "_REGION_BLOCK_ROWS", 100_000)
    positions = np.random.default_rng(4).uniform(-1, 1, size=(500_000, 3))
    region = _camera_region("polygon", points=POLYGONS["concave"])
    tracemalloc.start()
    try:
        main._region_mask(positions, region)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert peak < 20e6, f"selection peaked at {peak / 1e6:.0f} MB"


@pytest.fixture
def session(client, tmp_path, monkeypatch):
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "octrees"))
    pts = np.random.default_rng(5).uniform(-1, 1, size=(5000, 3))
    f = tmp_path / "cloud.xyz"
    np.savetxt(f, pts, fmt="%.6f")
    res = client.post("/api/cloud/session/create", json={"source_path": str(f), "ascii_format": "x y z"})
    assert res.status_code == 200, res.text
    return decode_streamed_json(res.content)["session_id"]


def _lock_free_from_another_thread():
    got = []
    def probe():
        ok = main._cloud_session_lock.acquire(timeout=2)
        got.append(ok)
        if ok:
            main._cloud_session_lock.release()
    t = threading.Thread(target=probe)
    t.start()
    t.join()
    return got[0]


REGION = _camera_region("polygon", points=POLYGONS["horizontal_edges"])


@pytest.mark.parametrize("route,body", [
    ("filter", {"region": REGION, "rebuild": False}),
    ("extract", {"region": REGION}),
    ("split", {"region": REGION}),
])
def test_edits_select_without_holding_the_global_lock(client, session, route, body, monkeypatch):
    real = main._region_mask
    seen = []
    def spy(positions, region, pixels=None):
        seen.append(_lock_free_from_another_thread())
        return real(positions, region, pixels=pixels)
    monkeypatch.setattr(main, "_region_mask", spy)
    res = client.post(f"/api/cloud/session/{session}/{route}", json=body)
    assert res.status_code == 200, res.text
    assert seen and all(seen), "the selection ran under _cloud_session_lock"


def test_filter_recomputes_when_the_cloud_moves_during_selection(client, session, monkeypatch):
    """Survivor picking must not use a selection made on the old geometry."""
    sess = main._cloud_sessions[session]
    real = main._region_mask
    calls = []
    def moving(positions, region, pixels=None):
        out = real(positions, region, pixels=pixels)
        calls.append(positions)
        if len(calls) == 1:
            # Timed: a selection regressing to run under this lock must fail here,
            # not deadlock the whole test run.
            assert main._cloud_session_lock.acquire(timeout=10), "the selection ran under the lock"
            try:
                sess.positions = sess.positions + np.array([1000.0, 1000.0, 0.0])  # all off-canvas
            finally:
                main._cloud_session_lock.release()
        return out
    monkeypatch.setattr(main, "_region_mask", moving)
    res = client.post(f"/api/cloud/session/{session}/filter", json={"region": REGION, "rebuild": False})
    assert res.status_code == 200, res.text
    assert len(calls) == 2
    assert calls[1] is sess.positions
    # Everything moved outside the region, so a filter keeps nothing.
    out = decode_streamed_json(res.content)
    assert out["rebuilt"] is False and out["point_count"] == 0


def test_filter_result_is_the_same_as_masking_survivors(client, session):
    """Selecting over all rows, then picking survivors, keeps the same points."""
    sess = main._cloud_sessions[session]
    client.post(f"/api/cloud/session/{session}/delete_region", json={"region": {
        "kind": "box", "min": [-2, -2, -2], "max": [0, 2, 2]}}).raise_for_status()
    before_deleted = sess.deleted.copy()
    surv_positions = np.asarray(sess.positions)[~before_deleted]
    expected_keep = main._region_mask(surv_positions, REGION)
    assert 0 < expected_keep.sum() < len(surv_positions)
    res = client.post(f"/api/cloud/session/{session}/filter", json={"region": REGION, "rebuild": False})
    assert res.status_code == 200, res.text
    np.testing.assert_array_equal(np.asarray(sess.positions)[~sess.deleted], surv_positions[expected_keep])
