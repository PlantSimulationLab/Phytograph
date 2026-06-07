"""Phase 0 deliverable: prove the validation harness DISCRIMINATES before any
real QSM algorithm exists.

If we feed the ground truth to itself, every metric must be ~perfect. If we feed
a progressively perturbed copy, the metrics must degrade monotonically. This is
what lets later stage tests trust a passing score (and a failing one).

Also exercises: gt_io round-trip + invariant checks, the resample primitive, and
the overlay render (writes a PNG artifact).
"""

from __future__ import annotations

import copy
import math

import numpy as np
import pytest

from qsm.model import QSM, Cylinder
from qsm.validation import gt_io
from qsm.validation.overlay import render_overlay
from qsm.validation.report import build_report
from qsm.validation.resample import centerline_samples
from qsm.validation.synthetic import (
    sample_cloud,
    simple_tree,
    tricky_fork_tree,
)

R_MIN = 0.005
ARTIFACTS = None  # set in conftest-less way below


def _artifact_dir():
    from pathlib import Path

    d = Path(__file__).resolve().parent / "_artifacts"
    d.mkdir(exist_ok=True)
    return d


# --------------------------------------------------------------------------
# resample primitive
# --------------------------------------------------------------------------


def test_centerline_samples_are_arclength_uniform():
    qsm = simple_tree()
    cl = centerline_samples(qsm, ds=0.01)
    assert len(cl) > 0
    # Total sampled arc length ~ total cylinder length (each sample owns ds).
    sampled_len = len(cl) * cl.ds
    assert sampled_len == pytest.approx(qsm.total_length, rel=0.05)
    # Every sample carries a rank in the model's rank set.
    assert set(np.unique(cl.rank)).issubset({0, 1, 2})


def test_resample_density_independent_of_tessellation():
    """A coarsely- and finely-tessellated version of the SAME geometry must
    yield the same sample density -- the core discretization-robustness claim."""
    qsm = simple_tree()
    # Build a coarse copy: merge each shoot into one cylinder per shoot.
    coarse_cyls = []
    by_id = qsm.cylinder_by_id()
    nid = 0
    for s in qsm.shoots:
        first = by_id[s.cylinder_ids[0]]
        last = by_id[s.cylinder_ids[-1]]
        r = float(np.mean([by_id[c].radius for c in s.cylinder_ids]))
        coarse_cyls.append(Cylinder(nid, first.start, last.end, r,
                                    shoot_id=s.shoot_id, rank=s.rank))
        nid += 1
    coarse = QSM(cylinders=coarse_cyls, shoots=copy.deepcopy(qsm.shoots))

    fine_cl = centerline_samples(qsm, ds=0.01)
    coarse_cl = centerline_samples(coarse, ds=0.01)
    # Sampled lengths agree closely though cylinder counts differ ~10x.
    assert len(fine_cl) * fine_cl.ds == pytest.approx(qsm.total_length, rel=0.05)
    assert len(coarse_cl) * coarse_cl.ds == pytest.approx(coarse.total_length, rel=0.05)


# --------------------------------------------------------------------------
# gt_io round-trip + invariants
# --------------------------------------------------------------------------


def _qsm_to_gt_dict(qsm: QSM) -> dict:
    cyls = []
    for i, c in enumerate(qsm.cylinders):
        cyls.append({
            "cyl_id": c.cyl_id,
            "shoot_id": c.shoot_id,
            "rank": c.rank,
            "phytomer_index": 0,
            "segment_index": i,
            "parent_cyl_id": c.parent_id,
            "start": c.start.tolist(),
            "end": c.end.tolist(),
            "radius": c.radius,
        })
    shoots = []
    for s in qsm.shoots:
        shoots.append({
            "shoot_id": s.shoot_id,
            "rank": s.rank,
            "parent_shoot_id": s.parent_shoot_id,
            "parent_node_index": 0,
            "base_position": [0, 0, 0],
            "child_shoot_ids": s.child_shoot_ids,
            "length": 0.0,
        })
    return {"units": "meters", "shoots": shoots, "cylinders": cyls}


def test_gt_io_roundtrip():
    qsm = simple_tree()
    parsed = gt_io.ground_truth_from_dict(_qsm_to_gt_dict(qsm))
    assert len(parsed.cylinders) == len(qsm.cylinders)
    assert len(parsed.shoots) == len(qsm.shoots)
    assert len(parsed.shoots_of_rank(0)) == 1


def test_gt_io_rejects_two_trunks():
    qsm = simple_tree()
    d = _qsm_to_gt_dict(qsm)
    d["shoots"][1]["rank"] = 0  # make a second rank-0 shoot
    with pytest.raises(gt_io.GroundTruthError):
        gt_io.ground_truth_from_dict(d)


def test_gt_io_rejects_nonmeter_units():
    d = _qsm_to_gt_dict(simple_tree())
    d["units"] = "millimeters"
    with pytest.raises(gt_io.GroundTruthError):
        gt_io.ground_truth_from_dict(d)


def test_gt_io_derives_missing_parent_cyl_id():
    qsm = simple_tree()
    d = _qsm_to_gt_dict(qsm)
    for c in d["cylinders"]:
        c.pop("parent_cyl_id")  # force derivation
    parsed = gt_io.ground_truth_from_dict(d)
    # Trunk first cylinder has no parent; later trunk cylinders chain.
    trunk = parsed.shoots_of_rank(0)[0]
    by_id = parsed.cylinder_by_id()
    chain = trunk.cylinder_ids
    assert by_id[chain[0]].parent_id == -1
    assert by_id[chain[1]].parent_id == chain[0]


# --------------------------------------------------------------------------
# THE self-test: identity -> perfect, perturbation -> monotone degradation
# --------------------------------------------------------------------------


def test_identity_scores_perfect():
    qsm = simple_tree()
    cloud = sample_cloud(qsm, seed=1)
    rep = build_report(qsm, qsm, cloud=cloud, r_min=R_MIN)
    print(rep.summary())

    assert rep.centerline.mean_sym < 1e-9
    assert rep.centerline.cov_gt == pytest.approx(1.0)
    assert rep.centerline.cov_recon == pytest.approx(1.0)
    assert abs(rep.radius.volume_relerr_total) < 1e-6
    assert rep.rank.overall_accuracy == pytest.approx(1.0)
    assert rep.rank.unmatched_fraction < 1e-9
    assert rep.rank.n_rank0_shoots_recon == 1
    assert rep.topometric.total_length_relerr == pytest.approx(0.0, abs=1e-6)


def _jitter(qsm: QSM, sigma: float, seed: int) -> QSM:
    """Return a copy with each cylinder endpoint perturbed by N(0, sigma)."""
    rng = np.random.default_rng(seed)
    new = copy.deepcopy(qsm)
    for c in new.cylinders:
        c.start = c.start + rng.normal(0, sigma, 3)
        c.end = c.end + rng.normal(0, sigma, 3)
    return new


def test_centerline_degrades_monotonically_with_jitter():
    qsm = simple_tree()
    sigmas = [0.0, 0.002, 0.005, 0.01, 0.02]
    means = []
    covs = []
    for i, s in enumerate(sigmas):
        pert = _jitter(qsm, s, seed=100 + i)
        rep = build_report(pert, qsm, r_min=R_MIN)
        means.append(rep.centerline.mean_sym)
        covs.append(rep.centerline.cov_gt)
    print("jitter sigmas:", sigmas)
    print("mean_sym:", [f"{m*1000:.2f}mm" for m in means])
    print("cov_gt:", [f"{c:.3f}" for c in covs])
    # mean distance must increase with jitter; coverage must drop.
    assert all(means[i] <= means[i + 1] + 1e-9 for i in range(len(means) - 1))
    assert covs[0] >= covs[-1]
    assert means[-1] > means[0]


def test_radius_inflation_is_caught():
    """Inflating all radii must show up as positive volume relerr, scaled."""
    qsm = simple_tree()
    inflated = copy.deepcopy(qsm)
    for c in inflated.cylinders:
        c.radius *= 1.3
    rep = build_report(inflated, qsm, r_min=R_MIN)
    print(rep.summary())
    # 30% radius inflation -> ~69% volume inflation (1.3^2 - 1).
    assert rep.radius.volume_relerr_total == pytest.approx(0.69, rel=0.1)


def test_wrong_rank_is_caught():
    """Relabel every branch as rank 0 -> rank accuracy collapses, >1 trunk."""
    qsm = simple_tree()
    wrong = copy.deepcopy(qsm)
    for c in wrong.cylinders:
        c.rank = 0
    for s in wrong.shoots:
        s.rank = 0
    rep = build_report(wrong, qsm, r_min=R_MIN)
    print(rep.summary())
    # GT has rank-1 and rank-2 arc length; predicting all rank-0 tanks accuracy.
    assert rep.rank.overall_accuracy < 0.85
    assert rep.rank.n_rank0_shoots_recon > 1


# --------------------------------------------------------------------------
# overlay render (visual artifact)
# --------------------------------------------------------------------------


def test_overlay_renders_png():
    qsm = simple_tree()
    cloud = sample_cloud(qsm, seed=2)
    # perturb a copy so the overlay shows some red mismatch
    pert = _jitter(qsm, 0.01, seed=7)
    out = render_overlay(
        pert, _artifact_dir() / "selftest_overlay.png",
        gt=qsm, cloud=cloud, r_min=R_MIN, title="harness self-test",
    )
    assert out.exists()
    assert out.stat().st_size > 1000  # a real image, not an empty file


def test_tricky_fork_ground_truth_is_single_trunk():
    """The adversarial fixture must itself be valid GT: exactly one rank-0 shoot,
    and its rank-0 arc length equals the true trunk length."""
    qsm = tricky_fork_tree()
    assert len(qsm.shoots_of_rank(0)) == 1
    cl = centerline_samples(qsm, ds=0.005)
    trunk_arc = float(np.sum(cl.rank == 0) * cl.ds)
    # lower(1.0) + upper(1.6) = 2.6 m trunk; decoy lateral is 0.5 m rank-1.
    assert trunk_arc == pytest.approx(2.6, rel=0.05)
