"""Unit tests for the canonical pose-stream resolver (`trajectory.py`).

Pure-logic: numpy + scipy only, no native plugin, so these run everywhere.

The load-bearing test is `origins_for_returns` with a NON-TRIVIAL attitude checked
against an INDEPENDENT hand computation of `pos + R(q)·lever_arm` using the raw
Hamilton quat-rotate formula (v + 2*qw*(qv×v) + 2*qv×(qv×v)) — the same formula the
helios-core C++ uses. A static or zero-velocity test would pass even with a wrong
rotation convention; only a real rotation exposes a sign/axis bug.
"""

import numpy as np
import pytest

from trajectory import (
    PoseStream,
    origins_for_returns,
    quat_from_rpy,
    resolve_pose_at,
)


def _hamilton_rotate(q, v):
    """Rotate body-frame vector v into world by Hamilton quat (qx,qy,qz,qw).

    Independent reimplementation of helios-core's quat_rotate, used as the oracle.
    """
    q = np.asarray(q, dtype=np.float64)
    qv = q[:3]
    v = np.asarray(v, dtype=np.float64)
    t = 2.0 * np.cross(qv, v)
    return v + q[3] * t + np.cross(qv, t)


def _identity_stream(**kw):
    """Two-sample stream, straight line along +x, identity attitude."""
    return PoseStream.from_samples(
        t=[0.0, 10.0],
        pos=[[0, 0, 0], [10, 0, 0]],
        rot=[[0, 0, 0, 1], [0, 0, 0, 1]],
        rot_is_quaternion=True,
        **kw,
    )


# ---- resolve_pose_at -------------------------------------------------------

def test_position_lerp_midpoint():
    s = _identity_stream()
    pos, quat = resolve_pose_at(s, [5.0])
    np.testing.assert_allclose(pos[0], [5.0, 0.0, 0.0], atol=1e-9)


def test_slerp_halfway_is_analytic_half_rotation():
    # 0 -> 90deg yaw over [0,1]; midpoint must be exactly 45deg yaw.
    q0 = quat_from_rpy([[0, 0, 0]])[0]
    q1 = quat_from_rpy([[0, 0, np.pi / 2]])[0]
    s = PoseStream.from_samples(t=[0.0, 1.0], pos=[[0, 0, 0], [0, 0, 0]],
                                rot=[q0.tolist(), q1.tolist()])
    _, quat = resolve_pose_at(s, [0.5])
    expected = quat_from_rpy([[0, 0, np.pi / 4]])[0]
    # Quaternion double-cover: compare up to sign.
    dot = abs(float(np.dot(quat[0], expected)))
    assert dot == pytest.approx(1.0, abs=1e-9)


def test_clamp_before_and_after_span():
    s = _identity_stream()
    pos_before, _ = resolve_pose_at(s, [-5.0])
    pos_after, _ = resolve_pose_at(s, [99.0])
    np.testing.assert_allclose(pos_before[0], [0, 0, 0], atol=1e-9)
    np.testing.assert_allclose(pos_after[0], [10, 0, 0], atol=1e-9)


def test_single_sample_is_constant_pose():
    q = quat_from_rpy([[0.1, -0.2, 0.3]])[0]
    s = PoseStream.from_samples(t=[3.0], pos=[[1, 2, 3]], rot=[q.tolist()])
    pos, quat = resolve_pose_at(s, [0.0, 3.0, 100.0])
    assert pos.shape == (3, 3)
    np.testing.assert_allclose(pos, [[1, 2, 3]] * 3, atol=1e-12)
    for i in range(3):
        assert abs(float(np.dot(quat[i], q))) == pytest.approx(1.0, abs=1e-12)


def test_reject_non_monotonic_times():
    with pytest.raises(ValueError, match="strictly increasing"):
        PoseStream.from_samples(t=[0.0, 1.0, 1.0], pos=[[0, 0, 0]] * 3,
                                rot=[[0, 0, 0, 1]] * 3)
    with pytest.raises(ValueError, match="strictly increasing"):
        PoseStream.from_samples(t=[0.0, 2.0, 1.0], pos=[[0, 0, 0]] * 3,
                                rot=[[0, 0, 0, 1]] * 3)


def test_length_mismatch_rejected():
    with pytest.raises(ValueError):
        PoseStream.from_samples(t=[0.0, 1.0], pos=[[0, 0, 0]],
                                rot=[[0, 0, 0, 1], [0, 0, 0, 1]])


# ---- origins_for_returns (the convention test) -----------------------------

def test_origin_no_lever_arm_is_position():
    s = _identity_stream()
    o = origins_for_returns(s, [0.0, 5.0, 10.0])
    np.testing.assert_allclose(o, [[0, 0, 0], [5, 0, 0], [10, 0, 0]], atol=1e-9)


def test_origin_nontrivial_attitude_matches_hand_computed():
    # Non-trivial constant attitude + a non-axis-aligned lever arm. The origin must
    # equal pos + R(q)·lever for the EXACT Hamilton/Z-Y-X convention; a wrong axis
    # or sign would shift it. Oracle: _hamilton_rotate (independent of scipy).
    rpy = [0.3, -0.4, 1.1]  # roll, pitch, yaw (rad)
    q = quat_from_rpy([rpy])[0]
    lever = np.array([0.2, -0.5, 0.7])
    s = PoseStream.from_samples(
        t=[0.0, 2.0],
        pos=[[100.0, 200.0, 50.0], [120.0, 200.0, 50.0]],
        rot=[q.tolist(), q.tolist()],          # constant attitude
        lever_arm=lever.tolist(),
    )
    tq = np.array([0.0, 1.0, 2.0])
    got = origins_for_returns(s, tq)
    # Independent expectation.
    pos_expected = np.column_stack([np.interp(tq, s.t, s.pos[:, c]) for c in range(3)])
    rot_lever = _hamilton_rotate(q, lever)
    expected = pos_expected + rot_lever
    np.testing.assert_allclose(got, expected, atol=1e-6)


def test_euler_quat_equivalence():
    # A stream built from Euler rpy must resolve identically to one built from the
    # equivalent quaternion.
    rpy = [[0.1, 0.2, 0.3], [0.4, -0.1, 0.9]]
    q = quat_from_rpy(rpy)
    s_euler = PoseStream.from_samples(t=[0.0, 1.0], pos=[[0, 0, 0], [1, 1, 1]],
                                      rot=rpy, rot_is_quaternion=False,
                                      lever_arm=[0.1, 0.2, 0.3])
    s_quat = PoseStream.from_samples(t=[0.0, 1.0], pos=[[0, 0, 0], [1, 1, 1]],
                                     rot=q.tolist(), rot_is_quaternion=True,
                                     lever_arm=[0.1, 0.2, 0.3])
    tq = [0.0, 0.5, 1.0]
    np.testing.assert_allclose(origins_for_returns(s_euler, tq),
                               origins_for_returns(s_quat, tq), atol=1e-9)


# ---- recenter invariance ---------------------------------------------------

def test_recenter_shifts_origins_by_exactly_minus_shift():
    rpy = [0.3, -0.4, 1.1]
    q = quat_from_rpy([rpy])[0]
    s = PoseStream.from_samples(
        t=[0.0, 2.0],
        pos=[[500000.0, 4000000.0, 50.0], [500020.0, 4000000.0, 50.0]],  # UTM-scale
        rot=[q.tolist(), q.tolist()],
        lever_arm=[0.2, -0.5, 0.7],
    )
    shift = np.array([500000.0, 4000000.0, 0.0])
    tq = np.array([0.0, 1.0, 2.0])
    o_world = origins_for_returns(s, tq)
    o_local = origins_for_returns(s.recentered(shift), tq)
    np.testing.assert_allclose(o_local, o_world - shift, atol=1e-3)
