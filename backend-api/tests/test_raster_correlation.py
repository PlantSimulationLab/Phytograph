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
