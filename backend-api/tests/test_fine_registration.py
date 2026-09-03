"""Tests for the fine registration stage.

The property under test is not "ICP converges" -- the stage it replaced
converged too, onto a pose 3-12x worse than the one it started from. What
matters is that the fit is decided by geometry across the WHOLE scan rather
than by whatever happens to be nearest the tripod, so these exercise the
density equalisation directly and then check that a pose is recovered from a
realistic pair of scans of the same scene.
"""
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import fine_registration as fr


def _scene(rng, count=400_000):
    """Ground plus vertical structure over a 60 m plot.

    Vertical surfaces matter: ground alone constrains height and tilt but
    nothing horizontal, so a scene of ground only cannot tell a correct
    registration from one shifted sideways.
    """
    ground = np.column_stack([
        rng.uniform(-30, 30, count),
        rng.uniform(-30, 30, count),
        rng.normal(0, 0.01, count),
    ])
    posts = []
    for x, y in [(-20, -12), (-8, 14), (3, -5), (11, 18), (22, -22), (-25, 6)]:
        n = count // 12
        angle = rng.uniform(0, 2 * np.pi, n)
        posts.append(np.column_stack([
            x + 0.4 * np.cos(angle),
            y + 0.4 * np.sin(angle),
            rng.uniform(0, 4.0, n),
        ]))
    return np.vstack([ground] + posts)


def _scan_from(surface, station, rng, count=250_000):
    """Sample `surface` the way a scanner does: in ANGLE, so returns per unit
    of surface AREA fall as 1/r^2 from the station.

    Drawn with replacement and jittered, so two stations never share a point --
    real scans do not either, and a correspondence window that only worked on
    identical points would pass a test it should not.
    """
    radius = np.linalg.norm(surface - station, axis=1)
    weight = 1.0 / np.maximum(radius, 1.0) ** 2
    index = rng.choice(len(surface), count, p=weight / weight.sum())
    return surface[index] + rng.normal(0, 0.004, (count, 3))


def test_working_copy_equalises_density_across_range():
    """The whole point of voxelising instead of striding.

    A stride cap keeps the scanner's 1/r^2 sampling exactly as it found it, so
    the near field outvotes the far field at any point count. A metric voxel
    grid weights by surface AREA instead, which is what makes near and far
    geometry count alike -- and is why the near-field cut this replaced is no
    longer needed.
    """
    rng = np.random.default_rng(4)
    surface = _scene(rng)
    scan = _scan_from(surface, np.array([0.0, 0.0, 2.0]), rng)

    def near_share(points):
        r = np.linalg.norm(points[:, :2], axis=1)
        return float(np.mean(r < 8.0))

    raw = near_share(scan)
    strided = near_share(scan[np.linspace(0, len(scan) - 1, 40_000).astype(int)])
    reduced, voxel = fr.working_copy(scan, budget=40_000)

    assert raw > 0.5, "the fixture is meant to be near-field dominated"
    assert np.isclose(strided, raw, atol=0.02), (
        "a stride sample reproduces the raw density bias at any size -- if it "
        "does not, this test is no longer measuring what it claims to")
    assert near_share(reduced) < 0.5 * raw, (
        f"voxelising left {near_share(reduced):.2f} of the points inside 8 m "
        f"against {raw:.2f} raw; the near field still dominates")
    assert voxel > 0


def test_working_copy_respects_its_budget_even_past_the_voxel_ceiling():
    """The budget is a memory bound, so it outranks the voxel ceiling.

    A big enough plot still exceeds the budget at `_MAX_FINEST_VOXEL_M`; the
    voxel has to keep growing there. Stopping at the ceiling instead would let
    the fine stage allocate without limit on exactly the scans where that is
    least affordable.
    """
    rng = np.random.default_rng(5)
    scan = _scan_from(_scene(rng), np.array([0.0, 0.0, 2.0]), rng)
    reduced, voxel = fr.working_copy(scan, budget=20_000)
    assert len(reduced) <= 20_000
    assert voxel > fr._MAX_FINEST_VOXEL_M, (
        "this fixture is meant to force the voxel past the ceiling; if it no "
        "longer does, the test has stopped covering that path")


def test_plan_levels_covers_the_pull_in_range_then_tightens():
    levels = fr.plan_levels(0.05, pull_in=1.5)
    voxels = [v for v, _ in levels]
    windows = [c for _, c in levels]

    assert windows[0] >= 1.5, "the first level must be able to reach the truth"
    assert voxels == sorted(voxels, reverse=True), "levels run coarse to fine"
    assert np.isclose(voxels[-1], 0.05)
    # Geometric, factor two: each level halves the problem.
    assert all(np.isclose(a / b, 2.0) for a, b in zip(voxels, voxels[1:]))
    # The window tracks the voxel rather than the plot.
    assert all(np.isclose(c / v, fr._CORR_PER_VOXEL) for v, c in levels)


def test_plan_levels_stops_growing_at_the_level_cap():
    levels = fr.plan_levels(fr._MIN_FINEST_VOXEL_M, pull_in=10_000.0)
    assert len(levels) == fr._MAX_LEVELS


def test_align_recovers_a_known_pose_from_two_viewpoints():
    """The end-to-end property, on scans that disagree the way real ones do.

    The two stations see the same surfaces at different densities and sample
    different points, so nothing pairs exactly -- which is the situation the
    correspondence window has to survive.
    """
    rng = np.random.default_rng(7)
    surface = _scene(rng)
    target = _scan_from(surface, np.array([-6.0, -4.0, 2.0]), rng)
    source_world = _scan_from(surface, np.array([7.0, 5.0, 2.0]), rng)

    # The pose to recover: 1.2 deg of yaw and a 22 cm offset, i.e. an error far
    # larger than the accuracy being asked for.
    yaw = np.radians(1.2)
    truth = np.eye(4)
    truth[:3, :3] = np.array([[np.cos(yaw), -np.sin(yaw), 0],
                              [np.sin(yaw), np.cos(yaw), 0],
                              [0, 0, 1]])
    truth[:3, 3] = [0.18, -0.11, 0.04]
    # The source cloud as the scanner recorded it, i.e. before `truth` places it.
    source = (np.linalg.inv(truth)[:3, :3] @ source_world.T).T + np.linalg.inv(truth)[:3, 3]

    result = fr.refine(target, source, init=np.eye(4), pull_in=1.0)

    error = np.linalg.inv(truth) @ result["transformation"]
    offset = float(np.linalg.norm(error[:3, 3]))
    angle = np.degrees(np.arccos(np.clip((np.trace(error[:3, :3]) - 1) / 2, -1, 1)))
    assert result["fitness"] > 0.5
    assert offset < 0.02, f"translation off by {offset:.3f} m"
    assert angle < 0.1, f"rotation off by {angle:.3f} deg"


def test_align_leaves_the_pose_alone_when_the_clouds_do_not_overlap():
    """Zero correspondences must not be reported as a move.

    Open3D returns fitness 0.0 AND rmse 0.0 when nothing matches, which reads
    as a flawless fit; the pose it returns is meaningless. Handing that back as
    the answer is how a failed registration becomes a silently wrong one.
    """
    rng = np.random.default_rng(11)
    target = _scan_from(_scene(rng), np.array([0.0, 0.0, 2.0]), rng)
    source = target + np.array([5_000.0, 0.0, 0.0])

    init = np.eye(4)
    result = fr.refine(target, source, init=init, pull_in=1.0)

    assert result["fitness"] == 0.0
    assert np.allclose(result["transformation"], init)


def test_a_result_with_no_usable_level_is_json_safe():
    """No level ran, so there is no RMSE -- and it must not be NaN.

    This dict goes straight into a JSON response body. `json.dumps` writes a
    bare `NaN`, which the renderer's `JSON.parse` rejects outright, so a
    registration that merely failed would surface as a parse error instead of
    as the zero-fitness result the UI knows how to explain.
    """
    import json

    empty = np.empty((0, 3))
    levels = fr.plan_levels(0.05, pull_in=1.0)
    result = fr.align(fr.Pyramid(empty, levels), fr.Pyramid(empty, levels), levels)

    assert result["fitness"] == 0.0
    assert result["rmse"] == 0.0
    assert "NaN" not in json.dumps({k: v for k, v in result.items()
                                    if k != "transformation"})


def test_plane_shaped_covariances_flatten_along_the_normal():
    """The axis `_GICP_EPSILON` lands on decides what the estimator measures.

    The local covariance is flattened to diag(epsilon, 1, 1) in its own
    eigenbasis; the shrunk axis has to be the SURFACE NORMAL, the direction a
    point on that surface is not free to move in. Put it on a tangent instead
    and nothing reports an error -- the run converges, on a worse pose.
    """
    normals = np.array([[0.0, 0.0, 1.0], [1.0, 0.0, 0.0]])

    shaped = fr._plane_shaped(normals)

    for normal, matrix in zip(normals, shaped):
        values, vectors = np.linalg.eigh(matrix)
        shrunk = vectors[:, int(np.argmin(values))]
        assert np.isclose(values.min(), fr._GICP_EPSILON)
        assert np.isclose(values.max(), 1.0)
        assert abs(float(shrunk @ normal)) > 0.999, (
            f"the shrunk axis is {np.round(shrunk, 3)}, not the normal "
            f"{np.round(normal, 3)}")


def test_plane_shaped_matches_eigendecomposing_the_covariance():
    """`_plane_shaped` takes a shortcut; this pins that it IS one.

    The shipped form builds `I - (1-e) n n^T` from the normal alone. That is
    algebraically identical to eigendecomposing the local covariance and
    rebuilding it as diag(e, 1, 1) -- the eigenbasis is orthonormal, so the two
    tangent terms sum to `I - n n^T` and everything but the normal cancels.
    Identical output is the whole justification for the cheaper route, so it is
    checked rather than asserted in a comment.
    """
    rng = np.random.default_rng(21)
    covariances = np.empty((400, 3, 3))
    for i in range(len(covariances)):
        basis = np.linalg.qr(rng.normal(size=(3, 3)))[0]
        scale = np.sort(rng.uniform(1e-4, 1.0, 3))
        covariances[i] = basis @ np.diag(scale) @ basis.T

    _, vectors = np.linalg.eigh(covariances)
    long_way = (vectors @ np.diag([fr._GICP_EPSILON, 1.0, 1.0])
                @ np.swapaxes(vectors, 1, 2))
    short_way = fr._plane_shaped(vectors[:, :, 0])

    assert np.abs(long_way - short_way).max() < 1e-9


def test_supplied_covariances_mean_the_same_as_open3d_computing_them():
    """A pyramid's covariances must be interchangeable with Open3D's own.

    They are supplied rather than left to Open3D because the run re-enters the
    estimator once per iteration batch, and each entry would otherwise redo
    them. That is only sound if the two produce the same registration -- and
    the failure mode when they do not is silent: Open3D neither validates the
    shape nor raises, it just stops finding correspondences.
    """
    import open3d as o3d

    rng = np.random.default_rng(13)
    surface = _scene(rng, count=40_000)
    target = _scan_from(surface, np.array([-5.0, -3.0, 2.0]), rng, count=40_000)
    source = _scan_from(surface, np.array([6.0, 4.0, 2.0]), rng, count=40_000)

    levels = fr.plan_levels(0.2, pull_in=1.0)
    ours = fr.align(fr.Pyramid(target, levels), fr.Pyramid(source, levels), levels)

    # The same ladder, but with the covariances left for Open3D to fill in.
    transform = np.eye(4)
    for voxel, corr in levels:
        def bare(points):
            cloud = o3d.geometry.PointCloud()
            cloud.points = o3d.utility.Vector3dVector(points)
            return cloud.voxel_down_sample(voxel)

        result = o3d.pipelines.registration.registration_generalized_icp(
            bare(source), bare(target), corr, transform,
            o3d.pipelines.registration.TransformationEstimationForGeneralizedICP(),
            o3d.pipelines.registration.ICPConvergenceCriteria(
                max_iteration=fr._MAX_ITERATIONS_PER_LEVEL))
        if result.fitness > 0:
            transform = np.asarray(result.transformation)

    difference = np.linalg.inv(transform) @ ours["transformation"]
    assert ours["fitness"] > 0.5
    assert float(np.linalg.norm(difference[:3, 3])) < 0.01, (
        "supplied covariances gave a materially different pose from Open3D's")
