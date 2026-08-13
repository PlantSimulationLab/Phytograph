"""Read RIEGL raw scanner projects (.riproject) via RiVLib's scanifc C API.

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

COORDINATES ARE SCANNER-LOCAL. Raw projects carry no registration (that is what
RiSCAN PRO produces), so every scan position is its own frame with the origin at
the scanner. The GNSS fix is what lets the caller lay positions out relative to
one another; it is a metres-level prior for ICP, not survey-grade truth.
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
import sys

import numpy as np

# ---------------------------------------------------------------------------
# ctypes bindings
# ---------------------------------------------------------------------------

_LIB_PATH = os.environ.get("RIVLIB_SO", "/rivlib/lib/libscanifc.so")

# Batch size for point reads. 200k points is ~3.2 MB of xyz + ~3.2 MB of
# attributes, which keeps the C->numpy copy amortised without a large resident
# buffer. Measured throughput at this size is ~2.3 M pts/s under emulation.
_READ_CHUNK = 200_000

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

    def open(self, uri: str, hk_path: str | None = None) -> ctypes.c_void_p:
        """Open a point stream. When `hk_path` is given, the housekeeping
        ("status protocol") stream is demultiplexed to that file as points are
        read — this is the only route to the GNSS records."""
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
                    handle, hk_path.encode(), 0, b"status protocol"
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


def parse_hk_inclination(hk_path: str) -> dict | None:
    """Extract the first inclination reading, if present.

    Format is `hk_incl (10006.0), <roll>, <pitch>, <t1>, <t2>`. Units are not
    confirmed against RIEGL's documentation, so the raw values are passed
    through under clearly-raw key names rather than being presented as degrees.
    Levelling the cloud with these would remove two rotational DOF before ICP,
    but that is Phase 6 work and needs the units pinned down first.
    """
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
                    return {"roll_raw": int(fields[0]), "pitch_raw": int(fields[1])}
                except ValueError:
                    continue
    except OSError:
        return None
    return None


# ---------------------------------------------------------------------------
# Project + scan-position discovery
# ---------------------------------------------------------------------------


def find_scan_positions(project_dir: str) -> list[dict]:
    """Enumerate ScanPos* directories and the files each one contributes.

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
        rxps = [
            p
            for p in sorted(glob.glob(os.path.join(scan_dir, "*.rxp")))
            if not p.endswith(".mon.rxp")
        ]
        if not rxps:
            continue
        rxp = rxps[0]
        stem = os.path.basename(rxp)[: -len(".rxp")]
        pat = os.path.join(scan_dir, stem + ".pat")
        positions.append(
            {
                "name": os.path.basename(scan_dir),
                "rxp_path": rxp,
                "pat_path": pat if os.path.exists(pat) else None,
                "size_bytes": os.path.getsize(rxp),
            }
        )
    return positions


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
    """
    handle = ifc.open(_uri(rxp_path), hk_path=hk_path)
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

    handle = ifc.open(_uri(rxp_path), hk_path=hk_path)
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
            "has_misses": False,
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
_STREAM_VERSION = 2

# (filename, dtype, columns-per-point)
_ARRAY_SPEC = (
    ("positions.f64", "<f8", 3),
    ("reflectance.f32", "<f4", 1),
    ("amplitude.f32", "<f4", 1),
    ("deviation.f32", "<f4", 1),
    ("target_index.f32", "<f4", 1),
    ("target_count.f32", "<f4", 1),
)


def _write_scan_arrays(out_dir: str, arrays: dict) -> None:
    """Write one scan's columns as raw arrays, then the completion marker.

    `tofile` is a straight memcpy — the point of this transport. The marker is
    written last so a partially-written scan is never mistaken for a complete
    one.
    """
    os.makedirs(out_dir, exist_ok=True)
    n = int(arrays["positions"].shape[0])
    for name, dtype, _cols in _ARRAY_SPEC:
        key = name.split(".")[0]
        np.ascontiguousarray(arrays[key], dtype=dtype).tofile(
            os.path.join(out_dir, name)
        )
    with open(os.path.join(out_dir, "done.json"), "w") as fh:
        json.dump({"point_count": n}, fh)


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
    handle = ifc.open(_uri(rxp_path), hk_path=hk_path)
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
        del xyz_chunks, refl_chunks, ampl_chunks, dev_chunks
        del flag_chunks, time_chunks

        target_index, target_count = targets_from_timestamps(timestamps)
        echo_mismatches = validate_against_echo(target_index, target_count, flags)
        max_returns = int(target_count.max()) if target_count.size else 0
        del timestamps, flags

        _write_scan_arrays(out_dir, {
            "positions": xyz,
            "reflectance": reflectance,
            "amplitude": amplitude,
            "deviation": deviation,
            "target_index": target_index,
            "target_count": target_count,
        })

        result = {
            "point_count": total,
            "instrument": _instrument_from_meta(meta),
            "bbox_local": {
                "min": [float(v) for v in xyz.min(axis=0)],
                "max": [float(v) for v in xyz.max(axis=0)],
            },
            "has_misses": False,
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


def _attach_scan_params_extras(entry: dict) -> None:
    """Fold the instrument id and the GNSS origin prior into `scan_params`.

    The renderer builds a Scan's ScanParameters from this one object
    (scanParametersFromFile), so everything it should populate has to live here
    rather than beside it. `origin` is required by that contract; it is the
    GNSS-derived ENU offset when we have a fix, and the scanner's own origin
    (0,0,0 — raw scans are unregistered) when we don't.
    """
    params = entry.get("scan_params")
    if params is None:
        # No .pat file: still surface origin + instrument so the Scan gets a
        # position and a marker, just without the angular sweep.
        params = {}
        entry["scan_params"] = params

    params["origin"] = entry.get("origin_prior") or [0.0, 0.0, 0.0]

    model = (entry.get("instrument") or {}).get("model")
    if model:
        # RiVLib's raw instrument string ("VZ-1000"). The renderer maps it onto
        # its own catalog id and ignores anything it has no preset for.
        params["scanner_model"] = model


def cmd_inspect(args: argparse.Namespace) -> int:
    """Report every scan position in a project without extracting point data."""
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

        if pos["pat_path"]:
            pat = parse_pat(pos["pat_path"])
            if pat:
                entry["scan_params"] = pat
        fix = parse_hk_gps(hk_path)
        entry["gnss"] = fix
        incl = parse_hk_inclination(hk_path)
        if incl:
            entry["inclination_raw"] = incl
        fixes.append(fix)
        scans.append(entry)

    for entry, enu in zip(scans, gnss_to_enu(fixes)):
        entry["enu"] = enu
        # Same origin prior as the extract path, so the selection UI can preview
        # the layout it will actually get.
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
                # Raw projects carry no registration; say so here too so the
                # selection UI can warn before the user commits to an import.
                "registered": False,
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

        if pos["pat_path"]:
            pat = parse_pat(pos["pat_path"])
            if pat:
                entry["scan_params"] = pat
        fix = parse_hk_gps(hk_path)
        entry["gnss"] = fix
        incl = parse_hk_inclination(hk_path)
        if incl:
            entry["inclination_raw"] = incl
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
    positions = find_scan_positions(args.project)
    if not positions:
        print(
            json.dumps(
                {
                    "error": f"No ScanPos* directories found in {args.project}. "
                    "Is this a raw .riproject directory?"
                }
            ),
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
        positions = [p for p in positions if p["name"] in wanted]

    hk_dir = args.hk_dir or "/tmp"
    os.makedirs(hk_dir, exist_ok=True)

    # Pass 1 (cheap): scan-pattern + instrument + GNSS for every position, so
    # the header is complete before any bytes of payload go out. This costs a
    # bounded prefix read per position, which is what `inspect` already does.
    header_scans: list[dict] = []
    fixes: list[dict | None] = []
    for pos in positions:
        hk_path = os.path.join(hk_dir, f"hk_{pos['name']}.txt")
        entry: dict = {"name": pos["name"]}
        try:
            info = read_scan(
                ifc, pos["rxp_path"], hk_path,
                count_points=False, max_points=args.probe_points,
            )
            entry["instrument"] = info.get("instrument", {})
        except RxpError as exc:
            entry["error"] = str(exc)
        if pos["pat_path"]:
            pat = parse_pat(pos["pat_path"])
            if pat:
                entry["scan_params"] = pat
        fix = parse_hk_gps(hk_path)
        entry["gnss"] = fix
        incl = parse_hk_inclination(hk_path)
        if incl:
            entry["inclination_raw"] = incl
        fixes.append(fix)
        header_scans.append(entry)

    for entry, enu in zip(header_scans, gnss_to_enu(fixes)):
        entry["enu"] = enu
        if enu is not None:
            entry["origin_prior"] = [enu["east_m"], enu["north_m"], enu["up_m"]]
        _attach_scan_params_extras(entry)

    header = {
        "project": args.project,
        "rivlib_version": ifc.version(),
        "scan_count": len(header_scans),
        "gnss_anchor": anchor_of(fixes),
        "registered": False,
        "scans": header_scans,
    }
    raw = json.dumps(header).encode("utf-8")

    out = sys.stdout.buffer
    out.write(_STREAM_MAGIC)
    out.write(struct.pack("<II", _STREAM_VERSION, len(raw)))
    out.write(raw)
    out.flush()
    os.makedirs(args.out, exist_ok=True)

    # Pass 2: decode and stream each position's points in header order.
    trailer: list[dict] = []
    for index, (pos, entry) in enumerate(zip(positions, header_scans), start=1):
        if entry.get("error"):
            # No arrays and no marker: the host treats a missing done.json as
            # "this position produced nothing", which is exactly right.
            trailer.append({"name": pos["name"], "error": entry["error"]})
            continue

        def _progress(done: int, _name=pos["name"], _i=index) -> None:
            print(
                json.dumps({"progress": {
                    "scan": _name, "index": _i,
                    "total": len(positions), "points": done,
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
        except RxpError as exc:
            trailer.append({"name": pos["name"], "error": str(exc)})

    print(json.dumps({"trailer": trailer}), file=sys.stderr, flush=True)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="rxp_reader", description="Read RIEGL .riproject data via RiVLib."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    inspect = sub.add_parser(
        "inspect", help="List scan positions with metadata, FOV and GNSS."
    )
    inspect.add_argument("project", help="Path to the .riproject directory")
    inspect.add_argument(
        "--count-points",
        action="store_true",
        help="Read every point to report exact counts and a local bbox "
        "(slower; without it only a bounded prefix is read).",
    )
    inspect.add_argument(
        "--probe-points",
        type=int,
        default=2_000_000,
        help="Points to read per scan when not counting exactly. Must be enough "
        "to flush at least one GNSS housekeeping record (default: 2000000).",
    )
    inspect.add_argument(
        "--hk-dir", default=None, help="Directory for demultiplexed housekeeping files."
    )
    inspect.set_defaults(func=cmd_inspect)

    extract = sub.add_parser(
        "extract", help="Extract scan positions to LAS plus a JSON sidecar."
    )
    extract.add_argument("project", help="Path to the .riproject directory")
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
    stream.add_argument("project", help="Path to the .riproject directory")
    stream.add_argument(
        "--scans", nargs="*", default=None,
        help="Scan position names to stream (default: all).",
    )
    stream.add_argument(
        "--probe-points", type=int, default=2_000_000,
        help="Points read per position in the metadata pass (must be enough to "
             "flush a GNSS housekeeping record).",
    )
    stream.add_argument("--hk-dir", default=None)
    stream.add_argument(
        "--out", required=True,
        help="Directory for the raw array files (bind-mounted from the host).",
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
