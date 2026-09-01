#!/usr/bin/env python3
"""Recover sky/miss points for a timestamped LAS/LAZ scan and write them back out.

Standalone workaround for a scan whose misses cannot be reconstructed inside the
app — e.g. while waiting on a release that carries the gap-fill fixes. It runs the
SAME PyHelios call the Backfill Misses button runs (`LiDARcloud::gapfillMisses`),
so the output is the real reconstruction, not an approximation.

    python tools/gapfill_las_misses.py IN.las OUT.las \
        --origin X Y Z --theta 25 130 [--phi 0 360] [--ntheta N --nphi M]

The scanner origin and the zenith sweep are REQUIRED because a LAS carries neither:
unlike E57 (which can record a pose and sphericalBounds) a LAS is a bare point
table. Getting them wrong silently distorts the reconstruction — the sweep sets the
raster every recovered miss is placed on — so they are explicit arguments rather
than guesses. Read them off the scanner's own metadata export.

The output is a LAS carrying the original returns plus the synthesised misses, with
an `is_miss` extra dimension (0 = return, 1 = sky). That is exactly the shape
Phytograph's own E57 reader produces, so re-importing it gives a cloud that already
has its misses and needs no backfill step before Leaf Area Density.

Requires the project venv (`backend-api/venv`), because it needs the compiled
libhelios that ships with pyhelios.
"""

from __future__ import annotations

import argparse
import math
import os
import sys
import time

import numpy as np


def _log(msg: str) -> None:
    print(msg, flush=True)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Gap-fill sky/miss points for a timestamped LAS scan.")
    ap.add_argument("input", help="source .las/.laz (must carry gps_time)")
    ap.add_argument("output", help="destination .las")
    ap.add_argument("--origin", nargs=3, type=float, required=True,
                    metavar=("X", "Y", "Z"),
                    help="scanner head position in the file's own coordinates")
    ap.add_argument("--theta", nargs=2, type=float, required=True,
                    metavar=("MIN", "MAX"),
                    help="zenith sweep in degrees (0 = straight up, 90 = horizon)")
    ap.add_argument("--phi", nargs=2, type=float, default=[0.0, 360.0],
                    metavar=("MIN", "MAX"), help="azimuth sweep in degrees")
    ap.add_argument("--ntheta", type=int, default=None,
                    help="scan grid rows; estimated from the point count if omitted")
    ap.add_argument("--nphi", type=int, default=None,
                    help="scan grid columns; estimated from the point count if omitted")
    args = ap.parse_args(argv)

    try:
        import laspy
    except ImportError:
        _log("error: laspy not found — run this with backend-api/venv/bin/python")
        return 2
    try:
        from pyhelios import LiDARCloud
    except ImportError:
        _log("error: pyhelios not found — run this with backend-api/venv/bin/python")
        return 2

    origin = np.asarray(args.origin, dtype=np.float64)
    theta_min, theta_max = args.theta
    phi_min, phi_max = args.phi
    if not theta_max > theta_min:
        _log("error: --theta MAX must exceed MIN")
        return 2

    _log(f"reading {args.input}")
    las = laspy.read(args.input)
    n_in = len(las.points)
    if not hasattr(las, "gps_time"):
        _log("error: this file has no gps_time. The timestamp path cannot run, and\n"
             "       without scan-grid row/column indices there is nothing to\n"
             "       reconstruct miss directions from.")
        return 1

    # Sort by time. gapfillMisses sorts internally too, but doing it here keeps the
    # arrays we carry alongside (and write back out) aligned with what we feed in.
    gps = np.asarray(las.gps_time, dtype=np.float64)
    order = np.argsort(gps, kind="stable")
    gps = gps[order]
    xyz = np.column_stack([np.asarray(las.x, dtype=np.float64)[order],
                           np.asarray(las.y, dtype=np.float64)[order],
                           np.asarray(las.z, dtype=np.float64)[order]])
    _log(f"  {n_in:,} returns, gps_time {gps[0]:.3f}..{gps[-1]:.3f}")

    # Duplicate timestamps mean multiple returns per pulse. The gapfiller keeps only
    # first hits, so warn rather than let the count quietly differ from expectation.
    n_dup = int((np.diff(gps) == 0).sum())
    if n_dup:
        _log(f"  note: {n_dup:,} duplicate timestamps (multi-return); the gap-fill "
             f"uses first hits only")

    # Per-return beam direction from the scanner head. A zero-length vector (a point
    # exactly at the origin) has no direction; nudge it so normalisation is defined.
    d = xyz - origin
    norm = np.linalg.norm(d, axis=1, keepdims=True)
    n_degenerate = int((norm[:, 0] == 0).sum())
    if n_degenerate:
        _log(f"  note: {n_degenerate:,} point(s) coincide with --origin; skipped")
    norm[norm == 0] = 1.0
    dirs = (d / norm).astype(np.float32)

    # Sanity-check the declared sweep against the returns themselves. A sweep that
    # does not contain the data is the single most likely input error here, and it
    # would silently misplace every recovered miss.
    zen = np.degrees(np.arccos(np.clip(d[:, 2] / norm[:, 0], -1.0, 1.0)))
    _log(f"  returns span zenith {zen.min():.1f}..{zen.max():.1f} deg; "
         f"declared sweep {theta_min:g}..{theta_max:g}")
    slack = 2.0  # deg; edge returns can sit a little outside the nominal sweep
    if zen.min() < theta_min - slack or zen.max() > theta_max + slack:
        _log("  WARNING: returns fall outside the declared --theta sweep. Check the\n"
             "           value and --origin before trusting the output.")

    n_pts = xyz.shape[0]
    if args.ntheta and args.nphi:
        n_theta, n_phi = int(args.ntheta), int(args.nphi)
    else:
        # Mirrors the backend's fallback when a scan carries no declared raster.
        aspect = (theta_max - theta_min) / max(phi_max - phi_min, 1e-10)
        n_phi = max(int(math.sqrt(n_pts / max(aspect, 0.01))), 10)
        n_theta = max(int(n_pts / n_phi), 10)
    _log(f"  scan grid {n_theta} x {n_phi}")

    cloud = LiDARCloud()
    cloud.disableMessages()
    sid = cloud.addScan(
        origin=origin.tolist(), Ntheta=n_theta,
        theta_range=(math.radians(theta_min), math.radians(theta_max)),
        Nphi=n_phi, phi_range=(math.radians(phi_min), math.radians(phi_max)),
        exit_diameter=0.0, beam_divergence=0.0,
    )
    t = time.time()
    cloud.addHitPointsWithData(sid, xyz, dirs, ["timestamp"],
                               gps.reshape(-1, 1))
    _log(f"  built cloud in {time.time() - t:.1f}s")

    _log("gap-filling misses (this is the slow step)…")
    t = time.time()
    try:
        cloud.gapfillMisses()
    except Exception as exc:
        _log(f"error: gapfillMisses failed: {exc}")
        return 1
    _log(f"  done in {time.time() - t:.1f}s")

    # Slice out the synthesised misses. gapfillMisses APPENDS them to the cloud and
    # flags each one, so every miss-flagged row is new (the input was returns only).
    miss_flag = np.asarray(cloud.getHitMissArray(), dtype=np.int32)
    all_xyz, _rgb = cloud.getHitsXYZRGBArrays()
    all_xyz = np.asarray(all_xyz, dtype=np.float64)
    if miss_flag.shape[0] != all_xyz.shape[0]:
        _log("error: PyHelios bulk getters disagree on hit count; refusing to guess")
        return 1
    mask = miss_flag != 0
    synth = np.ascontiguousarray(all_xyz[mask])
    n_miss = int(mask.sum())
    _log(f"recovered {n_miss:,} sky/miss points")
    if n_miss == 0:
        _log("  nothing to add — writing the returns through unchanged")

    # --- write returns + misses, with is_miss, mirroring the E57 reader's output ---
    out_xyz = np.vstack([xyz, synth]) if n_miss else xyz
    is_miss = np.concatenate([
        np.zeros(n_pts, dtype=np.float32), np.ones(n_miss, dtype=np.float32)
    ]) if n_miss else np.zeros(n_pts, dtype=np.float32)

    header = laspy.LasHeader(point_format=3, version="1.4")
    header.scales = np.array([0.001, 0.001, 0.001], dtype=np.float64)
    # Offset to the data min so projected (UTM) coordinates fit LAS's 32-bit ints.
    # Misses sit ~20 km out along the beam, so this must span BOTH populations.
    header.offsets = np.floor(out_xyz.min(axis=0))
    header.add_extra_dim(laspy.ExtraBytesParams(name="is_miss", type=np.float32))

    n_out = out_xyz.shape[0]
    record = laspy.ScaleAwarePointRecord.zeros(n_out, header=header)
    record.x = out_xyz[:, 0]
    record.y = out_xyz[:, 1]
    record.z = out_xyz[:, 2]
    # Carry gps_time through for the returns; synthesised misses get 0 (their own
    # reconstructed times are not exposed by the bulk getters).
    gps_out = np.concatenate([gps, np.zeros(n_miss, dtype=np.float64)]) if n_miss else gps
    record.gps_time = gps_out
    if hasattr(las, "intensity"):
        inten = np.asarray(las.intensity)[order]
        record.intensity = np.concatenate([
            inten, np.zeros(n_miss, dtype=inten.dtype)]) if n_miss else inten
    record["is_miss"] = is_miss

    with laspy.open(args.output, mode="w", header=header) as writer:
        writer.write_points(record)

    size_mb = os.path.getsize(args.output) / (1024 * 1024)
    _log(f"wrote {args.output} — {n_out:,} points "
         f"({n_pts:,} returns + {n_miss:,} misses), {size_mb:.0f} MB")
    _log("Import it in Phytograph; it already carries its misses, so Backfill "
         "Misses is not needed before Leaf Area Density.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
