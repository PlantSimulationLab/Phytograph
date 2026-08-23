"""Plane-patch extraction and the plane-to-plane solve.

The properties worth pinning are the ones that differ from point-to-point ICP:
patches must be found on FOLIAGE (not just flat ground), correspondences must be
gated on orientation as well as proximity, and the residual must be measured
along the normal rather than between patch centres.
"""

import math

import numpy as np
import pytest

import plane_patches as pp


def _rot_z(deg):
    th = math.radians(deg)
    c, s = math.cos(th), math.sin(th)
    M = np.eye(4)
    M[:2, :2] = [[c, -s], [s, c]]
    return M


def _rigid(deg, t):
    M = _rot_z(deg)
    M[:3, 3] = t
    return M


def _ground(extent=12.0, step=0.05, seed=0):
    """A flat plane with scanner-scale noise."""
    rng = np.random.default_rng(seed)
    g = np.arange(-extent, extent, step)
    x, y = np.meshgrid(g, g)
    pts = np.column_stack([x.ravel(), y.ravel(), np.zeros(x.size)])
    return pts + rng.normal(0, 0.004, pts.shape)


def _canopy(n_plants=9, per_plant=40000, seed=1):
    """Foliage: no large planar surface anywhere in it.

    Density matters and has to be scan-realistic. A terrestrial scan of this
    plot has ~0.011 m between neighbouring returns; an earlier version of this
    fixture was 6x sparser at 0.066 m, and produced 60 patches against a real
    scan's 5,839 -- not because extraction was wrong, but because a cube of the
    minimum size rarely held enough points to fit a plane to. Testing patch
    extraction on a cloud that thin measures the fixture, not the filter.
    """
    rng = np.random.default_rng(seed)
    out = []
    for i in range(n_plants):
        centre = np.array([(i % 3) * 4.0, (i // 3) * 4.0, 2.5])
        out.append(centre + rng.normal(0, 0.5, size=(per_plant, 3)))
    return np.vstack(out)


def test_patches_are_found_on_foliage_not_only_flat_ground():
    """Subdivision finds planes where a fixed-radius planarity test does not.

    The filter does not ask "is this neighbourhood planar" -- it shrinks the
    cube until the answer is yes. That distinction is the whole reason patches
    work on vegetation, and an earlier analysis that tested fixed-radius
    neighbourhoods concluded (wrongly) that canopy yields almost nothing.
    """
    canopy = _canopy()
    centres, normals = pp.extract(canopy)

    assert len(centres) > 100, "foliage produced almost no patches"
    per_1k = 1000 * len(centres) / len(canopy)
    assert per_1k > 5, f"only {per_1k:.1f} patches per 1000 points of canopy"
    # Unit normals, or the orientation gate is meaningless.
    assert np.allclose(np.linalg.norm(normals, axis=1), 1.0, atol=1e-9)


def test_canopy_normals_are_varied_where_ground_normals_are_not():
    """Orientation diversity is what lets patches constrain yaw and xy.

    A ground plane gives near-vertical normals everywhere, which pins z, roll
    and pitch and nothing else. Foliage gives varied normals, so the gate can
    discriminate between poses that differ horizontally.
    """
    _, ground_n = pp.extract(_ground())
    _, canopy_n = pp.extract(_canopy())

    ground_vertical = np.mean(np.abs(ground_n[:, 2]) > 0.9)
    canopy_vertical = np.mean(np.abs(canopy_n[:, 2]) > 0.9)
    assert ground_vertical > 0.8, f"ground normals not vertical ({ground_vertical:.2f})"
    assert canopy_vertical < 0.5, f"canopy normals too uniform ({canopy_vertical:.2f})"


def test_recovers_a_known_rigid_transform():
    scene = np.vstack([_canopy(), _ground(extent=8.0, step=0.08)])
    applied = _rigid(4.0, [0.8, -0.5, 0.05])
    moved = scene @ applied[:3, :3].T + applied[:3, 3]

    ct, nt = pp.extract(scene)
    cs, ns = pp.extract(moved)
    result = pp.align(ct, nt, cs, ns)

    assert result["pairs"] > 50, f"only {result['pairs']} correspondences"
    M = result["transformation"]
    inverse = np.linalg.inv(applied)
    err = float(np.mean(np.linalg.norm(
        (moved @ M[:3, :3].T + M[:3, 3]) - (moved @ inverse[:3, :3].T + inverse[:3, 3]),
        axis=1)))
    assert err < 0.15, f"recovered pose is {err:.3f} m from the applied transform"


def test_the_residual_is_measured_along_the_normal_not_between_centres():
    """Two scans subdivide independently, so patch centres do not coincide.

    Sliding a plane WITHIN itself moves every patch centre while leaving every
    point on the same surface. A centre-to-centre residual counts that as error;
    the along-normal residual correctly reports zero. Measured on real scans,
    centre matching found partners for only 3.9% of patches at the known-correct
    pose, which is what made an earlier attempt look like a failure.
    """
    plane = _ground(extent=10.0, step=0.05, seed=3)
    centres, normals = pp.extract(plane)
    assert len(centres) > 50

    # Slide 1.5 m along the surface: geometrically identical, centres all moved.
    slid = np.eye(4)
    slid[0, 3] = 1.5
    src, tgt = pp._pairs(centres, normals, centres, normals, slid)
    assert len(src) > 20, "sliding within the plane destroyed all correspondences"

    moved = centres[src] + slid[:3, 3]
    along_normal = np.abs(np.einsum('ij,ij->i', normals[tgt], centres[tgt] - moved))
    between_centres = np.linalg.norm(centres[tgt] - moved, axis=1)

    # The assertion is the RATIO, not an absolute distance. Patches tile the
    # plane densely, so the nearest partner after sliding sits ~0.09 m away
    # rather than the full 1.5 m -- an absolute threshold would just be a
    # statement about patch spacing. What matters is that the along-normal
    # residual is near zero while the centre distance is not.
    assert np.median(along_normal) < 0.02, "along-normal residual should be ~0"
    assert np.median(between_centres) > 10 * np.median(along_normal), (
        f"centre distance {np.median(between_centres):.4f} m is not meaningfully "
        f"larger than the along-normal residual {np.median(along_normal):.4f} m")


def test_correspondences_require_orientation_agreement():
    """Proximity alone pairs a floor with a wall.

    Build two surfaces that touch but are perpendicular. Every wall patch has a
    floor patch nearby, so a distance-only gate pairs them; the tilt gate must
    not.
    """
    rng = np.random.default_rng(5)
    floor = np.column_stack([rng.uniform(0, 4, 60000), rng.uniform(0, 4, 60000),
                             np.zeros(60000)])
    wall = np.column_stack([rng.uniform(0, 4, 60000), np.zeros(60000),
                            rng.uniform(0, 4, 60000)])
    fc, fn = pp.extract(floor + rng.normal(0, 0.003, floor.shape))
    wc, wn = pp.extract(wall + rng.normal(0, 0.003, wall.shape))
    assert len(fc) > 20 and len(wc) > 20

    identity = np.eye(4)
    loose = pp._pairs(fc, fn, wc, wn, identity, radius=1.0, max_tilt_deg=90.0)
    gated = pp._pairs(fc, fn, wc, wn, identity, radius=1.0, max_tilt_deg=20.0)
    assert len(loose[0]) > 0, "fixture produced no nearby pairs at all"
    assert len(gated[0]) < 0.25 * len(loose[0]), (
        f"tilt gate kept {len(gated[0])} of {len(loose[0])} floor/wall pairs")


def test_reports_failure_rather_than_a_confident_wrong_pose():
    """Too few patches to solve six unknowns must not return a fitted pose."""
    tiny = np.random.default_rng(0).normal(0, 1, size=(20, 3))
    ct, nt = pp.extract(tiny)
    result = pp.align(ct, nt, ct, nt)
    assert not result["converged"]
    assert np.allclose(result["transformation"], np.eye(4))


def test_a_cube_spanning_two_surfaces_is_subdivided_not_accepted():
    """Subdivision is the mechanism, and it has to actually run.

    A top-level cube straddling a corner contains two perpendicular faces. Fit
    one plane to all of it and you get a meaningless normal averaging the two --
    and the patch then pulls the solve toward a surface that does not exist.
    The filter must split until each face is fitted separately, which shows up
    as BOTH a horizontal and a vertical family of normals.
    """
    rng = np.random.default_rng(7)
    n = 40000
    span = 0.4                      # smaller than one max cube, so it straddles
    floor = np.column_stack([rng.uniform(0, span, n), rng.uniform(0, span, n),
                             np.zeros(n)])
    wall = np.column_stack([rng.uniform(0, span, n), np.zeros(n),
                            rng.uniform(0, span, n)])
    corner = np.vstack([floor, wall]) + rng.normal(0, 0.002, (2 * n, 3))

    _, normals = pp.extract(corner)
    assert len(normals) > 10, "corner produced too few patches to judge"

    vertical_component = np.abs(normals[:, 2])
    horizontal_faces = float(np.mean(vertical_component > 0.9))
    vertical_faces = float(np.mean(vertical_component < 0.1))
    assert horizontal_faces > 0.15, (
        f"only {horizontal_faces:.2f} of normals are horizontal-surface -- the "
        "floor was not fitted separately")
    assert vertical_faces > 0.15, (
        f"only {vertical_faces:.2f} of normals are vertical-surface -- the wall "
        "was not fitted separately")
