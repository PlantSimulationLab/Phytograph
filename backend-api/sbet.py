"""Binary SBET (Smoothed Best Estimate of Trajectory) parser.

An SBET is the trajectory log from an Applanix POSPac (or compatible) INS/GNSS
post-processor: a headerless stream of fixed 136-byte records, each 17 little-endian
float64 fields, typically at ~200 Hz. This module parses one into the canonical
`PoseStream` *wire* shape (the same JSON the renderer's `poseStreamFromWire` consumes
and the LAD path turns into per-beam origins), doing the two conversions a raw SBET
needs before it can join to a point cloud:

  1. Geographic -> projected. lat/lon (radians) -> UTM easting/northing via pyproj
     (auto-picked zone from the mean longitude); altitude -> Z. The EPSG is recorded
     on the frame so the cloud and trajectory can be checked for a common CRS.
  2. Attitude NED -> ENU. SBET roll/pitch/heading describe a body(FRD) -> NED rotation
     (heading about Down, clockwise from North). Phytograph's world is ENU/Z-up and its
     quaternions are body -> world(ENU), Hamilton scalar-last. The conversion left-applies
     the NED<->ENU change-of-basis to map the rotation's OUTPUT (navigation) frame from NED
     to ENU: `R_enu = C · R_ned` with `C = [[0,1,0],[1,0,0],[0,0,-1]]`. The body frame is
     left as FRD (forward-right-down) — the resulting quaternion rotates an FRD body vector
     into ENU world, which is what a zero/known lever arm needs. This is NOT a hand-derived
     roll/pitch/yaw remap (which is error-prone and silently mirrors origins); it is a single
     basis change, unit-vector testable: heading 0 -> forward = +Y(North), heading +90° ->
     forward = +X(East).

`smrmsg` accuracy companion files are summarised for a QC warning only; they never
gate the parse. Records are decimated to a few thousand poses (the LAD join only needs
the platform path, not every 5 ms sample), always keeping the last record so the time
span — which the coverage check in main.py validates — is preserved.
"""

from __future__ import annotations

import os
from typing import List, Optional

import numpy as np

# 17 little-endian float64 fields, 136 bytes/record, no header. Field order is the
# Applanix SBET standard (time, lat, lon, alt, velocities, attitude, wander, accels,
# angular rates). All angles are RADIANS.
SBET_DTYPE = np.dtype([
    ("time", "<f8"),
    ("lat", "<f8"), ("lon", "<f8"), ("alt", "<f8"),
    ("vx", "<f8"), ("vy", "<f8"), ("vz", "<f8"),
    ("roll", "<f8"), ("pitch", "<f8"), ("heading", "<f8"),
    ("wander", "<f8"),
    ("ax", "<f8"), ("ay", "<f8"), ("az", "<f8"),
    ("arx", "<f8"), ("ary", "<f8"), ("arz", "<f8"),
])
SBET_RECORD_BYTES = SBET_DTYPE.itemsize  # 136

# NED <-> ENU change-of-basis (its own inverse): (E, N, U) = (NED_y, NED_x, -NED_z).
_NED_ENU = np.array([[0.0, 1.0, 0.0],
                     [1.0, 0.0, 0.0],
                     [0.0, 0.0, -1.0]], dtype=np.float64)

# Keep the trajectory dense enough to interpolate motion but small on the wire.
_DEFAULT_TARGET_POSES = 3000


class SbetParseError(ValueError):
    """Raised when a file is not a structurally valid SBET."""


def _rot_ned(roll, pitch, heading):
    """Body(FRD) -> NED rotation matrices for arrays of (roll, pitch, heading) radians.

    R = Rz(heading) · Ry(pitch) · Rx(roll) (intrinsic Z-Y-X, standard aerospace:
    heading about Down, then pitch, then roll). Returns (N,3,3).
    """
    cr, sr = np.cos(roll), np.sin(roll)
    cp, sp = np.cos(pitch), np.sin(pitch)
    cy, sy = np.cos(heading), np.sin(heading)
    n = roll.shape[0]
    rx = np.zeros((n, 3, 3)); rx[:, 0, 0] = 1; rx[:, 1, 1] = cr; rx[:, 1, 2] = -sr; rx[:, 2, 1] = sr; rx[:, 2, 2] = cr
    ry = np.zeros((n, 3, 3)); ry[:, 1, 1] = 1; ry[:, 0, 0] = cp; ry[:, 0, 2] = sp; ry[:, 2, 0] = -sp; ry[:, 2, 2] = cp
    rz = np.zeros((n, 3, 3)); rz[:, 2, 2] = 1; rz[:, 0, 0] = cy; rz[:, 0, 1] = -sy; rz[:, 1, 0] = sy; rz[:, 1, 1] = cy
    return rz @ ry @ rx


def ned_attitude_to_enu_quat(roll, pitch, heading):
    """Convert SBET (roll, pitch, heading) radians (body(FRD)->NED) to body(FRD)->world
    (ENU) Hamilton quaternions (qx,qy,qz,qw), by left-applying the NED->ENU basis change
    to the rotation's output frame: `R_enu = C · R_ned`. Inputs are (N,) arrays; returns
    (N,4). Pinned by unit-vector tests: heading 0 -> forward +Y(North), +90° -> +X(East)."""
    from scipy.spatial.transform import Rotation

    roll = np.atleast_1d(np.asarray(roll, dtype=np.float64))
    pitch = np.atleast_1d(np.asarray(pitch, dtype=np.float64))
    heading = np.atleast_1d(np.asarray(heading, dtype=np.float64))
    r_ned = _rot_ned(roll, pitch, heading)              # (N,3,3) body(FRD)->NED
    r_enu = _NED_ENU @ r_ned                            # body(FRD)->world(ENU)
    return Rotation.from_matrix(r_enu).as_quat()        # (N,4) scalar-last


def _utm_epsg(lat_deg_mean: float, lon_deg_mean: float) -> int:
    """UTM EPSG from the mean lat/lon (degrees). North 326zz / South 327zz."""
    zone = int((lon_deg_mean + 180.0) // 6.0) + 1
    zone = min(max(zone, 1), 60)
    return (32600 if lat_deg_mean >= 0 else 32700) + zone


def _decimate_indices(n: int, target: int) -> np.ndarray:
    """Even stride over n records down to <= `target`, always keeping the last index
    so the trajectory's time span is preserved (the coverage check needs t1)."""
    if n <= target:
        return np.arange(n)
    stride = int(np.ceil(n / target))
    idx = np.arange(0, n, stride)
    if idx[-1] != n - 1:
        idx = np.append(idx, n - 1)
    return idx


def _read_smrmsg_qc(path: str) -> Optional[str]:
    """Summarise an smrmsg accuracy file as a one-line QC warning (max position RMS),
    or None if absent/unreadable. smrmsg records are headerless float64; the first
    field is time and the next three are north/east/down position RMS (meters). This
    is advisory only — never gates the SBET parse."""
    if not path or not os.path.isfile(path):
        return None
    try:
        raw = np.fromfile(path, dtype="<f8")
        # Try common record widths (10 fields is typical); fall back gracefully.
        for width in (10, 17, 9):
            if raw.size % width == 0 and raw.size >= width:
                recs = raw.reshape(-1, width)
                pos_rms = recs[:, 1:4]
                worst = float(np.max(np.linalg.norm(pos_rms, axis=1)))
                return (f"smrmsg accuracy: worst position RMS ~{worst:.3f} m across "
                        f"{recs.shape[0]} samples.")
    except Exception:
        return None
    return None


def parse_sbet(path: str, target_poses: int = _DEFAULT_TARGET_POSES,
               smrmsg_path: Optional[str] = None) -> dict:
    """Parse a binary SBET into the canonical PoseStream wire dict.

    Returns {poses, frame, lever_arm, boresight_rpy, source_format, warnings}.
    `poses` is a decimated list of {t, x, y, z, qx, qy, qz, qw} with x/y in UTM meters
    (easting/northing), z = altitude, and a body->world ENU quaternion. Raises
    SbetParseError when the file is not a structurally valid SBET (size not a multiple
    of 136 bytes, or empty).
    """
    if not os.path.isfile(path):
        raise SbetParseError(f"SBET file not found: {path}")
    size = os.path.getsize(path)
    if size == 0:
        raise SbetParseError("SBET file is empty.")
    if size % SBET_RECORD_BYTES != 0:
        raise SbetParseError(
            f"File size {size} bytes is not a multiple of the {SBET_RECORD_BYTES}-byte "
            f"SBET record ({size % SBET_RECORD_BYTES} bytes left over); this is not a "
            f"valid SBET. If it is a TEXT trajectory, import it as .csv/.txt instead.")

    recs = np.fromfile(path, dtype=SBET_DTYPE)
    n = recs.shape[0]
    warnings: List[str] = []

    lat = recs["lat"]; lon = recs["lon"]  # radians
    lat_deg = np.degrees(lat); lon_deg = np.degrees(lon)
    lat_mean = float(np.mean(lat_deg)); lon_mean = float(np.mean(lon_deg))

    if abs(lat_mean) > 84.0:
        warnings.append(
            f"Mean latitude {lat_mean:.2f}° is outside UTM's valid band (±84°); "
            f"projected coordinates near the poles may be unreliable.")
    lon_span = float(np.max(lon_deg) - np.min(lon_deg))
    if lon_span > 3.0:
        warnings.append(
            f"Trajectory spans {lon_span:.1f}° of longitude, crossing toward a UTM "
            f"zone boundary; coordinates far from the central meridian carry more "
            f"projection error.")

    epsg = _utm_epsg(lat_mean, lon_mean)
    from pyproj import Transformer
    transformer = Transformer.from_crs("EPSG:4326", f"EPSG:{epsg}", always_xy=True)
    easting, northing = transformer.transform(lon_deg, lat_deg)  # always_xy: lon,lat
    easting = np.asarray(easting, dtype=np.float64)
    northing = np.asarray(northing, dtype=np.float64)
    alt = recs["alt"].astype(np.float64)

    quats = ned_attitude_to_enu_quat(recs["roll"], recs["pitch"], recs["heading"])

    idx = _decimate_indices(n, target_poses)
    if len(idx) < n:
        warnings.append(
            f"Decimated SBET from {n} to {len(idx)} poses for the trajectory "
            f"(the join interpolates between them).")

    # Monotonic-time sanity (SBET time is monotone; assert after decimation).
    t = recs["time"][idx].astype(np.float64)
    if not np.all(np.diff(t) > 0):
        warnings.append("SBET timestamps are not strictly increasing after decimation; "
                        "the trajectory join may be unreliable.")

    qc = _read_smrmsg_qc(smrmsg_path) if smrmsg_path else None
    if qc:
        warnings.append(qc)

    poses = [
        {"t": float(t[k]),
         "x": float(easting[i]), "y": float(northing[i]), "z": float(alt[i]),
         "qx": float(quats[i, 0]), "qy": float(quats[i, 1]),
         "qz": float(quats[i, 2]), "qw": float(quats[i, 3])}
        for k, i in enumerate(idx)
    ]

    return {
        "poses": poses,
        "frame": {"crs": f"EPSG:{epsg}", "up_axis": "z",
                  "body_convention": "FRD", "time_ref": "gps"},
        "lever_arm": [0.0, 0.0, 0.0],
        "boresight_rpy": [0.0, 0.0, 0.0],
        "source_format": "sbet",
        "warnings": warnings,
    }
