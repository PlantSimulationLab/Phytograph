"""Tests for the wood projection coefficient (backend-api/lad_wood.py).

These are correctness tests against known properties of the cylinder G-function,
not plumbing checks.

Key oracles:
  - A VERTICAL axis reduces to G = sin(theta_beam)/pi in closed form.
  - A SPHERICAL (random) axis distribution yields G == 0.25 at every beam zenith
    (the Cauchy/Lambert convex-body result, mean projected area = S/4).
  - Monte-Carlo integration of the definition reproduces the quadrature.
  - G is bounded in 0.236-0.282 across every achievable axis distribution, which
    is the measured basis for the fallback default being safe.

TESTING TRAP, inherited from the leaf kernel: a spherical AXIS distribution
gives G == 0.25 at EVERY beam zenith, so it is mathematically incapable of
revealing a beam-geometry bug. Every test here that exercises beam handling uses
a NON-spherical axis distribution. See
backend-api/tests/test_lad_gtheta.py and the lad_wood module docstring.
"""

import math

import numpy as np
import pytest

import lad_wood as W


# Canopy-relevant beam zeniths (radians).
BEAM_ZEN = np.radians(np.arange(5, 86, 5))

# A realistic terrestrial beam-zenith spread (mean ~66 deg), used where the
# absolute value of G matters rather than its trend.
_RNG = np.random.default_rng(0)
TLS_BEAM_ZEN = np.clip(
    np.abs(np.radians(_RNG.normal(66.6, 15.0, 600))), 1e-3, 0.5 * math.pi - 1e-3)


def _dens(name, ta):
    """de Wit-shaped densities reused as AXIS-inclination distributions."""
    two_over_pi = 2.0 / math.pi
    if name == "spherical":
        return np.sin(ta)
    if name == "planophile":      # axes mostly horizontal -> horizontal branches
        return two_over_pi * (1.0 + np.cos(2.0 * ta))
    if name == "erectophile":     # axes mostly vertical -> upright trunk
        return two_over_pi * (1.0 - np.cos(2.0 * ta))
    if name == "plagiophile":
        return two_over_pi * (1.0 - np.cos(4.0 * ta))
    raise AssertionError(name)


# ---------------------------------------------------------------------------
# Closed-form limits.
# ---------------------------------------------------------------------------
def test_vertical_axis_is_sin_over_pi():
    """A vertical cylinder's silhouette is 2rL*sin(theta), so G = sin(theta)/pi."""
    g = W.cylinder_G(BEAM_ZEN, np.array([0.0]))[:, 0]
    assert np.allclose(g, np.sin(BEAM_ZEN) / math.pi, atol=1e-12)


def test_spherical_axes_give_one_quarter_at_every_zenith():
    """Cauchy/Lambert: a convex body's mean projected area is S/4."""
    ta = W.theta_axis_grid()
    dens = _dens("spherical", ta)
    for tb in BEAM_ZEN:
        g = W.gtheta_wood_from_density(dens, ta, np.array([tb]))
        assert g == pytest.approx(0.25, abs=2e-3), f"zenith {math.degrees(tb):.0f}"


def test_default_equals_the_random_cylinder_value():
    assert W.WOOD_G_DEFAULT == pytest.approx(0.25, abs=1e-12)


def test_matches_monte_carlo_integration_of_the_definition():
    """Integrate sin(alpha)/pi by sampling azimuth directly, at NON-spherical
    axis inclinations (a spherical mix would hide a kernel bug)."""
    rng = np.random.default_rng(3)
    for tb in np.radians([5.0, 35.0, 66.0, 88.0]):
        for ta in np.radians([0.0, 20.0, 50.0, 90.0]):
            phi = rng.uniform(0, 2 * math.pi, 400_000)
            axes = np.stack([np.sin(ta) * np.cos(phi), np.sin(ta) * np.sin(phi),
                             np.full_like(phi, np.cos(ta))], axis=1)
            beam = np.array([math.sin(tb), 0.0, math.cos(tb)])
            cos_a = np.abs(axes @ beam)
            mc = float(np.mean(np.sqrt(np.clip(1 - cos_a ** 2, 0, 1))) / math.pi)
            q = W.cylinder_G(np.array([tb]), np.array([ta]))[0, 0]
            assert q == pytest.approx(mc, abs=3e-3)


# ---------------------------------------------------------------------------
# Angular signatures (these REQUIRE non-spherical axes to say anything).
# ---------------------------------------------------------------------------
def test_vertical_axis_G_rises_with_beam_zenith():
    """A nadir beam sees a vertical trunk end-on (G -> 0); a horizontal beam sees
    its full silhouette (G -> 1/pi). Strictly monotonic."""
    g = W.cylinder_G(BEAM_ZEN, np.array([0.0]))[:, 0]
    assert np.all(np.diff(g) > 0)
    assert g[0] < 0.05
    # BEAM_ZEN stops at 85 deg, so the 1/pi ceiling is approached, not reached;
    # assert the exact closed form at a true horizontal beam instead.
    assert g[-1] < 1.0 / math.pi
    horiz = W.cylinder_G(np.array([0.5 * math.pi]), np.array([0.0]))[0, 0]
    assert horiz == pytest.approx(1.0 / math.pi, abs=1e-12)


def test_horizontal_axis_G_falls_with_beam_zenith():
    """The mirror case: a horizontal branch is seen broadside from nadir."""
    g = W.cylinder_G(BEAM_ZEN, np.array([0.5 * math.pi]))[:, 0]
    assert g[0] > g[-1]
    assert g[0] == pytest.approx(1.0 / math.pi, abs=1e-3)


def test_erectophile_and_planophile_straddle_spherical():
    """Upright vs horizontal axis populations must fall either side of 0.25 at a
    terrestrial beam spread -- the signature a spherical-only test cannot see."""
    ta = W.theta_axis_grid()
    g_up = W.gtheta_wood_from_density(_dens("erectophile", ta), ta, TLS_BEAM_ZEN)
    g_flat = W.gtheta_wood_from_density(_dens("planophile", ta), ta, TLS_BEAM_ZEN)
    g_sph = W.gtheta_wood_from_density(_dens("spherical", ta), ta, TLS_BEAM_ZEN)
    assert g_up < g_sph < g_flat


# ---------------------------------------------------------------------------
# The bound that justifies the fallback default.
# ---------------------------------------------------------------------------
def test_G_is_bounded_across_every_axis_distribution():
    """Measured span is 0.236-0.282 (+-13% about 0.25). The fallback default is
    only defensible because of this bound, so the bound is pinned."""
    ta = W.theta_axis_grid()
    vals = [W.gtheta_wood_from_density(_dens(n, ta), ta, TLS_BEAM_ZEN)
            for n in ("spherical", "planophile", "erectophile", "plagiophile")]
    # The extremes are degenerate all-one-angle populations.
    vals.append(W.cylinder_G(TLS_BEAM_ZEN, np.array([0.0]))[:, 0].mean())
    vals.append(W.cylinder_G(TLS_BEAM_ZEN, np.array([0.5 * math.pi]))[:, 0].mean())
    lo, hi = min(vals), max(vals)
    assert 0.23 < lo and hi < 0.29, f"span {lo:.4f}-{hi:.4f} wider than measured"
    assert max(abs(v - 0.25) / 0.25 for v in vals) < 0.15


def test_pooling_tolerates_flipped_axes():
    """A 90-degree axis flip is the failure mode of per-voxel PCA. Pooling must
    stay within a few percent even when half the axes are flipped -- the measured
    basis for pooling rather than estimating per voxel."""
    ta = W.theta_axis_grid()
    true = np.exp(-((ta - math.radians(55)) ** 2) / (2 * math.radians(25) ** 2))
    g_true = W.gtheta_wood_from_density(true, ta, TLS_BEAM_ZEN)
    flipped = np.interp(0.5 * math.pi - ta, ta, true)
    for frac, tol in ((0.1, 0.01), (0.3, 0.02), (0.5, 0.03)):
        mix = (1 - frac) * true / true.sum() + frac * flipped / flipped.sum()
        g = W.gtheta_wood_from_density(mix, ta, TLS_BEAM_ZEN)
        assert abs(g - g_true) / g_true < tol, f"{int(frac*100)}% flipped"


# ---------------------------------------------------------------------------
# Measured-axis entry point.
# ---------------------------------------------------------------------------
def test_from_axes_matches_the_density_form():
    """Sampling axes from a distribution must agree with integrating it."""
    rng = np.random.default_rng(7)
    ta_grid = W.theta_axis_grid()
    dens = _dens("erectophile", ta_grid)
    cdf = np.cumsum(dens); cdf /= cdf[-1]
    sampled = np.interp(rng.uniform(0, 1, 40_000), cdf, ta_grid)
    g_s = W.gtheta_wood_from_axes(sampled, TLS_BEAM_ZEN)
    g_d = W.gtheta_wood_from_density(dens, ta_grid, TLS_BEAM_ZEN)
    assert g_s == pytest.approx(g_d, abs=5e-3)


def test_empty_axes_fall_back_to_the_default():
    assert W.gtheta_wood_from_axes(np.array([]), BEAM_ZEN) == W.WOOD_G_DEFAULT
    assert W.gtheta_wood_from_axes(np.radians([30.0]), np.array([])) == W.WOOD_G_DEFAULT
    assert W.gtheta_wood_from_axes(np.array([np.nan]), BEAM_ZEN) == W.WOOD_G_DEFAULT


def test_result_is_always_a_valid_gtheta():
    """The native inversion requires G in (0, 1]."""
    ta = W.theta_axis_grid()
    for n in ("spherical", "planophile", "erectophile", "plagiophile"):
        g = W.gtheta_wood_from_density(_dens(n, ta), ta, TLS_BEAM_ZEN)
        assert 0.0 < g <= 1.0


# ---------------------------------------------------------------------------
# Axis geometry helpers.
# ---------------------------------------------------------------------------
def test_axis_inclination_is_sign_invariant():
    """An axis is a line, not an arrow: +z and -z are the same inclination."""
    inc = W.axis_inclination(np.array([[0, 0, 1.0], [0, 0, -1.0],
                                       [1, 0, 0.0], [0, 0, 2.0]]))
    assert inc[0] == pytest.approx(0.0, abs=1e-12)
    assert inc[1] == pytest.approx(0.0, abs=1e-12)
    assert inc[2] == pytest.approx(0.5 * math.pi, abs=1e-12)
    assert inc[3] == pytest.approx(0.0, abs=1e-12)


def test_axis_inclination_drops_zero_length_rows():
    inc = W.axis_inclination(np.array([[0, 0, 1.0], [0, 0, 0.0], [1, 0, 0.0]]))
    assert inc.shape == (2,)


def test_hemisphere_folding_is_symmetric():
    """theta and pi-theta describe the same line for both beam and axis."""
    a = W.cylinder_G(np.array([0.7]), np.array([0.3]))[0, 0]
    b = W.cylinder_G(np.array([math.pi - 0.7]), np.array([math.pi - 0.3]))[0, 0]
    assert a == pytest.approx(b, abs=1e-12)


def test_beam_blocking_does_not_change_the_answer():
    """The kernel is evaluated in beam blocks to bound memory; blocking must be
    exactly equivalent, not approximately."""
    tb = np.linspace(0.01, 1.5, 3000)
    ta = np.linspace(0.01, 1.5, 32)
    blocked = W.cylinder_G(tb, ta)
    one_at_a_time = np.vstack([W.cylinder_G(np.array([t]), ta) for t in tb])
    assert np.array_equal(blocked, one_at_a_time)


# ===========================================================================
# Integration: the leaf/wood split on the REAL _do_lad_computation path.
#
# Driven through the real endpoint function on the committed leafcube fixture,
# not a hand-rebuilt cloud: the cull, the miss handling and the per-voxel
# binning are all part of what these assert, and a reconstruction omits them.
# ===========================================================================
import os

import main

_FIXTURE_DIR = os.path.join(os.path.dirname(__file__), "fixtures", "lad-leafcube")
_FIXTURE_XYZ = os.path.join(_FIXTURE_DIR, "leafcube.xyz")
_FIXTURE_ORIGIN = [-5.0, 0.0, 0.5]


def _wood_labelled_fixture(tmp_path, wood_prob=0.5, seed=0):
    """The leafcube with a `wood_class` column added to its HIT rows.

    Misses keep class 0 (unclassified) -- exactly what the real classifier
    produces, since it runs on hit survivors only.
    """
    d = np.loadtxt(_FIXTURE_XYZ)
    rng = np.random.default_rng(seed)
    hit = d[:, 3] == 0
    cls = np.zeros(len(d))
    cls[hit] = rng.choice([main.WOOD_CLASS_WOOD, main.WOOD_CLASS_LEAF],
                          int(hit.sum()), p=[wood_prob, 1.0 - wood_prob])
    out = tmp_path / "leafcube_wood.xyz"
    np.savetxt(out, np.column_stack([d[:, :3], d[:, 3], cls]),
               fmt="%.6f %.6f %.6f %.1f %.1f")
    return str(out)


def _run(path, fmt, *, override=False, **grid_over):
    scan = main.HeliosScanEntry(
        file_path=path, ascii_format=fmt, origin=_FIXTURE_ORIGIN,
        n_theta=2600, n_phi=5200, theta_min=0, theta_max=180,
        phi_min=0, phi_max=360, return_type="single")
    grid = main.HeliosGrid(center=[0, 0, 0.5], size=[1, 1, 1],
                           **({"nx": 1, "ny": 1, "nz": 1} | grid_over))
    kw = dict(gtheta=0.5, gtheta_override=True) if override else {}
    return main._do_lad_computation(main.LADComputeRequest(
        scans=[scan], grid=grid, lmax=0.04, max_aspect_ratio=10,
        min_voxel_hits=1, **kw))


class TestWoodSplitRealPath:
    def test_unclassified_cloud_is_untouched(self):
        """The degenerate guarantee: with no wood column the result is exactly
        what it was before wood existed, and every wood field reads None."""
        pytest.importorskip("pyhelios")
        r = _run(_FIXTURE_XYZ, "x y z is_miss")
        assert r["success"] is True, r.get("error")
        assert r["has_wood_classification"] is False
        assert r["total_wood_area"] is None and r["wood_gtheta"] is None
        c = r["cells"][0]
        assert c.get("wad") is None and c.get("wood_fraction") is None
        # The leafcube's analytic truth is LAD 2.0.
        assert c["lad"] == pytest.approx(2.0, rel=0.15)

    def test_split_conserves_the_measured_interception(self, tmp_path):
        """THE core invariant. The beams measured one interception density per
        voxel; the split may only REDISTRIBUTE it between leaf and wood, never
        create or destroy it:

            lad_leaf * G_leaf  +  wad * G_wood  ==  lad_unsplit * G_unsplit

        This is what makes the partition safe -- the inversion itself is
        untouched, so the beam bookkeeping cannot drift.
        """
        pytest.importorskip("pyhelios")
        base = _run(_FIXTURE_XYZ, "x y z is_miss")
        wood = _run(_wood_labelled_fixture(tmp_path), "x y z is_miss wood_class")
        assert wood["success"] is True, wood.get("error")
        assert wood["has_wood_classification"] is True
        b, c = base["cells"][0], wood["cells"][0]
        measured = b["lad"] * b["gtheta"]
        split = c["lad"] * c["gtheta"] + c["wad"] * wood["wood_gtheta"]
        assert split == pytest.approx(measured, rel=1e-6)

    def test_wood_fraction_matches_the_classified_returns(self, tmp_path):
        """The split is made on each voxel's classified interception counts, and
        the reported fraction must be exactly those counts."""
        pytest.importorskip("pyhelios")
        r = _run(_wood_labelled_fixture(tmp_path, wood_prob=0.25), "x y z is_miss wood_class")
        c = r["cells"][0]
        n_w, n_l = c["wood_hit_count"], c["leaf_hit_count"]
        assert n_w > 0 and n_l > 0
        assert c["wood_fraction"] == pytest.approx(n_w / (n_w + n_l), rel=1e-9)
        # 25% wood labelling must read back as roughly a quarter.
        assert 0.2 < c["wood_fraction"] < 0.3

    def test_misses_are_counted_as_neither_class(self, tmp_path):
        """A miss carries class 0 and is a TRANSMITTED beam, not an intercepted
        element. It must never enter an interception fraction -- counting it
        would drag the wood share toward zero."""
        pytest.importorskip("pyhelios")
        path = _wood_labelled_fixture(tmp_path)
        d = np.loadtxt(path)
        n_miss = int((d[:, 3] != 0).sum())
        assert n_miss > 0, "fixture must contain misses"
        assert np.all(d[d[:, 3] != 0, 4] == 0), "misses must be unclassified"
        r = _run(path, "x y z is_miss wood_class")
        c = r["cells"][0]
        # Classified returns account for the hits only, so the miss population
        # cannot have been folded in.
        assert c["wood_hit_count"] + c["leaf_hit_count"] <= int((d[:, 3] == 0).sum())

    def test_pad_is_the_sum_of_its_parts(self, tmp_path):
        pytest.importorskip("pyhelios")
        r = _run(_wood_labelled_fixture(tmp_path), "x y z is_miss wood_class")
        for c in r["cells"]:
            assert c["pad"] == pytest.approx(c["lad"] + c["wad"], rel=1e-9)

    def test_totals_match_the_per_voxel_values(self, tmp_path):
        """Reported totals must be the sum over MEASURED voxels of what each
        voxel reports -- never the pre-split Helios value."""
        pytest.importorskip("pyhelios")
        r = _run(_wood_labelled_fixture(tmp_path), "x y z is_miss wood_class", nx=4, ny=4, nz=4)
        leaf = sum(c["leaf_area"] for c in r["cells"]
                   if not c.get("under_sampled") and not c.get("lad_filled"))
        woodv = sum(c["wood_area"] for c in r["cells"]
                    if not c.get("under_sampled") and not c.get("lad_filled"))
        assert r["total_leaf_area"] == pytest.approx(leaf, rel=1e-9)
        assert r["total_wood_area"] == pytest.approx(woodv, rel=1e-9)

    def test_all_wood_puts_everything_in_wood(self, tmp_path):
        """A cloud whose every return is wood must report zero leaf area, and the
        wood area must equal the interception divided by G_wood."""
        pytest.importorskip("pyhelios")
        r = _run(_wood_labelled_fixture(tmp_path, wood_prob=1.0), "x y z is_miss wood_class")
        c = r["cells"][0]
        assert c["wood_fraction"] == pytest.approx(1.0)
        assert c["lad"] == pytest.approx(0.0, abs=1e-12)
        assert c["wad"] > 0

    def test_all_leaf_reproduces_the_unclassified_answer(self, tmp_path):
        """Labelling every return LEAF must return the original LAD exactly --
        the split is then an identity, and any drift is a bug in the algebra."""
        pytest.importorskip("pyhelios")
        base = _run(_FIXTURE_XYZ, "x y z is_miss")
        allleaf = _run(_wood_labelled_fixture(tmp_path, wood_prob=0.0),
                       "x y z is_miss wood_class")
        assert allleaf["cells"][0]["wood_fraction"] == pytest.approx(0.0)
        assert allleaf["cells"][0]["lad"] == pytest.approx(
            base["cells"][0]["lad"], rel=1e-9)
        assert allleaf["cells"][0]["wad"] == pytest.approx(0.0, abs=1e-12)

    def test_supplied_gtheta_path_blends_G_per_voxel(self, tmp_path):
        """On the supplied-G(theta) path the inversion must be given the
        interception-weighted blend, or a branch-filled voxel would be inverted
        with the leaf coefficient."""
        pytest.importorskip("pyhelios")
        r = _run(_wood_labelled_fixture(tmp_path), "x y z is_miss wood_class",
                 override=True)
        c = r["cells"][0]
        f, g_w = c["wood_fraction"], r["wood_gtheta"]
        assert c["gtheta"] == pytest.approx(f * g_w + (1 - f) * 0.5, rel=1e-6)

    def test_supplied_gtheta_path_also_conserves_interception(self, tmp_path):
        pytest.importorskip("pyhelios")
        base = _run(_FIXTURE_XYZ, "x y z is_miss", override=True)
        wood = _run(_wood_labelled_fixture(tmp_path), "x y z is_miss wood_class",
                    override=True)
        b, c = base["cells"][0], wood["cells"][0]
        assert (c["lad"] * 0.5 + c["wad"] * wood["wood_gtheta"]
                == pytest.approx(b["lad"] * b["gtheta"], rel=1e-6))

    def test_pooled_gtheta_is_reported_with_its_provenance(self, tmp_path):
        """A consumer must be able to tell a measured coefficient from the
        fallback, and how much evidence backed it."""
        pytest.importorskip("pyhelios")
        r = _run(_wood_labelled_fixture(tmp_path), "x y z is_miss wood_class")
        assert r["wood_gtheta_source"] in ("pooled", "default")
        assert 0.0 < r["wood_gtheta"] <= 1.0
        if r["wood_gtheta_source"] == "pooled":
            assert r["wood_angle_n"] > 0
        # Whatever the source, the coefficient must lie in the achievable band.
        assert 0.23 < r["wood_gtheta"] < 0.29


# ===========================================================================
# The leaf+wood fixture: the only LAD fixture whose WOOD area is known
# analytically. One scan of a combined scene (real mutual occlusion), with
# returns labelled by distance to the known tube axes -- so `wood_class` is
# exact geometry, not a classifier output whose error would be folded into the
# truth. See tests/fixtures/generate_lad_woodcube.py.
# ===========================================================================
_WOODCUBE_DIR = os.path.join(os.path.dirname(__file__), "fixtures", "lad-woodcube")
_WOODCUBE_XYZ = os.path.join(_WOODCUBE_DIR, "woodcube.xyz")

# Analytic truth, from Context.getPrimitiveArea over each population.
_WC_LEAF_AREA = 2.2500        # m^2, one-sided
_WC_WOOD_AREA = 0.7787        # m^2, total surface
_WC_VOLUME = 1.0              # the 1x1x1 m box


def _run_woodcube(**kw):
    scan = main.HeliosScanEntry(
        file_path=_WOODCUBE_XYZ, ascii_format="x y z is_miss wood_class",
        origin=[-5.0, 0.0, 0.5], n_theta=1400, n_phi=2800,
        theta_min=0, theta_max=180, phi_min=0, phi_max=360, return_type="single")
    grid = main.HeliosGrid(center=[0, 0, 0.5], size=[1, 1, 1], nx=1, ny=1, nz=1)
    return main._do_lad_computation(main.LADComputeRequest(
        scans=[scan], grid=grid, lmax=0.06, max_aspect_ratio=10,
        min_voxel_hits=1, **kw))


@pytest.mark.skipif(not os.path.exists(_WOODCUBE_XYZ),
                    reason="woodcube fixture not generated")
class TestWoodCubeFixture:
    def test_both_classes_are_present_and_misses_unclassified(self):
        """The fixture must actually exercise the split: both media sampled, and
        every miss unclassified (a miss intercepted nothing)."""
        d = np.loadtxt(_WOODCUBE_XYZ)
        hits, misses = d[d[:, 3] == 0], d[d[:, 3] != 0]
        assert (hits[:, 4] == main.WOOD_CLASS_WOOD).sum() > 100
        assert (hits[:, 4] == main.WOOD_CLASS_LEAF).sum() > 100
        assert misses.shape[0] > 100
        assert np.all(misses[:, 4] == 0), "a miss must carry no class"
        assert np.all(hits[:, 4] > 0), "every surviving hit must be classified"

    def test_recovers_both_media_in_the_right_proportion(self):
        """WAD must be a minority of PAD and the same ORDER as the truth ratio.

        The bar is deliberately a band, not an equality. The split recovers
        absolute areas for WELL-MIXED media (asserted directly in
        `test_well_mixed_media_recover_absolute_areas`); this fixture is the
        opposite extreme -- 7 solid full-height tubes among diffuse leaves --
        where each tube saturates its own footprint. What must hold HERE is that
        wood comes back as a real but minority component: a split that collapsed
        to all-leaf or ran away to all-wood would fail.
        """
        pytest.importorskip("pyhelios")
        r = _run_woodcube()
        assert r["success"] is True, r.get("error")
        c = r["cells"][0]
        assert c["lad"] > 0 and c["wad"] > 0
        true_ratio = _WC_WOOD_AREA / _WC_LEAF_AREA          # 0.346
        assert 0.3 < c["wad"] / c["lad"] < 3.0 * true_ratio
        assert 0.1 < c["wood_fraction"] < 0.5

    def test_segregated_wood_is_the_known_hard_case(self):
        """This fixture is the WORST case for the split, deliberately.

        The split attributes a voxel's interception by the share of returns in
        each class, which is an unbiased estimator of the extinction ratio when
        the two media are MIXED (see `_resolve_wood_split`). Here all the wood is
        in 7 solid full-height tubes among diffuse leaves -- maximally segregated
        -- so each tube saturates its own footprint and takes nearly every return
        there. The measured return share is 0.2555 against an extinction ratio of
        0.1475.

        That number is pinned NOT as the method's accuracy (a mixed canopy
        recovers both areas to well under 1%) but because this fixture is the
        stress case: if it MOVES, either the fixture or the attribution changed
        and someone should find out which.
        """
        d = np.loadtxt(_WOODCUBE_XYZ)
        hits = d[d[:, 3] == 0]
        observed = (hits[:, 4] == main.WOOD_CLASS_WOOD).mean()
        # Extinction ratio = projected-area ratio: wood*G_wood vs leaf*G_leaf.
        k_w, k_l = _WC_WOOD_AREA * 0.25, _WC_LEAF_AREA * 0.5
        extinction_ratio = k_w / (k_w + k_l)
        assert extinction_ratio == pytest.approx(0.1475, abs=0.005)
        assert observed == pytest.approx(0.2555, abs=0.02)

    def test_well_mixed_media_recover_absolute_areas(self):
        """THE claim the feature rests on: for a well-mixed voxel the split
        recovers each medium's area ABSOLUTELY, not merely their ratio.

        Driven as a direct simulation of the estimator rather than through a
        scan, because what is being asserted is the estimator's algebra: beams
        meet leaf and wood as competing exponential risks, so the wood share of
        stops equals k_wood/(k_leaf+k_wood), and multiplying that by the total
        extinction the inversion measured returns each density.

        If this fails, the leaf/wood split is not measuring what it claims and
        no amount of fixture tuning will fix it.
        """
        rng = np.random.default_rng(0)
        g_leaf, g_wood, dr = 0.5, W.WOOD_G_DEFAULT, 1.0
        a_leaf_true, a_wood_true = 2.0, 0.6
        k_leaf, k_wood = a_leaf_true * g_leaf, a_wood_true * g_wood

        n = 400_000
        t_leaf = rng.exponential(1.0 / k_leaf, n)
        t_wood = rng.exponential(1.0 / k_wood, n)
        stopped = np.minimum(t_leaf, t_wood) < dr
        assert stopped.sum() > 1000

        # What the pipeline measures per voxel.
        f_wood = ((t_wood < t_leaf) & stopped).sum() / stopped.sum()
        k_total = -np.log(1.0 - stopped.mean()) / dr

        # The same algebra `_do_lad_computation` applies to each cell.
        a_wood = f_wood * k_total / g_wood
        a_leaf = (1.0 - f_wood) * k_total / g_leaf
        assert a_wood == pytest.approx(a_wood_true, rel=0.03)
        assert a_leaf == pytest.approx(a_leaf_true, rel=0.03)

    def test_leaf_density_is_the_right_order(self):
        """The leaf side must stay physically sensible -- the split must not
        destroy the quantity the tool has always reported."""
        pytest.importorskip("pyhelios")
        r = _run_woodcube()
        lad = r["cells"][0]["lad"]
        assert 0.3 * (_WC_LEAF_AREA / _WC_VOLUME) < lad < 1.5 * (_WC_LEAF_AREA / _WC_VOLUME)

    def test_vertical_trunks_raise_G_wood_above_the_default(self):
        """The fixture's wood is ALL VERTICAL, whose true G at a terrestrial beam
        spread is ~0.28, above the randomly-oriented default of 0.25. The pooled
        estimator must detect that -- if it silently fell back to the default,
        this is the test that says so.
        """
        pytest.importorskip("pyhelios")
        r = _run_woodcube()
        assert r["wood_gtheta_source"] == "pooled", r.get("warnings")
        assert r["wood_gtheta"] > W.WOOD_G_DEFAULT
        assert 0.26 < r["wood_gtheta"] < 0.30

    def test_totals_and_summary_agree_on_the_fixture(self):
        """The reported totals must equal the per-voxel values, and the exported
        summary must agree with both (LAI + WAI = PAI)."""
        pytest.importorskip("pyhelios")
        r = _run_woodcube()
        c = r["cells"][0]
        assert r["total_leaf_area"] == pytest.approx(c["leaf_area"], rel=1e-9)
        assert r["total_wood_area"] == pytest.approx(c["wood_area"], rel=1e-9)
        cell = main.LADExportCell(
            center=c["center"], size=c["size"], lad=c["lad"],
            leaf_area=c["leaf_area"], gtheta=c["gtheta"], hit_count=c["hit_count"],
            wad=c["wad"], wood_area=c["wood_area"], pad=c["pad"],
            wood_fraction=c["wood_fraction"], solved=True)
        txt = main._lad_statistics_bytes(main.LADExportRequest(
            format="txt", cells=[cell], nx=1, ny=1, nz=1, origin=[-0.5, -0.5, 0.0],
            cell_size=[1, 1, 1])).decode()
        vals = {ln.rsplit(" ", 1)[0]: float(ln.rsplit(" ", 1)[1])
                for ln in txt.splitlines() if ln.split(" ")[0] in ("LAI", "WAI", "PAI")}
        assert vals["PAI"] == pytest.approx(vals["LAI"] + vals["WAI"], abs=1e-3)
        assert vals["WAI"] > 0
