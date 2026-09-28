"""Canopy-height-model tree segmentation (chm_trees.py, method='chm').

The fixture is a synthetic plantation seen from above, the shape TreeIso fuses
(bad_segment_example.laz): crowns wider than the tree spacing, so every crown
touches its neighbors, on sloped ground with the ground removed. Truth is
known exactly because the visible surface is built as the upper envelope of
the crowns — each canopy return belongs to the crown that is highest there.
"""
from __future__ import annotations

import numpy as np
import pytest

import chm_trees
import main
from tests.test_cloud_session import cache_root, decode_streamed_json  # noqa: F401

ROWS, COLS = 4, 5
DX, DY = 3.5, 4.0          # tree spacing (m) — narrower than a crown
CROWN_R = 2.4              # crown radius: neighbors overlap by ~1.4 m
# The best crown scale for these 4.8 m-wide crowns (3.0-3.5 m measured). NOT
# the trunk spacing in general — that it equals DX here is a coincidence.
SPACING = 3.5


def _seg(points, **kw):
    kw.setdefault("crown_scale", SPACING)
    return chm_trees.segment_trees_chm(points, **kw)
SLOPE = 0.08               # ground rises 8 cm per meter in x


def _ground(x):
    return SLOPE * x


def _plantation(seed=0, density=60.0):
    """(points, truth, tops, ground_pts). `density` = canopy returns per m²."""
    rng = np.random.default_rng(seed)
    cx, cy = np.meshgrid(np.arange(COLS) * DX, np.arange(ROWS) * DY)
    centers = np.c_[cx.ravel(), cy.ravel()] + rng.normal(0, 0.2, (ROWS * COLS, 2))
    heights = rng.uniform(8.0, 11.0, len(centers))
    lo = centers.min(axis=0) - CROWN_R
    hi = centers.max(axis=0) + CROWN_R
    n = int(density * np.prod(hi - lo))
    xy = rng.uniform(lo, hi, (n, 2))
    # Paraboloid crowns, 4 m deep; -inf outside a crown's radius.
    d2 = ((xy[:, None, :] - centers[None, :, :]) ** 2).sum(axis=2)
    dome = heights[None, :] - 4.0 * d2 / CROWN_R ** 2
    dome[d2 > CROWN_R ** 2] = -np.inf
    owner = np.argmax(dome, axis=1)
    top = dome[np.arange(n), owner]
    keep = np.isfinite(top)
    xy, owner, top = xy[keep], owner[keep], top[keep]
    # Some pulses penetrate: returns spread down into the owner's crown.
    depth = np.where(rng.random(len(xy)) < 0.3, rng.uniform(0, 3.5, len(xy)), 0.0)
    canopy = np.c_[xy, _ground(xy[:, 0]) + top - depth + rng.normal(0, 0.05, len(xy))]
    # A few stem returns, as an airborne scan gets.
    stems, stem_owner = [], []
    for k, (c, h) in enumerate(zip(centers, heights)):
        m = 25
        z = rng.uniform(0.2, h - 4.0, m)
        stems.append(np.c_[c[0] + rng.normal(0, 0.05, m), c[1] + rng.normal(0, 0.05, m),
                           _ground(c[0]) + z])
        stem_owner.append(np.full(m, k))
    points = np.vstack([canopy] + stems)
    truth = np.concatenate([owner] + stem_owner) + 1
    tops = np.c_[centers, _ground(centers[:, 0]) + heights]
    gxy = rng.uniform(lo, hi, (4000, 2))
    ground_pts = np.c_[gxy, _ground(gxy[:, 0])]
    return points, truth, tops, ground_pts


def _recovered(truth, labels, bar=0.7):
    """How many true trees come back as one instance: >= `bar` of the tree's
    points in one predicted label, which in turn is >= `bar` that tree.

    0.7, not higher: every point takes the label of its CHM cell, so a strip
    about one cell wide along each crown boundary lands in the neighbor. On
    these ~12 m² crowns at the default ~0.35 m cell that is ~10% of a crown
    even with the TRUE treetops as seeds. What this must catch is a merge,
    which drops one of a fused pair to ~0.5 purity."""
    ok = 0
    for t in np.unique(truth):
        mine = labels[truth == t]
        vals, cnt = np.unique(mine, return_counts=True)
        best = vals[np.argmax(cnt)]
        if best == 0:
            continue
        recall = cnt.max() / len(mine)
        purity = np.mean(truth[labels == best] == t)
        ok += recall >= bar and purity >= bar
    return ok


def test_touching_crowns_come_back_one_per_tree():
    points, truth, _, _ = _plantation()
    labels = _seg(points)
    n_trees = ROWS * COLS
    assert abs(int(labels.max()) - n_trees) <= 2, f"found {labels.max()} trees, expected {n_trees}"
    assert _recovered(truth, labels) >= 0.8 * n_trees, _recovered(truth, labels)


def test_stem_points_join_the_crown_above_them():
    """A stem under a crown belongs to that tree — the reason every point takes
    the label of the CHM cell it falls in, not only the canopy returns."""
    points, truth, _, _ = _plantation()
    labels = _seg(points)
    stems = np.arange(len(points)) >= len(points) - 25 * ROWS * COLS
    for t in np.unique(truth):
        crown_label = np.bincount(labels[(truth == t) & ~stems]).argmax()
        stem_labels = labels[(truth == t) & stems]
        assert np.mean(stem_labels == crown_label) > 0.9, (t, np.unique(stem_labels))


def test_crown_scale_is_read():
    """The main knob must change the RESULT, not just travel through the params
    (see project memory: TreeIso's max_outlier_gap was wired end to end and
    read by nothing)."""
    points, _, _, _ = _plantation()
    fine = _seg(points).max()
    coarse = _seg(points, crown_scale=14.0).max()
    assert coarse < fine / 2, (fine, coarse)


def test_min_height_drops_low_canopy():
    points, _, _, _ = _plantation()
    labels = _seg(points, min_height=50.0)
    assert labels.max() == 0


def test_seeds_take_ids_one_to_s_and_keep_the_other_trees():
    """Seeding a few trees must not swallow the unseeded rest: each seed owns
    the crown it was placed on, as ids 1..S in seed order, and the automatic
    trees continue from S+1."""
    points, truth, tops, _ = _plantation()
    chosen = [0, 7, 13]
    labels = _seg(points, seeds=tops[chosen])
    for sid, tree in enumerate(chosen, start=1):
        near = np.linalg.norm(points[:, :2] - tops[tree, :2], axis=1) < 0.5
        assert np.mean(labels[near] == sid) > 0.95, sid
    assert abs(int(labels.max()) - ROWS * COLS) <= 2, labels.max()
    assert _recovered(truth, labels) >= 0.8 * ROWS * COLS


def test_off_center_seed_takes_over_its_crowns_automatic_top():
    """A seed is rarely ON the treetop — it's a trunk click, and trunks lean.
    The crown's own automatic top must give way to it; otherwise the two
    markers split one tree between them."""
    points, truth, tops, _ = _plantation()
    tree = 8
    seed = tops[[tree]].copy()
    seed[0, 0] += 0.9                     # 0.9 m off the top, still in the crown
    labels = _seg(points, seeds=seed)
    mine = labels[truth == tree + 1]
    # 0.8, not higher: an off-center marker shifts the compact watershed a
    # little toward the seed. Without the takeover this scores ~0.12.
    assert np.mean(mine == 1) > 0.8, np.unique(mine, return_counts=True)


def test_two_seeds_split_a_crown_the_automatic_pass_merged():
    """The correction seeds exist for: a too-large crown scale merges neighbors,
    and a seed on each of two merged trees gives them back one each."""
    points, truth, tops, _ = _plantation()
    auto = _seg(points, crown_scale=14.0)
    a, b = 5, 6                       # neighbors in one row, ~3 m apart
    near_a = np.linalg.norm(points[:, :2] - tops[a, :2], axis=1) < 0.5
    near_b = np.linalg.norm(points[:, :2] - tops[b, :2], axis=1) < 0.5
    merged = np.bincount(auto[near_a]).argmax() == np.bincount(auto[near_b]).argmax()
    assert merged, "fixture precondition: crown_scale=14 should merge these two"
    seeded = _seg(points, crown_scale=14.0, seeds=tops[[a, b]])
    assert np.mean(seeded[near_a] == 1) > 0.95
    assert np.mean(seeded[near_b] == 2) > 0.95


def test_ground_points_and_lowest_return_agree():
    """A cloud with ground-labeled points uses them as the DTM; a ground-removed
    one falls back to its lowest returns. On the same canopy, both must find
    the same trees."""
    points, truth, _, ground_pts = _plantation()
    meta_g: dict = {}
    with_ground = _seg(points, ground=ground_pts, meta=meta_g)
    meta_l: dict = {}
    lowest = _seg(points, meta=meta_l)
    assert meta_g["ground_source"] == "ground_class"
    assert meta_l["ground_source"] == "lowest_return"
    n_trees = ROWS * COLS
    assert _recovered(truth, with_ground) >= 0.8 * n_trees
    assert _recovered(truth, lowest) >= 0.8 * n_trees


def test_height_above_ground_follows_the_slope():
    """HAG must remove the terrain: a tree at the high end of the slope is not
    taller than its twin at the low end."""
    _, _, _, ground_pts = _plantation()
    probe = np.array([[0.0, 5.0, _ground(0.0) + 3.0], [14.0, 5.0, _ground(14.0) + 3.0]])
    hag = chm_trees.height_above_ground(probe, ground_pts)
    assert np.allclose(hag, 3.0, atol=0.15), hag


@pytest.mark.parametrize("density", [8.0, 15.0, 30.0, 60.0])
def test_sparse_returns_still_find_every_tree(density):
    """Sparse airborne data must not lose trees. Two defects did exactly that at
    8 returns/m² (3 of 20 recovered): the default cell was tied to point
    spacing, so it got coarser as data got sparser; and cells no return landed
    in were left empty, splitting crowns into islands and minting a "treetop"
    on every lone cell."""
    points, truth, _, _ = _plantation(density=density)
    labels = _seg(points)
    n_trees = ROWS * COLS
    assert abs(int(labels.max()) - n_trees) <= 2, labels.max()
    assert _recovered(truth, labels) >= 0.8 * n_trees, _recovered(truth, labels)


def test_default_cell_follows_crown_scale_not_density():
    assert chm_trees.default_cell(2.4) == pytest.approx(0.2)
    assert chm_trees.default_cell(2.0) < chm_trees.default_cell(4.0)
    assert chm_trees.default_cell(0.1) == chm_trees.CELL_MIN_M
    assert chm_trees.default_cell(100.0) == chm_trees.CELL_MAX_M


def test_empty_input():
    assert chm_trees.segment_trees_chm(np.zeros((0, 3))).shape == (0,)


# ---- endpoints ------------------------------------------------------------ #

def test_inline_endpoint_runs_chm(client):
    points, truth, _, _ = _plantation()
    res = client.post("/api/segment/trees",
                      json={"points": points.tolist(), "method": "chm",
                            "chm_crown_scale": SPACING})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["success"] is True, body.get("error")
    assert abs(body["num_trees"] - ROWS * COLS) <= 2
    assert body["fusion_warning"] is None
    assert _recovered(truth, np.asarray(body["labels"])) >= 0.8 * ROWS * COLS


def test_inline_endpoint_rejects_bad_crown_scale(client):
    res = client.post("/api/segment/trees",
                      json={"points": [[0, 0, 0]] * 20, "method": "chm", "chm_crown_scale": 0})
    assert res.status_code == 422


def test_session_endpoint_runs_chm_and_keeps_ground_at_zero(client, cache_root, tmp_path):
    """The panel's path: tree_instance appended from the in-RAM arrays, ground
    points (a kept ground segmentation) stay 0 and serve as the DTM."""
    points, truth, _, ground_pts = _plantation(density=30.0)
    allp = np.vstack([points, ground_pts])
    f = tmp_path / "plantation.xyz"
    np.savetxt(f, allp, fmt="%.4f")
    sid = decode_streamed_json(client.post(
        "/api/cloud/session/create",
        json={"source_path": str(f), "ascii_format": "x y z"},
    ).content)["session_id"]
    sess = main._cloud_sessions[sid]
    is_ground = np.zeros(len(sess.positions), dtype=bool)
    is_ground[len(points):] = True
    gclass = np.where(is_ground, main.GROUND_CLASS_GROUND,
                      main.GROUND_CLASS_PLANT).astype(np.float32)
    with main._cloud_session_lock:
        main._session_add_extra_column(sess, main.GROUND_CLASS_SLUG,
                                       main.GROUND_CLASS_LABEL, gclass)

    res = client.post(f"/api/cloud/session/{sid}/segment_trees", json={"method": "chm", "chm_crown_scale": SPACING})
    assert res.status_code == 200, res.text
    body = res.json()
    assert abs(body["num_trees"] - ROWS * COLS) <= 2
    assert body["chm"]["ground_source"] == "ground_class"
    assert body["ground_warning"] is False     # ground-segmented: no reminder
    tree = main._cloud_sessions[sid].extras["tree_instance"]
    assert np.all(tree[is_ground] == 0)
    assert _recovered(truth, np.asarray(tree[~is_ground]).astype(int)) >= 0.8 * ROWS * COLS


def _natural_stand(seed, n_target=60, size=40.0, dmin=4.0, hmin=10.0, hmax=25.0,
                   crown_k=0.16, density=25.0):
    """An irregular stand: random positions at least `dmin` apart, heights
    uniform in [hmin, hmax], crown radius crown_k * height (+-15%), seen from
    above as the upper envelope of the crowns. Returns (points, truth)."""
    rng = np.random.default_rng(seed)
    centers = []
    for _ in range(20000):
        if len(centers) >= n_target:
            break
        p = rng.uniform(0, size, 2)
        if all(np.hypot(*(p - q)) >= dmin for q in centers):
            centers.append(p)
    c = np.array(centers)
    h = rng.uniform(hmin, hmax, len(c))
    r = crown_k * h * rng.uniform(0.85, 1.15, len(c))
    xy = rng.uniform(-2, size + 2, (int(density * size * size), 2))
    top = np.full(len(xy), -np.inf)
    owner = np.full(len(xy), -1)
    for k in range(len(c)):
        d2 = ((xy - c[k]) ** 2).sum(axis=1)
        dome = h[k] - 0.35 * h[k] * d2 / r[k] ** 2
        dome[d2 > r[k] ** 2] = -np.inf
        better = dome > top
        top[better] = dome[better]
        owner[better] = k
    keep = np.isfinite(top)
    xy, top, owner = xy[keep], top[keep], owner[keep]
    depth = np.where(rng.random(len(xy)) < 0.3, rng.uniform(0, 0.3, len(xy)) * top, 0.0)
    return np.c_[xy, top - depth + rng.normal(0, 0.1, len(xy))], owner + 1


def test_default_crown_scale_suits_an_irregular_natural_stand():
    """The 2.5 m default was first fitted on a plantation, so it must also hold
    where nothing is in rows: trees 4.4 m apart on average, 10-25 m tall. The
    default is 91% right here (the best of any single value); typing the
    trunk spacing instead (4.4 m) would drop it to ~75%, the reason the setting
    is a crown scale and not a spacing."""
    right = []
    for seed in range(3):
        points, truth = _natural_stand(seed)
        labels = chm_trees.segment_trees_chm(points)       # the default
        right.append(_recovered(truth, labels, bar=0.5) / len(np.unique(truth)))
    assert np.mean(right) >= 0.85, right


def test_session_chm_reminds_when_ground_was_never_segmented(client, cache_root, tmp_path):
    """A cloud that never went through Ground Segmentation gets the reminder:
    the CHM method takes the lowest returns as terrain, so any ground left in
    is labeled as part of the tree above it."""
    points, _, _, _ = _plantation(density=15.0)
    f = tmp_path / "no_ground_seg.xyz"
    np.savetxt(f, points, fmt="%.4f")
    sid = decode_streamed_json(client.post(
        "/api/cloud/session/create",
        json={"source_path": str(f), "ascii_format": "x y z"},
    ).content)["session_id"]
    res = client.post(f"/api/cloud/session/{sid}/segment_trees",
                      json={"method": "chm", "chm_crown_scale": SPACING})
    assert res.status_code == 200, res.text
    assert res.json()["ground_warning"] is True
