"""ICP must not report a total failure as a flawless alignment.

When ICP finds ZERO correspondences, Open3D returns fitness=0.0 *and*
inlier_rmse=0.0. That zero RMSE then sails through both of the guards that are
supposed to catch a bad fit:

  * `run_icp_until_convergence`'s plateau test sees 0.0 - 0.0 = 0.0 improvement
    and declares "converged";
  * `_icp_quality` divides that 0.0 by the cloud extent, gets a 0% error ratio,
    and stays silent because it is far below the 2% warning threshold.

So a registration that matched nothing at all was presented to the user as a
perfect result. These tests pin the fix.
"""

import numpy as np
import pytest

import main


def _blob(n=400, scale=0.02, seed=0):
    return np.random.default_rng(seed).normal(0.0, scale, (n, 3))


def _row(n_plants=3, spacing=4.0, seed=1):
    """A few separated clumps spanning several metres."""
    rng = np.random.default_rng(seed)
    out = []
    for i in range(n_plants):
        out.append(np.column_stack([
            i * spacing + rng.normal(0, 0.3, 200),
            rng.normal(0, 0.3, 200),
            rng.uniform(0, 3.0, 200),
        ]))
    return np.vstack(out)


def _ring(n_per=200, n_clumps=8, radius=5.0, seed=1):
    """Clumps arranged on a circle — a plot perimeter.

    The shape is the whole point: the centroid of a ring is EMPTY. Centroid
    pre-alignment therefore drops the source into the hole in the middle,
    `radius` away from every target point, so no correspondence can exist at any
    window this code would choose.

    A ROW cannot do that, which is what made the earlier version of this test
    wrong. Its centroid sits inside the middle clump, so the pre-aligned blob
    landed ~0.15 m from real target points against a 0.51 m window — every
    source point matched, and `fitness == 1.0` was the CORRECT answer. The test
    demanded 0.0 and passed on macOS only because point-to-plane ICP was
    diverging there on the degenerate normals of an isotropic Gaussian blob; on
    Linux it reported the truth and the test failed. Zero correspondence has to
    come from the geometry, not from an alignment that happens to fall over.
    """
    rng = np.random.default_rng(seed)
    out = []
    for i in range(n_clumps):
        theta = 2 * np.pi * i / n_clumps
        out.append(np.column_stack([
            radius * np.cos(theta) + rng.normal(0, 0.3, n_per),
            radius * np.sin(theta) + rng.normal(0, 0.3, n_per),
            rng.uniform(0, 3.0, n_per),
        ]))
    return np.vstack(out)


def _correspondence_gap(target, source):
    """(nearest-neighbour distance after centroid pre-alignment, ICP's window).

    Derived from the PRODUCTION helpers rather than hardcoded, so a change to
    the correspondence rule surfaces here as a failed precondition carrying real
    numbers, instead of quietly putting this test back on the knife edge it was
    on before.
    """
    from scipy.spatial import cKDTree

    diagonal = main._robust_cloud_diagonal(target)
    window = main._auto_correspondence_distance(target, diagonal)
    aligned = source + (target.mean(axis=0) - source.mean(axis=0))
    return float(cKDTree(target).query(aligned)[0].min()), float(window)


def test_quality_flags_zero_fitness_despite_zero_rmse():
    """The unit-level contract: rmse=0 with fitness=0 is a FAILURE, not a
    perfect fit. Without the fitness argument the same numbers must stay silent,
    because rmse=0 legitimately means 'identical clouds' when points did match."""
    ratio, warning = _icp = main._icp_quality(0.0, 10.0, 0.0)
    assert warning, "zero-fitness result produced no warning"
    assert "no overlapping points" in warning.lower()

    # A genuine perfect fit (points coincide AND correspondences were found).
    _, warning_ok = main._icp_quality(0.0, 10.0, 1.0)
    assert warning_ok is None, "a real perfect fit must not warn"


def test_c2c_does_not_report_success_when_nothing_corresponds():
    """End-to-end through the worker.

    A pure translation will NOT trigger this: the centroid pre-alignment slides
    the source straight onto the target and ICP legitimately succeeds. The
    trigger is a pair whose shapes cannot correspond once their centroids
    coincide — here a 10 m ring of clumps against a 2 cm blob, which leaves the
    blob stranded in the empty middle (see `_ring` for why a row does not work).
    """
    target = _ring()
    source = _blob()

    # Assert the premise before asserting the conclusion. Whether these clouds
    # CAN correspond is a property of the geometry and of ICP's window, and the
    # previous version of this test silently stopped satisfying it — leaving an
    # assertion that looked meaningful while demanding something false. Measured
    # here: a ~4.0 m gap against a ~0.85 m window, so ~4.7x clear.
    gap, window = _correspondence_gap(target, source)
    assert gap > 2.0 * window, (
        "PRECONDITION FAILED: this pair is supposed to have no possible "
        f"correspondence, but the nearest pair is {gap:.3f} m apart against a "
        f"{window:.3f} m window. The assertions below would then be demanding "
        "something false. Fix the geometry, not the assertion."
    )

    result = main._do_c2c_icp(main.CloudToCloudICPRequest(
        target_points=target.ravel().tolist(),
        source_points=source.ravel().tolist(),
    ), progress=None)

    assert result["success"] is True  # it completes; the point is what it REPORTS
    assert (result.get("fitness") or 0.0) == 0.0, "expected a zero-correspondence fit"
    assert result.get("quality_warning"), (
        "a registration that matched nothing was reported without any warning "
        f"(fitness={result.get('fitness')}, rmse={result.get('rmse')})")


def test_normal_alignment_still_reports_no_warning():
    """Guard against over-firing: an ordinary good alignment must stay clean, or
    the warning becomes noise users learn to ignore."""
    target = _row()
    source = target + np.array([0.2, -0.1, 0.05])

    result = main._do_c2c_icp(main.CloudToCloudICPRequest(
        target_points=target.ravel().tolist(),
        source_points=source.ravel().tolist(),
    ), progress=None)

    assert result["success"] is True
    assert (result.get("fitness") or 0.0) > 0.0
    assert not result.get("quality_warning"), (
        f"good alignment wrongly warned: {result.get('quality_warning')!r}")
