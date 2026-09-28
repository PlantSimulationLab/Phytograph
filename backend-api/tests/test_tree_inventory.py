"""Tree inventory: circle fits and per-tree measurements against KNOWN truth.

Every tree here is built by `synthetic_trees.SyntheticTree`, so DBH, stem base,
lean, height, crown base and crown offset each have an exact answer. The
tolerances are what the method should achieve on that geometry, not what one
run happened to print.
"""
import math

import numpy as np
import pytest

import tree_inventory as ti
from tests.synthetic_trees import SyntheticTree


def _circle(n, r=1.0, c=(0.0, 0.0), arc_deg=360.0, noise=0.0, seed=0):
    rng = np.random.default_rng(seed)
    half = math.radians(arc_deg) / 2
    th = rng.uniform(-half, half, n)
    rr = r + (rng.normal(0, noise, n) if noise else 0.0)
    return np.column_stack([c[0] + rr * np.cos(th), c[1] + rr * np.sin(th)])


# ==================== circle fitting ====================

class TestCircleThrough3Points:
    def test_three_points_on_unit_circle(self):
        center, radius = ti.circle_through_3_points(np.array([[1.0, 0.0], [0.0, 1.0], [-1.0, 0.0]]))
        assert np.allclose(center, [0.0, 0.0], atol=1e-12)
        assert radius == pytest.approx(1.0, abs=1e-12)

    def test_collinear_points_return_none(self):
        assert ti.circle_through_3_points(np.array([[0.0, 0.0], [1.0, 0.0], [2.0, 0.0]])) == (None, None)

    def test_wrong_point_count_returns_none(self):
        assert ti.circle_through_3_points(np.array([[0.0, 0.0], [1.0, 0.0]])) == (None, None)


class TestTaubin:
    def test_exact_on_a_full_circle_far_from_origin(self):
        # World coordinates are large (UTM); the fit centers the data first.
        pts = _circle(200, r=0.2, c=(612345.0, 4270000.0))
        center, r = ti.fit_circle_taubin(pts)
        assert np.allclose(center, [612345.0, 4270000.0], atol=1e-6)
        assert r == pytest.approx(0.2, abs=1e-8)

    def test_short_arc_bias_smaller_than_kasa(self):
        # The reason Taubin seeds the geometric fit (Al-Sharadqah & Chernov
        # 2009): on a short noisy arc the Kasa fit shrinks the radius.
        rng_errs_taubin, rng_errs_kasa = [], []
        for seed in range(30):
            pts = _circle(300, r=0.25, arc_deg=90, noise=0.005, seed=seed)
            _c, r_t = ti.fit_circle_taubin(pts)
            # Kasa: linear least squares on x^2 + y^2 + Dx + Ey + F = 0.
            A = np.column_stack([pts, np.ones(len(pts))])
            b = -(pts ** 2).sum(axis=1)
            D, E, F = np.linalg.lstsq(A, b, rcond=None)[0]
            r_k = math.sqrt(D * D / 4 + E * E / 4 - F)
            rng_errs_taubin.append(r_t - 0.25)
            rng_errs_kasa.append(r_k - 0.25)
        assert abs(np.mean(rng_errs_taubin)) < abs(np.mean(rng_errs_kasa))

    def test_degenerate_input(self):
        assert ti.fit_circle_taubin(np.array([[0.0, 0.0], [1.0, 1.0]])) == (None, None)
        # Collinear points are a line: no circle.
        line = np.column_stack([np.linspace(0, 1, 20), np.zeros(20)])
        assert ti.fit_circle_taubin(line) == (None, None)


class TestGeometricFit:
    def test_recovers_noisy_half_circle(self):
        pts = _circle(400, r=0.15, c=(3.0, -2.0), arc_deg=180, noise=0.003, seed=4)
        c, r, rms = ti.fit_circle_geometric(pts, np.array([3.05, -2.0]), 0.1)
        assert np.allclose(c, [3.0, -2.0], atol=0.003)
        assert r == pytest.approx(0.15, abs=0.003)
        assert rms == pytest.approx(0.003, rel=0.2)

    def test_too_few_points(self):
        assert ti.fit_circle_geometric(np.array([[0.0, 0.0], [1.0, 0.0]]), [0, 0], 1) == (None, None, None)


@pytest.mark.parametrize("method", ["ransac", "hough"])
class TestRobustSearch:
    def test_finds_stem_among_clutter(self, method):
        rng = np.random.default_rng(7)
        stem = _circle(300, r=0.2, c=(1.0, 1.0), noise=0.003, seed=1)
        clutter = rng.uniform(-1.0, 3.0, size=(300, 2))  # 50% outliers
        pts = np.vstack([stem, clutter])
        params = ti.InventoryParams(fit_method=method)
        f = ti.fit_stem_circle(pts, params, np.random.default_rng(0))
        assert f is not None
        assert np.allclose(f["center"], [1.0, 1.0], atol=0.005)
        assert f["radius"] == pytest.approx(0.2, abs=0.005)
        # The clutter is not the stem: inliers are about the 300 stem points.
        assert 280 <= f["n_inliers"] <= 330
        assert f["arc_coverage"] == pytest.approx(1.0)

    def test_deterministic_for_a_fixed_seed(self, method):
        pts = np.vstack([_circle(200, r=0.3, noise=0.005, seed=2),
                         np.random.default_rng(3).uniform(-1, 1, (100, 2))])
        params = ti.InventoryParams(fit_method=method)
        a = ti.fit_stem_circle(pts, params, np.random.default_rng(5))
        b = ti.fit_stem_circle(pts, params, np.random.default_rng(5))
        assert a["radius"] == b["radius"] and np.array_equal(a["center"], b["center"])

    def test_rejects_radius_out_of_range(self, method):
        pts = _circle(200, r=3.0)  # a 6 m "stem"
        assert ti.fit_stem_circle(pts, ti.InventoryParams(fit_method=method), np.random.default_rng(0)) is None


class TestQualityEvidence:
    def test_arc_stats_half_circle(self):
        pts = _circle(2000, r=1.0, arc_deg=180)
        coverage, gap = ti.arc_stats(pts, (0.0, 0.0))
        assert coverage == pytest.approx(0.5, abs=1 / 36 + 1e-9)
        assert gap == pytest.approx(180.0, abs=2.0)

    def test_partial_arc_and_few_points_flags(self):
        params = ti.InventoryParams()
        f = ti.fit_stem_circle(_circle(15, r=0.2, arc_deg=90, seed=3), params, np.random.default_rng(0))
        assert f is not None
        assert "partial_arc" in f["flags"] and "few_points" in f["flags"]

    def test_high_residual_flag(self):
        # 3 cm radial noise on a 10 cm radius: rms > 0.1 r.
        params = ti.InventoryParams(inlier_distance_m=0.1)
        f = ti.fit_stem_circle(_circle(400, r=0.1, noise=0.03, seed=9), params, np.random.default_rng(0))
        assert f is not None and "high_residual" in f["flags"]

    def test_clean_full_circle_has_no_flags(self):
        f = ti.fit_stem_circle(_circle(300, r=0.2, noise=0.002), ti.InventoryParams(), np.random.default_rng(0))
        assert f["flags"] == []


# ==================== per-tree measurement ====================

def _measure(tree: SyntheticTree, method="ransac", ground="hag", clutter=0, **params):
    pts, hag = tree.sample()
    if clutter:
        rng = np.random.default_rng(11)
        b = tree.base()
        cl = np.column_stack([rng.uniform(b[0] - 3, b[0] + 3, clutter),
                              rng.uniform(b[1] - 3, b[1] + 3, clutter),
                              rng.uniform(0, 2, clutter)])
        cl[:, 2] += tree.ground(cl[:, 0], cl[:, 1])
        pts = np.vstack([pts, cl])
        hag = pts[:, 2] - tree.ground(pts[:, 0], pts[:, 1])
    kw = {}
    if ground == "hag":
        kw["hag"] = hag
    elif ground == "grid":
        g = ti.GroundGrid()
        b = tree.base()
        gx, gy = np.meshgrid(np.arange(b[0] - 5, b[0] + 5, 0.1), np.arange(b[1] - 5, b[1] + 5, 0.1))
        g.add(np.column_stack([gx.ravel(), gy.ravel(), tree.ground(gx.ravel(), gy.ravel())]))
        kw["ground_grid"] = g
    p = ti.InventoryParams(fit_method=method, **params)
    return ti.measure_tree(pts, params=p, tree_id=7, **kw)


@pytest.mark.parametrize("method", ["ransac", "hough"])
class TestMeasureTree:
    def test_vertical_stem_on_flat_ground(self, method):
        t = SyntheticTree()
        r = _measure(t, method)["tree"]
        assert r["tree_id"] == 7
        assert r["dbh_m"] == pytest.approx(0.30, abs=0.003)
        assert r["stem_base"] == pytest.approx(t.base().tolist(), abs=0.005)
        assert r["lean_deg"] < 0.5 and r["lean_azimuth_deg"] is None
        assert r["height_m"] == pytest.approx(12.0, abs=0.01)
        assert r["crown_base_height_m"] == pytest.approx(5.0, abs=0.2)
        assert r["basal_area_m2"] == pytest.approx(math.pi / 4 * r["dbh_m"] ** 2)
        assert r["slenderness"] == pytest.approx(r["height_m"] / r["dbh_m"])
        assert r["ground_source"] == "height_above_ground"
        assert r["flags"] == []

    def test_leaning_stem_on_a_slope(self, method):
        # DBH is measured along the axis, perpendicular to it: a horizontal
        # cut would read 0.30 / cos(10 deg) = 0.305.
        t = SyntheticTree(slope=(0.3, 0.1), lean_deg=10, lean_azimuth_deg=60, base_xy=(5.0, 3.0))
        r = _measure(t, method)["tree"]
        assert r["dbh_m"] == pytest.approx(0.30, abs=0.002)
        assert r["stem_base"] == pytest.approx(t.base().tolist(), abs=0.01)
        assert r["lean_deg"] == pytest.approx(10.0, abs=0.3)
        assert r["lean_azimuth_deg"] == pytest.approx(60.0, abs=2.0)
        assert r["height_m"] == pytest.approx(12.0, abs=0.02)
        # The crown sits over the leaning top: 8 m along a 10 deg axis.
        assert r["crown_offset_m"] == pytest.approx(8 * math.sin(math.radians(10)), abs=0.1)
        assert r["crown_offset_azimuth_deg"] == pytest.approx(60.0, abs=5.0)

    def test_dbh_is_measured_from_the_dtm_not_the_lowest_point(self, method):
        # On a steep slope the downhill side of the stem is well below the
        # base; a tree-min baseline would put breast height ~0.09 m too low
        # and still find the stem. What moves is the stem BASE, so check it.
        t = SyntheticTree(slope=(0.6, 0.0), base_xy=(0.0, 0.0))
        r = _measure(t, method)["tree"]
        assert r["stem_base"][2] == pytest.approx(t.base()[2], abs=0.01)
        assert r["height_m"] == pytest.approx(12.0, abs=0.02)

    def test_breast_height_is_measured_from_the_uphill_side(self, method):
        # Strong taper makes the 12 cm uphill offset visible in the diameter:
        # 1.3 m from the uphill ground is ~1.42 m along the axis from the base.
        t = SyntheticTree(slope=(0.6, 0.0), taper_m_per_m=0.05, dbh_m=0.40)
        r = _measure(t, method)["tree"]
        uphill = t.base()[2] + 0.6 * (t.diameter_at(1.5) / 2)
        assert r["breast_height_ref_z"] == pytest.approx(uphill, abs=0.01)
        expected = t.diameter_at(1.3 + (uphill - t.base()[2]))
        assert r["dbh_m"] == pytest.approx(expected, abs=0.002)
        assert abs(r["dbh_m"] - t.diameter_at(1.3)) > 0.004

    def test_half_arc_noisy_stem(self, method):
        t = SyntheticTree(arc_deg=180, noise_m=0.005, dbh_m=0.45, lean_deg=15,
                          lean_azimuth_deg=200, slope=(-0.2, 0.25))
        r = _measure(t, method, clutter=3000)["tree"]
        assert r["dbh_m"] == pytest.approx(0.45, abs=0.01)
        assert r["dbh"]["arc_coverage"] == pytest.approx(0.5, abs=0.1)
        assert r["lean_deg"] == pytest.approx(15.0, abs=0.5)
        assert r["stem_base"][:2] == pytest.approx(t.base()[:2].tolist(), abs=0.02)

    def test_third_of_a_stem_is_flagged_partial(self, method):
        t = SyntheticTree(arc_deg=120, noise_m=0.01, dbh_m=0.5)
        r = _measure(t, method)["tree"]
        assert r["dbh_m"] == pytest.approx(0.5, abs=0.02)
        assert "partial_arc" in r["flags"] and "partial_arc" in r["dbh"]["flags"]

    def test_single_scan_stem_curve_is_ok_and_leaves_the_crown(self, method):
        # One scan position sees about half of each stem: every slice is a
        # partial arc. That is normal, so the curve must still be ok and the
        # stem still removed from the crown (else the trunk is "crown").
        t = SyntheticTree(arc_deg=170, noise_m=0.003, taper_m_per_m=0.02, dbh_m=0.35)
        out = _measure(t, method)
        ok = [c for c in out["stem_curve"] if c["ok"]]
        assert len(ok) >= 8
        for c in ok:
            assert c["diameter_m"] == pytest.approx(t.diameter_at(c["axial_m"]), abs=0.008)
        r = out["tree"]
        assert r["crown_base_height_m"] == pytest.approx(5.0, abs=0.2)
        assert r["n_crown_points"] < 0.3 * r["n_points"]

    def test_stem_curve_follows_the_taper(self, method):
        t = SyntheticTree(taper_m_per_m=0.02, dbh_m=0.35)
        curve = _measure(t, method)["stem_curve"]
        ok = [c for c in curve if c["ok"]]
        assert len(ok) >= 10
        for c in ok:
            assert c["diameter_m"] == pytest.approx(t.diameter_at(c["axial_m"]), abs=0.004)
            assert c["tree_id"] == 7
        # Axial distance steps by 0.5 m from 0.5 m.
        assert [c["axial_m"] for c in curve[:3]] == pytest.approx([0.5, 1.0, 1.5])

    def test_ground_from_labeled_ground_grid(self, method):
        t = SyntheticTree(slope=(0.2, -0.1), base_xy=(2.0, 2.0))
        r = _measure(t, method, ground="grid")["tree"]
        assert r["ground_source"] == "ground_class"
        assert r["stem_base"][2] == pytest.approx(t.base()[2], abs=0.03)
        assert r["dbh_m"] == pytest.approx(0.30, abs=0.003)

    def test_no_ground_falls_back_to_tree_minimum_and_flags_it(self, method):
        r = _measure(SyntheticTree(), method, ground=None)["tree"]
        assert r["ground_source"] == "tree_min_z"
        assert "ground_from_tree_min" in r["flags"]
        assert r["dbh_m"] == pytest.approx(0.30, abs=0.003)


class TestCrown:
    def test_isolated_low_branch_is_not_the_crown_base(self):
        r = _measure(SyntheticTree(low_branch_m=2.0))["tree"]
        assert r["crown_base_height_m"] == pytest.approx(5.0, abs=0.2)

    def test_one_sided_branch_below_the_crown_is_not_the_base(self):
        # A single branch 0.6 m below the crown is within the 1 m gap, so the
        # gap rule alone would call it the crown base; it occupies one
        # quadrant, so the 3-of-4-quadrant convention climbs past it.
        r = _measure(SyntheticTree(low_branch_m=4.4))["tree"]
        assert r["crown_base_height_m"] == pytest.approx(5.0, abs=0.2)

    def test_quadrant_rule_on_heights(self):
        h = np.concatenate([np.full(200, 4.5), np.linspace(5.0, 10.0, 5000)])
        az = np.concatenate([np.full(200, 45.0), np.random.default_rng(0).uniform(0, 360, 5000)])
        gap_only = ti.crown_base_height(h, bin_m=0.2, gap_m=1.0, occupancy_frac=0.05)
        with_quads = ti.crown_base_height(h, bin_m=0.2, gap_m=1.0, occupancy_frac=0.05, azimuth_deg=az)
        assert gap_only == pytest.approx(4.4)
        assert with_quads == pytest.approx(5.0)

    def test_crown_base_height_gap_rule(self):
        h = np.concatenate([np.full(50, 1.1), np.linspace(4.0, 10.0, 3000)])
        assert ti.crown_base_height(h, bin_m=0.2, gap_m=1.0, occupancy_frac=0.05) == pytest.approx(4.0)
        # A gap narrower than gap_m keeps the low branch in the crown.
        h2 = np.concatenate([np.full(50, 3.3), np.linspace(4.0, 10.0, 3000)])
        assert ti.crown_base_height(h2, bin_m=0.2, gap_m=1.0, occupancy_frac=0.05) == pytest.approx(3.2)

    def test_projected_area_and_diameters_of_a_circular_crown(self):
        t = SyntheticTree(crown_radius_m=(2.0, 2.0), crown_points=20000)
        r = _measure(t)["tree"]
        area = math.pi * 4.0
        assert r["crown_projected_area_m2"] == pytest.approx(area, rel=0.03)
        assert r["crown_diameter_equiv_m"] == pytest.approx(4.0, rel=0.02)
        assert r["crown_diameter_mean_m"] == pytest.approx(4.0, rel=0.03)
        assert r["crown_ellipse_eccentricity"] < 0.2
        assert r["crown_offset_m"] < 0.05

    def test_elliptical_offset_crown(self):
        t = SyntheticTree(crown_radius_m=(3.0, 1.5), crown_offset_xy=(1.0, 0.0), crown_points=20000)
        r = _measure(t)["tree"]
        assert r["crown_ellipse_eccentricity"] == pytest.approx(math.sqrt(1 - (1.5 / 3.0) ** 2), abs=0.03)
        assert r["crown_max_width_m"] == pytest.approx(6.0, rel=0.03)
        assert r["crown_perp_width_m"] == pytest.approx(3.0, rel=0.05)
        assert r["crown_offset_m"] == pytest.approx(1.0, abs=0.05)
        assert r["crown_offset_azimuth_deg"] == pytest.approx(90.0, abs=3.0)  # +x is east

    def test_voxel_volume_counts_occupied_cubes(self):
        # A solid 1 x 1 x 1 m block sampled densely fills 1000 cubes of 0.1 m.
        g = np.stack(np.meshgrid(*(np.arange(0.05, 1.0, 0.1),) * 3, indexing="ij"), -1).reshape(-1, 3)
        out = ti._crown_metrics(g + [10, 10, 10], np.array([10.5, 10.5, 10.0]), 10.0, ti.InventoryParams())
        assert out["crown_volume_voxel_m3"] == pytest.approx(1.0)


class TestEdgeCases:
    def test_no_stem_leaves_dbh_blank(self):
        # The stem is fully occluded: only a crown shell 6-10 m above the
        # (known) ground at z = 0, so the breast-height slice is empty.
        rng = np.random.default_rng(0)
        d = rng.normal(size=(3000, 3))
        d /= np.linalg.norm(d, axis=1, keepdims=True)
        pts = d * [2, 2, 2] + [0, 0, 8]
        r = ti.measure_tree(pts, params=ti.InventoryParams(), hag=pts[:, 2].copy(), tree_id=3)["tree"]
        assert r["dbh_m"] is None and "no_stem" in r["flags"]
        assert r["basal_area_m2"] is None and r["slenderness"] is None
        assert r["height_m"] == pytest.approx(pts[:, 2].max(), abs=1e-9)
        assert r["crown_projected_area_m2"] > 0

    def test_too_few_points(self):
        r = ti.measure_tree(np.zeros((2, 3)), params=ti.InventoryParams(), tree_id=1)["tree"]
        assert r["flags"] == ["too_few_points"]

    def test_output_is_json_safe(self):
        import json
        out = _measure(SyntheticTree())
        json.dumps(out, allow_nan=False)

    def test_ground_grid_lookup_matches_brute_force(self):
        rng = np.random.default_rng(4)
        g = ti.GroundGrid(cell=0.5, radius=2.0)
        pts = np.column_stack([rng.uniform(0, 30, 20000), rng.uniform(0, 30, 20000), rng.normal(100, 1, 20000)])
        for chunk in np.array_split(pts, 5):
            g.add(chunk)
        keys = np.array(list(g._cnt.keys()), dtype=float)
        z = np.array([g._sum[k] / g._cnt[k] for k in g._cnt])
        centers = (keys + 0.5) * 0.5
        for x, y in rng.uniform(0, 30, (20, 2)):
            d = np.hypot(centers[:, 0] - x, centers[:, 1] - y)
            near = d <= 2.0
            w = 1 / np.maximum(d[near], 0.05)
            assert g(x, y) == pytest.approx(np.sum(w * z[near]) / np.sum(w))
        assert g(500.0, 500.0) is None

    def test_hag_far_away_falls_through_to_the_ground_grid(self):
        # The DEM covers only the crown, which overhangs 3 m to one side of a
        # stem past the DEM's edge: its HAG is NaN at the stem. The ground must
        # come from the ground labels, not the DEM under the distant crown.
        t = SyntheticTree(slope=(0.4, 0.0), crown_offset_xy=(3.0, 0.0), crown_radius_m=(1.5, 1.5))
        pts, hag = t.sample()
        hag = np.where(pts[:, 0] > 1.5, hag, np.nan)
        g = ti.GroundGrid()
        gx, gy = np.meshgrid(np.arange(-5, 5, 0.1), np.arange(-5, 5, 0.1))
        g.add(np.column_stack([gx.ravel(), gy.ravel(), t.ground(gx.ravel(), gy.ravel())]))
        r = ti.measure_tree(pts, params=ti.InventoryParams(), hag=hag, ground_grid=g, tree_id=1)["tree"]
        assert r["ground_source"] == "ground_class"
        assert r["stem_base"][2] == pytest.approx(t.base()[2], abs=0.03)

    def test_params_from_dict_validates(self):
        p = ti.InventoryParams.from_dict({"breast_height_m": 1.37, "fit_method": "hough", "unknown": 1})
        assert p.breast_height_m == 1.37 and p.fit_method == "hough"
        with pytest.raises(ValueError):
            ti.InventoryParams.from_dict({"fit_method": "magic"})
        for bad in ({"voxel_size_m": 0}, {"crown_gap_m": 0}, {"crown_gap_m": -1},
                    {"inlier_distance_m": float("nan")}):
            with pytest.raises(ValueError):
                ti.InventoryParams.from_dict(bad)

    def test_breast_height_setting_moves_the_slice(self):
        t = SyntheticTree(taper_m_per_m=0.05, dbh_m=0.40)
        r = _measure(t, breast_height_m=1.37)["tree"]
        assert r["dbh_m"] == pytest.approx(t.diameter_at(1.37), abs=0.003)
