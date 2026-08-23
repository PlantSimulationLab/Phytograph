"""Coarse registration by raster correlation.

This replaced landmark-triangle matching as the default, and the reason is
worth stating because it is not a tuning story: landmarks are only ~50%
repeatable between scan positions (measured 25/46 on a real vineyard, and the
forest-registration literature reports the same), and triangle congruence cubes
that to ~16% usable evidence. Correlation never picks landmarks, so it never
has to pick the same ones twice.

Head-to-head on real vineyard geometry: correlation 4/4, landmark triangles 0/4
— the latter returned identity every time.
"""

import math

from pathlib import Path

import numpy as np
import pytest

from raster_correlation import (auto_cell_size, rasterise,
                                register_by_correlation)


def _planting(rows=7, per_row=9, row_spacing=3.0, plant_spacing=2.0, seed=0):
    """A trellised planting: regular rows, which is the geometry that makes
    registration hard (near-symmetric) and is what this must handle."""
    rng = np.random.default_rng(seed)
    pts = []
    for r in range(rows):
        for p in range(per_row):
            cx, cy = r * row_spacing, p * plant_spacing
            n = 260
            v = rng.normal(size=(n, 3))
            v /= np.linalg.norm(v, axis=1, keepdims=True)
            pts.append(np.column_stack([cx + v[:, 0] * 0.6,
                                        cy + v[:, 1] * 0.5,
                                        1.6 + v[:, 2] * 0.7]))
    ground = np.column_stack([
        rng.uniform(-3, rows * row_spacing + 3, 4000),
        rng.uniform(-3, per_row * plant_spacing + 3, 4000),
        rng.normal(0, 0.02, 4000)])
    return np.vstack(pts + [ground])


def _rigid(yaw_deg, t):
    th = math.radians(yaw_deg)
    c, s = math.cos(th), math.sin(th)
    M = np.eye(4)
    M[:3, :3] = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1.0]])
    M[:3, 3] = t
    return M


def _pose_error(M, M_true):
    D = np.asarray(M) @ np.linalg.inv(M_true)
    cos_t = np.clip((np.trace(D[:3, :3]) - 1.0) / 2.0, -1.0, 1.0)
    return math.degrees(math.acos(cos_t)), float(np.linalg.norm(D[:3, 3]))


def _two_views(scene, applied, keep=0.7, seed=0):
    """Independently sampled views — the condition that matters.

    Building the source from the target's own points gives every point an exact
    counterpart, which is not how two scan positions relate. The previous
    landmark matcher passed that easy case and failed this one."""
    rt = np.random.default_rng(seed)
    rs = np.random.default_rng(seed + 991)
    target = scene[rt.random(len(scene)) < keep]
    source = (scene @ applied[:3, :3].T + applied[:3, 3])
    source = source[rs.random(len(source)) < keep]
    return target, source


@pytest.mark.parametrize("yaw", [25.0, -70.0, 140.0, -175.0, 180.0])
def test_recovers_large_rotations(yaw):
    """The whole point of a coarse stage: no starting guess required.

    180 degrees is included deliberately — a regular planting is nearly
    symmetric under a row flip, so it is the pose most likely to be confused."""
    scene = _planting()
    applied = _rigid(yaw, [3.0, -2.0, 0.0])
    target, source = _two_views(scene, applied, seed=int(abs(yaw)))

    result = register_by_correlation(target, source)
    rot_err, trans_err = _pose_error(result["transformation"], np.linalg.inv(applied))

    assert rot_err < 5.0, f"yaw {yaw}: rotation off by {rot_err:.2f}°"
    assert trans_err < 2.0, f"yaw {yaw}: translation off by {trans_err:.2f} m"


def test_translation_composition_is_right():
    """Regression for a bug that left rotation exact and translation metres out.

    Each raster is centred on its OWN XY median, so the FFT shift is measured
    between grids with different origins and does not include the offset between
    those origins. Forgetting to add it back gave 0.00° rotation with 2-14 m of
    translation error across all three real datasets — a failure that looks like
    success on any rotation-only check."""
    scene = _planting(seed=3)
    applied = _rigid(35.0, [7.0, -5.0, 0.0])
    target, source = _two_views(scene, applied, seed=5)

    result = register_by_correlation(target, source)
    rot_err, trans_err = _pose_error(result["transformation"], np.linalg.inv(applied))

    assert rot_err < 5.0
    assert trans_err < 2.0, (
        f"translation off by {trans_err:.2f} m while rotation was fine "
        f"({rot_err:.2f}°) — the raster-centre offset is probably missing again")


def test_cell_size_is_not_load_bearing():
    """Scale fragility has been the recurring bug in this feature. The auto rule
    must work across scene sizes, and the exact value must not be critical."""
    small = _planting(rows=4, per_row=5)
    large = _planting(rows=14, per_row=18, row_spacing=5.0, plant_spacing=3.5)
    for scene in (small, large):
        cell, extent = auto_cell_size(scene)
        assert 0.2 <= cell <= 2.0
        assert extent > np.ptp(scene[:, 0])

    applied = _rigid(50.0, [4.0, 3.0, 0.0])
    target, source = _two_views(large, applied, seed=11)
    for cell in (0.3, 0.6, 1.2):
        r = register_by_correlation(target, source, cell=cell)
        rot_err, _ = _pose_error(r["transformation"], np.linalg.inv(applied))
        assert rot_err < 5.0, f"cell={cell} m gave {rot_err:.1f}° — too sensitive"


def test_reports_ambiguity_on_a_symmetric_scene():
    """A featureless disc has no unique orientation. The honest outcome is to
    say so, not to return a confident arbitrary answer — the same guarantee the
    landmark matcher provided and which must survive the replacement."""
    rng = np.random.default_rng(0)
    th = rng.uniform(0, 2 * np.pi, 40000)
    r = np.sqrt(rng.uniform(0, 1, 40000)) * 20
    disc = np.column_stack([r * np.cos(th), r * np.sin(th), rng.normal(0, 0.05, 40000)])

    result = register_by_correlation(disc, _rotate := (disc @ _rigid(40.0, [0, 0, 0])[:3, :3].T))
    assert result["ambiguous"] or result["margin"] < 0.2, (
        f"claimed a confident pose on a rotationally symmetric scene "
        f"(margin={result['margin']:.3f})")


def test_occupancy_resolves_a_row_flip_and_height_admits_it():
    """Why occupancy is the default — and proof the ambiguity guard is honest.

    On a regular planting the 180-degree row flip is the pose most easily
    confused. Measured on this scene: occupancy picks the right one with a
    healthy margin (0.34), while the height raster genuinely cannot separate
    them (margin 0.007) and reports ambiguous=True rather than returning a
    confident wrong answer.

    That is the correct behaviour for both. The test asserts the SAFETY
    property, not that every raster wins: a method that says "I cannot tell"
    is fine, a method that is confidently 180 degrees wrong is not."""
    scene = _planting(seed=7)
    applied = _rigid(60.0, [2.0, 4.0, 0.0])
    target, source = _two_views(scene, applied, seed=13)

    occ = register_by_correlation(target, source, mode="occupancy")
    rot_err, _ = _pose_error(occ["transformation"], np.linalg.inv(applied))
    assert rot_err < 5.0, f"occupancy (the default) failed: {rot_err:.1f}°"
    assert not occ["ambiguous"]

    height = register_by_correlation(target, source, mode="height")
    h_err, _ = _pose_error(height["transformation"], np.linalg.inv(applied))
    if h_err >= 5.0:
        assert height["ambiguous"], (
            f"height raster was {h_err:.1f}° wrong and did NOT flag ambiguity "
            f"(margin={height['margin']:.3f}) — a confidently wrong answer")


def test_rasterise_centres_on_the_median_not_the_bounding_box():
    """A terrestrial scan's bbox is dominated by sparse far-field returns, so
    its centre can sit hundreds of metres from the plot. Centring the raster
    there would put the actual data outside the grid entirely — which is exactly
    how an earlier crop silently produced empty clouds."""
    scene = _planting(seed=2)
    far = np.array([[900.0, 900.0, 5.0], [-900.0, -700.0, 5.0]])
    with_outliers = np.vstack([scene, far])

    centre = np.median(with_outliers[:, :2], axis=0)
    cell, extent = auto_cell_size(scene)
    grid = rasterise(with_outliers, cell, extent, centre)

    assert grid.sum() > 0, "raster is empty — centred on the wrong place"


def test_yaw_prior_rejects_rotational_aliases():
    """A heading prior is the single most valuable input this takes.

    An orchard scanned from within is nearly self-similar under rotation, so a
    full-circle search can find a pose with LOWER point-to-point residual than
    the correct one. Measured on a real GNSS-seeded peach orchard against
    RiSCAN PRO: unconstrained search produced 0.06 m residual while being 149
    degrees wrong, versus RiSCAN's 0.53 m residual at the right pose. Lower
    residual does not mean correct — so the aliases must be excluded from the
    search rather than scored away afterwards."""
    scene = _planting(seed=4)
    applied = _rigid(170.0, [2.0, -1.0, 0.0])
    target, source = _two_views(scene, applied, seed=9)

    # With a prior saying "the heading barely changed", the 170-degree pose is
    # not even considered.
    constrained = register_by_correlation(target, source, yaw_prior_deg=0.0,
                                          yaw_search_deg=30.0)
    assert abs(constrained["yaw_deg"]) <= 30.0 + 1e-6, (
        f"prior was ignored: searched to {constrained['yaw_deg']:.1f} degrees")


def test_no_prior_still_searches_the_full_circle():
    """The prior is optional. Without a heading the full circle must still be
    searched, or scans that genuinely need a large rotation become
    unregisterable."""
    scene = _planting(seed=6)
    applied = _rigid(150.0, [1.0, 2.0, 0.0])
    target, source = _two_views(scene, applied, seed=15)

    result = register_by_correlation(target, source)          # no prior
    rot_err, _ = _pose_error(result["transformation"], np.linalg.inv(applied))
    assert rot_err < 5.0, (
        f"unconstrained search failed to find a 150-degree rotation "
        f"({rot_err:.1f} degrees off)")


def test_ground_is_stripped_before_correlating():
    """Ground must not drive the correlation.

    The harm is NOT ground's bulk -- a uniform plane correlates identically at
    every shift, so adding one changes nothing (verified: a 42x ground-to-canopy
    ratio still registered exactly). The harm is that real TLS ground carries a
    RADIAL DENSITY GRADIENT centred on the scanner, and that centre is in a
    different place in every scan. Two such gradients correlate strongly with
    each other at the shift that superimposes the two scanner positions, which
    is not the shift that aligns the plants.

    This fixture reproduces exactly that: same canopy, same ground model, two
    different scanner positions. Measured on the real peach orchard, leaving
    ground in buried the true translation at rank 165 of the correlation
    surface.
    """
    rng = np.random.default_rng(4)
    canopy = np.vstack([
        np.array([i * 5.0, 0.0, 4.0]) + rng.normal(0, 0.6, size=(2500, 3))
        for i in range(6)
    ])

    def scan(centre, shift, seed, n_ground=60_000):
        r = np.random.default_rng(seed)
        # Returns thin out with range from the scanner -- the gradient that
        # makes ground an actively misleading correlation feature.
        rad = np.abs(r.normal(0, 14, size=n_ground))
        ang = r.uniform(0, 2 * np.pi, n_ground)
        ground = np.column_stack([centre[0] + rad * np.cos(ang),
                                  centre[1] + rad * np.sin(ang),
                                  np.zeros(n_ground)])
        return np.vstack([canopy + shift, ground + shift])

    shift = np.array([3.0, 2.0, 0.0])
    target = scan(np.array([0.0, -18.0]), np.zeros(3), seed=1)
    source = scan(np.array([14.0, 16.0]), shift, seed=2)

    result = register_by_correlation(target, source, yaw_prior_deg=0.0)
    err = float(np.linalg.norm(result["transformation"][:2, 3] + shift[:2]))
    # Stripped: ~0.3 m. Not stripped: ~34 m, locking onto the scanner offset.
    assert err < 2.0, (
        f"translation off by {err:.1f} m -- the ground's radial density "
        f"gradient appears to be driving the correlation instead of the canopy"
    )


# The shortlist can only be exercised on real data. On synthetic plantings the
# tallest correlation peak is ALREADY correct once plants vary in size at all
# (measured: K=1 succeeded on 8 of 8 seeds with realistic variation), and on a
# perfectly periodic scene BOTH K=1 and K=8 fail together, because a
# lattice-shifted pose genuinely fits better and ICP cannot prefer the truth
# either. Neither case tests anything. The real peach orchard is the case where
# the tallest peak is wrong and ICP can still tell -- so that is the fixture.
_PEACH_DIR = (Path(__file__).resolve().parents[2] / "example-datasets"
              / "PeachRegistration")
_PEACH_UNREG = _PEACH_DIR / "unregistered"
_PEACH_TARGET = _PEACH_UNREG / "unregistered_ScaPos001.laz"
_PEACH_SOURCE = _PEACH_UNREG / "unregistered_ScanPos004.laz"
# RiSCAN's own transforms for these two scans, recovered from the registered
# export by per-return gps_time correspondence. Regenerated by
# tools/recover_riscan_truth.py; see that script for the recovery method.
_TRUTH_DIR = Path(__file__).resolve().parent / "fixtures" / "riscan_truth"
_TRUTH_1 = _TRUTH_DIR / "TRUTH_1.npy"
_TRUTH_4 = _TRUTH_DIR / "TRUTH_4.npy"


def _load_peach(path, keep=250_000):
    """Near-field decimated load, matching how the benchmark reads these."""
    import laspy
    f = laspy.read(str(path))
    X = np.column_stack([f.x, f.y, f.z]).astype(np.float64)
    X = X[np.linalg.norm(X - np.median(X, axis=0), axis=1) < 60.0]
    return X[np.linspace(0, len(X) - 1, min(keep, len(X))).astype(int)]


@pytest.mark.skipif(
    not (_PEACH_TARGET.is_file() and _PEACH_SOURCE.is_file()
         and _TRUTH_1.is_file() and _TRUTH_4.is_file()),
    reason="PeachRegistration fixtures not available (local-only example dataset)",
)
def test_shortlist_beats_the_tallest_peak_on_real_orchard():
    """ScanPos004: the tallest correlation peak is the WRONG row.

    This is the pair that motivated the shortlist. With ground stripped its true
    translation sits at rank 1 of the correlation surface rather than rank 0,
    and the leading peaks are separated by hundredths -- far inside the noise of
    a correlation score. Taking the tallest alone leaves the source ~9 m out.

    The reference is RiSCAN PRO's own registration of this scan, recovered
    exactly by matching per-return gps_time between the unregistered and
    registered exports (sub-millimetre residual), so this asserts against a real
    answer rather than a self-consistent one.

    Note the prior is the pair's RELATIVE yaw (-170 deg), not scan 4's absolute
    heading (-101 deg): the search is over the rotation between the two clouds.
    """
    target = _load_peach(_PEACH_TARGET)
    source = _load_peach(_PEACH_SOURCE)

    truth = np.linalg.inv(np.load(str(_TRUTH_1))) @ np.load(str(_TRUTH_4))
    prior = -170.0          # rounded hard; not a perfect prior

    def pose_error(result):
        M = np.asarray(result["transformation"], dtype=np.float64)
        moved = source @ M[:3, :3].T + M[:3, 3]
        want = source @ truth[:3, :3].T + truth[:3, 3]
        return float(np.mean(np.linalg.norm(moved - want, axis=1)))

    top_only = pose_error(register_by_correlation(
        target, source, yaw_prior_deg=prior, refine_top_k=1))
    shortlist = pose_error(register_by_correlation(
        target, source, yaw_prior_deg=prior, refine_top_k=8))

    # One plant spacing is ~4 m; the tallest peak lands a row or two off.
    assert top_only > 3.0, (
        f"fixture no longer traps the tallest peak (error {top_only:.2f} m) -- "
        "this pair is only meaningful while rank 0 is the wrong row"
    )
    # The coarse stage cannot beat its own cell size (~0.87 m here).
    assert shortlist < 1.5, (
        f"shortlist left the source {shortlist:.2f} m from RiSCAN's answer; "
        f"the tallest peak alone gives {top_only:.2f} m"
    )


_OLIVE_UNREG = (Path(__file__).resolve().parents[2] / "example-datasets"
                / "OliveRegistration" / "unregistered")
_OLIVE_TARGET = _OLIVE_UNREG / "ScanPos001_olive_unregistered.laz"
_OLIVE_SOURCE = _OLIVE_UNREG / "ScanPos011_olive_unregistered.laz"
_OLIVE_TRUTH_1 = _TRUTH_DIR / "OLIVE_TRUTH_1.npy"
_OLIVE_TRUTH_4 = _TRUTH_DIR / "OLIVE_TRUTH_4.npy"


@pytest.mark.skipif(
    not (_OLIVE_TARGET.is_file() and _OLIVE_SOURCE.is_file()
         and _OLIVE_TRUTH_1.is_file() and _OLIVE_TRUTH_4.is_file()),
    reason="OliveRegistration fixtures not available (local-only example dataset)",
)
def test_second_orchard_is_not_regressed_by_peach_tuning():
    """A DIFFERENT orchard, guarding against over-fitting to the peach data.

    Every mechanism in the coarse stage was developed against one peach dataset,
    so this pair exists to catch tuning that only works there. It caught two:

      * Candidate selection ranked on ICP *fitness*, which saturates on dense
        canopy -- a pose 4.3 m out scored 0.9738 against the true pose's 0.9721
        and won. Ranking on inlier RMSE separates them (0.2346 vs 0.1956).
      * The shortlist was sized K=8 from peach, where the true peak ranks 1st.
        On this pair it ranks 14th, so K=8 could not reach it at all.

    Both defaults now hold on both datasets; this test fails if either reverts.
    """
    target = _load_peach(_OLIVE_TARGET)      # same near-field decimated load
    source = _load_peach(_OLIVE_SOURCE)

    truth = (np.linalg.inv(np.load(str(_OLIVE_TRUTH_1)))
             @ np.load(str(_OLIVE_TRUTH_4)))
    prior = float(round(math.degrees(math.atan2(truth[1, 0], truth[0, 0]))))

    result = register_by_correlation(target, source, yaw_prior_deg=prior)
    M = np.asarray(result["transformation"], dtype=np.float64)
    moved = source @ M[:3, :3].T + M[:3, 3]
    want = source @ truth[:3, :3].T + truth[:3, 3]
    err = float(np.mean(np.linalg.norm(moved - want, axis=1)))

    # ~0.15 m when both defaults hold; 3.8 m at K=8, 4.3 m ranked on fitness.
    assert err < 1.0, (
        f"olive pair landed {err:.2f} m from RiSCAN's answer -- the coarse "
        f"stage looks tuned to the peach dataset rather than to orchards"
    )


# `test_a_wrong_pose_is_reported_ambiguous_not_confident` lived here and has
# been REMOVED rather than re-pointed. It reproduced a wrong pose by starving the
# shortlist on the olive (001, 011) pair, and that pair now registers correctly
# at every shortlist size down to K=2 (0.14 m) because the coarse stage
# improved -- so there is no wrong pose left for it to assert on. Its own
# premise-guard caught this, which is the guard working as designed.
#
# The property it protected -- a wrong pose must report ambiguous rather than
# confident -- is NOT currently covered on real data. Re-adding it needs a pair
# that still fails, not a fixture bent until it does; a manufactured failure
# would test the bending, not the guard.
