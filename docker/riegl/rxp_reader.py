"""Read RIEGL raw scanner projects (.riproject and .PROJ) via RiVLib's scanifc C API.

Runs INSIDE the container built by the Dockerfile beside this file; RiVLib is
bind-mounted at /rivlib. Nothing here imports from the Phytograph backend — the
container boundary is deliberately dumb, and the only contract with the host is
the JSON printed on stdout.

WHY CTYPES AND NOT A COMPILED EXTENSION: libscanifc.so exports a flat C API
(`scanifc_point3dstream_open` / `_read` / `_get_meta` / `_close`) with two plain
structs, so ctypes binds it with no compiler in the image and no build step. The
C++ headers (scanlib.hpp etc.) would need a toolchain for no extra capability.

WHERE EACH PIECE OF METADATA ACTUALLY LIVES — this cost real digging, so:

  * Points + per-point attributes  -> scanifc_point3dstream_read
  * Instrument id / serial / beam  -> scanifc_point3dstream_get_meta (JSON)
  * Angular sweep (the FOV)        -> the .pat file, NOT RiVLib. `get_meta`'s
    "scanmech" block is mirror-facet calibration (normals + exit-pane geometry),
    not the commanded pattern. The only FOV-ish keys in the whole meta blob are
    `line_angle_0`, `line_circle_count`, `frame_circle_count`. The .pat file
    states it outright, so that is what we parse.
  * Scanner GNSS position          -> `hk_gps_hr` housekeeping records, reachable
    only through `scanifc_point3dstream_add_demultiplexer(h, path, 0,
    "status protocol")`, which writes the housekeeping stream to a text file as
    a side effect of reading points.

TWO PROJECT LAYOUTS, ONE DECODE PATH. Both are directories of scan positions
whose points are .rxp, so everything from _Scanifc down is shared and only
discovery and metadata differ:

  * .riproject — the older on-instrument layout. Flat `ScanPosNNN/` folders
    holding `<stamp>.rxp` + `<stamp>.pat`. No manifest, no registration.
  * .PROJ      — the newer layout (VZ-2000i and friends). `ScanPosNNN.SCNPOS/`
    holding `scans/<stamp>.rxp` + `<stamp>.scn`, beside a `project.json`
    manifest and per-position pose/SOP sidecars. Registration IS present.

The .PROJ also writes a `<stamp>.rdbx` (RIEGL's MTA-resolved RDB2 cloud) beside
each .rxp. We deliberately read the .rxp instead: the .rdbx needs RIEGL's
separate rdblib SDK as a second licensed dependency, and it contains no
no-return shots — which is exactly what collect_misses recovers and what LAD
needs. MTA ambiguity is not a concern at the ranges this is used for (the
reference project's unambiguous range is 497 m against a 142 m scan extent).

COORDINATE FRAMES. A .riproject carries no registration (that is what RiSCAN PRO
produces), so every scan position is its own frame with the origin at the
scanner, and its GNSS fix is a metres-level prior for ICP rather than
survey-grade truth. A .PROJ carries real SOPs, so `--frame registered` places
each position in the project frame directly; see load_sop for the chain and
decompose_sop for how the rotation is folded into ScanParameters.
"""

from __future__ import annotations

import argparse
import ctypes
import glob
import json
import math
import os
import re
import struct
import subprocess
import sys
import time
from collections.abc import Sequence

import numpy as np

# ---------------------------------------------------------------------------
# ctypes bindings
# ---------------------------------------------------------------------------

_LIB_PATH = os.environ.get("RIVLIB_SO", "/rivlib/lib/libscanifc.so")

# Batch size for point reads. 200k points is ~3.2 MB of xyz + ~3.2 MB of
# attributes, which keeps the C->numpy copy amortised without a large resident
# buffer. Measured throughput at this size is ~2.3 M pts/s under emulation.
_READ_CHUNK = 200_000

# Which record stream `scanifc_point3dstream_add_demultiplexer` writes out.
#
# STATUS is the housekeeping subset (20 record kinds on a VZ-1000): hk_gps_hr,
# hk_incl, hk_time, power/battery telemetry. ALL is the full record set (46
# kinds) and is the ONLY place `scanner_pose_hr` (id 72) appears — the
# instrument's own fused roll/pitch/yaw in degrees. Nothing else needs ALL, and
# it produces a larger sidecar file, so the pose path opts in explicitly rather
# than making it the default.
HK_SELECTOR_STATUS = b"status protocol"
HK_SELECTOR_ALL = b"all"

# How many points to decode from a position that is only being probed for its
# GNSS fix -- an UNSELECTED position during a `stream`, which contributes to the
# project's ENU anchor and nothing else.
#
# Housekeeping records ride the point stream (RiVLib exposes no way to read them
# on their own), so a fix costs some decoding no matter what; the only question
# is how much. Measured on all six positions of a VZ-1000 project, both
# `hk_gps_hr` and `scanner_pose_hr` are present after 50k points, in ~0.25 s
# each. 250k is therefore a 5x margin over the observed requirement and still
# ~0.45 s -- cheap enough that anchoring a single-scan import against the whole
# project stays imperceptible.
#
# A position whose receiver never locked yields no fix at any prefix length, and
# that is handled the same way it always was: `parse_hk_gps` returns None and
# `gnss_to_enu` anchors on whatever fixes did resolve.
_ANCHOR_PROBE_POINTS = 250_000

# Points whose range is below this are the scanner seeing itself (mount, tripod
# collar). RiVLib reports them as ordinary returns.
_MIN_RANGE_M = 0.15


class ScanifcXYZ(ctypes.Structure):
    """scanifc_xyz32 — riegl/detail/pointsifc_t.h"""

    _fields_ = [
        ("x", ctypes.c_float),
        ("y", ctypes.c_float),
        ("z", ctypes.c_float),
    ]


class ScanifcAttributes(ctypes.Structure):
    """scanifc_attributes — riegl/detail/pointsifc_t.h

    Field order and widths are load-bearing: ctypes lays this out to match the C
    struct, and a mismatch would silently misread every point rather than error.
    `deviation` and `flags` are both uint16 and sit between two floats.
    """

    _fields_ = [
        ("amplitude", ctypes.c_float),
        ("reflectance", ctypes.c_float),
        ("deviation", ctypes.c_uint16),
        ("flags", ctypes.c_uint16),
        ("background_radiation", ctypes.c_float),
    ]


# The C structs must match RiVLib's layout byte for byte, because
# scanifc_point3dstream_read writes into a buffer of them by stride. A mismatch
# does NOT raise: RiVLib writes correctly-sized records into wrongly-sized slots,
# so attributes come back as garbage and the buffer silently under-holds `want`
# points. Nothing in a points-and-counts read would notice — verified by
# sabotage, where widening the two uint16s to uint32 still produced the exact
# right point count and bbox. Assert the sizes at import instead, so the failure
# is loud and immediate rather than surfacing as corrupt reflectance in Phase 2.
_EXPECTED_XYZ_SIZE = 12  # 3 x float32
_EXPECTED_ATTR_SIZE = 16  # 2 x float32 + 2 x uint16 + 1 x float32

if ctypes.sizeof(ScanifcXYZ) != _EXPECTED_XYZ_SIZE:
    raise RuntimeError(
        f"scanifc_xyz32 is {ctypes.sizeof(ScanifcXYZ)} bytes, expected "
        f"{_EXPECTED_XYZ_SIZE}. The ctypes layout no longer matches RiVLib."
    )
if ctypes.sizeof(ScanifcAttributes) != _EXPECTED_ATTR_SIZE:
    raise RuntimeError(
        f"scanifc_attributes is {ctypes.sizeof(ScanifcAttributes)} bytes, "
        f"expected {_EXPECTED_ATTR_SIZE}. The ctypes layout no longer matches "
        "RiVLib; every per-point attribute would be silently corrupt."
    )


class RxpError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# Miss recovery (no-return shots) via the C++ shim
# ---------------------------------------------------------------------------
#
# An .rxp stores only returns, so `scanifc_point3dstream_read` never mentions a
# shot that hit nothing — yet those are ~46% of a real scan (7,518,052 of
# 18,199,111 shots on the reference position) and they ARE the transmission
# term LAD needs. rxp_shim.cpp reaches them through the C++ pointcloud class;
# see its header comment for why on_shot_end and not on_gap.
#
# Built on first use rather than at image-build time: the shim links against
# libscanifc.so, which is bind-mounted at run time because RIEGL's licence
# forbids baking it into the image.

_SHIM_SRC = "/opt/riegl/rxp_shim.cpp"
_SHIM_SO = "/tmp/librxpshim.so"
_RIVLIB_ROOT = os.environ.get("RIVLIB_ROOT", "/rivlib")


def _build_shim() -> str:
    """Compile the miss-recovery shim if it isn't already built."""
    if os.path.exists(_SHIM_SO):
        return _SHIM_SO
    if not os.path.exists(_SHIM_SRC):
        raise RxpError(f"miss-recovery shim source missing at {_SHIM_SRC}")
    cmd = [
        "g++", "-std=c++11", "-O2", "-fPIC", "-shared",
        f"-I{_RIVLIB_ROOT}/include", _SHIM_SRC,
        f"-L{_RIVLIB_ROOT}/lib", "-lscanifc", "-o", _SHIM_SO,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 or not os.path.exists(_SHIM_SO):
        raise RxpError(
            "could not build the miss-recovery shim: "
            + (proc.stderr or proc.stdout or "no compiler output")[-800:]
        )
    return _SHIM_SO


def collect_misses(rxp_path: str) -> dict:
    """Return the beam direction and time of every no-return shot.

    {'dirs': (M,3) float64 unit vectors in the SCANNER frame,
     'times': (M,) float64 seconds,
     'shots', 'hit_shots', 'echoes': counts for cross-checking}

    The counts are the reconciliation handle: `shots` must equal
    `hit_shots + len(times)`, and `echoes` must match what the C API returned.
    """
    lib = ctypes.CDLL(_build_shim())
    lib.rxpshim_collect_misses.restype = ctypes.c_void_p
    lib.rxpshim_collect_misses.argtypes = [ctypes.c_char_p]
    lib.rxpshim_error.restype = ctypes.c_char_p
    lib.rxpshim_error.argtypes = [ctypes.c_void_p]
    for name in ("rxpshim_miss_count", "rxpshim_shot_count",
                 "rxpshim_hit_shot_count", "rxpshim_echo_count"):
        getattr(lib, name).restype = ctypes.c_uint64
        getattr(lib, name).argtypes = [ctypes.c_void_p]
    lib.rxpshim_copy.argtypes = [
        ctypes.c_void_p,
        np.ctypeslib.ndpointer(dtype=np.float64, flags="C_CONTIGUOUS"),
        np.ctypeslib.ndpointer(dtype=np.float64, flags="C_CONTIGUOUS"),
    ]
    lib.rxpshim_free.argtypes = [ctypes.c_void_p]

    handle = lib.rxpshim_collect_misses(_uri(rxp_path).encode())
    if not handle:
        raise RxpError("miss recovery could not allocate")
    try:
        err = (lib.rxpshim_error(handle) or b"").decode("latin-1")
        if err:
            raise RxpError(f"miss recovery failed: {err}")
        m = int(lib.rxpshim_miss_count(handle))
        dirs = np.empty((max(m, 1), 3), dtype=np.float64)
        times = np.empty(max(m, 1), dtype=np.float64)
        lib.rxpshim_copy(handle, dirs, times)
        return {
            "dirs": dirs[:m],
            "times": times[:m],
            "shots": int(lib.rxpshim_shot_count(handle)),
            "hit_shots": int(lib.rxpshim_hit_shot_count(handle)),
            "echoes": int(lib.rxpshim_echo_count(handle)),
        }
    finally:
        lib.rxpshim_free(handle)


class _Scanifc:
    """Thin ctypes wrapper. Every call checks the int return and, on failure,
    pulls RiVLib's own message via scanifc_get_last_error rather than raising a
    bare non-zero code."""

    def __init__(self, lib_path: str = _LIB_PATH):
        if not os.path.exists(lib_path):
            raise RxpError(
                f"RiVLib not found at {lib_path}. The library is user-supplied "
                "(RIEGL licence forbids redistribution); bind-mount it at /rivlib."
            )
        self.lib = ctypes.CDLL(lib_path)

    def _last_error(self) -> str:
        buf = ctypes.create_string_buffer(1024)
        size = ctypes.c_uint32()
        try:
            self.lib.scanifc_get_last_error(buf, 1024, ctypes.byref(size))
            return buf.value.decode("latin-1", errors="replace")
        except Exception:
            return "<no error detail>"

    def _check(self, rc: int, what: str) -> None:
        if rc != 0:
            raise RxpError(f"{what} failed: {self._last_error()}")

    def version(self) -> str:
        major, minor, build = (ctypes.c_uint16() for _ in range(3))
        self._check(
            self.lib.scanifc_get_library_version(
                ctypes.byref(major), ctypes.byref(minor), ctypes.byref(build)
            ),
            "scanifc_get_library_version",
        )
        return f"{major.value}.{minor.value}.{build.value}"

    def open(
        self,
        uri: str,
        hk_path: str | None = None,
        selector: bytes = HK_SELECTOR_STATUS,
    ) -> ctypes.c_void_p:
        """Open a point stream. When `hk_path` is given, the named record
        stream is demultiplexed to that file as points are read — this is the
        only route to the GNSS and pose records.

        `selector` picks WHICH records land in that file, and the choice is not
        cosmetic: "status protocol" yields 20 record kinds and "all" yields 46.
        `scanner_pose_hr` — the instrument's own fused roll/pitch/yaw — is in
        the latter but NOT the former, which is why it went unnoticed for so
        long. Default stays "status protocol" so existing callers (GNSS,
        housekeeping inclination) are byte-for-byte unaffected.
        """
        handle = ctypes.c_void_p()
        self._check(
            self.lib.scanifc_point3dstream_open(
                uri.encode(), 0, ctypes.byref(handle)
            ),
            f"open {uri}",
        )
        if hk_path is not None:
            self._check(
                self.lib.scanifc_point3dstream_add_demultiplexer(
                    handle, hk_path.encode(), 0, selector
                ),
                "add_demultiplexer",
            )
        return handle

    def meta(self, handle: ctypes.c_void_p) -> dict:
        raw = ctypes.c_char_p()
        self._check(
            self.lib.scanifc_point3dstream_get_meta(handle, ctypes.byref(raw)),
            "get_meta",
        )
        if not raw.value:
            return {}
        try:
            return json.loads(raw.value.decode("latin-1"))
        except json.JSONDecodeError:
            return {}

    def close(self, handle: ctypes.c_void_p) -> None:
        try:
            self.lib.scanifc_point3dstream_close(handle)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# .pat — the commanded scan pattern (the FOV)
# ---------------------------------------------------------------------------

# e.g. SCN_SET_RECT_FOV(30.0000, 130.0000, 0.0400, 0.0000, 360.0000, 0.0500)
#                       theta_min theta_max theta_inc phi_min phi_max phi_inc
_PAT_RE = re.compile(
    r"SCN_SET_RECT_FOV\s*\(\s*"
    r"([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*"
    r"([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)"
)


def parse_pat(path: str) -> dict | None:
    """Parse a .pat scan-pattern file into Phytograph's scan_params shape.

    The file is ISO-8859 (the degree signs are latin-1, and decoding as UTF-8
    raises), CRLF-terminated, and only the SCN_SET_RECT_FOV line matters — the
    lines above it are a human-readable restatement of the same numbers.

    RIEGL theta is zenith measured from +Z, which is already Phytograph/Helios's
    convention — unlike E57, whose elevation is measured from the XY plane and
    needs a 90-degree flip with a min/max swap. Do not "fix" this.

    Sample counts are derived from the sweep and increment rather than counting
    points, so they describe the commanded raster even when returns are sparse.
    """
    try:
        with open(path, encoding="latin-1") as handle:
            text = handle.read()
    except OSError:
        return None

    match = _PAT_RE.search(text)
    if match is None:
        return None

    theta_min, theta_max, theta_inc, phi_min, phi_max, phi_inc = (
        float(g) for g in match.groups()
    )

    params: dict = {
        "theta_min": theta_min,
        "theta_max": theta_max,
        "phi_min": phi_min,
        "phi_max": phi_max,
        "theta_increment": theta_inc,
        "phi_increment": phi_inc,
    }
    if theta_inc > 0:
        params["n_theta"] = int(round((theta_max - theta_min) / theta_inc)) + 1
    if phi_inc > 0:
        # Phi typically sweeps a full 360 deg, where the last column coincides
        # with the first, so this is a sample count and not a fencepost count.
        params["n_phi"] = int(round((phi_max - phi_min) / phi_inc))
    return params


# ---------------------------------------------------------------------------
# .scn — the commanded scan pattern in a .PROJ project
# ---------------------------------------------------------------------------


def parse_scn(path: str) -> dict | None:
    """Parse a .PROJ `.scn` file into the SAME shape `parse_pat` returns.

    A .PROJ writes the scan pattern as JSON instead of the .riproject's
    `SCN_SET_RECT_FOV(...)` text line, but the numbers mean exactly the same
    thing, so the two parsers deliberately converge on one dict and everything
    downstream stays layout-agnostic:

        {"fov": {"thetaStart": 30, "thetaStop": 130, "thetaIncrement": 0.0398,
                 "phiStart": 0,    "phiStop": 360,   "phiIncrement": 0.08}}

    RIEGL theta is zenith measured from +Z in both layouts, which is already
    Phytograph/Helios's convention. Do not "fix" it.
    """
    try:
        with open(path, encoding="utf-8") as handle:
            doc = json.load(handle)
    except (OSError, ValueError):
        return None

    fov = doc.get("fov") if isinstance(doc, dict) else None
    if not isinstance(fov, dict):
        return None

    try:
        theta_min = float(fov["thetaStart"])
        theta_max = float(fov["thetaStop"])
        phi_min = float(fov["phiStart"])
        phi_max = float(fov["phiStop"])
    except (KeyError, TypeError, ValueError):
        return None

    def _inc(key: str) -> float:
        try:
            return float(fov.get(key, 0.0))
        except (TypeError, ValueError):
            return 0.0

    theta_inc = _inc("thetaIncrement")
    phi_inc = _inc("phiIncrement")

    params: dict = {
        "theta_min": theta_min,
        "theta_max": theta_max,
        "phi_min": phi_min,
        "phi_max": phi_max,
        "theta_increment": theta_inc,
        "phi_increment": phi_inc,
    }
    if theta_inc > 0:
        params["n_theta"] = int(round((theta_max - theta_min) / theta_inc)) + 1
    if phi_inc > 0:
        # Same fencepost rule as parse_pat: phi sweeps a full circle where the
        # last column coincides with the first, so this is a sample count.
        params["n_phi"] = int(round((phi_max - phi_min) / phi_inc))
    return params


# ---------------------------------------------------------------------------
# .PROJ pose / SOP sidecars
# ---------------------------------------------------------------------------
#
# A .PROJ carries real registration results, which a .riproject does not. Every
# transform is a small JSON file holding a 3x3 rotation plus a translation:
#
#     {"matrix3x3": [[...],[...],[...]], "translation": {"x":..,"y":..,"z":..}}
#
# THE CHAIN, VERIFIED NUMERICALLY against the project's own projectmap.json
# `coords_prcs` for all 9 registered positions of the reference olive project
# (max residual 7.8e-7 m):
#
#     SOP_PRCS = VPP.vop  o  plane_registration.sopv
#
# The per-position `Voxels1.VPP/ScanPosNNN.vop` files are NOT part of this
# chain. Composing them in shifts every position by 8-41 cm. They are voxel
# bookkeeping; leave them alone.
#
# PRCS IS A TRUE ENU FRAME. Deriving the local up/north from project.pop and
# expressing them back in PRCS gives (2e-11, -2e-10, 1) and (2e-11, 1, 2e-10) —
# so +Z is true up and +Y is true north to 1e-11. Registered scans therefore
# land plumb-level and north-aligned, which is why the SOP rotation decomposes
# into a large yaw (the scanner heading) plus a sub-2-degree plumb tilt.

_SOP_SOURCES = (
    # (filename, registration status). First hit wins.
    ("plane_registration.sopv", "registered"),
    ("voxel_registration.sopv", "registered"),
    ("pose_estimation.sop", "prior"),
)


def _matrix_from_sop(path: str) -> np.ndarray | None:
    """Load a RIEGL JSON transform sidecar as a 4x4."""
    try:
        with open(path, encoding="utf-8") as handle:
            doc = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(doc, dict):
        return None
    rot = doc.get("matrix3x3")
    trans = doc.get("translation")
    if not isinstance(rot, list) or len(rot) != 3:
        return None
    out = np.eye(4, dtype=np.float64)
    try:
        out[:3, :3] = np.asarray(rot, dtype=np.float64).reshape(3, 3)
    except (TypeError, ValueError):
        return None
    if isinstance(trans, dict):
        try:
            out[:3, 3] = [
                float(trans.get("x", 0.0)),
                float(trans.get("y", 0.0)),
                float(trans.get("z", 0.0)),
            ]
        except (TypeError, ValueError):
            return None
    return out


def load_sop(pos_dir: str, vpp_dir: str | None) -> tuple[np.ndarray, str]:
    """Resolve one scan position's SOCS -> PRCS transform and its provenance.

    Returns (4x4, status) where status is one of:

      "registered" — a .sopv from plane (or coarse voxel) registration. Placed
                     to the registration's own accuracy, millimetres here.
      "prior"      — only pose_estimation.sop, i.e. the inclinometer/compass/
                     GNSS estimate. Metre-level; the user should refine by ICP.
      "none"       — no pose at all (an aborted acquisition). Identity.

    The reference position is the reason "prior" is a first-class outcome and
    not an error: ScanPos001 of the reference project has NO .sopv, only
    pose_estimation.sop, whose euler angles (0.821, -1.356, -27.723) match its
    row in all_sopv.csv exactly. Registration has nothing to register the first
    position against, so its SOP legitimately comes from the pose estimate.
    """
    vpp = np.eye(4, dtype=np.float64)
    if vpp_dir:
        loaded = _matrix_from_sop(os.path.join(vpp_dir, "VPP.vop"))
        if loaded is not None:
            vpp = loaded

    for filename, status in _SOP_SOURCES:
        sop = _matrix_from_sop(os.path.join(pos_dir, filename))
        if sop is not None:
            return vpp @ sop, status

    return np.eye(4, dtype=np.float64), "none"


def decompose_sop(sop: np.ndarray) -> dict:
    """Split a SOP into the three knobs ScanParameters can actually hold.

    ScanParameters has no field for a general registration rotation — only
    `origin`, `azimuthOffsetDeg` (heading), and `tiltRollDeg`/`tiltPitchDeg`
    (plumb tilt). That is enough here precisely BECAUSE PRCS is a true ENU
    frame (see the chain note above): the SOP rotation is a large yaw plus the
    instrument's genuine sub-2-degree tilt off plumb, which is exactly what
    those fields describe.

    Yaw/pitch/roll are the intrinsic Z-Y-X decomposition, matching
    _ptx_decompose_pose in the backend so the two importers agree.

    NOTE ON DIVERGING FROM THE PTX RULE. _ptx_scan_params drops the azimuth
    sweep entirely once |roll| or |pitch| reaches 0.5 deg, because for a generic
    PTX pose those angles are an unmodellable rotation and reporting a rotated
    sweep as the instrument's own would be a lie. Here they are not generic:
    they are the inclinometer reading (pose_estimation.sop's `accuracy` block
    quotes ~0.01 deg on both), so emitting the tilt AND the yaw-corrected phi
    window is the honest description, not a fudge.
    """
    rot = np.asarray(sop, dtype=np.float64)[:3, :3]
    # Clamp guards against a rotation that is a hair outside [-1, 1] after the
    # matrix multiply, which would make asin raise.
    pitch = math.degrees(math.asin(max(-1.0, min(1.0, -rot[2, 0]))))
    roll = math.degrees(math.atan2(rot[2, 1], rot[2, 2]))
    yaw = math.degrees(math.atan2(rot[1, 0], rot[0, 0]))
    return {"yaw_deg": yaw, "pitch_deg": pitch, "roll_deg": roll}


def sensor_level_matrix(
    roll_deg: float,
    pitch_deg: float,
    origin: Sequence[float] | None = None,
) -> np.ndarray:
    """Build the 4x4 that LEVELS a scan using its own inclinometer.

    ROLL AND PITCH ONLY — the heading is deliberately not applied. See
    "WHY NO YAW" below; this is a measured decision, not an oversight.

    DIRECTION — AND WHICH FRAME THE POINTS ARE IN, which is the whole trap.
    The attitude Ry(pitch) @ Rx(roll) (the same intrinsic Z-Y-X decompose_sop
    reads back, with yaw held at zero) maps the INSTRUMENT's body frame to the
    world. The points arrive in SOCS, i.e. the body frame, so expressing them
    level in the world is `attitude @ p` — the attitude itself, NOT its
    transpose. Saying "levelling applies the inverse of the attitude" is true
    only of a vector already in world coordinates, which no point here is.

    An earlier revision returned the transpose on exactly that reasoning, and
    it shipped: measured on 2018-02-23.002, the ground plane went from 2.90 deg
    off level to 6.15 deg for ScanPos002 and 1.91 -> 3.42 for ScanPos001 —
    doubled, the signature of applying a rotation the wrong way round. With the
    attitude applied both positions land at 0.41 deg, and agreeing to 0.001 deg
    from two different tripod attitudes is what says the residual is the
    orchard's real slope rather than leftover sensor error.

    The unit test missed it by making the same transpose twice: it built its
    probe vector as `attitude @ [0,0,1]` (a WORLD-frame up) and asked the
    matrix to bring it back, which any exact inverse satisfies regardless of
    which direction the points need.
    test_sensor_level_matrix_levels_a_body_frame_ground_plane now samples a
    level plane in the body frame instead, which is what a point actually is,
    and test_sensor_level_matrix_transpose_would_double_the_tilt pins the
    doubling signature by name.

    WHY NO YAW. The same record carries a compass heading, and it is not good
    enough to apply. Measured against RiSCAN PRO's own SOPs:

        project          position     yaw_acc_deg    actual yaw error
        2018-02-23.002   ScanPos001        19.04              10.70
        2018-02-23.002   ScanPos004         2.98              10.68
        2017-12-15.001   ScanPos004         0.22              14.14

    The instrument's self-reported accuracy spans 86x while the true error
    stays flat at 10-14 deg, and the most confident reading is the worst one —
    so `yaw_acc_deg` cannot gate it either. Roll/pitch from the same record
    agree with RiSCAN to <=0.05 deg and <=0.008 deg, so the two halves of this
    pose have completely different trustworthiness. Heading stays ICP's job;
    yaw is carried in `sensor_pose` as metadata for a future coarse seed.
    """
    roll = math.radians(float(roll_deg))
    pitch = math.radians(float(pitch_deg))
    cr, sr = math.cos(roll), math.sin(roll)
    cp, sp = math.cos(pitch), math.sin(pitch)
    rx = np.array([[1.0, 0.0, 0.0], [0.0, cr, -sr], [0.0, sr, cr]])
    ry = np.array([[cp, 0.0, sp], [0.0, 1.0, 0.0], [-sp, 0.0, cp]])
    attitude = ry @ rx

    out = np.eye(4, dtype=np.float64)
    # The attitude itself, not its transpose — the points are body-frame. See
    # DIRECTION above; this was `.T` and doubled every scan's tilt.
    out[:3, :3] = attitude
    if origin is not None and len(origin) == 3:
        out[:3, 3] = [float(v) for v in origin]
    return out


def _pose_gnss(path: str) -> dict | None:
    """Read the GNSS fix out of a .PROJ `final.pose`.

    A .riproject can only reach its GNSS through the housekeeping stream, which
    means decoding points just to learn where the scanner stood. A .PROJ states
    it as JSON, so this is a few hundred bytes instead of a bounded prefix read
    of a 150 MB file. Height is `altitude`, which is ellipsoidal and matches the
    EPSG::4979 the file declares — same datum the hk path yields, so both feed
    gnss_to_enu unchanged.
    """
    try:
        with open(path, encoding="utf-8") as handle:
            doc = json.load(handle)
    except (OSError, ValueError):
        return None
    gnss = doc.get("gnss") if isinstance(doc, dict) else None
    if not isinstance(gnss, dict):
        return None
    try:
        lat = float(gnss["latitude"])
        lon = float(gnss["longitude"])
        height = float(gnss.get("altitude", 0.0))
    except (KeyError, TypeError, ValueError):
        return None
    if not (_LAT_RANGE[0] <= lat <= _LAT_RANGE[1]):
        return None
    if not (_LON_RANGE[0] <= lon <= _LON_RANGE[1]):
        return None
    return {
        "latitude": lat,
        "longitude": lon,
        "height_m": height,
        "height_datum": "ellipsoidal",
        "satellites": gnss.get("numSatellites"),
        "fix_info": gnss.get("fixInfo"),
    }



# ---------------------------------------------------------------------------
# hk_gps_hr — scanner GNSS position
# ---------------------------------------------------------------------------

# Field layout, verified against this project's data and cross-checked against
# an independent raw-float64 scan of the same files (agreement to 7 decimals):
#
#   hk_gps_hr (10020.0), <systime>, <ecef_x_mm>, <ecef_y_mm>, <ecef_z_mm>,
#                        <?>, <lon*1e9>, <lat*1e9>, <height_mm>, ...
#
# Longitude precedes latitude, both as integers scaled by 1e9. Height is
# millimetres and is ELLIPSOIDAL, so near Davis CA it reads about -26.7 m while
# the orthometric elevation is about +16 m (geoid separation ~ -30 m). Do not
# present it as elevation without a geoid model.
_HK_GPS_LON_IDX = 5
_HK_GPS_LAT_IDX = 6
_HK_GPS_HEIGHT_IDX = 7

_LAT_RANGE = (-90.0, 90.0)
_LON_RANGE = (-180.0, 180.0)


def parse_hk_gps(hk_path: str) -> dict | None:
    """Extract the first plausible GNSS fix from a demultiplexed housekeeping file.

    Records appear at ~1 Hz for the duration of the scan (162 of them in the
    reference project). We take the FIRST rather than averaging: it is the fix
    closest to the moment the scan started, and later records drift by ~1 m as
    the receiver wanders. Averaging would blend a moving estimate and blur the
    relative geometry between positions, which is the only thing that matters
    for seeding ICP.
    """
    try:
        with open(hk_path, encoding="latin-1", errors="replace") as handle:
            lines = handle.readlines()
    except OSError:
        return None

    for line in lines:
        if not line.startswith("hk_gps_hr"):
            continue
        # Drop the "hk_gps_hr (10020.0)" prefix, keep the numeric fields.
        _, _, rest = line.partition(",")
        fields = [f.strip() for f in rest.split(",") if f.strip()]
        if len(fields) <= _HK_GPS_HEIGHT_IDX:
            continue
        try:
            lon = int(fields[_HK_GPS_LON_IDX]) / 1e9
            lat = int(fields[_HK_GPS_LAT_IDX]) / 1e9
            height = int(fields[_HK_GPS_HEIGHT_IDX]) / 1000.0
        except (ValueError, IndexError):
            continue
        # A receiver with no lock emits zeros/garbage; reject anything that is
        # not a plausible coordinate rather than placing a scan at null island.
        if not (_LAT_RANGE[0] <= lat <= _LAT_RANGE[1]):
            continue
        if not (_LON_RANGE[0] <= lon <= _LON_RANGE[1]):
            continue
        if lat == 0.0 and lon == 0.0:
            continue
        return {
            "latitude": lat,
            "longitude": lon,
            "height_m": height,
            "height_datum": "ellipsoidal",
        }
    return None


# hk_incl's raw int16 counts are MILLIDEGREES. RiVLib's own data spec says so
# outright — `include/riegl/ridataspec.hpp`, struct hk_incl (id_main = 10006):
#
#     int16_t ROLL;   //!<  inclination angle along x-axis   [0.001 deg ]
#     int16_t PITCH;  //!<  inclination angle along y-axis   [0.001 deg ]
#
# corroborated by RIEGL's SDK consumer rivlib-utils, which applies
# `arg.ROLL * 0.001` in src/inclination.cpp. An earlier revision of this file
# said the units were unconfirmed and passed the counts through untouched;
# that was wrong, and the check was a grep of the vendored headers away.
_HK_INCL_TO_DEG = 0.001


def parse_hk_inclination(hk_path: str) -> dict | None:
    """Average the scan's inclination readings, in degrees.

    Format is `hk_incl (10006.0), <roll>, <pitch>, <t1>, <t2>`, emitted at ~1 Hz
    for the duration of the scan (~162 records over ~90 s).

    We AVERAGE rather than take the first, which is the opposite of
    parse_hk_gps's deliberate first-fix rule. The reasoning differs because the
    signals differ: a GNSS receiver wanders ~1 m over a scan, so averaging
    blends a moving estimate, whereas a levelled tripod does not drift and the
    ~0.01 deg spread between inclinometer records is pure sensor noise. Taking
    one sample throws away a 160x noise reduction for nothing.

    Verified against RiSCAN PRO's own SOPs on two independent projects: the
    resulting roll/pitch agree to <=0.05 deg and <=0.008 deg respectively.
    """
    rolls: list[float] = []
    pitches: list[float] = []
    try:
        with open(hk_path, encoding="latin-1", errors="replace") as handle:
            for line in handle:
                if not line.startswith("hk_incl"):
                    continue
                _, _, rest = line.partition(",")
                fields = [f.strip() for f in rest.split(",") if f.strip()]
                if len(fields) < 2:
                    continue
                try:
                    rolls.append(int(fields[0]) * _HK_INCL_TO_DEG)
                    pitches.append(int(fields[1]) * _HK_INCL_TO_DEG)
                except ValueError:
                    continue
    except OSError:
        return None
    if not rolls:
        return None
    return {
        "roll_deg": sum(rolls) / len(rolls),
        "pitch_deg": sum(pitches) / len(pitches),
        "sample_count": len(rolls),
    }


# scanner_pose_hr (id_main = 72) field order, fixed by the bit offsets in
# RiVLib's ridataspec.hpp (0/64/128/192 for the doubles, then 256..480 for the
# floats — contiguous, no padding):
_POSE_HR_FIELDS = (
    "latitude", "longitude", "height_m", "hmsl_m",
    "roll_deg", "pitch_deg", "yaw_deg",
    "h_acc_m", "v_acc_m", "roll_acc_deg", "pitch_acc_deg", "yaw_acc_deg",
)


def parse_scanner_pose_hr(hk_path: str) -> dict | None:
    """Read the instrument's own fused attitude, if the scan recorded one.

    `scanner_pose_hr` is the VZ-1000's GNSS + inclinometer + compass solution,
    already in DEGREES under the convention RIEGL documents in its own ROS2
    package (riegl_vz/pose.py): roll about +X, pitch about +Y, yaw about +Z,
    all counter-clockwise, composed intrinsic Z-Y-X. That is exactly what
    decompose_sop produces, so the two paths agree without conversion.

    Only reachable through the "all" demultiplexer selector, not the
    "status protocol" one the rest of this module uses.

    TWO REAL-DATA HAZARDS, both observed on VZ-1000 captures:

      * The FIRST record is routinely all-NaN — a pose row written before the
        GNSS fix resolves. Every field, not just the position ones.
      * Some positions emit ONLY NaN rows (4 of 8 in one project). A scan
        position legitimately having no pose is not an error; the caller falls
        back to hk_incl and then to no levelling at all.

    So this scans for the first row that is finite THROUGHOUT, and returns None
    rather than raising when there is none.
    """
    try:
        with open(hk_path, encoding="latin-1", errors="replace") as handle:
            for line in handle:
                if not line.startswith("scanner_pose_hr"):
                    continue
                _, _, rest = line.partition(",")
                fields = [f.strip() for f in rest.split(",") if f.strip()]
                if len(fields) < len(_POSE_HR_FIELDS):
                    continue
                try:
                    values = [
                        float(f) for f in fields[: len(_POSE_HR_FIELDS)]
                    ]
                except ValueError:
                    continue
                if not all(math.isfinite(v) for v in values):
                    continue
                return dict(zip(_POSE_HR_FIELDS, values))
    except OSError:
        return None
    return None


def attach_sensor_pose(entry: dict, hk_path: str) -> None:
    """Record whatever attitude this scan position measured, if any.

    Writes `entry["sensor_pose"]` with roll/pitch in degrees plus a `source`
    naming where they came from, and leaves the entry untouched when the
    position measured nothing.

    PRECEDENCE, best first:
      "scanner_pose_hr" — the instrument's own fused solution. Also carries a
                          heading, kept as metadata but never applied (see
                          sensor_level_matrix).
      "hk_incl"         — the raw inclinometer, averaged over the scan. No
                          heading at all.
      (absent)          — the position has neither, and imports unlevelled.

    That last case is ordinary, not exceptional: 4 of 8 positions in one real
    project emit only NaN pose rows. Callers must treat a missing `sensor_pose`
    as "no levelling available" rather than as an error.
    """
    pose = parse_scanner_pose_hr(hk_path)
    if pose is not None:
        entry["sensor_pose"] = {
            "roll_deg": pose["roll_deg"],
            "pitch_deg": pose["pitch_deg"],
            # Carried for a future coarse-ICP seed. NOT applied — the compass
            # is 10-14 deg wrong on measured data and its own accuracy figure
            # does not predict that.
            "yaw_deg": pose["yaw_deg"],
            "yaw_acc_deg": pose["yaw_acc_deg"],
            "roll_acc_deg": pose["roll_acc_deg"],
            "pitch_acc_deg": pose["pitch_acc_deg"],
            "source": "scanner_pose_hr",
        }
        return

    incl = parse_hk_inclination(hk_path)
    if incl is not None:
        entry["sensor_pose"] = {
            "roll_deg": incl["roll_deg"],
            "pitch_deg": incl["pitch_deg"],
            "sample_count": incl["sample_count"],
            "source": "hk_incl",
        }


# ---------------------------------------------------------------------------
# Project + scan-position discovery
# ---------------------------------------------------------------------------


LAYOUT_RIPROJECT = "riproject"
LAYOUT_PROJ = "proj"

# A .PROJ nests its scans one level deeper than a .riproject and suffixes the
# position directory. Everything else that differs (pattern file, GNSS source,
# registration) hangs off that one structural fact.
_PROJ_SCANPOS_GLOB = "ScanPos*.SCNPOS"
_PROJ_MANIFEST = "project.json"

# Companion streams that sit beside the real .rxp and must never be mistaken for
# it: .mon.rxp is the housekeeping subset, .residual.rxp the MTA leftovers.
_RXP_COMPANIONS = (".mon.rxp", ".residual.rxp")


def detect_layout(project_dir: str) -> str:
    """Classify a RIEGL project directory by its structure, not its suffix.

    Structure rather than the folder name because the two layouts are told
    apart reliably by what is inside them, while the suffix is only a
    convention: the reference .PROJ is a directory of ScanPosNNN.SCNPOS beside a
    project.json manifest, and a .riproject is a flat set of ScanPosNNN folders
    with no manifest at all.
    """
    if glob.glob(os.path.join(project_dir, _PROJ_SCANPOS_GLOB)) or os.path.isfile(
        os.path.join(project_dir, _PROJ_MANIFEST)
    ):
        return LAYOUT_PROJ
    return LAYOUT_RIPROJECT


def _main_rxp(candidates: list[str]) -> str | None:
    hits = [p for p in sorted(candidates) if not p.endswith(_RXP_COMPANIONS)]
    return hits[0] if hits else None


def _read_proj_manifest(project_dir: str) -> dict:
    """Index project.json's registration list by scan-position name.

    Used only to ENRICH filesystem discovery, never to drive it — see
    find_scan_positions for why.
    """
    try:
        with open(os.path.join(project_dir, _PROJ_MANIFEST), encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError):
        return {}
    if not isinstance(doc, dict):
        return {}
    out: dict = {"_scanner": doc.get("scanner") or {}, "_location": doc.get("location")}
    reg = doc.get("registration") or {}
    for item in reg.get("scanpositions") or []:
        if isinstance(item, dict) and item.get("name"):
            out[item["name"]] = item
    return out


def _find_proj_positions(project_dir: str) -> list[dict]:
    """Enumerate a .PROJ's scan positions from the FILESYSTEM.

    Discovery is deliberately filesystem-driven and only enriched by
    project.json, because the manifest is an incomplete record of what was
    acquired. In the reference olive project there are 25 ScanPos*.SCNPOS
    directories but the manifest lists 23: ScanPos019 holds a perfectly good
    17 MB .rxp from an aborted acquisition and appears nowhere in the manifest,
    and ScanPos025 is an empty shell. Trusting the manifest would silently drop
    real point data; trusting the filesystem and skipping positions with no .rxp
    handles both.
    """
    manifest = _read_proj_manifest(project_dir)
    vpp_default = os.path.join(project_dir, "Voxels1.VPP")

    positions: list[dict] = []
    for pos_dir in sorted(glob.glob(os.path.join(project_dir, _PROJ_SCANPOS_GLOB))):
        if not os.path.isdir(pos_dir):
            continue
        name = os.path.basename(pos_dir)
        if name.endswith(".SCNPOS"):
            name = name[: -len(".SCNPOS")]

        rxp = _main_rxp(glob.glob(os.path.join(pos_dir, "scans", "*.rxp")))
        if rxp is None:
            # ScanPos025: directory exists, nothing was ever written into it.
            continue

        stem = os.path.basename(rxp)[: -len(".rxp")]
        scn = os.path.join(pos_dir, "scans", stem + ".scn")
        pose = os.path.join(pos_dir, "final.pose")

        entry = manifest.get(name) or {}
        vpp_name = entry.get("vpp")
        vpp_dir = os.path.join(project_dir, vpp_name) if vpp_name else vpp_default
        if not os.path.isdir(vpp_dir):
            vpp_dir = None

        sop, status = load_sop(pos_dir, vpp_dir)
        positions.append(
            {
                "name": name,
                "layout": LAYOUT_PROJ,
                "rxp_path": rxp,
                "pat_path": None,
                "scn_path": scn if os.path.exists(scn) else None,
                "pose_path": pose if os.path.exists(pose) else None,
                "pos_dir": pos_dir,
                "size_bytes": os.path.getsize(rxp),
                "sop": sop,
                "registration": status,
                # The manifest's own verdict, kept distinct from `registration`:
                # a position can carry a .sopv and still be flagged failed, and
                # a position can be absent from the manifest entirely.
                "manifest_success": entry.get("success"),
            }
        )
    return positions


def _find_riproject_positions(project_dir: str) -> list[dict]:
    """Enumerate a raw .riproject's ScanPos* directories.

    A raw .riproject is a flat directory of ScanPos### folders plus top-level
    poslog_*.rxp files; there is no manifest to parse (unlike a RiSCAN project,
    which has project.rsp). Sorting keeps ScanPos001..006 in field order.

    Each position holds `<stamp>.rxp` (the points) and `<stamp>.mon.rxp` (a
    housekeeping subset of the same record stream). We deliberately read only
    the main .rxp: it carries the housekeeping records too, so opening the .mon
    file as well would double the work and add a way for the two to disagree.
    """
    positions: list[dict] = []
    for scan_dir in sorted(glob.glob(os.path.join(project_dir, "ScanPos*"))):
        if not os.path.isdir(scan_dir):
            continue
        rxp = _main_rxp(glob.glob(os.path.join(scan_dir, "*.rxp")))
        if rxp is None:
            continue
        stem = os.path.basename(rxp)[: -len(".rxp")]
        pat = os.path.join(scan_dir, stem + ".pat")
        positions.append(
            {
                "name": os.path.basename(scan_dir),
                "layout": LAYOUT_RIPROJECT,
                "rxp_path": rxp,
                "pat_path": pat if os.path.exists(pat) else None,
                "scn_path": None,
                "pose_path": None,
                "pos_dir": scan_dir,
                "size_bytes": os.path.getsize(rxp),
                # Raw projects carry no registration whatsoever.
                "sop": None,
                "registration": "none",
                "manifest_success": None,
            }
        )
    return positions


def find_scan_positions(project_dir: str) -> list[dict]:
    """Enumerate scan positions in either supported project layout."""
    if detect_layout(project_dir) == LAYOUT_PROJ:
        return _find_proj_positions(project_dir)
    return _find_riproject_positions(project_dir)


def scan_params_for(pos: dict) -> dict | None:
    """Parse whichever scan-pattern file this layout uses."""
    if pos.get("scn_path"):
        return parse_scn(pos["scn_path"])
    if pos.get("pat_path"):
        return parse_pat(pos["pat_path"])
    return None


def _uri(path: str) -> str:
    """RiVLib takes URIs, not paths — `file:` for local reads."""
    return "file:" + path


def _instrument_from_meta(meta: dict) -> dict:
    pc = meta.get("pointcloud", {}) if isinstance(meta, dict) else {}
    out: dict = {}
    for key, target in (
        ("type_id", "model"),
        ("serial", "serial"),
        ("wavelength", "wavelength_m"),
        ("pulse_repetition_rate", "pulse_repetition_rate_hz"),
        ("unambiguous_range", "unambiguous_range_m"),
    ):
        if key in pc:
            value = pc[key]
            if target != "model" and target != "serial":
                try:
                    value = float(value)
                except (TypeError, ValueError):
                    continue
            out[target] = value
    return out


def read_scan(
    ifc: _Scanifc,
    rxp_path: str,
    hk_path: str,
    *,
    count_points: bool,
    max_points: int | None = None,
) -> dict:
    """Open one .rxp, harvest metadata, and optionally stream all its points.

    Points are read whenever `count_points` is set, because the housekeeping
    stream is written as a SIDE EFFECT of reading the point stream — RiVLib does
    not expose it independently. So a metadata-only inspect still has to pull
    some points to get a GNSS fix; `max_points` bounds that work.

    The sidecar uses the ALL selector rather than "status protocol" because
    `scanner_pose_hr` — the instrument's own attitude — appears only there. It
    costs a larger sidecar file and no extra decoding, since the records ride
    the same pass over the points.
    """
    handle = ifc.open(_uri(rxp_path), hk_path=hk_path, selector=HK_SELECTOR_ALL)
    try:
        meta = ifc.meta(handle)

        total = 0
        hits = 0
        mins = np.full(3, np.inf)
        maxs = np.full(3, -np.inf)

        xyz_buf = (ScanifcXYZ * _READ_CHUNK)()
        attr_buf = (ScanifcAttributes * _READ_CHUNK)()
        time_buf = (ctypes.c_uint64 * _READ_CHUNK)()
        got = ctypes.c_uint32()
        end_of_frame = ctypes.c_int32()

        while True:
            if max_points is not None and total >= max_points:
                break
            rc = ifc.lib.scanifc_point3dstream_read(
                handle,
                _READ_CHUNK,
                xyz_buf,
                attr_buf,
                time_buf,
                ctypes.byref(got),
                ctypes.byref(end_of_frame),
            )
            if rc != 0:
                raise RxpError(f"read failed: {ifc._last_error()}")
            n = got.value
            if n == 0 and end_of_frame.value == 0:
                break
            if n == 0:
                continue

            total += n
            if count_points:
                # One bulk copy per batch: viewing the ctypes array through
                # numpy and slicing is far cheaper than a Python-level loop.
                arr = np.ctypeslib.as_array(xyz_buf)[:n]
                pts = np.stack((arr["x"], arr["y"], arr["z"]), axis=1).astype(
                    np.float64
                )
                ranges = np.linalg.norm(pts, axis=1)
                keep = ranges > _MIN_RANGE_M
                if keep.any():
                    kept = pts[keep]
                    hits += int(keep.sum())
                    mins = np.minimum(mins, kept.min(axis=0))
                    maxs = np.maximum(maxs, kept.max(axis=0))

        result: dict = {
            "point_count": total,
            "instrument": _instrument_from_meta(meta),
        }
        if count_points and hits:
            result["hit_count"] = hits
            result["bbox_local"] = {
                "min": [float(v) for v in mins],
                "max": [float(v) for v in maxs],
            }
        return result
    finally:
        ifc.close(handle)


# ---------------------------------------------------------------------------
# Local ENU
# ---------------------------------------------------------------------------

_WGS84_A = 6378137.0
_WGS84_F = 1.0 / 298.257223563
_WGS84_E2 = _WGS84_F * (2.0 - _WGS84_F)


def gnss_to_enu(fixes: list[dict | None]) -> list[dict | None]:
    """Convert per-scan lat/lon/height to metres in a local ENU frame anchored
    at the centroid of the fixes.

    Anchoring at the centroid (rather than using raw lat/lon, or ECEF, or UTM)
    keeps every coordinate small and near the origin. That matters downstream:
    the renderer path has already been bitten twice by large absolute
    coordinates — float32 parsing collapsing distinct UTM positions, and LAS
    int32 offsets overflowing on projected clouds. Small numbers avoid both.

    Uses the proper WGS84 meridional/normal radii rather than a flat
    degrees-to-metres constant, since the scale error of the naive version is
    ~0.3% at this latitude and would show up as a systematic stretch across a
    survey.
    """
    valid = [f for f in fixes if f is not None]
    if not valid:
        return [None] * len(fixes)

    lat0 = sum(f["latitude"] for f in valid) / len(valid)
    lon0 = sum(f["longitude"] for f in valid) / len(valid)
    h0 = sum(f["height_m"] for f in valid) / len(valid)

    lat0_rad = math.radians(lat0)
    sin_lat = math.sin(lat0_rad)
    denom = math.sqrt(1.0 - _WGS84_E2 * sin_lat * sin_lat)
    # Metres per radian, north and east, at the anchor latitude.
    m_per_rad_north = _WGS84_A * (1.0 - _WGS84_E2) / (denom**3)
    m_per_rad_east = _WGS84_A * math.cos(lat0_rad) / denom

    out: list[dict | None] = []
    for fix in fixes:
        if fix is None:
            out.append(None)
            continue
        out.append(
            {
                "east_m": math.radians(fix["longitude"] - lon0) * m_per_rad_east,
                "north_m": math.radians(fix["latitude"] - lat0) * m_per_rad_north,
                "up_m": fix["height_m"] - h0,
            }
        )
    return out


def anchor_of(fixes: list[dict | None]) -> dict | None:
    valid = [f for f in fixes if f is not None]
    if not valid:
        return None
    return {
        "latitude": sum(f["latitude"] for f in valid) / len(valid),
        "longitude": sum(f["longitude"] for f in valid) / len(valid),
        "height_m": sum(f["height_m"] for f in valid) / len(valid),
        "height_datum": "ellipsoidal",
    }


# ---------------------------------------------------------------------------
# Echo flags -> target_index / target_count
# ---------------------------------------------------------------------------

# Phytograph's multi-return tooling (LAD's _LAD_MULTI_RETURN_COLUMNS, the
# gap-fill path, multi-return triangulation) reads a 1-based target_index and a
# target_count per point. Both are fully recoverable from the .rxp:
#
# THE SCANNER STAMPS EVERY RETURN OF ONE PULSE WITH THE SAME TIMESTAMP, so a run
# of consecutive equal `scanifc_time_ns` values IS a pulse. Verified exhaustively
# over all 13,083,685 points of ScanPos001: timestamps are monotonic
# non-decreasing, runs partition into 10,681,059 pulses, and EVERY run matches
# the echo flags exactly -- runlen 1 is always `single`, runlen 2 is always
# (first, last), runlen 3 is always (first, interior, last), with ZERO
# violations and a max of 3 returns per pulse.
#
# So target_index is the 1-based position within the run and target_count is the
# run length. The echo bits (flags & 0x3: 0 single, 1 first, 2 interior, 3 last;
# riegl/detail/pointsifc_t.h) are then redundant, which is exactly why they make
# a good cross-check -- `validate_against_echo` below asserts the two agree
# rather than trusting the grouping blindly.
_ECHO_SINGLE = 0
_ECHO_FIRST = 1
_ECHO_INTERIOR = 2
_ECHO_LAST = 3


def targets_from_timestamps(
    timestamps: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Group returns into pulses by identical timestamp.

    Returns (target_index, target_count) as float32, 1-based, both exact.

    Vectorised because this runs over ~14 M points per scan: run boundaries come
    from a single diff, and the within-run index is a cumulative count minus the
    running start offset.
    """
    n = timestamps.size
    if n == 0:
        empty = np.empty((0,), dtype=np.float32)
        return empty, empty

    # Boundary flags: True where a new pulse starts.
    starts = np.empty(n, dtype=bool)
    starts[0] = True
    np.not_equal(timestamps[1:], timestamps[:-1], out=starts[1:])

    start_idx = np.flatnonzero(starts)
    run_lengths = np.diff(np.append(start_idx, n))

    # 1-based position within each run: global position minus the run's start.
    target_index = (
        np.arange(n, dtype=np.int64) - np.repeat(start_idx, run_lengths) + 1
    )
    target_count = np.repeat(run_lengths, run_lengths)

    return target_index.astype(np.float32), target_count.astype(np.float32)


def decode_flags(flags: np.ndarray) -> dict:
    """Split the per-point `flags` bitfield into named scalar columns.

    RiVLib packs several independent facts into one uint16
    (riegl/detail/pointsifc_t.h). Only bits 0-1 (the echo type) were being read,
    for the multi-return cross-check, and the rest were discarded — including
    `pseudo_echo`, which flags a SYNTHETIC return at a fixed 0.1 m range rather
    than a real measurement. Those were importing as ordinary points.

      bit0-1  echo type (0 single, 1 first, 2 interior, 3 last)
      bit3    waveform available
      bit4    pseudo echo, fixed range 0.1 m  -> not a real target
      bit5    target calculated in software rather than detected
      bit6    pps not older than 1.5 s
      bit7    time is in the pps timeframe   -> the timestamp is GPS-locked
      bit8-9  mirror facet number (0-3)
      bit13   line stop
    """
    f = flags.astype(np.uint16)
    return {
        "echo_type": (f & 0x3).astype(np.float32),
        "waveform_available": ((f >> 3) & 0x1).astype(np.float32),
        "pseudo_echo": ((f >> 4) & 0x1).astype(np.float32),
        "sw_calculated": ((f >> 5) & 0x1).astype(np.float32),
        "pps_locked": ((f >> 7) & 0x1).astype(np.float32),
        "facet": ((f >> 8) & 0x3).astype(np.float32),
    }


def validate_against_echo(
    target_index: np.ndarray, target_count: np.ndarray, flags: np.ndarray
) -> int:
    """Cross-check timestamp grouping against RiVLib's own echo classification.

    Returns the number of disagreeing points (0 on healthy data). The two
    encodings are independent, so a non-zero count means the timestamp
    assumption does not hold for this file -- e.g. an instrument that does not
    share a timestamp across returns, or a stream read with sync_to_pps where
    timestamps are rewritten. The caller surfaces it rather than silently
    shipping wrong multi-return data into LAD.
    """
    echo = (flags & 0x3).astype(np.uint8)
    expected = np.where(
        target_count <= 1,
        _ECHO_SINGLE,
        np.where(
            target_index == 1,
            _ECHO_FIRST,
            np.where(target_index == target_count, _ECHO_LAST, _ECHO_INTERIOR),
        ),
    ).astype(np.uint8)
    return int(np.count_nonzero(expected != echo))


# ---------------------------------------------------------------------------
# LAS extraction
# ---------------------------------------------------------------------------

# Conventions mirrored from the backend's own writers (_e57_to_las,
# _session_to_las) so an extracted file is indistinguishable from any other
# Phytograph LAS on the import path:
#   * point_format 3, LAS 1.4
#   * scales 0.001 (1 mm)
#   * offsets floor(min) — NOT zero. Large absolute coordinates otherwise
#     overflow the LAS int32 range; this bit the project once already on
#     projected/UTM clouds. Scanner-local coords are small, but the rule is
#     cheap and keeps every writer consistent.
#   * extra dims float32, named with the backend's canonical slugs.
_LAS_SCALE = 0.001
_LAS_POINT_FORMAT = 3
_LAS_VERSION = "1.4"

_MISS_SLUG = "is_miss"

_EXTRA_DIMS = (
    (_MISS_SLUG, "Miss"),
    ("reflectance", "Reflectance"),
    ("amplitude", "Amplitude"),
    ("deviation", "Deviation"),
    ("target_index", "Target Index"),
    ("target_count", "Target Count"),
)


def extract_scan(
    ifc: _Scanifc,
    rxp_path: str,
    out_las: str,
    hk_path: str,
    *,
    progress=None,
) -> dict:
    """Stream one .rxp into a LAS file, returning a metadata summary.

    Points are accumulated in memory before writing. A VZ-1000 position runs
    ~14 M points, which is ~170 MB of float64 xyz plus ~110 MB of float32
    attributes — comfortable, and it keeps the writer to a single pass. If a
    future instrument makes that untenable, laspy supports chunked appends.

    MISSES ARE NOT RECOVERED HERE. A .rxp records only returns; no-return shots
    are simply absent rather than flagged, so `is_miss` is written as all-zero
    and the caller reports has_misses=false. Synthesising misses from the .pat
    raster is deliberately Phase 7 work — it needs the true beam grid, and
    getting it wrong corrupts LAD silently rather than erroring.
    """
    import laspy  # imported lazily so `inspect` works without laspy present

    handle = ifc.open(_uri(rxp_path), hk_path=hk_path, selector=HK_SELECTOR_ALL)
    try:
        meta = ifc.meta(handle)

        xyz_chunks: list[np.ndarray] = []
        refl_chunks: list[np.ndarray] = []
        ampl_chunks: list[np.ndarray] = []
        dev_chunks: list[np.ndarray] = []
        flag_chunks: list[np.ndarray] = []
        time_chunks: list[np.ndarray] = []

        xyz_buf = (ScanifcXYZ * _READ_CHUNK)()
        attr_buf = (ScanifcAttributes * _READ_CHUNK)()
        time_buf = (ctypes.c_uint64 * _READ_CHUNK)()
        got = ctypes.c_uint32()
        end_of_frame = ctypes.c_int32()

        total = 0
        while True:
            rc = ifc.lib.scanifc_point3dstream_read(
                handle,
                _READ_CHUNK,
                xyz_buf,
                attr_buf,
                time_buf,
                ctypes.byref(got),
                ctypes.byref(end_of_frame),
            )
            if rc != 0:
                raise RxpError(f"read failed: {ifc._last_error()}")
            n = got.value
            if n == 0 and end_of_frame.value == 0:
                break
            if n == 0:
                continue

            xyz_view = np.ctypeslib.as_array(xyz_buf)[:n]
            attr_view = np.ctypeslib.as_array(attr_buf)[:n]

            # Each append MUST materialise a new array, because the ctypes
            # buffers are reused on the next read() and a view would alias the
            # following batch's bytes. `np.stack` and `.astype()` (which
            # defaults to copy=True) both do that already, so no explicit
            # .copy() is needed here — but if either is ever swapped for a
            # zero-copy form (astype(..., copy=False), a bare view, or a slice),
            # add one back or every chunk will end up holding the last batch.
            xyz_chunks.append(
                np.stack(
                    (xyz_view["x"], xyz_view["y"], xyz_view["z"]), axis=1
                ).astype(np.float64)
            )
            refl_chunks.append(attr_view["reflectance"].astype(np.float32))
            ampl_chunks.append(attr_view["amplitude"].astype(np.float32))
            dev_chunks.append(attr_view["deviation"].astype(np.float32))
            flag_chunks.append(attr_view["flags"].astype(np.uint16))
            # Timestamps group returns into pulses. They are concatenated and
            # grouped ONCE over the whole scan rather than per batch: a pulse's
            # returns can straddle a read boundary, and grouping per batch would
            # split it into two short pulses, mislabelling both.
            time_chunks.append(np.ctypeslib.as_array(time_buf)[:n].astype(np.uint64))

            total += n
            if progress is not None and total % (_READ_CHUNK * 10) == 0:
                progress(total)

        if total == 0:
            raise RxpError(f"{rxp_path} contained no points")

        xyz = np.concatenate(xyz_chunks, axis=0)
        reflectance = np.concatenate(refl_chunks, axis=0)
        amplitude = np.concatenate(ampl_chunks, axis=0)
        deviation = np.concatenate(dev_chunks, axis=0)
        flags = np.concatenate(flag_chunks, axis=0)
        timestamps = np.concatenate(time_chunks, axis=0)
        del xyz_chunks, refl_chunks, ampl_chunks, dev_chunks, flag_chunks
        del time_chunks

        target_index, target_count = targets_from_timestamps(timestamps)
        echo_mismatches = validate_against_echo(target_index, target_count, flags)
        max_returns = int(target_count.max()) if target_count.size else 0

        header = laspy.LasHeader(
            point_format=_LAS_POINT_FORMAT, version=_LAS_VERSION
        )
        header.scales = np.array([_LAS_SCALE] * 3, dtype=np.float64)
        header.offsets = np.floor(xyz.min(axis=0))
        for slug, _label in _EXTRA_DIMS:
            header.add_extra_dim(
                laspy.ExtraBytesParams(name=slug, type=np.float32)
            )

        record = laspy.ScaleAwarePointRecord.zeros(total, header=header)
        record.x = xyz[:, 0]
        record.y = xyz[:, 1]
        record.z = xyz[:, 2]

        # LAS `intensity` is uint16 and is what the viewer colours by default.
        # RIEGL reflectance is dB relative to a white diffuse target and is
        # negative for most natural surfaces, so it is rescaled rather than
        # cast. The window matches PDAL's rxp reader defaults (-25..+5 dB), so
        # a Phytograph import and a PDAL import of the same scan shade alike.
        refl_lo, refl_hi = -25.0, 5.0
        norm = (reflectance - refl_lo) / (refl_hi - refl_lo)
        record.intensity = (np.clip(norm, 0.0, 1.0) * 65535).astype(np.uint16)

        # Full-precision values are preserved in the extra dims; `intensity` is
        # only the display channel.
        record[_MISS_SLUG] = np.zeros(total, dtype=np.float32)
        record["reflectance"] = reflectance
        record["amplitude"] = amplitude
        record["deviation"] = deviation
        record["target_index"] = target_index
        record["target_count"] = target_count

        with laspy.open(out_las, mode="w", header=header) as writer:
            writer.write_points(record)

        result = {
            "point_count": total,
            "instrument": _instrument_from_meta(meta),
            "bbox_local": {
                "min": [float(v) for v in xyz.min(axis=0)],
                "max": [float(v) for v in xyz.max(axis=0)],
            },
            # This LAS path writes RETURNS ONLY — `is_miss` is zeroed a few
            # lines up, because recovering no-return shots happens in the
            # streaming path (which is what the app uses) and not here. So the
            # counts are stated as the constants they are, rather than read
            # from the miss-recovery variables that only exist over there:
            # naming those was a NameError that killed `extract` after the
            # .las had already been written, making a complete file look like
            # a failed run.
            "has_misses": False,
            "hit_count": total,
            "miss_count": 0,
            "max_returns_per_pulse": max_returns,
            "extra_dims": [
                {"slug": slug, "label": label} for slug, label in _EXTRA_DIMS
            ],
        }
        if echo_mismatches:
            # Loud, not fatal: the points and every other column are still
            # correct, but multi-return consumers must not trust these two.
            result["warning"] = (
                f"{echo_mismatches} of {total} points disagree with RiVLib's echo "
                "classification, so returns could not be grouped into pulses "
                "reliably. target_index/target_count may be wrong; do not use "
                "this scan for multi-return analysis."
            )
            result["echo_mismatches"] = echo_mismatches
        return result
    finally:
        ifc.close(handle)


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Streaming extraction (stdout binary protocol)
# ---------------------------------------------------------------------------
#
# WHY STREAM INSTEAD OF WRITING LAS HERE: measured on a 13.1 M-point position,
# RiVLib decoding costs ~7 s but encoding a LAS costs ~37 s — 84% of the work,
# purely serialisation. The SAME laspy write takes ~1.2 s on the arm64 host:
# x86 emulation is ~30x slower at the bit-packing. So the container should do
# only what it alone can do (call RiVLib) and hand raw arrays to the host, which
# writes the LAS PotreeConverter needs at native speed. That also removes ~800 MB
# of disk round-trip per position.
#
# TRANSPORT: one raw array file per column, per scan, in a bind-mounted dir.
#
# NOT stdout. Measured on the same machine moving 1 GB container->host with no
# RIEGL code involved: a Docker stdout pipe runs at ~32 MB/s, a bind-mounted
# file at ~880 MB/s write (and 3.5 GB/s read back). At 576 MB per position the
# pipe alone cost ~20 s of a ~40 s import — roughly half the total. Writing raw
# arrays keeps the win that mattered (no LAS bit-packing under x86 emulation,
# which cost ~37 s) while using the fast channel.
#
# LAYOUT, under <out>/<ScanPosNNN>/:
#     positions.f64   N*3 float64, C-order
#     reflectance.f32 N   float32
#     amplitude.f32   N   float32
#     deviation.f32   N   float32
#     target_index.f32 N  float32
#     target_count.f32 N  float32
#     done.json       written LAST — its presence is the completion signal, and
#                     it carries the row count the host uses to shape the arrays
#
# `done.json` is written only after every array is closed, so the host can never
# read a half-written column: no marker means the scan is incomplete. Files are
# deleted by the host as soon as they are loaded, so peak disk is one position.
#
# stdout carries a single JSON header (scan list + metadata) and nothing else;
# progress and diagnostics stay on stderr.

_STREAM_MAGIC = b"PHRX"
# 3: added the .PROJ layout — per-scan `registration`/`sop`, project `layout`,
#    and the `--frame` option. The bump is what makes a stale reader image fail
#    loudly ("Rebuild the reader image") instead of reporting a .PROJ as empty.
# 4: added the `sensor` frame — per-scan `sensor_pose` / `sensor_matrix` from
#    the instrument's own inclinometer. Bumped for the same reason: a v3 image
#    silently omits both, so a "levelled" import would quietly not be levelled,
#    which is far worse than an error because the cloud still looks fine.
_STREAM_VERSION = 4

# (filename, dtype, columns-per-point)
_ARRAY_SPEC = (
    ("positions.f64", "<f8", 3),
    ("reflectance.f32", "<f4", 1),
    ("amplitude.f32", "<f4", 1),
    ("deviation.f32", "<f4", 1),
    ("target_index.f32", "<f4", 1),
    ("target_count.f32", "<f4", 1),
    ("is_miss.f32", "<f4", 1),
    ("background_radiation.f32", "<f4", 1),
    ("echo_type.f32", "<f4", 1),
    ("waveform_available.f32", "<f4", 1),
    ("pseudo_echo.f32", "<f4", 1),
    ("sw_calculated.f32", "<f4", 1),
    ("pps_locked.f32", "<f4", 1),
    ("facet.f32", "<f4", 1),
    # float64: this is the moving-platform LAD join key and CloudSession keeps
    # it in double precision for that reason. A float32 cast loses it.
    ("timestamp.f64", "<f8", 1),
)

# Where a no-return shot is placed along its beam. Matches _MISS_GAP_DISTANCE
# in the backend (and Helios's own gapfillMisses), so RIEGL misses land on the
# same far-field shell as every other importer's.
_MISS_GAP_DISTANCE = 20000.0


def _write_scan_arrays(out_dir: str, arrays: dict) -> None:
    """Write one scan's columns as raw arrays, then the completion marker.

    `tofile` is a straight memcpy — the point of this transport. The marker is
    written last so a partially-written scan is never mistaken for a complete
    one, and it NAMES the columns actually written: the set varies by scanner
    (a VZ-1000 records no background_radiation, and several flag bits are
    constant), so a fixed list on the host would look for files that do not
    exist.
    """
    os.makedirs(out_dir, exist_ok=True)
    n = int(arrays["positions"].shape[0])
    written = []
    for name, dtype, _cols in _ARRAY_SPEC:
        key = name.split(".")[0]
        if key not in arrays:
            continue
        np.ascontiguousarray(arrays[key], dtype=dtype).tofile(
            os.path.join(out_dir, name)
        )
        written.append(name)
    with open(os.path.join(out_dir, "done.json"), "w") as fh:
        json.dump({"point_count": n, "columns": written}, fh)


def stream_scan(
    ifc: _Scanifc,
    rxp_path: str,
    hk_path: str,
    out_dir: str,
    *,
    progress=None,
) -> dict:
    """Decode one .rxp and write its columns as raw arrays into `out_dir`.

    Mirrors extract_scan's decoding exactly — same attributes, same
    timestamp-based pulse grouping — but emits arrays instead of a LAS.

    Pulse grouping needs the WHOLE scan's timestamps (a pulse can straddle a
    read boundary), so points are accumulated in memory and emitted after
    grouping. That is the same peak as the LAS path had; the saving is the
    encode, not the buffering.
    """
    handle = ifc.open(_uri(rxp_path), hk_path=hk_path, selector=HK_SELECTOR_ALL)
    try:
        meta = ifc.meta(handle)

        xyz_chunks: list[np.ndarray] = []
        refl_chunks: list[np.ndarray] = []
        ampl_chunks: list[np.ndarray] = []
        dev_chunks: list[np.ndarray] = []
        flag_chunks: list[np.ndarray] = []
        time_chunks: list[np.ndarray] = []
        bgr_chunks: list[np.ndarray] = []

        xyz_buf = (ScanifcXYZ * _READ_CHUNK)()
        attr_buf = (ScanifcAttributes * _READ_CHUNK)()
        time_buf = (ctypes.c_uint64 * _READ_CHUNK)()
        got = ctypes.c_uint32()
        end_of_frame = ctypes.c_int32()

        total = 0
        while True:
            rc = ifc.lib.scanifc_point3dstream_read(
                handle, _READ_CHUNK, xyz_buf, attr_buf, time_buf,
                ctypes.byref(got), ctypes.byref(end_of_frame),
            )
            if rc != 0:
                raise RxpError(f"read failed: {ifc._last_error()}")
            n = got.value
            if n == 0 and end_of_frame.value == 0:
                break
            if n == 0:
                continue

            xyz_view = np.ctypeslib.as_array(xyz_buf)[:n]
            attr_view = np.ctypeslib.as_array(attr_buf)[:n]
            xyz_chunks.append(
                np.stack(
                    (xyz_view["x"], xyz_view["y"], xyz_view["z"]), axis=1
                ).astype(np.float64)
            )
            refl_chunks.append(attr_view["reflectance"].astype(np.float32))
            ampl_chunks.append(attr_view["amplitude"].astype(np.float32))
            dev_chunks.append(attr_view["deviation"].astype(np.float32))
            bgr_chunks.append(
                attr_view["background_radiation"].astype(np.float32)
            )
            flag_chunks.append(attr_view["flags"].astype(np.uint16))
            time_chunks.append(
                np.ctypeslib.as_array(time_buf)[:n].astype(np.uint64)
            )
            total += n
            if progress is not None and total % (_READ_CHUNK * 10) == 0:
                progress(total)

        if total == 0:
            raise RxpError(f"{rxp_path} contained no points")

        xyz = np.concatenate(xyz_chunks, axis=0)
        reflectance = np.concatenate(refl_chunks, axis=0)
        amplitude = np.concatenate(ampl_chunks, axis=0)
        deviation = np.concatenate(dev_chunks, axis=0)
        flags = np.concatenate(flag_chunks, axis=0)
        timestamps = np.concatenate(time_chunks, axis=0)
        background = np.concatenate(bgr_chunks, axis=0)
        del xyz_chunks, refl_chunks, ampl_chunks, dev_chunks
        del flag_chunks, time_chunks, bgr_chunks
        # RiVLib reports time in nanoseconds; seconds is what every other
        # Phytograph timestamp column carries.
        time_s = timestamps.astype(np.float64) * 1e-9
        flag_cols = decode_flags(flags)

        target_index, target_count = targets_from_timestamps(timestamps)
        echo_mismatches = validate_against_echo(target_index, target_count, flags)
        max_returns = int(target_count.max()) if target_count.size else 0
        del timestamps

        # NO-RETURN SHOTS. The C API above only ever yields returns, so the
        # misses are collected separately through the C++ shim and appended
        # here. They are placed the way every other Phytograph importer places a
        # miss — origin + unit_dir * _MISS_GAP_DISTANCE — so the far-field
        # shell, the hits-only octree and LAD all treat them identically.
        n_hits = total
        miss_info = collect_misses(rxp_path)
        n_miss = int(miss_info["times"].size)
        if n_miss:
            miss_xyz = miss_info["dirs"] * _MISS_GAP_DISTANCE
            xyz = np.concatenate([xyz, miss_xyz], axis=0)
            # A miss carries no return, so its per-return attributes are
            # meaningless; zero them rather than invent values. `is_miss` is
            # what every consumer keys off.
            zeros = np.zeros(n_miss, dtype=np.float32)
            reflectance = np.concatenate([reflectance, zeros])
            amplitude = np.concatenate([amplitude, zeros])
            deviation = np.concatenate([deviation, zeros])
            target_index = np.concatenate([target_index, zeros])
            target_count = np.concatenate([target_count, zeros])
            background = np.concatenate([background, zeros])
            for k in flag_cols:
                flag_cols[k] = np.concatenate([flag_cols[k], zeros])
            # A miss DOES have a real time — the shim records it per shot — so
            # this column stays meaningful across hits and misses, which is what
            # lets the timestamp-based miss reconstruction cross-check the shim.
            time_s = np.concatenate([time_s, miss_info["times"].astype(np.float64)])
        is_miss = np.concatenate([
            np.zeros(n_hits, dtype=np.float32),
            np.ones(n_miss, dtype=np.float32),
        ])
        total = n_hits + n_miss

        # The counts must reconcile or something is being dropped: every shot
        # either produced returns or was a miss.
        if miss_info["shots"] != miss_info["hit_shots"] + n_miss:
            raise RxpError(
                f"shot accounting does not reconcile for {rxp_path}: "
                f"{miss_info['shots']} shots vs {miss_info['hit_shots']} with "
                f"returns + {n_miss} misses"
            )

        # Drop columns this instrument does not actually populate. The VZ-1000
        # leaves background_radiation entirely NaN, and several flag bits are
        # constant-zero for a given scanner; surfacing those as scalars the user
        # can colour by is just noise in the picker. Which columns survive is
        # reported per scan so the wizard lists only the real ones.
        optional = {"background_radiation": background, **flag_cols}
        carried = {}
        for _k, _v in optional.items():
            if not np.isfinite(_v).any():
                continue          # all NaN: instrument does not record it
            if float(np.nanmin(_v)) == float(np.nanmax(_v)):
                continue          # constant: no information to colour by
            carried[_k] = _v

        _write_scan_arrays(out_dir, {
            "positions": xyz,
            "reflectance": reflectance,
            "amplitude": amplitude,
            "deviation": deviation,
            "target_index": target_index,
            "target_count": target_count,
            "is_miss": is_miss,
            "timestamp": time_s,
            **carried,
        })

        result = {
            "point_count": total,
            "instrument": _instrument_from_meta(meta),
            "bbox_local": {
                "min": [float(v) for v in xyz.min(axis=0)],
                "max": [float(v) for v in xyz.max(axis=0)],
            },
            "has_misses": bool(n_miss),
            "hit_count": n_hits,
            "miss_count": n_miss,
            "max_returns_per_pulse": max_returns,
            "extra_dims": [
                {"slug": slug, "label": label} for slug, label in _EXTRA_DIMS
            ],
        }
        if echo_mismatches:
            result["warning"] = (
                f"{echo_mismatches} of {total} points disagree with RiVLib's echo "
                "classification, so returns could not be grouped into pulses "
                "reliably. target_index/target_count may be wrong; do not use "
                "this scan for multi-return analysis."
            )
            result["echo_mismatches"] = echo_mismatches
        return result
    finally:
        ifc.close(handle)


FRAME_REGISTERED = "registered"
FRAME_LOCAL = "local"
# Levelled by the position's own inclinometer: plumb-corrected but NOT rotated
# to north and NOT aligned to the other positions. The only frame a .riproject
# can offer beyond raw local, since it carries no registration.
FRAME_SENSOR = "sensor"

# A sweep this wide is a full circle, and rotating a full circle is a no-op — so
# it is left at 0..360 rather than shifted into a arbitrary-looking window.
_FULL_SWEEP_DEG = 359.5


def _rotate_phi_window(params: dict, yaw_deg: float) -> None:
    """Counter-rotate the azimuth sweep so it describes the WORLD frame.

    scan_params' phi is the scanner's own azimuth sweep. Once the cloud has been
    rotated into PRCS by the SOP, LAD and gap-fill bin returns by their
    world-frame phi against this window, so the window has to move with them or
    every return lands in the wrong column.

    Helios measures phi CLOCKWISE FROM +Y while a yaw is a counter-clockwise
    rotation about +Z, so the world sweep is the local one MINUS the yaw. This
    is the same relation _ptx_scan_params encodes as `phi = 90 - az - yaw`,
    where the `90 - az` half is only PTX converting its mathematical atan2 LUT
    into that clockwise convention — a conversion RIEGL's phi does not need.
    """
    if "phi_min" not in params or "phi_max" not in params:
        return
    span = float(params["phi_max"]) - float(params["phi_min"])
    if abs(span) >= _FULL_SWEEP_DEG:
        params["phi_min"], params["phi_max"] = 0.0, 360.0
        return
    params["phi_min"] = float((float(params["phi_min"]) - yaw_deg) % 360.0)
    params["phi_max"] = float(params["phi_min"] + span)


def _attach_scan_params_extras(entry: dict, frame: str = FRAME_LOCAL) -> None:
    """Fold the instrument id, the origin and any pose into `scan_params`.

    The renderer builds a Scan's ScanParameters from this one object
    (scanParametersFromFile), so everything it should populate has to live here
    rather than beside it. `origin` is required by that contract.

    Which origin depends on the frame:

      FRAME_LOCAL      — the GNSS-derived ENU offset when we have a fix, and the
                         scanner's own origin (0,0,0) when we don't. No rotation
                         of any kind.
      FRAME_SENSOR     — the same origin, plus the instrument's own inclinometer
                         applied as a levelling rotation. Emits the tilt but
                         NEVER a heading; see below.
      FRAME_REGISTERED — the SOP translation, i.e. where the instrument actually
                         stood in PRCS, with the rotation split across
                         azimuth_offset_deg and the tilt fields.

    THESE FIELDS DESCRIBE A ROTATION THE POINTS ALREADY RECEIVED. They are not
    an instruction to rotate anything — the cloud is transformed backend-side in
    _riegl_arrays_to_las_result. The marker mesh, the coverage shell and a
    Helios re-export all read them, so emitting an angle the points did not get
    (or omitting one they did) silently desynchronises the three.
    """
    params = entry.get("scan_params")
    if params is None:
        # No pattern file: still surface origin + instrument so the Scan gets a
        # position and a marker, just without the angular sweep.
        params = {}
        entry["scan_params"] = params

    sop = entry.get("sop")
    pose = entry.get("sensor_pose")
    if frame == FRAME_REGISTERED and sop is not None:
        matrix = np.asarray(sop, dtype=np.float64)
        params["origin"] = [float(v) for v in matrix[:3, 3]]
        ypr = decompose_sop(matrix)
        _rotate_phi_window(params, ypr["yaw_deg"])
        if abs(ypr["yaw_deg"]) > 1e-6:
            params["azimuth_offset_deg"] = ypr["yaw_deg"]
        # Emitted alongside the azimuth rather than instead of it — see
        # decompose_sop for why this diverges from the PTX rule.
        params["tilt_roll_deg"] = ypr["roll_deg"]
        params["tilt_pitch_deg"] = ypr["pitch_deg"]
    elif frame == FRAME_SENSOR and pose is not None:
        origin = entry.get("origin_prior") or [0.0, 0.0, 0.0]
        params["origin"] = origin
        # LEVEL, BY CONSTRUCTION. These fields state the instrument's residual
        # tilt away from plumb *in the frame the points are now in*, and that is
        # exactly the tilt levelling just removed — so the honest value here is
        # zero, not the raw reading. Emitting the reading instead tilts the
        # marker mesh (and a Helios re-export) by the very angle the cloud no
        # longer has, which is the "angle the points did not get" failure the
        # note above this function warns about. The measurement itself is not
        # lost: it stays in `sensor_pose`, where it describes the tripod rather
        # than the delivered cloud.
        params["tilt_roll_deg"] = 0.0
        params["tilt_pitch_deg"] = 0.0
        # The 4x4 the backend applies to the points. Emitted here, beside the
        # angles that describe it, so the two can never disagree.
        entry["sensor_matrix"] = [
            [float(v) for v in row]
            for row in sensor_level_matrix(
                pose["roll_deg"], pose["pitch_deg"], origin
            )
        ]
        # NO azimuth_offset_deg and NO _rotate_phi_window: levelling applies no
        # heading, so the sweep still describes the scanner's own frame. The
        # pose's yaw stays in `sensor_pose` as metadata — it is 10-14 deg wrong
        # on measured data (see sensor_level_matrix).
    else:
        params["origin"] = entry.get("origin_prior") or [0.0, 0.0, 0.0]

    model = (entry.get("instrument") or {}).get("model")
    if model:
        # RiVLib's raw instrument string ("VZ-1000"). The renderer maps it onto
        # its own catalog id and ignores anything it has no preset for.
        params["scanner_model"] = model


# Rough bytes-per-echo for a V-Line .rxp, calibrated on VZ-2000i data
# (17,252,868 bytes -> 1,171,668 echoes). Only ever used to put an approximate
# size in front of the user when the fast path skips decoding; anything that
# needs a real count decodes.
_RXP_BYTES_PER_ECHO = 14.7

_NO_POSITIONS_ERROR = (
    "No scan positions found in {project}. Expected either a .riproject "
    "(ScanPosNNN/ holding <stamp>.rxp) or a .PROJ "
    "(ScanPosNNN.SCNPOS/scans/ holding <stamp>.rxp)."
)


def _proj_instrument(project_dir: str) -> dict:
    """Instrument identity from project.json, so inspect need not open a scan.

    Only model and serial are available here — the beam/PRR/range figures live
    in RiVLib's meta blob and are not worth a decode just to preview a list.
    """
    scanner = _read_proj_manifest(project_dir).get("_scanner") or {}
    out: dict = {}
    if scanner.get("type"):
        out["model"] = scanner["type"]
    if scanner.get("serialnumber"):
        out["serial"] = scanner["serialnumber"]
    return out


def _inspect_proj(args: argparse.Namespace, positions: list[dict]) -> tuple[list[dict], list]:
    """Fast metadata pass for a .PROJ — no point decoding at all.

    A .riproject hides its GNSS in the housekeeping stream, so previewing one
    means decoding a bounded prefix of every position: roughly ten seconds each,
    and the reference project has 24 of them. A .PROJ states everything in JSON
    sidecars (project.json, final.pose, .scn), so the whole preview is a few
    hundred bytes per position and returns effectively instantly.
    """
    instrument = _proj_instrument(args.project)
    scans: list[dict] = []
    fixes: list[dict | None] = []
    for pos in positions:
        entry: dict = {
            "name": pos["name"],
            "rxp_path": pos["rxp_path"],
            "size_bytes": pos["size_bytes"],
            "registration": pos["registration"],
            "manifest_success": pos.get("manifest_success"),
            "point_count_estimated": int(pos["size_bytes"] / _RXP_BYTES_PER_ECHO),
        }
        if instrument:
            entry["instrument"] = dict(instrument)
        params = scan_params_for(pos)
        if params:
            entry["scan_params"] = params
        if pos.get("sop") is not None:
            entry["sop"] = [[float(v) for v in row] for row in pos["sop"]]
        fix = _pose_gnss(pos["pose_path"]) if pos.get("pose_path") else None
        entry["gnss"] = fix
        fixes.append(fix)
        scans.append(entry)
    return scans, fixes


def _inspect_riproject(args, ifc, positions: list[dict]) -> tuple[list[dict], list]:
    """Metadata pass for a raw .riproject — needs a bounded decode per position."""
    hk_dir = args.hk_dir or "/tmp"
    os.makedirs(hk_dir, exist_ok=True)

    scans: list[dict] = []
    fixes: list[dict | None] = []
    for pos in positions:
        hk_path = os.path.join(hk_dir, f"hk_{pos['name']}.txt")
        entry: dict = {
            "name": pos["name"],
            "rxp_path": pos["rxp_path"],
            "size_bytes": pos["size_bytes"],
            "registration": pos["registration"],
        }
        try:
            info = read_scan(
                ifc,
                pos["rxp_path"],
                hk_path,
                count_points=args.count_points,
                max_points=None if args.count_points else args.probe_points,
            )
            entry.update(info)
            if not args.count_points:
                # Only a bounded prefix was read, so this is not the file's
                # total. Name the key so nobody mistakes it for one.
                entry["point_count_probed"] = entry.pop("point_count", 0)
        except RxpError as exc:
            entry["error"] = str(exc)

        params = scan_params_for(pos)
        if params:
            entry["scan_params"] = params
        fix = parse_hk_gps(hk_path)
        entry["gnss"] = fix
        attach_sensor_pose(entry, hk_path)
        fixes.append(fix)
        scans.append(entry)
    return scans, fixes


def cmd_inspect(args: argparse.Namespace) -> int:
    """Report every scan position in a project without extracting point data."""
    ifc = _Scanifc()
    layout = detect_layout(args.project)
    positions = find_scan_positions(args.project)
    if not positions:
        print(json.dumps({"error": _NO_POSITIONS_ERROR.format(project=args.project)}))
        return 1

    frame = getattr(args, "frame", FRAME_LOCAL)
    if layout == LAYOUT_PROJ:
        scans, fixes = _inspect_proj(args, positions)
    else:
        scans, fixes = _inspect_riproject(args, ifc, positions)

    for entry, enu in zip(scans, gnss_to_enu(fixes)):
        entry["enu"] = enu
        # Same origin prior as the extract path, so the selection UI can preview
        # the layout it will actually get.
        if enu is not None:
            entry["origin_prior"] = [enu["east_m"], enu["north_m"], enu["up_m"]]
        _attach_scan_params_extras(entry, frame)

    print(
        json.dumps(
            {
                "project": args.project,
                "layout": layout,
                "reader_version": _STREAM_VERSION,
                "rivlib_version": ifc.version(),
                "scan_count": len(scans),
                "gnss_anchor": anchor_of(fixes),
                "frame": frame,
                # A .riproject carries no registration at all; a .PROJ is
                # registered to whatever extent its per-position status says.
                "registered": any(
                    s.get("registration") == "registered" for s in scans
                ),
                "registered_count": sum(
                    1 for s in scans if s.get("registration") == "registered"
                ),
                "scans": scans,
            },
            indent=2,
        )
    )
    return 0


def cmd_extract(args: argparse.Namespace) -> int:
    """Extract selected scan positions to LAS plus a JSON sidecar.

    NOT used by the app any more — Phytograph calls `stream` instead, because
    writing LAS inside the container costs ~37 s per position against ~1.2 s on
    the arm64 host (x86 emulation is ~30x slower at laspy's bit-packing). Kept
    because it makes the container independently useful: `riegl-probe.mjs --out`
    still produces standalone LAS files without Phytograph running, which is how
    the reader was first validated and remains the quickest way to sanity-check
    a project by hand.

    The sidecar is what the host reads: it carries everything the LAS cannot
    (scan pattern, GNSS, ENU layout, instrument), so the caller never has to
    open the point file to learn about the scan.
    """
    ifc = _Scanifc()
    positions = find_scan_positions(args.project)
    if not positions:
        print(
            json.dumps(
                {
                    "error": f"No ScanPos* directories found in {args.project}. "
                    "Is this a raw .riproject directory?"
                }
            )
        )
        return 1

    wanted = set(args.scans) if args.scans else None
    if wanted:
        missing = wanted - {p["name"] for p in positions}
        if missing:
            print(
                json.dumps(
                    {
                        "error": "requested scan(s) not in project: "
                        + ", ".join(sorted(missing))
                    }
                )
            )
            return 1
        positions = [p for p in positions if p["name"] in wanted]

    os.makedirs(args.out, exist_ok=True)
    hk_dir = args.hk_dir or "/tmp"
    os.makedirs(hk_dir, exist_ok=True)

    scans: list[dict] = []
    fixes: list[dict | None] = []

    for index, pos in enumerate(positions, start=1):
        name = pos["name"]
        hk_path = os.path.join(hk_dir, f"hk_{name}.txt")
        out_las = os.path.join(args.out, f"{name}.las")

        # Progress goes to stderr as JSON lines: stdout is reserved for the
        # single result document, so the host can stream one and parse the
        # other without interleaving.
        def _progress(done: int, _name=name, _i=index) -> None:
            print(
                json.dumps(
                    {
                        "progress": {
                            "scan": _name,
                            "index": _i,
                            "total": len(positions),
                            "points": done,
                        }
                    }
                ),
                file=sys.stderr,
                flush=True,
            )

        entry: dict = {"name": name, "las_path": out_las}
        try:
            info = extract_scan(
                ifc, pos["rxp_path"], out_las, hk_path, progress=_progress
            )
            entry.update(info)
        except RxpError as exc:
            entry["error"] = str(exc)

        params = scan_params_for(pos)
        if params:
            entry["scan_params"] = params
        fix = parse_hk_gps(hk_path)
        entry["gnss"] = fix
        attach_sensor_pose(entry, hk_path)
        fixes.append(fix)
        scans.append(entry)

    for entry, enu in zip(scans, gnss_to_enu(fixes)):
        entry["enu"] = enu
        # The ENU offset is the scan's origin in the project frame. Raw scans
        # are unregistered, so this is a coarse GNSS prior for ICP, not a
        # registration — the key name says `prior` so nobody mistakes it.
        if enu is not None:
            entry["origin_prior"] = [enu["east_m"], enu["north_m"], enu["up_m"]]
        _attach_scan_params_extras(entry)

    print(
        json.dumps(
            {
                "project": args.project,
                "rivlib_version": ifc.version(),
                "scan_count": len(scans),
                "gnss_anchor": anchor_of(fixes),
                "registered": False,
                "scans": scans,
            },
            indent=2,
        )
    )
    return 0


# How long to wait for the host to load a finished position before giving up
# and decoding the next one anyway. The host's work per position is a session
# build plus a PotreeConverter run — seconds, not minutes — so a long stall
# means it has died or been cancelled. Pressing on then is the right call: the
# run is already doomed and blocking forever would just hang the container.
_CONSUME_TIMEOUT_S = 900.0


def _wait_for_consumption(scan_dir: str, timeout_s: float = _CONSUME_TIMEOUT_S) -> None:
    """Block until the host has loaded (and deleted) this position's arrays."""
    deadline = time.time() + timeout_s
    while os.path.exists(scan_dir) and time.time() < deadline:
        time.sleep(0.1)


def cmd_stream(args: argparse.Namespace) -> int:
    """Stream selected scan positions' points to stdout as raw arrays.

    The host writes the LAS (30x faster natively than under emulation) and
    builds the session, so this command's only job is to call RiVLib and hand
    the numbers over.

    The JSON header goes to stdout FIRST so the host knows the scan list and
    per-scan metadata before any arrays appear. Fields only knowable after
    decoding (point_count, bbox, multi-return warnings) ride in a trailing JSON
    document on stderr, read once the run ends.

    Each position's columns are written into <out>/<ScanPosNNN>/ and finished
    with a `done.json` marker, which is how the host knows a scan is complete
    and safe to load.
    """
    ifc = _Scanifc()
    layout = detect_layout(args.project)
    positions = find_scan_positions(args.project)
    if not positions:
        print(
            json.dumps({"error": _NO_POSITIONS_ERROR.format(project=args.project)}),
            file=sys.stderr,
        )
        return 1

    wanted = set(args.scans) if args.scans else None
    if wanted:
        missing = wanted - {p["name"] for p in positions}
        if missing:
            print(
                json.dumps(
                    {
                        "error": "requested scan(s) not in project: "
                        + ", ".join(sorted(missing))
                    }
                ),
                file=sys.stderr,
            )
            return 1

    # NOTE: `positions` is deliberately NOT filtered here. The ENU anchor is the
    # centroid of the fixes in pass 1, so filtering first would anchor a
    # single-position import at ITS OWN fix and place that scan at (0,0,0) --
    # discarding the GNSS offset the user selected it for, and putting two
    # separately-imported positions on top of each other instead of metres
    # apart. The anchor must be a property of the PROJECT, not of the selection,
    # or the same scan lands somewhere different depending on what it was
    # imported alongside. Pass 2 filters instead (see `selected` below).

    hk_dir = args.hk_dir or "/tmp"
    os.makedirs(hk_dir, exist_ok=True)

    # Pass 1 (cheap): scan-pattern + instrument + GNSS + pose for every
    # position, so the header is complete before any bytes of payload go out.
    # For a .riproject this costs a bounded prefix read per position, which is
    # what `inspect` already does; for a .PROJ it is pure JSON sidecar reads.
    #
    # It runs over EVERY position, including unselected ones, because the ENU
    # anchor is a project-level quantity (see the note by the `wanted` check).
    # An unselected position contributes its GNSS fix to that anchor and nothing
    # else, so it is probed with a much smaller prefix -- enough to flush a
    # housekeeping record, but none of the work that only a decoded position
    # needs. On the six-position VZ-1000 project that keeps the added cost of
    # anchoring correctly to well under a second in total.
    frame = getattr(args, "frame", FRAME_LOCAL)
    header_scans: list[dict] = []
    fixes: list[dict | None] = []
    proj_instrument = _proj_instrument(args.project) if layout == LAYOUT_PROJ else {}
    for pos in positions:
        entry: dict = {"name": pos["name"], "registration": pos["registration"]}
        chosen = wanted is None or pos["name"] in wanted
        if pos.get("sop") is not None:
            entry["sop"] = [[float(v) for v in row] for row in pos["sop"]]
        if layout == LAYOUT_PROJ:
            if proj_instrument:
                entry["instrument"] = dict(proj_instrument)
            fix = _pose_gnss(pos["pose_path"]) if pos.get("pose_path") else None
        else:
            hk_path = os.path.join(hk_dir, f"hk_{pos['name']}.txt")
            try:
                info = read_scan(
                    ifc, pos["rxp_path"], hk_path,
                    count_points=False,
                    max_points=(
                        args.probe_points if chosen else _ANCHOR_PROBE_POINTS
                    ),
                )
                entry["instrument"] = info.get("instrument", {})
            except RxpError as exc:
                # An unreadable position must not sink an import that did not
                # ask for it: record the error, contribute no fix, carry on.
                entry["error"] = str(exc)
            fix = parse_hk_gps(hk_path)
            attach_sensor_pose(entry, hk_path)
        params = scan_params_for(pos)
        if params:
            entry["scan_params"] = params
        entry["gnss"] = fix
        fixes.append(fix)
        header_scans.append(entry)

    for entry, enu in zip(header_scans, gnss_to_enu(fixes)):
        entry["enu"] = enu
        if enu is not None:
            entry["origin_prior"] = [enu["east_m"], enu["north_m"], enu["up_m"]]
        _attach_scan_params_extras(entry, frame)

    # The header describes only what is being imported. The unselected
    # positions have done their job -- they are in `fixes`, which is what
    # anchored the ENU frame -- and the host builds one session per header
    # entry, so leaving them in would fabricate scans nobody asked for.
    if wanted is not None:
        header_scans = [e for e in header_scans if e["name"] in wanted]

    header = {
        "project": args.project,
        "layout": layout,
        "reader_version": _STREAM_VERSION,
        "rivlib_version": ifc.version(),
        "scan_count": len(header_scans),
        "gnss_anchor": anchor_of(fixes),
        "frame": frame,
        "registered": any(
            s.get("registration") == "registered" for s in header_scans
        ),
        "registered_count": sum(
            1 for s in header_scans if s.get("registration") == "registered"
        ),
        "scans": header_scans,
    }
    raw = json.dumps(header).encode("utf-8")

    out = sys.stdout.buffer
    out.write(_STREAM_MAGIC)
    out.write(struct.pack("<II", _STREAM_VERSION, len(raw)))
    out.write(raw)
    out.flush()
    os.makedirs(args.out, exist_ok=True)

    # Pass 2: decode and stream each SELECTED position's points in header
    # order. `positions` still holds the whole project (pass 1 needed it for the
    # anchor), so re-pair it with the filtered header here rather than zipping
    # the two lists, which no longer line up.
    selected = [p for p in positions if wanted is None or p["name"] in wanted]
    trailer: list[dict] = []
    for index, (pos, entry) in enumerate(zip(selected, header_scans), start=1):
        if entry.get("error"):
            # No arrays and no marker: the host treats a missing done.json as
            # "this position produced nothing", which is exactly right.
            trailer.append({"name": pos["name"], "error": entry["error"]})
            continue

        def _progress(done: int, _name=pos["name"], _i=index) -> None:
            print(
                json.dumps({"progress": {
                    "scan": _name, "index": _i,
                    "total": len(selected), "points": done,
                }}),
                file=sys.stderr, flush=True,
            )

        hk_path = os.path.join(hk_dir, f"hk_{pos['name']}.txt")
        try:
            info = stream_scan(
                ifc, pos["rxp_path"], hk_path,
                os.path.join(args.out, pos["name"]), progress=_progress,
            )
            info["name"] = pos["name"]
            trailer.append(info)
            # Tell the host this position is ready NOW, so it can load and build
            # while the container decodes the next one.
            print(json.dumps({"ready": pos["name"]}), file=sys.stderr, flush=True)
            # Then WAIT for the host to consume it before decoding the next.
            #
            # Without this the container runs ahead: it writes position N+1
            # while the host is still building N, so two positions' arrays are
            # on disk at once (~3.2 GB rather than ~1.6 GB). That doubled peak
            # is what actually filled a user's disk mid-import. The host deletes
            # each position's directory as it loads it, so its disappearance is
            # the signal — no extra channel needed.
            _wait_for_consumption(os.path.join(args.out, pos["name"]))
        except RxpError as exc:
            trailer.append({"name": pos["name"], "error": str(exc)})

    print(json.dumps({"trailer": trailer}), file=sys.stderr, flush=True)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="rxp_reader",
        description="Read RIEGL .riproject / .PROJ data via RiVLib.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    inspect = sub.add_parser(
        "inspect", help="List scan positions with metadata, FOV and GNSS."
    )
    inspect.add_argument("project", help="Path to the .riproject or .PROJ directory")
    inspect.add_argument(
        "--count-points",
        action="store_true",
        help="Read every point to report exact counts and a local bbox "
        "(slower; without it only a bounded prefix is read).",
    )
    inspect.add_argument(
        "--probe-points",
        type=int,
        default=_ANCHOR_PROBE_POINTS,
        help="Points to read per scan when not counting exactly. Must be enough "
        f"to flush at least one GNSS housekeeping record "
        f"(default: {_ANCHOR_PROBE_POINTS}).",
    )
    inspect.add_argument(
        "--hk-dir", default=None, help="Directory for demultiplexed housekeeping files."
    )
    inspect.add_argument(
        "--frame",
        choices=(FRAME_REGISTERED, FRAME_LOCAL, FRAME_SENSOR),
        default=FRAME_LOCAL,
        help='Coordinate frame for the emitted points. "registered" applies each position\'s SOP so scans land pre-aligned in the project frame (.PROJ only); "local" keeps scanner-local coordinates, which is the only option a .riproject supports.',
    )
    inspect.set_defaults(func=cmd_inspect)

    extract = sub.add_parser(
        "extract", help="Extract scan positions to LAS plus a JSON sidecar."
    )
    extract.add_argument("project", help="Path to the .riproject or .PROJ directory")
    extract.add_argument(
        "--out", required=True, help="Output directory for the .las files"
    )
    extract.add_argument(
        "--scans",
        nargs="*",
        default=None,
        help="Scan position names to extract (default: all). "
        "e.g. --scans ScanPos001 ScanPos003",
    )
    extract.add_argument(
        "--hk-dir", default=None, help="Directory for demultiplexed housekeeping files."
    )
    extract.set_defaults(func=cmd_extract)

    stream = sub.add_parser(
        "stream",
        help="Stream scan points to stdout as raw arrays (no LAS written).",
    )
    stream.add_argument("project", help="Path to the .riproject or .PROJ directory")
    stream.add_argument(
        "--scans", nargs="*", default=None,
        help="Scan position names to stream (default: all).",
    )
    stream.add_argument(
        "--probe-points", type=int, default=_ANCHOR_PROBE_POINTS,
        help="Points read per position in the metadata pass (must be enough to "
             "flush a GNSS housekeeping record).",
    )
    stream.add_argument("--hk-dir", default=None)
    stream.add_argument(
        "--out", required=True,
        help="Directory for the raw array files (bind-mounted from the host).",
    )
    stream.add_argument(
        "--frame",
        choices=(FRAME_REGISTERED, FRAME_LOCAL, FRAME_SENSOR),
        default=FRAME_LOCAL,
        help='Coordinate frame for the emitted points. "registered" applies each position\'s SOP so scans land pre-aligned in the project frame (.PROJ only); "local" keeps scanner-local coordinates, which is the only option a .riproject supports.',
    )
    stream.set_defaults(func=cmd_stream)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except RxpError as exc:
        print(json.dumps({"error": str(exc)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
