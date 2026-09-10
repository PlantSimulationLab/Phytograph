"""Radius / voxel outlier removal runs per buffered tile on large clouds.

The two LOCAL criteria (a point's verdict depends only on points within the
radius / its voxel) tile with a collar of exactly that scale; SOR is global
and stays untiled. Pinned: agreement with the untiled run including the
seam band, a single parameter resolution shared by every tile (a stride
sample would overstate the spacing), the voxel grid anchored at one origin
so seams do not shift it, and that SOR is never tiled.
"""
import sys
from pathlib import Path

import numpy as np
import pytest

import denoise

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))


def _cloud_with_flyers(n=120_000, extent=30.0, seed=5):
    from make_big_cloud import _tree_centres, generate_chunk

    rng = np.random.default_rng(seed)
    centres = _tree_centres(rng, extent, 9)
    scanner = np.array([extent / 2, extent / 2, 1.6])
    xyz = generate_chunk(rng, n, extent, centres, 0.5, 0.0, scanner)["xyz"]
    n_fly = n // 200
    flyers = np.column_stack([rng.uniform(0, extent, n_fly), rng.uniform(0, extent, n_fly),
                              rng.uniform(6, 12, n_fly)])
    xyz = np.vstack([xyz, flyers])
    truth = np.zeros(len(xyz), dtype=bool)
    truth[n:] = True          # True = noise
    return xyz, truth


@pytest.mark.parametrize("method", ["ror", "voxel_count"])
def test_tiled_matches_untiled_including_at_the_seams(monkeypatch, method):
    xyz, truth = _cloud_with_flyers()
    monkeypatch.setenv("PHYTOGRAPH_DENOISE_TILE_MIN_POINTS", "1000000000")
    keep_u, stats_u = denoise.denoise_mask(xyz, method, {})
    assert "tiled" not in stats_u
    monkeypatch.setenv("PHYTOGRAPH_DENOISE_TILE_MIN_POINTS", "0")
    monkeypatch.setenv("PHYTOGRAPH_DENOISE_TILE_TARGET_POINTS", "10000")
    keep_t, stats_t = denoise.denoise_mask(xyz, method, {})
    assert stats_t["tiled"]["tiles"] >= 4, stats_t["tiled"]
    # Same resolved parameters (within the sample's noise) and the same verdicts.
    key = "radius" if method == "ror" else "voxel"
    assert stats_t["params_used"][key] == pytest.approx(stats_u["params_used"][key], rel=0.35)
    agree = np.mean(keep_t == keep_u)
    assert agree >= 0.995, f"{method}: tiled vs untiled agreement {agree:.4f}"
    # Both find the flyers.
    assert np.mean(~keep_t[truth]) >= 0.9
    assert np.mean(keep_t[~truth]) >= 0.98
    # Seam band: within 0.5 m of an internal tile boundary.
    tile_m = stats_t["tiled"]["tile_m"]
    origin = np.floor(xyz[:, :2].min(axis=0))
    rel = (xyz[:, :2] - origin) % tile_m
    band = np.any((rel < 0.5) | (rel > tile_m - 0.5), axis=1)
    assert band.sum() > 500
    assert np.mean(keep_t[band] == keep_u[band]) >= 0.99


def test_sor_is_never_tiled(monkeypatch):
    xyz, _ = _cloud_with_flyers(n=20_000)
    monkeypatch.setenv("PHYTOGRAPH_DENOISE_TILE_MIN_POINTS", "0")
    _, stats = denoise.denoise_mask(xyz, "sor", {})
    assert "tiled" not in stats


def test_voxel_grid_origin_is_shared():
    rng = np.random.default_rng(0)
    pts = rng.uniform(0, 10, (5000, 3))
    a = denoise.voxel_count_mask(pts, 0.5, 2)
    b = denoise.voxel_count_mask(pts, 0.5, 2, origin=pts.min(axis=0))
    np.testing.assert_array_equal(a, b)
    # A different origin shifts the grid and, in general, the counts.
    c = denoise.voxel_count_mask(pts, 0.5, 2, origin=pts.min(axis=0) - 0.25)
    assert c.shape == a.shape


def test_labels_wrapper_carries_the_tile_plan(monkeypatch):
    xyz, _ = _cloud_with_flyers(n=30_000)
    monkeypatch.setenv("PHYTOGRAPH_DENOISE_TILE_MIN_POINTS", "0")
    monkeypatch.setenv("PHYTOGRAPH_DENOISE_TILE_TARGET_POINTS", "5000")
    meta: dict = {}
    labels = denoise.denoise_labels(xyz, "voxel_count", meta=meta)
    assert labels.shape == (len(xyz),)
    assert meta["tiled"]["n"] == len(xyz)
