"""Recover RiSCAN PRO's registration transforms from a registered export.

Why this exists
---------------
Benchmarking our registration needs a REFERENCE pose. Reconstructing one from
the registration report's Euler angles was tried and is unreliable -- the
convention is not documented and a wrong guess is indistinguishable from a bad
algorithm. Four geometric recovery attempts (index matching, ICP on crops,
percentile-trimmed ICP, attribute keys) all failed too, because the registered
export clips the far field differently from the unregistered one.

What works is per-return identity. Each LAS point carries a gps_time, and a
rigid transform does not change it. Matching returns by timestamp gives TRUE
correspondences, and Kabsch on those recovers the transform in closed form.

Two data quirks this handles:
  * Timestamps are not bit-identical between exports (~2e-5 s apart), so the
    match is nearest-in-time with an ambiguity guard, not equality.
  * One scan (ScanPos004) has its GPS clock offset by a constant ~1105 s in the
    registered export. Without removing it the time windows do not overlap and
    the matcher silently returns zero pairs.

Recovered quality: 0.52-0.64 mm median nearest-neighbour over the full 13-14 M
point clouds, with rotation matrices orthonormal to ~1e-16.

Usage:  python tools/recover_riscan_truth.py <unregistered_dir> <registered_dir> <out_dir>
"""

import math
import sys
from pathlib import Path

import laspy
import numpy as np
import open3d as o3d
from scipy.spatial import cKDTree

# Matching tolerances. Point spacing is ~3.5e-6 s, so a 5e-6 s window admits a
# near neighbour; the gap test then rejects any match whose runner-up is close
# enough to be confusable.
_MAX_DT = 5e-6
_MIN_GAP = 2e-5
# Fallback for exports decimated enough that few returns have a clean time gap.
_MIN_GAP_RELAXED = 1e-6


def _load_drop_far_outliers():
    """Borrow `main._drop_far_outliers` without importing `main`.

    Importing the module runs a startup guard that refuses to load unless the
    PyHelios native library is present -- correct for the server, pointless for
    an offline analysis script. Exec just that one function's source instead, so
    the tool and the registration path share a single definition of "this is a
    sky return" rather than drifting apart.
    """
    src = (Path(__file__).resolve().parent.parent / "main.py").read_text()
    start = src.index("def _drop_far_outliers(")
    end = src.index("\ndef ", start + 1)
    ns = {"np": np}
    exec(compile(src[start:end], "main._drop_far_outliers", "exec"), ns)
    return ns["_drop_far_outliers"]


def _drop_misses(points, times):
    """Remove sky/miss returns before anything else looks at the geometry.

    A scanner emits a return for every pulse, including those that hit nothing;
    those land at the instrument's maximum range. In the GrapeX exports that is
    61% of all points sitting at ~20 km, which drags the cloud median to
    z=2586 m and makes any median-centred crop select empty space. Peach and
    olive had no misses, so this only surfaced on the third dataset.

    Uses the same filter the registration path uses, so the recovery tool and
    the algorithm agree on what counts as a real return.
    """
    keep = np.isfinite(points).all(axis=1)
    points, times = points[keep], times[keep]
    if len(points) == 0:
        return points, times
    # `_drop_far_outliers` returns the surviving POINTS, so re-derive the mask
    # by range to keep `times` aligned with them.
    kept = _load_drop_far_outliers()(points.copy())
    if len(kept) < 100 or len(kept) == len(points):
        return points, times
    centre = np.median(kept, axis=0)
    limit = float(np.max(np.linalg.norm(kept - centre, axis=1)))
    mask = np.linalg.norm(points - centre, axis=1) <= limit
    return points[mask], times[mask]


def _near(points, radius=45.0):
    """Near-field only: the far tail is clipped differently between exports."""
    return points[np.linalg.norm(points - np.median(points, axis=0), axis=1) < radius]


def _pc(a, voxel=0.05):
    p = o3d.geometry.PointCloud()
    p.points = o3d.utility.Vector3dVector(a)
    p = p.voxel_down_sample(voxel)
    p.estimate_normals(
        search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=0.4, max_nn=30))
    return p


def recover(unreg_path, reg_path):
    """Return (4x4 transform, n_pairs, full-cloud median NN residual)."""
    u, r = laspy.read(str(unreg_path)), laspy.read(str(reg_path))
    tu, tr = np.asarray(u.gps_time), np.asarray(r.gps_time)
    XU = np.column_stack([u.x, u.y, u.z])
    XR = np.column_stack([r.x, r.y, r.z])
    XU, tu = _drop_misses(XU, tu)
    XR, tr = _drop_misses(XR, tr)

    offset = np.median(tr) - np.median(tu)
    if abs(offset) > 1.0:
        print(f"   (clock offset {offset:+.3f}s removed)")
        tr = tr - offset

    ou, orr = np.argsort(tu, kind="stable"), np.argsort(tr, kind="stable")
    tus, trs, XUs, XRs = tu[ou], tr[orr], XU[ou], XR[orr]

    j = np.clip(np.searchsorted(tus, trs), 1, len(tus) - 1)
    left, right = np.abs(trs - tus[j - 1]), np.abs(trs - tus[j])
    pick = np.where(left <= right, j - 1, j)
    dt = np.minimum(left, right)
    gap = np.full(len(tus), np.inf)
    gap[:-1] = np.diff(tus)
    def _kabsch(mask):
        if mask.sum() < 100:
            return None
        A, B = XUs[pick[mask]], XRs[mask]
        ca, cb = A.mean(0), B.mean(0)
        U, _, Vt = np.linalg.svd((A - ca).T @ (B - cb))
        d = np.sign(np.linalg.det(Vt.T @ U.T))
        R = Vt.T @ np.diag([1.0, 1.0, d]) @ U.T
        M = np.eye(4)
        M[:3, :3], M[:3, 3] = R, cb - R @ ca
        return M

    def _score(M):
        """Median nearest-neighbour of the whole cloud under M."""
        if M is None:
            return float("inf")
        k = np.linspace(0, len(XU) - 1, 60_000).astype(int)
        dist, _ = cKDTree(XR).query(XU[k] @ M[:3, :3].T + M[:3, 3])
        return float(np.median(dist))

    # Try BOTH gap guards and keep whichever actually fits the cloud better.
    # Neither is reliably the winner. The strict guard is cleaner in principle
    # (every match unambiguous) but starves on a decimated export: on GrapeX
    # scan 1 it yielded 16,756 matches fitting to 0.315 m, while the relaxed
    # guard's 7.2 M matches fitted to 0.027 m -- the extra pairs are noisier
    # individually but Kabsch averages over millions of them. On other scans the
    # strict guard wins. Measuring is cheaper than guessing.
    masks = {"strict": (dt < _MAX_DT) & (gap[pick] > _MIN_GAP),
             "dense": (dt < _MAX_DT) & (gap[pick] > _MIN_GAP_RELAXED)}
    candidates = {k: _kabsch(v) for k, v in masks.items()}
    scores = {k: _score(v) for k, v in candidates.items()}
    label = min(scores, key=scores.get)
    M = candidates[label]
    if M is None or not np.isfinite(scores[label]):
        raise RuntimeError("no usable time-matched correspondences")
    n_pairs = int(masks[label].sum())
    if label != "strict":
        print(f"   (used {label} time matching: {scores[label]:.4f} m "
              f"vs strict {scores['strict']:.4f} m)")

    # Polish against the clouds themselves: time matching fixes the rotation to
    # ~0.004 deg but leaves translation slightly soft on the clock-shifted scan.
    res = o3d.pipelines.registration.registration_icp(
        _pc(_near(XU)), _pc(_near(XR)), 0.30, M,
        o3d.pipelines.registration.TransformationEstimationPointToPlane(),
        o3d.pipelines.registration.ICPConvergenceCriteria(max_iteration=200))
    M = np.asarray(res.transformation)

    k = np.linspace(0, len(XU) - 1, 150_000).astype(int)
    dist, _ = cKDTree(XR).query(XU[k] @ M[:3, :3].T + M[:3, 3])
    return M, int(n_pairs), float(np.median(dist))


def main():
    if len(sys.argv) != 4:
        print(__doc__)
        return 1
    unreg_dir, reg_dir, out_dir = (Path(a) for a in sys.argv[1:])
    out_dir.mkdir(parents=True, exist_ok=True)

    unreg = sorted(unreg_dir.glob("*.laz"))
    reg = sorted(reg_dir.glob("*.laz"))
    if len(unreg) != len(reg):
        print(f"count mismatch: {len(unreg)} unregistered, {len(reg)} registered")
        return 1

    for i, (up, rp) in enumerate(zip(unreg, reg), 1):
        M, n, resid = recover(up, rp)
        yaw = math.degrees(math.atan2(M[1, 0], M[0, 0]))
        ortho = float(np.abs(M[:3, :3] @ M[:3, :3].T - np.eye(3)).max())
        print(f"{up.name:34s} pairs={n:>7,} resid={resid:.6f}m "
              f"yaw={yaw:9.4f} ortho={ortho:.1e}")
        np.save(out_dir / f"TRUTH_{i}.npy", M)
    print(f"\nwrote TRUTH_1..{len(unreg)}.npy to {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
