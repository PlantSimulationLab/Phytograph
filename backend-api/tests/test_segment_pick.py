"""Click-to-pick segments for the label tool (F6): label_segments + the
`segment_pick` endpoint + the `voxel_set` region a picked piece travels as.

``src/shared/voxelSet.contract.json`` pins the voxel-set membership test on
both sides (src/renderer/lib/voxelSet.test.ts asserts the same vectors).
"""
import json
import pathlib

import numpy as np
import pytest
from fastapi import HTTPException

import label_segments as ls
import main
from tests.binframe import decode_streamed_json

CONTRACT = json.loads((pathlib.Path(__file__).resolve().parents[2]
                       / "src" / "shared" / "voxelSet.contract.json").read_text("utf-8"))


def test_voxel_set_mask_matches_the_contract():
    r = CONTRACT["region"]
    got = main._region_mask(np.asarray(CONTRACT["points"], dtype=np.float64), r)
    assert got.tolist() == CONTRACT["expected"]
    main._canonical_region(r)


@pytest.mark.parametrize("patch, message", [
    ({"voxel": 0}, "region.voxel"),
    ({"origin": [0, 0]}, "region.origin"),
    ({"keys": "AAAA"}, "triplets"),
    ({"keys": ""}, "1 to"),
])
def test_invalid_voxel_sets_are_400(patch, message):
    with pytest.raises(HTTPException) as exc:
        main._canonical_region({**CONTRACT["region"], **patch})
    assert exc.value.status_code == 400
    assert message in exc.value.detail


def _blob(center, n, r, rng):
    d = rng.normal(size=(n, 3))
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    return np.asarray(center) + d * r * rng.uniform(0.5, 1.0, size=(n, 1))


def _picked(seg, voxels, pts):
    """Which of `pts` a picked voxel set covers."""
    return ls.voxel_set_mask(pts, seg.origin, seg.voxel, seg.keys[voxels])


def test_connected_mode_picks_exactly_one_blob():
    rng = np.random.default_rng(3)
    a = _blob((0, 0, 0), 400, 0.5, rng)
    b = _blob((3, 0, 0), 300, 0.5, rng)
    pts = np.vstack([a, b])
    seg = ls.segment(pts, 0.3, "connected")
    assert seg.n_segments == 2
    v = int(np.argmin(((seg.sums / seg.counts[:, None] - a[0]) ** 2).sum(axis=1)))
    got = _picked(seg, ls.pick(seg, v, grow=False), pts)
    assert got[:400].all() and not got[400:].any()


def test_pieces_are_compact_and_never_jump_a_gap():
    # Two parallel 4 m lines 0.5 m apart, points every 1 cm: pieces of ~0.4 m.
    x = np.arange(0, 4, 0.01)
    line1 = np.stack([x, np.zeros_like(x), np.zeros_like(x)], axis=1)
    line2 = line1 + [0, 0.5, 0]
    pts = np.vstack([line1, line2])
    seg = ls.segment(pts, 0.4, "pieces")
    assert seg.n_segments >= 16   # ~10 per line
    for v in (0, seg.keys.shape[0] // 3, seg.keys.shape[0] - 1):
        got = _picked(seg, ls.pick(seg, v, grow=False), pts)
        sel = pts[got]
        assert sel.shape[0] > 0
        assert np.ptp(sel[:, 0]) < 1.0            # compact along the line
        assert np.unique(sel[:, 1]).size == 1      # one line only: no jump


def test_grow_follows_a_flat_surface_and_stops_at_a_fold():
    # A floor (z = 0) meeting a wall (x = 1) along an edge.
    g = np.arange(0, 1, 0.02)
    xx, yy = np.meshgrid(g, g)
    floor = np.stack([xx.ravel(), yy.ravel(), np.zeros(xx.size)], axis=1)
    wall = np.stack([np.full(xx.size, 1.0), yy.ravel(), xx.ravel() + 0.02], axis=1)
    pts = np.vstack([floor, wall])
    seg = ls.segment(pts, 0.25, "pieces")
    v = int(np.argmin(((seg.sums / seg.counts[:, None] - [0.3, 0.5, 0]) ** 2).sum(axis=1)))
    one = _picked(seg, ls.pick(seg, v, grow=False), pts)
    grown = _picked(seg, ls.pick(seg, v, grow=True, max_angle_deg=20), pts)
    n_floor = floor.shape[0]
    assert one.sum() < 0.3 * n_floor
    assert grown[:n_floor].mean() > 0.8          # most of the floor
    assert grown[n_floor:].mean() < 0.2          # little of the wall


# ── Through the endpoints ────────────────────────────────────────────────────

def _converter_available() -> bool:
    try:
        main._resolve_potree_converter_path()
        return True
    except Exception:
        return False


@pytest.mark.skipif(not _converter_available(), reason="PotreeConverter binary not found")
def test_pick_then_label_labels_exactly_the_blob(client, tmp_path, monkeypatch):
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "octree_cache"))
    rng = np.random.default_rng(5)
    a = _blob((0, 0, 0), 500, 0.5, rng)
    b = _blob((4, 0, 0), 300, 0.5, rng)
    f = tmp_path / "blobs.xyz"
    np.savetxt(f, np.vstack([a, b]), fmt="%.5f")
    res = client.post("/api/cloud/session/create",
                      json={"source_path": str(f), "ascii_format": "x y z"})
    assert res.status_code == 200, res.text
    sid = decode_streamed_json(res.content)["session_id"]

    res = client.post(f"/api/cloud/session/{sid}/segment_pick",
                      json={"seed": a[0].tolist(), "mode": "connected"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["size"] > 0 and body["segments"] == 2 and body["points"] == 500

    res = client.post(f"/api/cloud/session/{sid}/label_region", json={"strokes": [
        {"region": body["region"], "to_class": 9, "stroke_id": "p1"},
    ]})
    assert res.status_code == 200, res.text
    pts = main._cloud_sessions[sid].positions
    labels = main._cloud_sessions[sid].extras[main.MANUAL_CLASS_SLUG]
    assert np.array_equal(labels == 9, pts[:, 0] < 2)

    # Nothing there: a 404, not a silent empty stroke.
    res = client.post(f"/api/cloud/session/{sid}/segment_pick",
                      json={"seed": [50, 50, 50], "mode": "connected"})
    assert res.status_code == 404
    # Later picks reuse the segmentation, whether at the automatic size or
    # with that size sent back explicitly (the panel echoes it).
    seg_before = main._SEGMENT_CACHE[sid][1]
    client.post(f"/api/cloud/session/{sid}/segment_pick",
                json={"seed": b[0].tolist(), "mode": "connected"})
    res = client.post(f"/api/cloud/session/{sid}/segment_pick",
                      json={"seed": b[0].tolist(), "mode": "connected", "size": body["size"]})
    assert res.json()["points"] == 300
    assert main._SEGMENT_CACHE[sid][1] is seg_before


def test_bad_pick_requests_are_400(client):
    for body in ({"seed": [0, 0], "mode": "pieces"}, {"seed": [0, 0, 0], "mode": "x"},
                 {"seed": [0, 0, 0], "size": -1}):
        res = client.post("/api/cloud/session/nope/segment_pick", json=body)
        assert res.status_code in (400, 404)
