"""The buffered tiling engine, and its seams against the untiled answer.

Two kinds of contract. Structural: every point lands in exactly one core,
every tile's chunk contains every point within the buffer of its core, and
the tile size chooser behaves. Behavioural: a whole-cloud algorithm run per
buffered tile agrees with the same algorithm run untiled - checked on the
cloth filter, the tool the tiling exists for, with the seam band inspected
separately so a buffer that is too small cannot hide in the average.
"""
import sys
from pathlib import Path

import numpy as np
import pytest

import tiled

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR / "tools"))


def _cloud(n=50_000, extent=40.0, seed=1):
    from make_big_cloud import _tree_centres, generate_chunk

    rng = np.random.default_rng(seed)
    centres = _tree_centres(rng, extent, 9)
    scanner = np.array([extent / 2, extent / 2, 1.6])
    cols = generate_chunk(rng, n, extent, centres, 0.5, 0.0, scanner)
    return cols["xyz"], cols["ground_truth"]


def test_every_point_is_core_of_exactly_one_tile_and_collars_are_complete():
    xyz, _ = _cloud(20_000)
    plan = tiled.TilePlan.build(xyz, tile_m=10.0, buffer_m=2.5)
    core_count = np.zeros(len(xyz), dtype=int)
    for tile in plan.tiles():
        idx, core = plan.gather(tile)
        core_count[idx[core]] += 1
        # Every point within buffer_m of the core box must be in the chunk.
        lo, hi = tile.buf_min, tile.buf_max
        expected = np.flatnonzero(np.all((xyz[:, :2] >= lo) & (xyz[:, :2] < hi), axis=1))
        assert set(expected) <= set(idx.tolist())
        # And nothing outside the buffered box sneaks in.
        assert np.all((xyz[idx, :2] >= lo) & (xyz[idx, :2] < hi))
    assert np.all(core_count == 1), np.unique(core_count, return_counts=True)


def test_run_tiled_scatters_core_results_and_reports_progress():
    xyz, _ = _cloud(10_000)
    plan = tiled.TilePlan.build(xyz, tile_m=10.0, buffer_m=1.0)
    seen = []

    def fn(chunk, core):
        # A "local" algorithm whose answer is the chunk's own mean z - which
        # differs per tile, so a mis-scattered result would show.
        seen.append(len(chunk))
        return np.full(len(chunk), int(round(chunk[:, 2].mean() * 1000)), dtype=np.int32)

    prog = []
    out = tiled.run_tiled(plan, xyz, fn, progress=lambda f, m: prog.append(f))
    assert out.shape == (len(xyz),)
    assert len(seen) == len(plan.tiles())
    assert prog[-1] == 1.0 and all(0 < f <= 1 for f in prog)
    # Cancel between tiles.
    with pytest.raises(tiled.TiledCancelled):
        tiled.run_tiled(plan, xyz, fn, should_cancel=lambda: True)
    # A wrong-length result is an error, not silent misalignment.
    with pytest.raises(ValueError):
        tiled.run_tiled(plan, xyz, lambda c, m: np.zeros(3))


def test_auto_tile_size_targets_points_and_respects_buffer():
    # 1 M points over 100x100 m at 3 M per tile -> one tile (the whole extent).
    assert tiled.auto_tile_size(1_000_000, (100.0, 100.0)) == 100.0
    # 100 M points over 100x100 m: 10 000 pts/m^2 -> ~17 m tiles.
    t = tiled.auto_tile_size(100_000_000, (100.0, 100.0))
    assert 15 < t < 20
    # Never below 4x the buffer.
    assert tiled.auto_tile_size(100_000_000, (100.0, 100.0), buffer_m=10.0) == 40.0
    plan = tiled.TilePlan.build(np.random.default_rng(0).uniform(0, 100, (5000, 3)), buffer_m=5.0)
    assert len(plan.tiles()) == 1 and plan.tile_m > 99.0


def test_plan_rejects_a_collar_wider_than_a_tile_and_handles_empty_input():
    with pytest.raises(ValueError):
        tiled.TilePlan(np.zeros((10, 3)), tile_m=1.0, buffer_m=2.0)
    plan = tiled.TilePlan(np.zeros((0, 3)), tile_m=1.0, buffer_m=0.0)
    assert plan.tiles() == []
    assert tiled.run_tiled(plan, np.zeros((0, 3)), lambda c, m: c[:, 0]).shape == (0,)


def test_tiled_cloth_filter_agrees_with_untiled_including_at_the_seams():
    """The seam check: compare per-point ground labels from CSF run untiled
    against CSF run on 10 m tiles with a 2 m collar, and look at the points
    within 0.5 m of a tile boundary separately. A collar that is too small
    would still pass the whole-cloud average (seam points are a few percent)
    but not this band."""
    CSF = pytest.importorskip("CSF")
    import main

    xyz, truth = _cloud(150_000, extent=40.0)
    params = dict(cloth_resolution=0.5, rigidness=3, class_threshold=0.1, iterations=500)
    untiled = main.segment_ground(xyz, **params)

    plan = tiled.TilePlan.build(xyz, tile_m=10.0, buffer_m=2.0)
    assert len(plan.tiles()) >= 9
    tiled_labels = tiled.run_tiled(
        plan, xyz, lambda chunk, core: main.segment_ground(chunk, **params), out_dtype=np.int32)

    agree = np.mean(tiled_labels == untiled)
    assert agree >= 0.995, f"tiled vs untiled agreement {agree:.4f}"
    # Seam band: within 0.5 m of any internal tile boundary.
    rel = (xyz[:, :2] - plan.origin) % plan.tile_m
    band = np.any((rel < 0.5) | (rel > plan.tile_m - 0.5), axis=1)
    assert band.sum() > 1000
    seam_agree = np.mean(tiled_labels[band] == untiled[band])
    assert seam_agree >= 0.99, f"seam-band agreement {seam_agree:.4f}"
    # And both are right: against the generator's truth on hits.
    assert np.mean((tiled_labels == main.GROUND_CLASS_GROUND) == (truth == 1)) >= 0.98
