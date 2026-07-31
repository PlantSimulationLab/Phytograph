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
    coincide — here a multi-metre row of clumps against a 2 cm blob."""
    target = _row()
    source = _blob()

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
