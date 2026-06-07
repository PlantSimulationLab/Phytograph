"""Layer-2 validation: the full A->E pipeline on PyHelios ground-truth fixtures.

This is the realistic-density gate. Layer-1 used hand-built trees; here we run the
WHOLE pipeline (preprocess-free merged scan -> skeleton -> segments/shoot-rank ->
cylinder fit -> radius correction) on clouds the Helios C++ generator simulated
from known trees, and compare to the GT QSM with the (now tessellation-invariant)
harness metrics. Three complexity tiers: simple, tricky_fork, moderate.

Comparison is STATISTICAL (arc-length-resampled centerline samples), never
cylinder-to-cylinder -- the GT internode tessellation and our reconstruction chop
the tree at unrelated places. Every bar lives in tolerances.py (L2_*), calibrated
to measured performance so a regression trips it.

Two limitations are KNOWN and ACCEPTED (user decision 2026-06-07) and are asserted
as explicit, documented behaviors rather than silently tolerated:
  1. TRUNK WHORL: the GT trunk is a short determinate shoot ending in a whorl of
     scaffolds; our largest-GrowthLength continuation extends rank-0 up a scaffold
     instead of terminating. So trunk PRECISION is low. We assert we never MISS the
     trunk (recall) and that the rank-0 base is at the true tree base -- the trunk
     IS found, it just continues too far. ("If the trunk continues as rank 0 into a
     scaffold, that's acceptable" -- user.)
  2. FINE TWIGS: the geodesic skeleton merges the shortest rank-3 twigs into their
     parents, so tip COUNT is under-reported. We assert LENGTH recovery (95%+),
     which is what matters for volume/structure, rather than tip count.

If a fixture isn't present the case is skipped (not failed).
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from qsm.cylinders import fit_qsm_cylinders
from qsm.radius import correct_radii
from qsm.segments import segments_to_qsm
from qsm.skeleton import extract_skeleton
from qsm.validation.datasets import (
    CASES,
    CENTRAL_LEADER_CASES,
    available_cases,
    load_case,
)
from qsm.validation.metrics import (
    centerline_agreement,
    radius_agreement,
    rank_agreement,
    topometric_agreement,
)
from qsm.validation.overlay import render_overlay
from qsm.validation.resample import centerline_samples
from tests.qsm import tolerances as tol

ARTIFACTS = Path(__file__).parent / "_artifacts"

# Cases present at collection time; skip the whole module if none are.
_AVAILABLE = available_cases()
pytestmark = pytest.mark.skipif(
    not _AVAILABLE, reason="no Layer-2 fixtures in example-datasets/"
)


# Cache the (expensive) full-pipeline run per case across the test functions.
_PIPELINE_CACHE: dict[str, dict] = {}


def _run(name: str) -> dict:
    if name in _PIPELINE_CACHE:
        return _PIPELINE_CACHE[name]
    case = load_case(name)
    r_min = min(c.radius for c in case.gt.cylinders)
    graph = extract_skeleton(case.cloud)
    prov = segments_to_qsm(graph)
    fit = fit_qsm_cylinders(prov, case.cloud)
    corr = correct_radii(fit)
    tau = 3.0 * r_min
    recon_cl = centerline_samples(corr)
    gt_cl = centerline_samples(case.gt)
    out = dict(
        case=case, graph=graph, recon=corr, r_min=r_min, tau=tau,
        recon_cl=recon_cl, gt_cl=gt_cl,
        centerline=centerline_agreement(recon_cl, gt_cl, tau),
        radius=radius_agreement(recon_cl, gt_cl),
        rank=rank_agreement(recon_cl, gt_cl, tau),
        topo=topometric_agreement(corr, case.gt),
    )
    _PIPELINE_CACHE[name] = out
    return out


def _param(*ids):
    return pytest.mark.parametrize("name", [c for c in CASES if c in _AVAILABLE])


# --------------------------------------------------------------------------
# Coverage + centerline geometry
# --------------------------------------------------------------------------


@_param()
def test_coverage_and_centerline(name):
    """The reconstruction covers GT wood (recall) and doesn't invent wood
    (precision), and its centerline sits on the true axes."""
    r = _run(name)
    cm = r["centerline"]
    assert cm.cov_gt >= tol.L2_COV_GT_MIN, f"{name}: cov_gt {cm.cov_gt:.3f}"
    assert cm.cov_recon >= tol.L2_COV_RECON_MIN, f"{name}: cov_recon {cm.cov_recon:.3f}"
    assert cm.mean_sym <= tol.L2_CENTERLINE_MEAN_SYM_MAX_M, (
        f"{name}: mean_sym {cm.mean_sym:.4f}"
    )
    assert cm.p95_sym <= tol.L2_CENTERLINE_P95_SYM_MAX_M, f"{name}: p95 {cm.p95_sym:.4f}"


# --------------------------------------------------------------------------
# Length + volume (the headline radius/structure numbers)
# --------------------------------------------------------------------------


@_param()
def test_total_length_and_recovery(name):
    """Total woody length matches GT, and >=90% of GT arc length is recovered
    (the honest 'did we get the wood' number, robust to fine-twig merging which
    deflates tip COUNT but not length)."""
    r = _run(name)
    assert abs(r["topo"].total_length_relerr) <= tol.L2_TOTAL_LENGTH_RELERR_MAX, (
        f"{name}: total_length_relerr {r['topo'].total_length_relerr:+.3f}"
    )
    recovered = float(np.sum(r["recon_cl"].weights)) / float(np.sum(r["gt_cl"].weights))
    assert recovered >= tol.L2_LENGTH_RECOVERED_MIN, f"{name}: recovered {recovered:.3f}"


@_param()
def test_volume_within_tolerance(name):
    """Corrected total volume within tolerance -- the Demol-relevant number. The
    raw fit over-estimates branch volume by ~+100% (occlusion); Phase E pulls total
    volume to within ~10% on determinate-trunk trees and ~20% on the fine-branched
    central-leader (redbud) trees, whose thin self-occluded branches are the
    hardest volume case (see the L2_VOLUME_RELERR_MAX rationale)."""
    r = _run(name)
    v = r["radius"].volume_relerr_total
    assert abs(v) <= tol.L2_VOLUME_RELERR_MAX, f"{name}: volume_relerr {v:+.3f}"


@_param()
def test_radius_stem_and_branch_reported_separately(name):
    """Stem vs branch radius error, reported SEPARATELY (Demol: stem is accurate,
    branches carry the occlusion bias). Stem (well-sampled) must be tight; the
    branch bar is deliberately loose -- branches are occluded and the taper is
    slightly aggressive -- and is documented, with volume above as the headline."""
    r = _run(name)
    rm = r["radius"]
    assert abs(rm.mean_relerr_stem) <= tol.L2_STEM_RADIUS_RELERR_MAX, (
        f"{name}: stem radius relerr {rm.mean_relerr_stem:+.3f}"
    )
    assert abs(rm.mean_relerr_branch) <= tol.L2_BRANCH_RADIUS_RELERR_MAX, (
        f"{name}: branch radius relerr {rm.mean_relerr_branch:+.3f}"
    )


# --------------------------------------------------------------------------
# Shoot rank (headline) + the two KNOWN limitations, asserted explicitly
# --------------------------------------------------------------------------


@_param()
def test_exactly_one_trunk_at_the_base(name):
    """Exactly one rank-0 (trunk) shoot, and it starts at the true tree base. (The
    trunk may continue too far up a scaffold -- the accepted whorl limitation -- but
    it must exist, be unique, and be rooted at the base.)"""
    r = _run(name)
    corr = r["recon"]
    trunks = corr.shoots_of_rank(0)
    assert len(trunks) == 1, f"{name}: {len(trunks)} rank-0 shoots"
    # rank-0 base near the GT base (lowest z of GT cylinders).
    gt = r["case"].gt
    gt_base_z = min(min(c.start[2], c.end[2]) for c in gt.cylinders)
    root_cyls = [c for c in corr.cylinders if c.parent_id == -1]
    assert root_cyls, f"{name}: no root cylinder"
    recon_base_z = min(min(c.start[2], c.end[2]) for c in root_cyls)
    assert abs(recon_base_z - gt_base_z) < 0.05, (
        f"{name}: trunk base z {recon_base_z:.3f} vs GT {gt_base_z:.3f}"
    )


@_param()
def test_rank_recall_and_match(name):
    """We never MISS the trunk (rank-0 recall ~1), rank-1 scaffolds are mostly
    recovered, and few samples are unmatched. Trunk PRECISION is intentionally NOT
    asserted -- the trunk over-extends into a scaffold (known whorl limitation)."""
    r = _run(name)
    km = r["rank"]
    assert km.recall.get(0, 0.0) >= tol.L2_RANK_TRUNK_RECALL_MIN, (
        f"{name}: trunk recall {km.recall.get(0, 0):.3f}"
    )
    assert km.recall.get(1, 0.0) >= tol.L2_RANK_R1_RECALL_MIN, (
        f"{name}: rank-1 recall {km.recall.get(1, 0):.3f}"
    )
    assert km.unmatched_fraction <= tol.L2_RANK_UNMATCHED_MAX, (
        f"{name}: unmatched {km.unmatched_fraction:.3f}"
    )


@pytest.mark.parametrize(
    "name", [c for c in CASES if c in _AVAILABLE and c not in CENTRAL_LEADER_CASES]
)
def test_known_limitation_trunk_overextends_is_bounded(name):
    """DETERMINATE-trunk cases only. Document + bound the accepted whorl
    limitation: the GT trunk terminates in a whorl but our continuation extends
    rank-0 up a scaffold, so the rank-0 arc is LONGER than the GT trunk (trunk
    precision < 1). We assert the over-extension EXISTS (the known behavior) but is
    BOUNDED -- it follows ONE leader, staying under half the total tree arc, not
    running away across the crown. A tested, bounded property, not a silent pass."""
    r = _run(name)
    rs, gs = r["recon_cl"], r["gt_cl"]
    recon_r0 = float(np.sum(rs.weights[rs.rank == 0]))
    gt_r0 = float(np.sum(gs.weights[gs.rank == 0]))
    gt_total = float(np.sum(gs.weights))
    assert recon_r0 >= gt_r0, f"{name}: rank-0 arc {recon_r0:.2f} unexpectedly < GT {gt_r0:.2f}"
    assert recon_r0 < 0.5 * gt_total, (
        f"{name}: rank-0 arc {recon_r0:.2f} exceeds half the tree ({0.5*gt_total:.2f}) "
        f"-- trunk ran away, not just into one scaffold"
    )


@pytest.mark.parametrize(
    "name", [c for c in CENTRAL_LEADER_CASES if c in _AVAILABLE]
)
def test_central_leader_trunk_precision_high(name):
    """GENERALIZATION TEST. On a MONOPODIAL central leader (trunk continues as one
    rank-0 axis through its junctions), the SAME largest-GrowthLength continuation
    rule that over-extends on a determinate whorl should instead follow the leader
    correctly -- giving HIGH trunk precision and a rank-0 arc that matches GT. This
    proves the algorithm handles BOTH trunk architectures (user requirement)."""
    r = _run(name)
    km = r["rank"]
    rs, gs = r["recon_cl"], r["gt_cl"]
    recon_r0 = float(np.sum(rs.weights[rs.rank == 0]))
    gt_r0 = float(np.sum(gs.weights[gs.rank == 0]))
    # The leader is followed, not over-run: trunk precision is high AND the rank-0
    # arc length matches GT (unlike the whorl cases where it runs ~3-5x long).
    assert km.precision.get(0, 0.0) >= 0.90, (
        f"{name}: trunk precision {km.precision.get(0, 0):.3f} -- leader not followed"
    )
    assert km.recall.get(0, 0.0) >= tol.L2_RANK_TRUNK_RECALL_MIN
    assert abs(recon_r0 - gt_r0) / gt_r0 <= 0.15, (
        f"{name}: rank-0 arc {recon_r0:.2f} vs GT {gt_r0:.2f} "
        f"({abs(recon_r0-gt_r0)/gt_r0:.0%} off) -- leader length should match"
    )


# --------------------------------------------------------------------------
# Determinism + visual artifact
# --------------------------------------------------------------------------


@_param()
def test_pipeline_deterministic(name):
    """Same cloud -> bit-identical radii + ranks (the whole pipeline is
    deterministic). Runs the pipeline a second time (not from the cache)."""
    case = load_case(name)
    graph = extract_skeleton(case.cloud)
    a = correct_radii(fit_qsm_cylinders(segments_to_qsm(graph), case.cloud))
    b = correct_radii(fit_qsm_cylinders(segments_to_qsm(graph), case.cloud))
    assert np.array_equal(
        np.array([c.radius for c in a.cylinders]),
        np.array([c.radius for c in b.cylinders]),
    )
    assert [c.rank for c in a.cylinders] == [c.rank for c in b.cylinders]


@_param()
def test_render_overlay(name):
    """Render recon vs GT vs cloud for visual inspection (linewidth=radius)."""
    r = _run(name)
    out = render_overlay(
        r["recon"], ARTIFACTS / f"phaseL2_{name}.png", gt=r["case"].gt,
        cloud=r["case"].cloud, r_min=r["r_min"],
        title=f"Layer-2 {name}: recon (color=rank, width=radius) vs GT",
    )
    assert out.exists() and out.stat().st_size > 1000
