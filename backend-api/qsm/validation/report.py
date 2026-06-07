"""Assemble all validation metrics into one report with a printable summary.

Usage in a test::

    report = build_report(recon_qsm, gt_qsm, cloud=cloud, r_min=0.005)
    print(report.summary())          # visible under pytest -s
    assert report.centerline.cov_gt >= COV_GT_MIN
    ...

The report holds raw numbers only; the *assertions* (bars) live in the tests so
a deliberate loosening shows up in a diff.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..model import QSM
from .metrics import (
    CenterlineMetrics,
    CloudAnchoredMetrics,
    RadiusMetrics,
    RankMetrics,
    TopometricMetrics,
    centerline_agreement,
    cloud_anchored_agreement,
    radius_agreement,
    rank_agreement,
    topometric_agreement,
)
from .resample import DEFAULT_DS, centerline_samples


@dataclass
class ValidationReport:
    r_min: float
    centerline: CenterlineMetrics
    radius: RadiusMetrics
    topometric: TopometricMetrics
    rank: RankMetrics
    cloud: CloudAnchoredMetrics | None = None

    def summary(self) -> str:
        c, r, t, k = self.centerline, self.radius, self.topometric, self.rank
        lines = [
            "===== QSM Validation Report =====",
            f"r_min = {self.r_min*1000:.1f} mm",
            "",
            "[1] Centerline agreement",
            f"    mean_sym = {c.mean_sym*1000:.2f} mm   p95_sym = {c.p95_sym*1000:.2f} mm"
            f"   hausdorff = {c.hausdorff*1000:.1f} mm",
            f"    cov_gt(recall) = {c.cov_gt:.3f}   cov_recon(prec) = {c.cov_recon:.3f}"
            f"   (tau = {c.tau*1000:.1f} mm)",
        ]
        if self.cloud is not None:
            lines += [
                f"    cloud-anchored: mean = {self.cloud.mean*1000:.2f} mm"
                f"   p95 = {self.cloud.p95*1000:.2f} mm",
            ]
        lines += [
            "",
            "[2] Radius vs geodesic distance (stem vs branch)",
            f"    mean_relerr_stem = {r.mean_relerr_stem*100:+.1f}%"
            f"   mean_relerr_branch = {r.mean_relerr_branch*100:+.1f}%",
            f"    rmse_radius = {r.rmse_radius*1000:.2f} mm"
            f"   volume_relerr total = {r.volume_relerr_total*100:+.1f}%"
            f"   stem = {r.volume_relerr_stem*100:+.1f}%",
            "",
            "[3] Topometric",
            f"    total_length_relerr = {t.total_length_relerr*100:+.1f}%"
            f"   total_volume_relerr = {t.total_volume_relerr*100:+.1f}%",
            f"    tips recon/gt = {t.n_tips_recon}/{t.n_tips_gt}"
            f"   forks = {t.n_forks_recon}/{t.n_forks_gt}"
            f"   shoots = {t.n_shoots_recon}/{t.n_shoots_gt}",
            f"    branch_len KS p = {t.branch_len_ks_p:.3f}   mad = {t.branch_len_mad*1000:.1f} mm"
            f"   branch_angle mad = {t.branch_angle_mad:.1f} deg",
            "",
            "[4] Shoot-rank agreement (headline)",
            f"    overall_accuracy = {k.overall_accuracy:.3f}"
            f"   unmatched = {k.unmatched_fraction:.3f}",
            f"    rank-0 shoots recon/gt = {k.n_rank0_shoots_recon}/{k.n_rank0_shoots_gt}",
            "    per-rank precision/recall: "
            + ", ".join(
                f"r{kk}={k.precision.get(kk,0):.2f}/{k.recall.get(kk,0):.2f}"
                for kk in sorted(k.precision)
            ),
            "    arc-length relerr per rank: "
            + ", ".join(
                f"r{kk}={k.arclen_relerr_per_rank.get(kk,0)*100:+.0f}%"
                for kk in sorted(k.arclen_relerr_per_rank)
            ),
            "    confusion (rows=recon rank, cols=gt rank, arc-length m):",
        ]
        conf = k.confusion
        for i in range(conf.shape[0]):
            lines.append("      " + "  ".join(f"{conf[i,j]:6.3f}" for j in range(conf.shape[1])))
        lines.append("=================================")
        return "\n".join(lines)


def build_report(
    recon: QSM,
    gt: QSM,
    cloud: np.ndarray | None = None,
    r_min: float = 0.005,
    ds: float = DEFAULT_DS,
) -> ValidationReport:
    """Compute every metric. ``r_min`` (smallest target branch radius) scales the
    distance tolerances; ``cloud`` (Nx3) enables the GT-independent check."""
    recon_cl = centerline_samples(recon, ds=ds)
    gt_cl = centerline_samples(gt, ds=ds)

    tau_cov = 2.0 * r_min
    tau_rank = 3.0 * r_min

    return ValidationReport(
        r_min=r_min,
        centerline=centerline_agreement(recon_cl, gt_cl, tau=tau_cov),
        radius=radius_agreement(recon_cl, gt_cl),
        topometric=topometric_agreement(recon, gt),
        rank=rank_agreement(recon_cl, gt_cl, tau_rank=tau_rank, recon_qsm=recon, gt_qsm=gt),
        cloud=cloud_anchored_agreement(recon, cloud, ds=ds) if cloud is not None else None,
    )
