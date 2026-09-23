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


def test_a_level_costs_one_open3d_call():
    """The cost that actually drives this stage is CALLS, not iterations.

    Open3D deep-copies both clouds on entry to `registration_generalized_icp`,
    so every extra call is ~1.13 s at the finest level against 0.35 s for an
    extra iteration. A level that has converged must therefore not be split
    across several calls to notice -- measured, doing exactly that (batch=1)
    ran SLOWER than the unoptimised original.

    Counts the real calls into Open3D rather than reading the constant, so it
    fails if `align`'s loop is restructured in a way that reintroduces the
    per-call cost by another route.
    """
    import open3d as o3d

    rng = np.random.default_rng(29)
    surface = _scene(rng, count=40_000)
    target = _scan_from(surface, np.array([-5.0, -3.0, 2.0]), rng, count=40_000)
    source = _scan_from(surface, np.array([6.0, 4.0, 2.0]), rng, count=40_000)

    calls = {"n": 0}
    real = o3d.pipelines.registration.registration_generalized_icp

    def counting(*args, **kwargs):
        calls["n"] += 1
        return real(*args, **kwargs)

    levels = fr.plan_levels(0.2, pull_in=1.0)
    o3d.pipelines.registration.registration_generalized_icp = counting
    try:
        outcome = fr.align(fr.Pyramid(target, levels), fr.Pyramid(source, levels),
                           levels, init=np.eye(4))
    finally:
        o3d.pipelines.registration.registration_generalized_icp = real

    assert outcome["fitness"] > 0.5, "the fit failed; the count means nothing"
    assert calls["n"] <= len(levels), (
        f"{calls['n']} Open3D calls for {len(levels)} levels -- each one "
        "deep-copies both clouds, so a level must converge inside a single "
        "call. Was _ITERATION_BATCH lowered below the per-level cap?")


def test_the_iteration_budget_costs_one_call_per_level():
    """Both constants are measurements, and the BATCH is the counter-intuitive
    one -- see the table in `_ITERATION_BATCH`.

    Open3D deep-copies both clouds per call (1.13 s at the finest level against
    0.35 s per iteration), so a level's cost has a per-CALL term as well as a
    per-iteration one. Shrinking the batch to make convergence fire earlier
    cuts iterations and RAISES calls, and measured end to end that was slower
    than the 40-iteration original it replaced. What wins is one call per
    level.

    Asserted as calls-per-level rather than as literal values, because that is
    the property; the numbers may move again.
    """
    assert fr._MAX_ITERATIONS_PER_LEVEL <= 8, (
        "measured: a level's pose stops moving after ~5 iterations")
    assert fr._ITERATION_BATCH >= fr._MAX_ITERATIONS_PER_LEVEL, (
        "a converged level must cost ONE call -- a smaller batch trades "
        "0.35 s/iteration of work for 1.13 s/call of Open3D deep-copy "
        "overhead, which measured SLOWER than doing nothing at all")


def test_trim_to_anchor_drops_only_detail_the_ladder_cannot_read():
    """The working copy must not be finer than the ladder's finest level.

    `working_copy` reduces per scan; `plan_levels` anchors at the WIDEST voxel
    in the set. On a heterogeneous set the dense scans therefore carry roughly
    twice the points any level will ever read -- the pyramid's own first
    downsample merges them away. Trimming first must (a) actually reduce a
    finer copy, (b) leave a copy already at the anchor alone, and (c) not
    change what the pyramid ends up holding.
    """
    rng = np.random.default_rng(31)
    surface = _scene(rng, count=60_000)
    dense = _scan_from(surface, np.array([0.0, 0.0, 2.0]), rng, count=60_000)

    fine, coarse = 0.05, 0.20
    on_fine_grid, _ = fr.working_copy(dense)
    trimmed = fr.trim_to_anchor(on_fine_grid, fine, coarse)
    assert len(trimmed) < len(on_fine_grid) * 0.75, (
        "trimming a 0.05 m copy to a 0.20 m anchor barely reduced it")

    # Already at the anchor: untouched, and the SAME ARRAY, since re-gridding
    # would shift points to new cell centroids for no gain.
    at_anchor = fr.trim_to_anchor(on_fine_grid, coarse, coarse)
    assert at_anchor is on_fine_grid

    # The pyramid is what consumes this, and it must not notice the trim.
    levels = fr.plan_levels(coarse, pull_in=0.6)
    assert fr.Pyramid(trimmed, levels).sizes == fr.Pyramid(on_fine_grid,
                                                           levels).sizes, (
        "trimming changed what the pyramid holds -- it must only remove points "
        "the pyramid's own downsample would have merged")


def test_voxel_centroids_match_open3d_exactly():
    """The numpy downsample exists to release the GIL, not to change the
    answer: same cells, same centroids as Open3D's, only the row order may
    differ."""
    import open3d as o3d

    rng = np.random.default_rng(3)
    pts = _scene(rng, count=120_000)
    for voxel in (0.05, 0.2, 0.73):
        mine = fr.voxel_centroids(pts, voxel)
        pc = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(pts))
        theirs = np.asarray(pc.voxel_down_sample(voxel).points)
        assert len(mine) == len(theirs)
        a = mine[np.lexsort(mine.T)]
        b = theirs[np.lexsort(theirs.T)]
        np.testing.assert_allclose(a, b, rtol=0, atol=1e-9)


def test_occupied_voxel_count_predicts_the_downsample_length():
    """`working_copy` searches its voxel by COUNTING rather than downsampling;
    the count is only a valid stand-in if it is the downsample's length."""
    rng = np.random.default_rng(4)
    pts = _scene(rng, count=120_000)
    for voxel in (0.03, 0.11, 0.4):
        assert (fr._occupied_voxels(pts, voxel, pts.min(axis=0))
                == len(fr.voxel_centroids(pts, voxel)))


def test_working_copy_search_lands_under_budget_on_volumetric_cover():
    """Vegetation fills volume, so occupancy falls slower than 1/voxel^2 and
    the old sqrt step undershot for several passes. The measured-exponent
    search must still land inside the budget, and not far under it."""
    rng = np.random.default_rng(5)
    canopy = rng.uniform([-10, -10, 0], [10, 10, 4], size=(600_000, 3))
    budget = 60_000
    pts, voxel = fr.working_copy(canopy, budget=budget)
    assert len(pts) <= budget
    assert len(pts) > 0.6 * budget
    assert len(pts) == len(fr.voxel_centroids(canopy, voxel))


def test_median_spacing_block_subset_tracks_the_full_cloud(monkeypatch):
    """Above the size threshold the spacing probe measures whole columns of the
    cloud rather than all of it; the answer must stay close to the full one."""
    rng = np.random.default_rng(6)
    pts = _scene(rng, count=400_000)
    monkeypatch.setattr(fr, "_SPACING_BLOCK_MIN_POINTS", 10 ** 12)
    full = fr.median_spacing(pts)
    monkeypatch.setattr(fr, "_SPACING_BLOCK_MIN_POINTS", 1000)
    subset = fr.median_spacing(pts)
    assert abs(subset - full) / full < 0.10


def test_pyramid_skips_only_a_redundant_finest_pass():
    """`gridded_at` lets a caller whose points already sit on the finest grid
    skip re-voxelising them. The levels must match an unskipped build to
    within the handful of cells a second centroid pass merges."""
    rng = np.random.default_rng(7)
    pts = _scene(rng, count=200_000)
    levels = fr.plan_levels(0.1, 0.6)
    gridded = fr.voxel_centroids(pts, levels[-1][0])
    plain = fr.Pyramid(gridded, levels).sizes
    skipped = fr.Pyramid(gridded, levels, gridded_at=levels[-1][0]).sizes
    assert skipped[-1] == len(gridded)
    for a, b in zip(plain, skipped):
        assert abs(a - b) <= 0.01 * b


def test_pyramid_feed_hands_over_in_order_and_bounds_what_it_holds():
    import threading
    import time

    built, live = [], []
    lock = threading.Lock()

    def build(k):
        with lock:
            built.append(k)
            live.append(k)
            assert len(live) <= 3
        return f"pyramid-{k}"

    feed = fr.PyramidFeed(build, [2, 0, 1, 3, 4], ahead=3)
    try:
        assert feed.take(2) == "pyramid-2"          # held, never released
        for k in [0, 1, 3, 4]:
            assert feed.take(k) == f"pyramid-{k}"
            with lock:
                live.remove(k)
            feed.release()
        assert built == [2, 0, 1, 3, 4]
    finally:
        feed.close()

    # A builder failure surfaces to the consumer instead of hanging it.
    def boom(k):
        raise MemoryError("no room")

    bad = fr.PyramidFeed(boom, [0, 1], ahead=2)
    with pytest.raises(MemoryError):
        bad.take(0)
    bad.close()

    # Closing while the builder is parked on a full window lets it exit.
    parked = fr.PyramidFeed(lambda k: k, [0, 1, 2, 3], ahead=1)
    assert parked.take(0) == 0
    parked.close()
    parked._thread.join(timeout=5)
    assert not parked._thread.is_alive()


# --- surface pyramid (per-voxel moments) -------------------------------------


def test_voxel_moments_match_a_direct_per_voxel_computation():
    rng = np.random.default_rng(21)
    pts = rng.normal(0, 1.0, (20_000, 3)) * [3.0, 2.0, 0.5] + [120.0, -40.0, 8.0]
    voxel = 0.7
    m = fr.VoxelMoments.from_points(pts, voxel)
    key = fr._voxel_keys(pts, voxel, pts.min(axis=0))
    _, inverse = np.unique(key, return_inverse=True)
    inverse = inverse.ravel()
    assert len(m) == inverse.max() + 1
    assert m.n.sum() == len(pts)
    # Check a spread of voxels against numpy's own mean / covariance.
    order = np.argsort(m.mean[:, 0])
    for v in order[:: max(1, len(order) // 25)]:
        # Voxel ids from from_points are in sorted-key order, as are np.unique's.
        members = pts[inverse == v]
        assert len(members) == m.n[v]
        np.testing.assert_allclose(m.mean[v], members.mean(axis=0), atol=1e-9)
        if len(members) > 1:
            c = np.cov(members.T, bias=True)
            got = m.cov[v]
            np.testing.assert_allclose(
                got, [c[0, 0], c[1, 1], c[2, 2], c[0, 1], c[1, 2], c[0, 2]],
                rtol=1e-5, atol=1e-7)


def test_regridding_moments_conserves_mass_mean_and_spread():
    """Coarser levels are built from moments alone; merging must be exact, or
    every normal above the finest level is fitted to the wrong spread."""
    rng = np.random.default_rng(22)
    pts = _scene(rng, count=60_000)
    fine = fr.VoxelMoments.from_points(pts, 0.05)
    for voxel in (0.1, 0.4, 1000.0):
        coarse, parent = fine.regrid(voxel)
        assert coarse.n.sum() == len(pts)
        assert parent.shape == (len(fine),)
        whole = coarse.regrid(1e6)[0]            # everything in one cell
        assert len(whole) == 1
        np.testing.assert_allclose(whole.mean[0], pts.mean(axis=0), atol=1e-9)
        c = np.cov(pts.T, bias=True)
        np.testing.assert_allclose(
            whole.cov[0], [c[0, 0], c[1, 1], c[2, 2], c[0, 1], c[1, 2], c[0, 2]],
            rtol=1e-4, atol=1e-6)


def test_closed_form_eigen_matches_numpy():
    rng = np.random.default_rng(23)
    A = rng.normal(size=(5000, 3, 3))
    C = A @ np.transpose(A, (0, 2, 1))
    C[:100] = np.diag([1.0, 1.0, 1e-6])            # near-perfect planes
    six = np.stack([C[:, 0, 0], C[:, 1, 1], C[:, 2, 2],
                    C[:, 0, 1], C[:, 1, 2], C[:, 0, 2]], axis=1)
    vec, variation = fr._smallest_eigen(six)
    w, V = np.linalg.eigh(C)
    dot = np.abs((vec * V[:, :, 0]).sum(axis=1))
    assert np.all(dot > 1 - 1e-6)
    np.testing.assert_allclose(variation, w[:, 0] / w.sum(axis=1), atol=1e-9)
    assert np.all(variation[:100] < 1e-5)


def test_surface_pyramid_trusts_planes_and_matches_thin_foliage_point_to_point():
    """A dense flat sheet is fitted as a plane; a sparse volumetric scatter --
    one return per voxel, like far-field canopy -- gets no plane at all."""
    rng = np.random.default_rng(24)
    sheet = np.column_stack([rng.uniform(0, 4, 80_000), rng.uniform(0, 4, 80_000),
                             rng.normal(0, 0.002, 80_000)])
    blob = rng.uniform([10, 10, 0], [14, 14, 4], (3_000, 3))
    m = fr.VoxelMoments.from_points(np.vstack([sheet, blob]), 0.1)
    levels = fr.plan_levels(0.1, 0.5)
    pyramid = fr.SurfacePyramid(m, levels)
    finest = pyramid.level(len(levels) - 1)
    pts = np.asarray(finest.points)
    cov = np.asarray(finest.covariances)
    on_sheet = pts[:, 0] < 5
    # Plane-shaped with a vertical normal on the sheet...
    normal_var = cov[on_sheet][:, 2, 2]
    assert np.median(normal_var) < 0.01
    # ...isotropic in the scatter.
    blob_cov = cov[~on_sheet]
    iso = np.all(np.abs(blob_cov - np.eye(3)) < 1e-9, axis=(1, 2))
    assert iso.mean() > 0.9
    assert pyramid.sizes == [len(pyramid.level(i).points) for i in range(len(levels))]


def test_surface_pyramid_recovers_a_known_pose_from_two_viewpoints():
    """The same end-to-end check `align` has for `Pyramid`, on the surface
    pyramid the multi-scan stage uses."""
    rng = np.random.default_rng(7)
    surface = _scene(rng)
    target = _scan_from(surface, np.array([-6.0, -4.0, 2.0]), rng)
    source_world = _scan_from(surface, np.array([7.0, 5.0, 2.0]), rng)
    yaw = np.radians(1.2)
    truth = np.eye(4)
    truth[:3, :3] = np.array([[np.cos(yaw), -np.sin(yaw), 0],
                              [np.sin(yaw), np.cos(yaw), 0],
                              [0, 0, 1]])
    truth[:3, 3] = [0.18, -0.11, 0.04]
    inv = np.linalg.inv(truth)
    source = source_world @ inv[:3, :3].T + inv[:3, 3]

    tm, tv = fr.surface_moments(target)
    sm, sv = fr.surface_moments(source)
    levels = fr.plan_levels(max(tv, sv), 1.0)
    result = fr.align(fr.SurfacePyramid(tm, levels), fr.SurfacePyramid(sm, levels),
                      levels, init=np.eye(4))
    error = inv @ result["transformation"]
    offset = float(np.linalg.norm(error[:3, 3]))
    angle = np.degrees(np.arccos(np.clip((np.trace(error[:3, :3]) - 1) / 2, -1, 1)))
    assert result["fitness"] > 0.5
    assert offset < 0.02, f"translation off by {offset:.3f} m"
    assert angle < 0.1, f"rotation off by {angle:.3f} deg"
