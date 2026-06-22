"""Phase 2: timestamp <-> trajectory join coverage validation.

The trajectory join clamps query times to the trajectory's [t0, t1] span. That is
correct for small legitimate edge overruns but catastrophic for a clock mismatch:
every return clamps to one endpoint pose and silently collapses to a single static
origin. `_validate_join_coverage` turns that silent corruption into a loud failure
(zero overlap / known GPS offset) or a structured warning (partial coverage), while
leaving the clamp in place for legitimate small overruns.
"""

import numpy as np
import pytest

import main


def test_zero_overlap_raises():
    """Points at a huge epoch, trajectory near zero → no overlap → raise."""
    ts = 3.5e8 + np.arange(10) * 0.1
    traj_t = np.array([0.0, 1.0, 2.0])
    with pytest.raises(ValueError, match="do not overlap"):
        main._validate_join_coverage(ts, traj_t, warnings=[])


def test_full_overlap_passes_no_warning():
    """All returns inside the trajectory span → no raise, no warning."""
    ts = np.linspace(0.1, 1.9, 50)
    traj_t = np.array([0.0, 1.0, 2.0])
    warnings = []
    main._validate_join_coverage(ts, traj_t, warnings=warnings)
    assert warnings == []


def test_partial_coverage_warns():
    """Half the returns fall past the trajectory end → warning, no raise."""
    # Trajectory spans [0, 1]; half the points sit in (1, 2] and will be clamped.
    ts = np.concatenate([np.linspace(0.0, 1.0, 50), np.linspace(1.01, 2.0, 50)])
    traj_t = np.array([0.0, 0.5, 1.0])
    warnings = []
    main._validate_join_coverage(ts, traj_t, warnings=warnings)
    assert len(warnings) == 1
    assert "%" in warnings[0]
    assert "clamped" in warnings[0]


def test_1e9_standard_vs_adjusted_offset_raises():
    """A ~1e9 s lead (Standard vs Adjusted-Standard GPS) is refused explicitly."""
    traj_t = np.array([100.0, 200.0, 300.0])
    ts = 1e9 + np.linspace(100.0, 300.0, 20)  # exactly the Standard offset
    with pytest.raises(ValueError, match="1e9|Adjusted-Standard"):
        main._validate_join_coverage(ts, traj_t, warnings=[])


def test_gps_week_offset_raises():
    """An integer-GPS-week offset (week-time vs absolute) is refused explicitly."""
    traj_t = np.array([100.0, 200.0, 300.0])
    ts = 2 * 604800.0 + np.linspace(100.0, 300.0, 20)  # two whole GPS weeks
    with pytest.raises(ValueError, match="week"):
        main._validate_join_coverage(ts, traj_t, warnings=[])


def test_single_pose_trajectory_skips_check():
    """A single-pose trajectory applies to every return by design → no raise even
    though the instant can't 'span' the timestamps."""
    ts = np.linspace(0.0, 100.0, 20)
    traj_t = np.array([5.0])  # one pose
    main._validate_join_coverage(ts, traj_t, warnings=[])  # must not raise


def test_nan_timestamps_raise():
    ts = np.array([0.1, 0.2, np.nan, 0.4])
    traj_t = np.array([0.0, 1.0])
    with pytest.raises(ValueError, match="NaN"):
        main._validate_join_coverage(ts, traj_t, warnings=[])


def test_small_relative_clock_no_false_positive():
    """A synthetic scan's small relative clock (median offset ~0) must NOT trip the
    1e9 or GPS-week refusal — the guard that broke existing moving-scan fixtures."""
    ts = np.linspace(0.0, 2.0, 100)
    traj_t = np.array([0.0, 1.0, 2.0])
    warnings = []
    main._validate_join_coverage(ts, traj_t, warnings=warnings)
    assert warnings == []


# ---------------------------------------------------------------------------
# Integration: the check fires through the real _apply_trajectory_origins path.
# ---------------------------------------------------------------------------

def _straight_stream(t0, t1):
    """A 2-pose identity-attitude PoseStream as the Pydantic wire model."""
    return main.PoseStream(poses=[
        main.PoseSample(t=t0, x=0, y=0, z=10, qx=0, qy=0, qz=0, qw=1),
        main.PoseSample(t=t1, x=2, y=0, z=10, qx=0, qy=0, qz=0, qw=1),
    ])


def test_apply_trajectory_origins_raises_on_mismatch():
    """End-to-end: a mismatched-epoch timestamp column makes the real reconstruction
    path raise rather than emit collapsed origins."""
    n = 6
    xyz = np.column_stack([np.linspace(0, 2, n), np.zeros(n), np.zeros(n)])
    dirs = np.zeros((n, 3), dtype=np.float32)
    labels = ["timestamp"]
    vals = (3.5e8 + np.arange(n) * 0.1).reshape(-1, 1)  # huge epoch
    traj = _straight_stream(0.0, 2.0)                   # near-zero clock
    with pytest.raises(ValueError, match="do not overlap"):
        main._apply_trajectory_origins(xyz, dirs, labels, vals, traj)


def test_apply_trajectory_origins_full_coverage_ok():
    """A matched clock reconstructs distinct origins and appends origin_x/y/z."""
    n = 6
    xyz = np.column_stack([np.linspace(0, 2, n), np.zeros(n), np.zeros(n)])
    dirs = np.zeros((n, 3), dtype=np.float32)
    labels = ["timestamp"]
    vals = np.linspace(0.0, 2.0, n).reshape(-1, 1)
    traj = _straight_stream(0.0, 2.0)
    warnings = []
    new_dirs, new_labels, new_vals, origins = main._apply_trajectory_origins(
        xyz, dirs, labels, vals, traj, warnings=warnings)
    assert warnings == []
    assert new_labels[-3:] == ["origin_x", "origin_y", "origin_z"]
    # Origins move along +x with time (the platform translates 0->2 in x).
    assert origins[0, 0] < origins[-1, 0]
