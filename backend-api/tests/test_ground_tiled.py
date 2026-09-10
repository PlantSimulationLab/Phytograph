"""Ground segmentation runs per buffered tile on large clouds.

The seam agreement of tiled vs untiled CSF is pinned in test_tiled.py; this
pins the wiring: the dispatch by point count, the sampled auto threshold that
keeps tiles from disagreeing, the metadata the session endpoint reports, and
that the cost estimate's memory term stops growing with N once tiling applies.
"""
import sys
from pathlib import Path

import numpy as np
import pytest

import main
import tiled

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))


def _cloud(n, extent=40.0, seed=3):
    from make_big_cloud import _tree_centres, generate_chunk

    rng = np.random.default_rng(seed)
    centres = _tree_centres(rng, extent, 9)
    scanner = np.array([extent / 2, extent / 2, 1.6])
    cols = generate_chunk(rng, n, extent, centres, 0.5, 0.0, scanner)
    return cols["xyz"], cols["ground_truth"]


def test_dispatch_by_point_count(monkeypatch):
    pytest.importorskip("CSF")
    xyz, truth = _cloud(60_000)
    monkeypatch.setenv("PHYTOGRAPH_GROUND_TILE_MIN_POINTS", "50000")
    monkeypatch.setenv("PHYTOGRAPH_GROUND_TILE_TARGET_POINTS", "10000")
    meta_t: dict = {}
    labels_t = main.segment_ground(xyz, cloth_resolution=0.1, class_threshold=0.1, meta=meta_t)
    assert meta_t["tiled"]["tiles"] >= 4
    assert meta_t["method"] == "manual"
    monkeypatch.setenv("PHYTOGRAPH_GROUND_TILE_MIN_POINTS", "1000000")
    meta_u: dict = {}
    labels_u = main.segment_ground(xyz, cloth_resolution=0.1, class_threshold=0.1, meta=meta_u)
    assert "tiled" not in meta_u
    assert np.mean(labels_t == labels_u) >= 0.995
    assert np.mean((labels_t == main.GROUND_CLASS_GROUND) == (truth == 1)) >= 0.98


def test_sampled_auto_threshold_is_shared_by_every_tile(monkeypatch):
    pytest.importorskip("CSF")
    xyz, truth = _cloud(60_000)
    monkeypatch.setenv("PHYTOGRAPH_GROUND_TILE_MIN_POINTS", "0")
    monkeypatch.setenv("PHYTOGRAPH_GROUND_TILE_TARGET_POINTS", "10000")
    meta: dict = {}
    labels = main.segment_ground(xyz, cloth_resolution=0.5, auto_class_threshold=True, meta=meta)
    assert meta["auto"] is True and meta["method"] == "auto (sampled)"
    assert 0.02 <= meta["class_threshold"] <= 5.0
    # One threshold for the whole cloud, and a sane result against the truth.
    assert np.mean((labels == main.GROUND_CLASS_GROUND) == (truth == 1)) >= 0.95
    # The same call untiled with the sampled threshold agrees with the tiles.
    untiled = main.segment_ground(xyz, cloth_resolution=0.5, class_threshold=meta["class_threshold"],
                                  tile=False)
    assert np.mean(labels == untiled) >= 0.995


def test_collar_scales_with_the_cloth_and_is_clamped():
    assert main._ground_tile_buffer_m(0.05) == 2.0
    assert main._ground_tile_buffer_m(0.5) == 15.0
    assert main._ground_tile_buffer_m(5.0) == 30.0


def test_cost_memory_term_is_bounded_by_a_tile_once_tiling_applies(monkeypatch):
    monkeypatch.setenv("PHYTOGRAPH_GROUND_TILE_MIN_POINTS", "1000000")
    _s1, small, _ = main._ground_cost_estimate(500_000, 100.0, 0.5, 500, 500_000)
    _s2, big, _ = main._ground_cost_estimate(100_000_000, 100.0, 0.5, 500, 100_000_000)
    # 200x the points: the parent/worker/label copies scale (56 B/pt) but the
    # CSF working set does not, so the total is well under 200x.
    assert big < 200 * small
    assert big < 100_000_000 * (56 + 60) + 10 * 1024 ** 3


XYZ_FORMAT = "x y z"


def test_session_endpoint_reports_the_tiling(client, tmp_path, monkeypatch):
    from tests.binframe import decode_streamed_json

    pytest.importorskip("CSF")
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "octrees"))
    monkeypatch.setenv("PHYTOGRAPH_GROUND_TILE_MIN_POINTS", "1000")
    monkeypatch.setenv("PHYTOGRAPH_GROUND_TILE_TARGET_POINTS", "2000")
    xyz, _ = _cloud(20_000, extent=30.0)
    src = tmp_path / "c.xyz"
    np.savetxt(src, xyz, fmt="%.4f")
    res = client.post("/api/cloud/session/create", json={"source_path": str(src), "ascii_format": XYZ_FORMAT})
    sid = decode_streamed_json(res.content)["session_id"]
    res = client.post(f"/api/cloud/session/{sid}/segment_ground",
                      json={"cloth_resolution": 0.1, "class_threshold": 0.1})
    assert res.status_code == 200, res.text
    out = res.json()
    assert out["tiled"]["tiles"] >= 4 and out["tiled"]["n"] == 20_000
    assert out["class_threshold_method"] == "manual"
