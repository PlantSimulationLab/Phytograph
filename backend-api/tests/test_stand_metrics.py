"""Stand geometry against exact answers: polygon clipping, Hegyi's index,
crown overlap, canopy cover and the edge flag."""
import math

import numpy as np
import pytest

import stand_metrics as sm


def _square(cx, cy, half):
    return np.array([[cx - half, cy - half], [cx + half, cy - half],
                     [cx + half, cy + half], [cx - half, cy + half]], dtype=float)


def _circle(cx, cy, r, n=64):
    t = np.linspace(0, 2 * math.pi, n, endpoint=False)
    return np.column_stack([cx + r * np.cos(t), cy + r * np.sin(t)])


class TestPolygons:
    def test_hull_of_a_square_with_interior_points(self):
        rng = np.random.default_rng(0)
        pts = np.vstack([_square(0, 0, 1), rng.uniform(-0.9, 0.9, (200, 2))])
        h = sm.convex_hull(pts)
        assert len(h) == 4 and sm.polygon_area(h) == pytest.approx(4.0)

    def test_hull_degenerate(self):
        assert sm.convex_hull(np.array([[0, 0], [1, 1], [2, 2]])) is None
        assert sm.polygon_area(None) == 0.0

    def test_clip_overlapping_squares(self):
        inter = sm.clip_convex(_square(0, 0, 1), _square(1, 1, 1))
        assert sm.polygon_area(inter) == pytest.approx(1.0)

    def test_clip_disjoint_and_contained(self):
        assert sm.clip_convex(_square(0, 0, 1), _square(5, 5, 1)) is None
        inner = sm.clip_convex(_square(0, 0, 2), _square(0.5, 0, 0.5))
        assert sm.polygon_area(inner) == pytest.approx(1.0)

    def test_clip_is_orientation_independent(self):
        a = sm.polygon_area(sm.clip_convex(_square(0, 0, 1)[::-1], _square(1, 0, 1)))
        assert a == pytest.approx(2.0)

    def test_distance_to_boundary(self):
        assert sm.distance_to_boundary((0.2, 0.0), _square(0, 0, 1)) == pytest.approx(0.8)

    def test_hull_accumulator_matches_one_shot_hull(self):
        rng = np.random.default_rng(1)
        pts = rng.normal(size=(5000, 2))
        acc = sm.HullAccumulator()
        for chunk in np.array_split(pts, 7):
            acc.add(chunk)
        assert sm.polygon_area(acc.hull) == pytest.approx(sm.polygon_area(sm.convex_hull(pts)))


def _tree(tid, x, y, dbh, crown_r=None):
    return {"tree_id": tid, "stem_base": [x, y, 100.0], "dbh_m": dbh,
            "crown_hull_xy": _circle(x, y, crown_r).tolist() if crown_r else None}


class TestCompetition:
    def test_hegyi_index_exact(self):
        trees = [_tree(1, 0, 0, 0.2), _tree(2, 4, 0, 0.4), _tree(3, 0, 5, 0.1), _tree(4, 20, 0, 0.5)]
        c = sm.competition(trees, radius_m=6.0)
        # Tree 1: (0.4/0.2)/4 + (0.1/0.2)/5 ; tree 4 is out of range.
        assert c[1]["hegyi_index"] == pytest.approx(2 / 4 + 0.5 / 5)
        assert c[1]["n_competitors"] == 2
        assert c[4]["hegyi_index"] == 0.0 and c[4]["n_competitors"] == 0

    def test_tree_without_dbh(self):
        c = sm.competition([_tree(1, 0, 0, None), _tree(2, 3, 0, 0.3)], radius_m=6.0)
        assert c[1]["hegyi_index"] is None
        # A DBH-less tree is not a competitor of anyone.
        assert c[2]["n_competitors"] == 0

    def test_crown_overlap_of_two_circles(self):
        r, d = 2.0, 2.0
        lens = 2 * r * r * math.acos(d / (2 * r)) - (d / 2) * math.sqrt(4 * r * r - d * d)
        c = sm.competition([_tree(1, 0, 0, 0.3, r), _tree(2, d, 0, 0.3, r)], radius_m=6.0)
        assert c[1]["crown_overlap_m2"] == pytest.approx(lens, rel=0.01)
        assert c[1]["crown_overlap_fraction"] == pytest.approx(lens / (math.pi * r * r), abs=0.02)
        far = sm.competition([_tree(1, 0, 0, 0.3, r), _tree(2, 9, 0, 0.3, r)], radius_m=6.0)
        assert far[1]["crown_overlap_m2"] == 0.0 and far[1]["crown_overlap_fraction"] == 0.0

    def test_edge_flag(self):
        plot = _square(0, 0, 10)
        c = sm.competition([_tree(1, 0, 0, 0.3), _tree(2, 8, 0, 0.3)], radius_m=5.0, plot_polygon=plot)
        assert c[1]["edge"] is False and c[2]["edge"] is True


class TestCover:
    def test_union_of_overlapping_squares(self):
        a, _ = sm.crown_union_area([_square(0, 0, 1), _square(1, 0, 1)], cell_m=0.02)
        assert a == pytest.approx(6.0, rel=0.02)

    def test_union_clipped_to_plot(self):
        a, _ = sm.crown_union_area([_square(0, 0, 1)], cell_m=0.02, within=_square(1, 0, 1))
        assert a == pytest.approx(2.0, rel=0.03)

    def test_raster_cell_grows_on_a_huge_extent(self):
        # Two tiny crowns 10 km apart: the raster may not be 1e10 cells.
        a, cell = sm.crown_union_area([_square(0, 0, 1), _square(10000, 10000, 1)], cell_m=0.1)
        assert cell > 0.1
        assert (10000 / cell) ** 2 <= sm.MAX_COVER_CELLS * 1.01
        assert a == pytest.approx(8.0, rel=0.5)

    def test_check_can_cancel(self):
        class Stop(Exception):
            pass

        def check():
            raise Stop()
        with pytest.raises(Stop):
            sm.stand_geometry([_tree(1, 0, 0, 0.3, 2.0)], plot_polygon=None,
                              competition_radius_m=5.0, check=check)

    def test_many_trees_is_fast(self):
        import time
        rng = np.random.default_rng(2)
        xy = rng.uniform(0, 400, (3000, 2))
        trees = [_tree(i + 1, x, y, 0.3, 2.0) for i, (x, y) in enumerate(xy)]
        t0 = time.time()
        c = sm.competition(trees, radius_m=6.0)
        assert time.time() - t0 < 30
        # Spot-check one tree against brute force.
        i = 17
        d = np.hypot(*(xy - xy[i]).T)
        nb = (d > 0) & (d <= 6.0)
        assert c[i + 1]["n_competitors"] == int(nb.sum())
        assert c[i + 1]["hegyi_index"] == pytest.approx(float(np.sum(1.0 / np.maximum(d[nb], 0.1))))

    def test_stand_geometry(self):
        plot = _square(0, 0, 10)
        trees = [_tree(1, -3, 0, 0.3, 2.0), _tree(2, 3, 0, 0.3, 2.0)]
        g = sm.stand_geometry(trees, plot_polygon=plot, competition_radius_m=8.0, cover_cell_m=0.05)
        assert g["plot_area_m2"] == pytest.approx(400.0)
        assert g["crown_union_area_m2"] == pytest.approx(2 * math.pi * 4, rel=0.02)
        assert g["crown_area_sum_m2"] == pytest.approx(2 * math.pi * 4, rel=0.01)
        assert set(g["competition"]) == {"1", "2"}
