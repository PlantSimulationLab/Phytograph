"""Visual sanity overlay: render the reconstruction over the cloud / ground truth.

"Statistics can lie" -- so every validation run emits a 2x2 montage (4 camera
angles) an agent or human can eyeball:
  - point cloud as light-gray dots,
  - ground-truth cylinders as thin green lines,
  - reconstructed cylinders as thicker lines colored by shoot rank,
  - mismatched reconstruction samples (far from any GT) highlighted red.

matplotlib (already a backend dependency) is used instead of open3d-offscreen so
this works headless in CI / inside the pytest process with no EGL/display.
Backend Agg is forced so importing this never requires a window.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from ..model import QSM
from .resample import DEFAULT_DS, centerline_samples

# Per-rank colors (rank 0 = trunk, dark brown -> outward). Index clamped.
RANK_COLORS = [
    "#5b3a1a",  # 0 trunk
    "#e07b1a",  # 1 scaffold (orange)
    "#1f77b4",  # 2 (blue)
    "#7f7f7f",  # 3+ (gray)
]

# 4 viewing angles (elev, azim) for the montage.
VIEWS = [(20, -60), (20, 30), (90, -90), (5, 0)]
VIEW_NAMES = ["3/4 iso", "side", "top", "front"]


def _rank_color(rank: int) -> str:
    return RANK_COLORS[min(int(rank), len(RANK_COLORS) - 1)]


def render_overlay(
    recon: QSM,
    out_path: str | Path,
    gt: QSM | None = None,
    cloud: np.ndarray | None = None,
    r_min: float = 0.005,
    ds: float = DEFAULT_DS,
    max_cloud_points: int = 30000,
    title: str | None = None,
) -> Path:
    """Write a 2x2 PNG montage to ``out_path``. Returns the path."""
    import matplotlib

    matplotlib.use("Agg")  # headless; no display required
    import matplotlib.pyplot as plt

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # Precompute mismatch highlight: recon samples far from any GT sample.
    mismatch_xyz = None
    if gt is not None:
        from scipy.spatial import cKDTree

        recon_cl = centerline_samples(recon, ds=ds)
        gt_cl = centerline_samples(gt, ds=ds)
        if len(recon_cl) and len(gt_cl):
            d, _ = cKDTree(gt_cl.xyz).query(recon_cl.xyz)
            mismatch_xyz = recon_cl.xyz[d > 2.0 * r_min]

    cloud_ds = None
    if cloud is not None and len(cloud):
        cloud = np.asarray(cloud, dtype=np.float64)
        if cloud.shape[0] > max_cloud_points:
            stride = int(np.ceil(cloud.shape[0] / max_cloud_points))
            cloud_ds = cloud[::stride]
        else:
            cloud_ds = cloud

    # Linewidth proportional to radius so a human can eyeball radius accuracy
    # (recon vs GT use the SAME scale -> visually comparable thickness). This is
    # the visual check Phase D depends on -- "statistics can lie." Falls back to
    # a thin constant line if no radius spread (e.g. provisional all-equal radii).
    all_r = [c.radius for c in recon.cylinders]
    if gt is not None:
        all_r += [c.radius for c in gt.cylinders]
    r_ref = max(all_r) if all_r else 0.0
    # Map the largest radius to ~6 points of linewidth; floor so thin twigs show.
    lw_scale = (6.0 / r_ref) if r_ref > 0 else 0.0

    def _lw(radius: float) -> float:
        return max(0.6, lw_scale * radius) if lw_scale else 1.0

    fig = plt.figure(figsize=(12, 12))
    for vi, (elev, azim) in enumerate(VIEWS):
        ax = fig.add_subplot(2, 2, vi + 1, projection="3d")
        if cloud_ds is not None:
            ax.scatter(
                cloud_ds[:, 0], cloud_ds[:, 1], cloud_ds[:, 2],
                s=0.5, c="#cccccc", alpha=0.4, linewidths=0,
            )
        if gt is not None:
            for c in gt.cylinders:
                ax.plot(
                    [c.start[0], c.end[0]], [c.start[1], c.end[1]], [c.start[2], c.end[2]],
                    color="#2ca02c", linewidth=_lw(c.radius), alpha=0.45,
                    solid_capstyle="round",
                )
        for c in recon.cylinders:
            ax.plot(
                [c.start[0], c.end[0]], [c.start[1], c.end[1]], [c.start[2], c.end[2]],
                color=_rank_color(c.rank), linewidth=_lw(c.radius),
                alpha=0.85, solid_capstyle="round",
            )
        if mismatch_xyz is not None and len(mismatch_xyz):
            ax.scatter(
                mismatch_xyz[:, 0], mismatch_xyz[:, 1], mismatch_xyz[:, 2],
                s=6, c="red", alpha=0.8, linewidths=0,
            )
        ax.view_init(elev=elev, azim=azim)
        ax.set_title(VIEW_NAMES[vi], fontsize=10)
        _set_equal_aspect(ax, recon, gt)
        ax.set_axis_off()

    if title:
        fig.suptitle(title, fontsize=13)
    fig.tight_layout()
    fig.savefig(out_path, dpi=110)
    plt.close(fig)
    return out_path


def _set_equal_aspect(ax, recon: QSM, gt: QSM | None) -> None:
    """Equalize 3D axes so the tree isn't distorted."""
    pts = []
    for q in (recon, gt):
        if q is None:
            continue
        for c in q.cylinders:
            pts.append(c.start)
            pts.append(c.end)
    if not pts:
        return
    p = np.asarray(pts)
    mins, maxs = p.min(axis=0), p.max(axis=0)
    center = 0.5 * (mins + maxs)
    span = float(np.max(maxs - mins)) or 1.0
    half = 0.5 * span
    ax.set_xlim(center[0] - half, center[0] + half)
    ax.set_ylim(center[1] - half, center[1] + half)
    ax.set_zlim(center[2] - half, center[2] + half)
