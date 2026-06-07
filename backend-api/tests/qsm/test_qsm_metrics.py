"""Phase F: horticultural output metrics (qsm/metrics.py).

These describe ONE finished QSM for the user (TCSA, scaffold count, per-rank
diameter/angle/length, woody volume stem-vs-branch). Tested against hand-built
synthetic trees with known geometry (exact expected values) and the PyHelios GT
(plausible-range + recon-tracks-GT) so the assertions are concrete numbers, not
"didn't throw".
"""

from __future__ import annotations

import numpy as np
import pytest

from qsm.metrics import compute_metrics
from qsm.model import QSM
from qsm.validation.synthetic import simple_tree


def test_empty_qsm_is_all_zero():
    m = compute_metrics(QSM())
    assert m.tcsa_m2 == 0.0
    assert m.n_shoots_total == 0
    assert m.per_rank == []


def test_synthetic_tree_known_values():
    """simple_tree() is hand-built with exact geometry: trunk r 0.05->0.03 base
    0.05 (dia 100mm) over L=2.0, 3 rank-1 scaffolds, 3 rank-2 sub-branches. Assert
    the metrics recover these exactly (it's a known QSM, no reconstruction)."""
    gt = simple_tree()
    m = compute_metrics(gt)

    # Trunk base diameter = 2 * the base CYLINDER's radius. simple_tree tapers the
    # trunk 0.05->0.03 across 10 segments, so the lowest cylinder's radius is the
    # value at its midpoint (~0.049), i.e. ~98 mm, not the nominal 100. Assert
    # against that base cylinder directly so the expectation is exact.
    base = min(gt.cylinders, key=lambda c: min(c.start[2], c.end[2]))
    assert m.trunk_diameter_mm == pytest.approx(2.0 * base.radius * 1000.0, rel=1e-6)
    assert m.tcsa_m2 == pytest.approx(np.pi * base.radius**2, rel=1e-6)
    assert 95.0 < m.trunk_diameter_mm < 100.0  # sanity: near the nominal 100 mm
    # Height: trunk is 2.0 m tall plus scaffolds rise above; >= 2.0.
    assert m.tree_height_m >= 2.0
    # Structure: exactly 3 scaffolds (rank 1), max rank 2.
    assert m.n_scaffolds == 3
    assert m.max_rank == 2
    assert m.n_shoots_total == 1 + 3 + 3  # trunk + 3 scaffolds + 3 sub-branches

    # Volume splits and sums consistently.
    assert m.stem_volume_m3 > 0 and m.branch_volume_m3 > 0
    assert m.total_woody_volume_m3 == pytest.approx(
        m.stem_volume_m3 + m.branch_volume_m3, rel=1e-9
    )
    assert m.total_woody_volume_m3 == pytest.approx(gt.total_volume, rel=1e-9)


def test_per_rank_diameter_decreases_with_rank():
    """Wood gets thinner with rank (trunk > scaffold > sub-branch)."""
    m = compute_metrics(simple_tree())
    by_rank = {pr.rank: pr for pr in m.per_rank}
    assert by_rank[0].mean_diameter_mm > by_rank[1].mean_diameter_mm
    assert by_rank[1].mean_diameter_mm > by_rank[2].mean_diameter_mm
    # Trunk has no crotch angle; scaffolds/sub-branches do, and they are sane.
    assert by_rank[0].mean_branch_angle_deg is None
    assert 0.0 < by_rank[1].mean_branch_angle_deg < 180.0


def test_per_rank_lengths_sum_to_total():
    m = compute_metrics(simple_tree())
    assert sum(pr.total_length_m for pr in m.per_rank) == pytest.approx(
        m.total_length_m, rel=1e-9
    )


def test_canopy_extents_positive_and_ordered():
    m = compute_metrics(simple_tree())
    assert m.canopy_width_m > 0
    assert 0 < m.canopy_height_m <= m.tree_height_m


# --- Layer-2 GT: plausible ranges on a realistic tree ---


@pytest.mark.parametrize("name", ["simple", "central_leader_branched"])
def test_layer2_gt_metrics_plausible(name):
    from qsm.validation.datasets import case_available, load_case

    if not case_available(name):
        pytest.skip(f"fixture {name} not present")
    gt = load_case(name).gt
    m = compute_metrics(gt)
    # Orchard-tree sanity: trunk a few cm, height ~1-3 m, >=1 scaffold, volume tiny
    # but positive, ranks present.
    assert 5.0 < m.trunk_diameter_mm < 100.0, m.trunk_diameter_mm
    assert 0.5 < m.tree_height_m < 4.0, m.tree_height_m
    assert m.n_scaffolds >= 1
    assert m.max_rank >= 1
    assert m.total_woody_volume_m3 > 0
    # TCSA consistent with the reported trunk diameter.
    assert m.tcsa_m2 == pytest.approx(np.pi * (m.trunk_diameter_mm / 2000.0) ** 2, rel=0.05)
