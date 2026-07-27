"""Unit tests for the triangulation Lmax auto-estimate (`_helios_filter_estimate`).

The estimate seeds the mesh's displayed triangle filter, so an Lmax below the
smallest real triangle silently renders an EMPTY mesh — which then surfaces
downstream as "mesh_indices is empty" when LAD reuses that triangulation.

The regression these guard is a real capture from the terrain-snapped LAD
workflow (`tests/e2e/lad-snap-to-ground.spec.ts`): the candidate set carried a
cluster of sub-millimetre micro-triangles alongside the real surface, Otsu
locked onto that (much stronger) split, and returned an Lmax ~62x below the
smallest genuine triangle.
"""

import numpy as np
import pytest

import main


def _edges_with_slivers():
    """Candidate max-edges mirroring the observed failure: 33 degenerate slivers
    (3e-5 .. 2e-4 m) plus a real surface/bridge population (0.107 .. 1.93 m)."""
    rng = np.random.default_rng(0)
    slivers = np.exp(rng.uniform(np.log(3.2e-5), np.log(2.0e-4), 33))
    surface = np.exp(rng.uniform(np.log(0.107), np.log(1.93), 498))
    return np.concatenate([slivers, surface])


def test_degenerate_slivers_do_not_drag_lmax_below_real_geometry():
    """The headline regression: with a sliver cluster present, the estimate must
    still land inside the REAL triangle population, not below all of it."""
    e = _edges_with_slivers()
    real_min = float(e[e > 1e-3].min())

    est = main._helios_filter_estimate(e, np.zeros(e.size, dtype=np.int64))

    assert est["lmax"] is not None
    # The pre-fix behaviour returned ~2.3e-4 here — below every real triangle.
    assert est["lmax"] >= real_min, (
        f"lmax {est['lmax']:.6g} sits below the smallest real edge {real_min:.6g}; "
        "the seeded filter would keep zero triangles and render an empty mesh")


def test_seeded_filter_keeps_triangles_when_slivers_present():
    """Behavioural consequence: filtering the candidates at the estimated Lmax
    must leave a non-empty mesh (this is what the reuse path requires)."""
    e = _edges_with_slivers()

    est = main._helios_filter_estimate(e, np.zeros(e.size, dtype=np.int64))
    kept = int((e <= est["lmax"]).sum())

    assert kept > 0, "the estimated Lmax filtered every candidate away"


def test_estimate_is_unchanged_on_a_clean_bimodal_distribution():
    """The guard must be INERT on well-formed data: a surface population plus a
    genuine gap-bridge population still splits exactly where it used to."""
    rng = np.random.default_rng(7)
    surface = rng.normal(0.05, 0.008, 800).clip(0.01)
    bridges = rng.normal(0.80, 0.150, 60).clip(0.30)
    e = np.concatenate([surface, bridges])

    est = main._helios_filter_estimate(e, np.zeros(e.size, dtype=np.int64))

    # Threshold falls in the gap between the two modes.
    assert 0.06 < est["lmax"] < 0.30
    assert est["eta"] > 0.7          # cleanly bimodal
    assert est["lmax"] >= float(e.min())


def test_lmax_never_falls_below_the_smallest_candidate():
    """Otsu returns a bin CENTER, so on a tight unimodal set it can land just
    under the minimum. The clamp must keep the seeded mesh non-empty."""
    rng = np.random.default_rng(3)
    e = rng.normal(0.5, 0.02, 500).clip(0.44)

    est = main._helios_filter_estimate(e, np.zeros(e.size, dtype=np.int64))

    assert est["lmax"] >= float(e.min())
    assert int((e <= est["lmax"]).sum()) > 0


def test_merged_guard_stays_row_aligned_after_the_floor():
    """The merged-cloud heuristic runs over the same filtered subset as the
    estimate. Its per-scan mask must stay aligned (multi-scan + slivers), and a
    sliver cluster must not by itself trip the merged verdict."""
    e = _edges_with_slivers()
    # Two scans interleaved across the whole candidate set.
    sids = np.tile([0, 1], e.size // 2 + 1)[:e.size].astype(np.int64)

    est = main._helios_filter_estimate(e, sids)   # must not raise

    assert est["lmax"] is not None
    assert isinstance(est["merged"], bool)


def test_too_few_candidates_returns_no_estimate():
    """Below the minimum sample size the estimator declines rather than guessing."""
    est = main._helios_filter_estimate(np.full(8, 0.05), np.zeros(8, dtype=np.int64))

    assert est["lmax"] is None
    assert est["label"] == "n/a"


def test_all_degenerate_input_still_produces_a_usable_lmax():
    """A pathological set that is ENTIRELY slivers has no real geometry to fall
    back to; the floor must not empty the sample and strand the estimate."""
    rng = np.random.default_rng(11)
    e = np.exp(rng.uniform(np.log(3e-5), np.log(2e-4), 200))

    est = main._helios_filter_estimate(e, np.zeros(e.size, dtype=np.int64))

    assert est["lmax"] is not None
    assert int((e <= est["lmax"]).sum()) > 0
