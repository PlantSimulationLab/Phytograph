"""Tiled tree segmentation: the stitching rules, then real TreeIso.

The stitching tests swap the per-tile segmenter for an ORACLE that labels
each point with its true tree - but only from the points it is given, like
TreeIso on a buffered tile: a tree reaching past the tile's buffer is cut
there. So any error is the stitching's (anchor, ownership, claims, ids).
"""
import numpy as np
import pytest

import tiled
import tiled_trees as tt
from tests.synthetic_trees import SyntheticTree


def _forest(nx=4, ny=4, spacing=7.0, seed=0, density=500, crown_points=1500):
    pts, truth, bases = [], [], []
    k = 0
    for i in range(nx):
        for j in range(ny):
            k += 1
            t = SyntheticTree(base_xy=(i * spacing, j * spacing), dbh_m=0.25 + 0.02 * ((i + j) % 4),
                              stem_density=density, crown_points=crown_points,
                              crown_radius_m=(2.5, 2.5), seed=seed + k)
            p, _h = t.sample()
            pts.append(p)
            truth.append(np.full(len(p), k))
            bases.append(t.base())
    return np.vstack(pts), np.concatenate(truth), np.array(bases)


def _oracle(truth_all, points_all):
    """A tile job that knows the truth for the rows it is handed."""
    lookup = {tuple(np.round(p, 9)): int(t) for p, t in zip(points_all, truth_all)}

    def job(chunk, params, seeds, seed_ids):
        lab = np.array([lookup[tuple(np.round(p, 9))] for p in chunk], dtype=np.int64)
        if seeds is not None and len(seeds):
            # Seeded: tree id = the global id of the seed on that stem.
            out = np.zeros(len(chunk), dtype=np.int64)
            for s, gid in zip(seeds, seed_ids):
                d = np.hypot(chunk[:, 0] - s[0], chunk[:, 1] - s[1])
                near = lab[(d < 0.5) & (chunk[:, 2] < s[2] + 1)]
                if len(near):
                    out[lab == np.bincount(near).argmax()] = gid
            anchors = {int(g): np.asarray(s[:2]) for g, s in zip(seed_ids, seeds) if (out == g).any()}
            return out, anchors
        return lab, tt._anchors(chunk, lab)
    return job


def _purity(labels, truth):
    """(every true tree maps to exactly one label, fraction of points agreeing)."""
    agree = 0
    one_to_one = True
    used = set()
    for t in np.unique(truth):
        lab = labels[truth == t]
        vals, cnt = np.unique(lab, return_counts=True)
        best = vals[np.argmax(cnt)]
        agree += cnt.max()
        if best == 0 or best in used:
            one_to_one = False
        used.add(best)
    return one_to_one, agree / len(truth)


@pytest.mark.parametrize("tile_m,buffer_m", [(8.0, 5.0), (12.0, 6.0), (30.0, 5.0)])
def test_stitching_recovers_every_tree_exactly(monkeypatch, tile_m, buffer_m):
    pts, truth, _bases = _forest()
    monkeypatch.setattr(tt, "tile_job", _oracle(truth, pts))
    plan = tiled.TilePlan(pts[:, :2], tile_m, buffer_m)
    labels, meta = tt.segment_tiled(pts, {}, None, plan=plan)
    ok, agree = _purity(labels, truth)
    assert ok and agree == 1.0
    assert meta["trees_kept"] == 16 and len(np.unique(labels[labels > 0])) == 16
    # Buffer (>= 5 m) wider than any crown's reach (2.5 m): nothing cut off.
    assert meta["trees_truncated"] == 0
    # Dense ids 1..16, in spatial order (x, then y).
    assert sorted(np.unique(labels).tolist()) == list(range(1, 17))


def test_a_narrow_buffer_is_reported(monkeypatch):
    pts, truth, _ = _forest()
    monkeypatch.setattr(tt, "tile_job", _oracle(truth, pts))
    # 1 m buffer against 2.5 m crowns: trees reaching past it are cut.
    labels, meta = tt.segment_tiled(pts, {}, None, plan=tiled.TilePlan(pts[:, :2], 8.0, 1.0))
    assert meta["trees_truncated"] > 0


def test_seeded_ids_are_the_seed_numbers(monkeypatch):
    pts, truth, bases = _forest()
    monkeypatch.setattr(tt, "tile_job", _oracle(truth, pts))
    seeds = bases + [0, 0, 1.3]
    order = np.random.default_rng(3).permutation(len(seeds))
    labels, meta = tt.segment_tiled(pts, {}, seeds[order], plan=tiled.TilePlan(pts[:, :2], 8.0, 5.0))
    for k, s_idx in enumerate(order):
        true_tree = s_idx + 1
        assert np.all(labels[truth == true_tree] == k + 1)


def test_ownership_is_unique_and_total():
    # Every anchor - including ones past the outermost cores - has exactly one
    # owner among the full grid of tiles.
    plan = tiled.TilePlan(np.array([[0.0, 0.0], [29.9, 19.9]]), 10.0, 2.0)
    grid = []
    for ix in range(plan.nx):
        for iy in range(plan.ny):
            cmin = plan.origin + np.array([ix, iy]) * plan.tile_m
            grid.append(tiled.Tile(ix, iy, cmin, cmin + plan.tile_m, cmin - 2, cmin + plan.tile_m + 2))
    for a in np.random.default_rng(0).uniform([-1, -1], [31, 21], size=(500, 2)):
        assert sum(tt._owns(t, plan, a) for t in grid) == 1


def test_segment_validates():
    with pytest.raises(ValueError):
        tt.segment(np.zeros((5, 3)), {}, None, tiling="sometimes")
    with pytest.raises(ValueError):
        tt.segment(np.zeros((5, 3)), {}, None, buffer_m=0)


def test_real_treeiso_tiled_matches_the_forest():
    """TreeIso itself, tiled, on 16 separate trees: each tree should be one
    instance, as it is untiled."""
    pts, truth, _ = _forest(density=300, crown_points=1200)
    labels, meta = tt.segment(pts, {}, None, tiling="on", buffer_m=6.0, tile_nodes=15_000)
    assert meta["tiled"] and meta["tiles_run"] > 1
    ok, agree = _purity(labels, truth)
    assert agree > 0.9, meta
    untiled, m0 = tt.segment(pts, {}, None, tiling="off")
    assert not m0["tiled"]
    _ok0, agree0 = _purity(untiled, truth)
    assert agree >= agree0 - 0.05


@pytest.fixture
def cache_root(tmp_path, monkeypatch):
    root = tmp_path / "octree_cache"
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(root))
    return root


def test_session_endpoint_tiles_through_the_worker(client, cache_root, tmp_path, monkeypatch):
    """The real path: session -> killable worker -> tiled_trees, with a small
    per-tile target so a 16-tree plot runs as several tiles."""
    import main
    from tests.binframe import decode_streamed_json

    monkeypatch.setenv("PHYTOGRAPH_TREEISO_TILE_NODES", "15000")
    pts, truth, _ = _forest(density=300, crown_points=1200)
    f = tmp_path / "forest.xyz"
    np.savetxt(f, pts, fmt="%.4f")
    sid = decode_streamed_json(client.post(
        "/api/cloud/session/create", json={"source_path": str(f), "ascii_format": "x y z"},
    ).content)["session_id"]
    res = client.post(f"/api/cloud/session/{sid}/segment_trees",
                      json={"tiling": "on", "tile_buffer_m": 6.0, "acknowledge_cost": True})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["tiling"]["tiled"] is True and body["tiling"]["tiles_run"] > 1
    assert body["tiling"]["trees_truncated"] == 0
    labels = np.asarray(main._cloud_sessions[sid].extras["tree_instance"]).astype(int)
    # Session order is the file order.
    ok, agree = _purity(labels, truth)
    assert ok and agree > 0.98
    assert body["num_trees"] == 16


def test_cost_warning_still_asks_but_says_it_will_tile(monkeypatch):
    import main
    monkeypatch.setattr(main, "_TREEISO_MAX_NODES", 10)
    pts, _truth, _ = _forest(nx=2, ny=2, density=300, crown_points=800)
    w_tiled = main._treeiso_cost_warning(pts, {"tiling": "auto"})
    assert w_tiled is not None and "in tiles" in w_tiled["message"]
    assert "cancel" in w_tiled["message"].lower()
    w_off = main._treeiso_cost_warning(pts, {"tiling": "off"})
    assert w_off is not None and "15 minutes" in w_off["message"]
