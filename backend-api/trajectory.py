"""Canonical 6-DOF pose-stream representation + the timestamp->pose join.

A moving-platform LiDAR acquisition is reconstructed from three ingredients joined
by *time*: a per-return timestamp, a dense platform trajectory (position + attitude
sampled over time), and a fixed lever-arm/boresight calibration between the platform
body frame and the scanner optical frame. This module is the single home for that
join: it interpolates the trajectory to each return's timestamp and produces the
per-beam emission origin the leaf-area (Beer's-law) inversion needs.

CONVENTIONS (pinned to match helios-core's lidar plugin exactly — see
`quat_from_rpy`/`quat_rotate`/`poseAt` in plugins/lidar/src/LiDAR.cpp):

- Quaternions are Hamilton, body->world, components (qx, qy, qz, qw) — scalar last.
  This is scipy's native `Rotation.from_quat([qx,qy,qz,qw])` convention.
- Euler angles are intrinsic Z-Y-X (yaw-pitch-roll) Tait-Bryan, i.e.
  q = qz(yaw) * qy(pitch) * qx(roll): roll applied first, then pitch, then yaw
  (standard aerospace). This is scipy's `Rotation.from_euler('ZYX', [yaw,pitch,roll])`.
- Interpolation: linear position, SLERP attitude, clamped to the trajectory
  endpoints (no extrapolation), matching `ScanMetadata::poseAt`.

The emission origin for a return acquired at time t is
    origin = pos(t) + R(quat(t)) . lever_arm
where R(q) rotates a body-frame vector into the world frame. This matches the C++
`origin = pos + quat_rotate(q, lever_arm)` used by `addScanMoving`, so an imported
real cloud and a synthetic scan reconstruct origins identically.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

import numpy as np
from scipy.spatial.transform import Rotation, Slerp


@dataclass
class PoseStream:
    """A dense timestamped 6-DOF platform trajectory plus its calibration.

    `t` (M,) float64 strictly-increasing seconds, the join clock (same clock as the
    point cloud's per-return timestamps). `pos` (M,3) float64 world positions.
    `quat` (M,4) float64 Hamilton body->world quaternions (qx,qy,qz,qw). `lever_arm`
    (3,) the scanner optical center in the body frame (meters). `boresight_rpy` (3,)
    fixed sensor misalignment as roll/pitch/yaw radians — folded into the attitude
    when resolving directions (origins depend only on lever_arm, not boresight).
    """

    t: np.ndarray
    pos: np.ndarray
    quat: np.ndarray
    lever_arm: np.ndarray = field(default_factory=lambda: np.zeros(3, dtype=np.float64))
    boresight_rpy: np.ndarray = field(default_factory=lambda: np.zeros(3, dtype=np.float64))
    frame_crs: Optional[str] = None

    @staticmethod
    def from_samples(
        t: List[float],
        pos: List[List[float]],
        rot: List[List[float]],
        rot_is_quaternion: bool = True,
        lever_arm: Optional[List[float]] = None,
        boresight_rpy: Optional[List[float]] = None,
        frame_crs: Optional[str] = None,
    ) -> "PoseStream":
        """Build a PoseStream from parsed sample lists.

        `rot` rows are (qx,qy,qz,qw) when `rot_is_quaternion`, else (roll,pitch,yaw)
        radians (intrinsic Z-Y-X). Validates lengths and strict monotonicity of `t`.
        """
        t_arr = np.asarray(t, dtype=np.float64)
        pos_arr = np.asarray(pos, dtype=np.float64)
        rot_arr = np.asarray(rot, dtype=np.float64)

        m = t_arr.shape[0]
        if m == 0:
            raise ValueError("PoseStream needs at least one sample")
        if pos_arr.shape != (m, 3):
            raise ValueError(f"pos must be ({m}, 3); got {pos_arr.shape}")
        if rot_is_quaternion:
            if rot_arr.shape != (m, 4):
                raise ValueError(f"quaternion rot must be ({m}, 4); got {rot_arr.shape}")
            quat = _normalize_quat(rot_arr)
        else:
            if rot_arr.shape != (m, 3):
                raise ValueError(f"euler rot must be ({m}, 3) roll/pitch/yaw; got {rot_arr.shape}")
            quat = quat_from_rpy(rot_arr)
        # Strict monotonicity: poseAt() bisection and Slerp both require it. A single
        # sample is allowed (constant pose); >1 must strictly increase.
        if m > 1 and not np.all(np.diff(t_arr) > 0):
            raise ValueError("trajectory times (t) must be strictly increasing")

        lever = (np.asarray(lever_arm, dtype=np.float64) if lever_arm is not None
                 else np.zeros(3, dtype=np.float64))
        bore = (np.asarray(boresight_rpy, dtype=np.float64) if boresight_rpy is not None
                else np.zeros(3, dtype=np.float64))
        if lever.shape != (3,):
            raise ValueError("lever_arm must have 3 elements")
        if bore.shape != (3,):
            raise ValueError("boresight_rpy must have 3 elements")

        return PoseStream(t=t_arr, pos=pos_arr, quat=quat, lever_arm=lever,
                          boresight_rpy=bore, frame_crs=frame_crs)

    def recentered(self, shift: np.ndarray) -> "PoseStream":
        """Return a copy with `shift` (3,) SUBTRACTED from every position.

        Used to move world (e.g. UTM) coordinates into a small local frame before
        they reach PyHelios's float32 geometry path. Attitude and calibration are
        frame-independent, so only `pos` changes; the origins this stream produces
        shift by exactly `-shift`, matching points recentered by the same `shift`.
        """
        shift = np.asarray(shift, dtype=np.float64).reshape(3)
        return PoseStream(t=self.t, pos=self.pos - shift, quat=self.quat,
                          lever_arm=self.lever_arm, boresight_rpy=self.boresight_rpy,
                          frame_crs=self.frame_crs)


def quat_from_rpy(rpy: np.ndarray) -> np.ndarray:
    """Convert (N,3) intrinsic Z-Y-X roll/pitch/yaw (radians) to (N,4) Hamilton
    (qx,qy,qz,qw) quaternions, matching helios-core's quat_from_rpy."""
    rpy = np.atleast_2d(np.asarray(rpy, dtype=np.float64))
    roll, pitch, yaw = rpy[:, 0], rpy[:, 1], rpy[:, 2]
    # scipy 'ZYX' intrinsic takes angles in [yaw, pitch, roll] order and yields
    # q = qz(yaw) qy(pitch) qx(roll) as scalar-last (qx,qy,qz,qw) — exactly the C++.
    return Rotation.from_euler("ZYX", np.column_stack([yaw, pitch, roll])).as_quat()


def _normalize_quat(quat: np.ndarray) -> np.ndarray:
    """Unit-normalize (N,4) quaternions; reject any with ~zero norm."""
    quat = np.atleast_2d(np.asarray(quat, dtype=np.float64))
    norms = np.linalg.norm(quat, axis=1, keepdims=True)
    if np.any(norms < 1e-9):
        raise ValueError("quaternion with ~zero norm cannot be normalized")
    return quat / norms


def resolve_pose_at(stream: PoseStream, t_query: np.ndarray):
    """Interpolate the trajectory to each query time. Returns (pos (N,3) float64,
    quat (N,4) float64 Hamilton body->world).

    Linear position, SLERP attitude, clamped to [t.front, t.back] (no extrapolation).
    Mirrors ScanMetadata::poseAt for a vector of query times. A single-sample stream
    yields the constant pose for every query.
    """
    t_query = np.asarray(t_query, dtype=np.float64).reshape(-1)
    n = t_query.shape[0]
    m = stream.t.shape[0]

    if m == 1:
        pos = np.repeat(stream.pos[0:1], n, axis=0)
        quat = np.repeat(stream.quat[0:1], n, axis=0)
        return pos, quat

    # Clamp queries to the sampled span; Slerp rejects out-of-range times.
    tq = np.clip(t_query, stream.t[0], stream.t[-1])

    # Linear position interpolation, component-wise.
    pos = np.column_stack([np.interp(tq, stream.t, stream.pos[:, c]) for c in range(3)])

    # SLERP attitude. scipy's Slerp picks the shorter arc and handles the bracket.
    slerp = Slerp(stream.t, Rotation.from_quat(stream.quat))
    quat = slerp(tq).as_quat()

    return pos, quat


def origins_for_returns(stream: PoseStream, t_query: np.ndarray) -> np.ndarray:
    """Per-return emission origins: origin = pos(t) + R(quat(t)) . lever_arm.

    Returns (N,3) float64. When the lever arm is zero the origin is just the
    interpolated platform position. This is the array fed (as origin_x/y/z hit data)
    to the beam-based LAD inversion, which reads each beam's own origin via
    getHitOrigin().
    """
    pos, quat = resolve_pose_at(stream, t_query)
    lever = np.asarray(stream.lever_arm, dtype=np.float64)
    if not np.any(lever):
        return pos
    # R(quat) rotates the body-frame lever arm into the world frame, per return.
    rotated = Rotation.from_quat(quat).apply(lever)
    return pos + rotated
