#!/usr/bin/env python3
"""Compute the label-free leaf-triangulation separability metrics on a REAL scan.

Companion to leaf_triangulation_separation.py. Real scans have no organ labels, so this
only runs the *label-free* half of the validated pipeline -- the part the product would
actually compute: triangulate the returns through the shipping Helios path (unfiltered),
take the candidate longest-edge distribution, and report Otsu separability (eta) + the
suggested Lmax + the GMM/NN alternatives, plus a histogram. There is no ground truth here
(no gt_auc / Lmax* / contamination); this is a "what does the metric say on real data" check.

CAVEAT -- scanner origin: the Helios triangulation projects points to (zenith, azimuth)
from the scanner origin, so an origin is required. Registered TXT exports don't carry one.
Edge *lengths* are 3-D metric (viewpoint-invariant); only the *connectivity* depends on the
origin, and any external vantage still yields the intra-leaf (short) vs inter-leaf-bridge
(long) split. Pass the true scan position with --origin if known; the default assumes the
world origin, which for these clouds is a clean external viewpoint ~19 m from the canopy.

Usage (from backend-api/, venv active):
    python research/analyze_real_scan.py path/to/scan.txt
    python research/analyze_real_scan.py scan.txt --origin 0,0,0 --xyz-cols 0,1,2 --delim ,
"""

from __future__ import annotations

import argparse
import math
import os
import sys
import tempfile

import numpy as np

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_BACKEND_DIR = os.path.dirname(_THIS_DIR)
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)

import leaf_triangulation_separation as h  # reuse stat_otsu / stat_gmm / stat_nn_spacing  # noqa: E402

OUT_DIR = os.path.join(_THIS_DIR, "out")


def load_xyz(path: str, xyz_cols, delim, max_points: int | None,
             index_col: int | None = None, index_val: float | None = None):
    """Stream the point file and return an (N,3) float array. Skips a leading comment/header
    line (starts with '/', '#', or a non-numeric first token).

    If ``index_col``/``index_val`` are given, keep only rows whose column ``index_col``
    equals ``index_val`` -- used to isolate ONE scan position from a merged multi-scan
    cloud (e.g. a CloudCompare "Original cloud index"), so the single-origin angular
    Delaunay is valid (a merged cloud manufactures spurious cross-position bridges)."""
    pts = []
    cols = list(xyz_cols)
    with open(path) as f:
        for ln, line in enumerate(f):
            if not line.strip():
                continue
            if line[0] in "/#":
                continue
            parts = line.replace(delim, " ").split() if delim != " " else line.split()
            try:
                if index_col is not None and float(parts[index_col]) != index_val:
                    continue
                pts.append([float(parts[cols[0]]), float(parts[cols[1]]), float(parts[cols[2]])])
            except (ValueError, IndexError):
                continue  # header row or malformed line
            if max_points and len(pts) >= max_points:
                break
    return np.asarray(pts, dtype=np.float64)


def angular_extent(xyz: np.ndarray, origin: np.ndarray):
    """Zenith/azimuth ranges (degrees) of the cloud seen from origin, in Helios convention
    (zenith = acos(dz/r), azimuth = atan2(dx, dy)). Azimuth is unwrapped about its mean so a
    cloud near the 0/2pi seam doesn't get a spurious ~360deg span. Also returns n hint."""
    d = xyz - origin
    r = np.linalg.norm(d, axis=1)
    zen = np.degrees(np.arccos(np.clip(d[:, 2] / r, -1.0, 1.0)))
    az = np.arctan2(d[:, 0], d[:, 1])
    az_unwrapped = np.degrees(np.angle(np.exp(1j * (az - np.mean(az))))) + math.degrees(np.mean(az))
    return (zen.min(), zen.max()), (az_unwrapped.min(), az_unwrapped.max())


def triangulate_real(xyz: np.ndarray, origin, oversample: float = 1.4):
    """Triangulate a real single-viewpoint cloud through the shipping Helios path with no
    edge/aspect filter. Returns the candidate triangles' longest edges (T,)."""
    from main import _do_helios_computation, HeliosTriangulationRequest, HeliosScanEntry

    origin = np.asarray(origin, dtype=np.float64)
    (zmin, zmax), (amin, amax) = angular_extent(xyz, origin)
    margin = 0.5
    # Grid fine enough that points rarely share an angular cell (else collisions drop them):
    # aim for ~oversample x more cells than points, split by the angular aspect ratio.
    n = len(xyz)
    aspect = max((zmax - zmin), 1e-3) / max((amax - amin), 1e-3)
    n_phi = max(int(math.sqrt(n * oversample / max(aspect, 1e-3))), 16)
    n_theta = max(int(n * oversample / n_phi), 16)

    tmp = tempfile.mkdtemp(prefix="real_scan_")
    fp = os.path.join(tmp, "scan.xyz")
    np.savetxt(fp, xyz, fmt="%.6f")
    try:
        entry = HeliosScanEntry(
            file_path=fp, ascii_format="x y z",
            origin=[float(origin[0]), float(origin[1]), float(origin[2])],
            n_theta=int(n_theta), n_phi=int(n_phi),
            theta_min=float(zmin - margin), theta_max=float(zmax + margin),
            phi_min=float(amin - margin), phi_max=float(amax + margin),
        )
        res = _do_helios_computation(HeliosTriangulationRequest(
            scans=[entry], lmax=h._KEEP_ALL, max_aspect_ratio=h._KEEP_ALL))
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)

    if not res.get("success") or not res.get("triangles"):
        raise RuntimeError(f"triangulation produced no candidates: {res.get('error')}")
    V = np.asarray(res["vertices"], dtype=np.float64)
    T = np.asarray(res["triangles"], dtype=np.int64)
    a, b, c = V[T[:, 0]], V[T[:, 1]], V[T[:, 2]]
    edges = np.maximum.reduce([
        np.linalg.norm(a - b, axis=1),
        np.linalg.norm(b - c, axis=1),
        np.linalg.norm(c - a, axis=1),
    ])
    return edges, (n_theta, n_phi), (zmin, zmax, amin, amax)


def plot_hist(edges, otsu_lmax, gmm_lmax, nn_lmax, otsu_conf, gmm_conf, title, fname):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    x = np.log10(edges[edges > 0])
    fig, ax = plt.subplots(figsize=(8, 4.5))
    ax.hist(x, bins=120, color="#4c72b0", alpha=0.85)
    for val, name, style in [(otsu_lmax, "Otsu", "b-"), (gmm_lmax, "GMM", "m--"),
                             (nn_lmax, "NN x4", "g:")]:
        if np.isfinite(val) and val > 0:
            ax.axvline(math.log10(val), linestyle=style[1:], color=style[0],
                       label=f"{name} = {val*100:.2f} cm")
    ax.set_xlabel("log10(longest triangle edge / m)")
    ax.set_ylabel("count")
    ax.set_title(f"{title}\nOtsu eta={otsu_conf:.2f}  GMM conf={gmm_conf:.2f}  "
                 f"(NO ground truth -- label-free only)")
    ax.legend(fontsize=8)
    fig.tight_layout()
    os.makedirs(OUT_DIR, exist_ok=True)
    fig.savefig(os.path.join(OUT_DIR, fname), dpi=110)
    plt.close(fig)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("scan", help="path to the scan point file")
    ap.add_argument("--origin", default="0,0,0", help="scanner origin x,y,z (default 0,0,0)")
    ap.add_argument("--xyz-cols", default="0,1,2", help="0-based column indices for x,y,z")
    ap.add_argument("--delim", default=",", help="column delimiter (default ',')")
    ap.add_argument("--max-points", type=int, default=None, help="cap points (debug)")
    ap.add_argument("--index-col", type=int, default=None,
                    help="0-based column holding a per-point scan-position index "
                         "(e.g. CloudCompare 'Original cloud index'); use with --index")
    ap.add_argument("--index", type=float, default=None,
                    help="keep only points whose --index-col equals this value (isolate "
                         "ONE scan position from a merged multi-scan cloud)")
    ap.add_argument("--label", default=None, help="title/filename label (default: file stem)")
    args = ap.parse_args()

    origin = np.array([float(v) for v in args.origin.split(",")])
    xyz_cols = [int(v) for v in args.xyz_cols.split(",")]
    label = args.label or os.path.splitext(os.path.basename(args.scan))[0]
    if args.index_col is not None and args.index is not None:
        label += f"_idx{args.index:g}"

    print(f"Loading {args.scan} ...")
    xyz = load_xyz(args.scan, xyz_cols, args.delim, args.max_points,
                   index_col=args.index_col, index_val=args.index)
    bbox = xyz.max(0) - xyz.min(0)
    print(f"  points={len(xyz)}  bbox span={np.round(bbox, 2).tolist()} m  "
          f"center={np.round(xyz.mean(0), 2).tolist()}")
    print(f"  assumed scanner origin={origin.tolist()}  "
          f"(distance to cloud center {np.linalg.norm(xyz.mean(0)-origin):.1f} m)")

    edges, (nt, npi), (zmin, zmax, amin, amax) = triangulate_real(xyz, origin)
    print(f"  angular extent from origin: zenith [{zmin:.1f},{zmax:.1f}] deg, "
          f"azimuth [{amin:.1f},{amax:.1f}] deg; grid {nt}x{npi}")
    print(f"  candidate triangles={len(edges)}  "
          f"(edge median={np.median(edges)*100:.2f}cm  p95={np.percentile(edges,95)*100:.2f}cm)")

    otsu_lmax, otsu_conf = h.stat_otsu(edges)
    gmm_lmax, gmm_conf = h.stat_gmm(edges)
    nn_lmax, _ = h.stat_nn_spacing(xyz)
    print(f"\n  Otsu : Lmax={otsu_lmax*100:.2f}cm  separability eta={otsu_conf:.3f}")
    print(f"  GMM  : Lmax={gmm_lmax*100:.2f}cm  confidence={gmm_conf:.3f}")
    print(f"  NN x4: Lmax={nn_lmax*100:.2f}cm  (baseline)")

    fname = f"real_{label}.png"
    plot_hist(edges, otsu_lmax, gmm_lmax, nn_lmax, otsu_conf, gmm_conf,
              f"Real scan: {label}  (origin {origin.tolist()})", fname)
    print(f"\n  Wrote histogram -> {os.path.join(OUT_DIR, fname)}")


if __name__ == "__main__":
    main()
