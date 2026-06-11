"""Smoke test for the leaf-triangulation separation research harness.

This keeps ``research/leaf_triangulation_separation.py`` from rotting: it exercises the
full pipeline end-to-end on a small plant at low resolution and asserts the *labelling
and classification machinery works* -- not any particular separation outcome (that's the
research question the harness answers, not a fixed pass/fail). Specifically:

  * per-organ ground-truth labels actually populate on returned hits (>=2 distinct ids),
  * the synthetic scan returns geometry,
  * triangulation produces candidates whose vertices resolve back to an organ_id,
  * both valid (intra-organ) and erroneous (inter-organ) triangles are detected, so the
    classifier isn't degenerate.

Requires a compiled pyhelios with the lidar + plantarchitecture plugins; skipped when
they aren't importable (CI without the native build).
"""

import os
import sys

import numpy as np
import pytest
from scipy.spatial import cKDTree

# The harness lives under backend-api/research/, which isn't on the default test path.
_RESEARCH_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "research")
if _RESEARCH_DIR not in sys.path:
    sys.path.insert(0, _RESEARCH_DIR)

pytest.importorskip("pyhelios", reason="pyhelios native build required")

try:  # the plantarchitecture plugin must be present in this build
    from pyhelios import Context, PlantArchitecture
    _PA_OK = PlantArchitecture is not None
except Exception:  # pragma: no cover - import guard
    _PA_OK = False

pytestmark = pytest.mark.skipif(not _PA_OK, reason="plantarchitecture plugin unavailable")

import leaf_triangulation_separation as harness  # noqa: E402


# A small, fast configuration: a young plant scanned from one position at low resolution.
_MODEL = "bean"
_AGE = 22.0
_RES = 160


def test_organ_labels_populate_on_hits():
    """Every leaf is its own Helios object, so labelling by parent object then sampling
    via column_format must come back with multiple distinct organ ids on the hits."""
    ctx = None
    try:
        ctx, uuids, n_org, (lo, hi) = harness.build_labeled_plant(_MODEL, _AGE)
        assert n_org >= 2, f"expected multiple organs, got {n_org}"
        scanners = harness.plan_scanners(lo, hi, n_scanners=1)
        xyz, organ, sid = harness.scan_plant(ctx, scanners, _RES, _RES)
    finally:
        harness.close_context(ctx)

    assert len(xyz) >= 50, f"scan returned too few hits: {len(xyz)}"
    finite = organ[np.isfinite(organ)]
    # The vast majority of hits land on labelled plant geometry...
    assert len(finite) >= 0.9 * len(organ), "too many hits without an organ_id"
    # ...and they span more than one organ (otherwise classification is trivial).
    assert len(np.unique(finite)) >= 2


def test_pipeline_detects_valid_and_erroneous_triangles():
    """Full pipeline: scan -> triangulate (unfiltered) -> classify. Both intra-organ
    (valid) and inter-organ (erroneous) triangles must appear, and every counted
    triangle's vertices must resolve to an organ (n_unlabelled stays small)."""
    ctx = None
    try:
        ctx, uuids, n_org, (lo, hi) = harness.build_labeled_plant(_MODEL, _AGE)
        scanners = harness.plan_scanners(lo, hi, n_scanners=1)
        xyz, organ, sid = harness.scan_plant(ctx, scanners, _RES, _RES)
    finally:
        harness.close_context(ctx)

    edges, erroneous, n_unlabelled = harness.triangulate_candidates(
        xyz, organ, sid, scanners, _RES, _RES)

    assert len(edges) >= 20, f"too few candidate triangles: {len(edges)}"
    assert n_unlabelled <= 0.1 * (len(edges) + n_unlabelled), "too many unlabelled triangles"
    n_err = int(erroneous.sum())
    assert 0 < n_err < len(edges), (
        f"classifier degenerate: {n_err}/{len(edges)} erroneous")
    # Edges are positive metric lengths.
    assert np.all(edges > 0)


def test_leaflet_granularity_is_per_object():
    """Ground-truth granularity sanity for compound (trifoliate) leaves like bean: the
    labelling groups by Helios compound object, and each leaflet is its OWN object (the
    leaf prototype is built once per leaflet -- see label_organs() docstring). So a
    trifoliate plant must yield many distinct leaf objects, several of which sit at nearly
    the same base point (the three leaflets of one compound leaf radiating from a shared
    petiole tip). If leaflets were ever merged into a single object that pattern would
    vanish (one object per compound leaf instead of three).

    This is a light, deterministic (seeded) sanity check -- not a full merge detector;
    the authoritative guarantee is the Helios source cited in label_organs()."""
    ctx = None
    try:
        ctx, uuids, n_org, _ = harness.build_labeled_plant(_MODEL, 30.0, seed=12345)
        u = np.array(uuids)
        labels = np.array([str(ctx.getPrimitiveData(int(x), "object_label")) for x in u])
        parents = np.array([ctx.getPrimitiveParentObjectID(int(x)) for x in u])
        cent = np.array([
            np.mean([[p.x, p.y, p.z] for p in ctx.getPrimitiveVertices(int(x))], axis=0)
            for x in u
        ])
    finally:
        harness.close_context(ctx)

    leaf_objs = np.unique(parents[labels == "leaf"])
    assert len(leaf_objs) >= 10, "expected many distinct leaflet objects on a trifoliate plant"

    # At least one cluster of >=3 leaf objects whose centroids nearly coincide (a compound
    # leaf's leaflets sharing a base) -- impossible if the three leaflets were one object.
    centroids = np.array([cent[parents == o].mean(0) for o in leaf_objs])
    tree = cKDTree(centroids)
    max_near = max(len(tree.query_ball_point(c, r=0.02)) for c in centroids)
    assert max_near >= 3, (
        "no cluster of >=3 coincident leaf objects found -- compound-leaf leaflets may be "
        "merged into a single object rather than labelled separately")


def test_statistics_return_sane_values():
    """The label-free statistics and ground-truth metrics should produce finite,
    in-range values on a real scan (suggested Lmax > 0, confidences in [0, 1],
    AUC in [0, 1])."""
    ctx = None
    try:
        ctx, uuids, n_org, (lo, hi) = harness.build_labeled_plant(_MODEL, _AGE)
        scanners = harness.plan_scanners(lo, hi, n_scanners=1)
        xyz, organ, sid = harness.scan_plant(ctx, scanners, _RES, _RES)
    finally:
        harness.close_context(ctx)
    edges, erroneous, _ = harness.triangulate_candidates(
        xyz, organ, sid, scanners, _RES, _RES)

    auc = harness.rank_auc(edges, erroneous)
    assert 0.0 <= auc <= 1.0

    otsu_lmax, otsu_conf = harness.stat_otsu(edges)
    gmm_lmax, gmm_conf = harness.stat_gmm(edges)
    assert otsu_lmax > 0 and 0.0 <= otsu_conf <= 1.0
    assert gmm_lmax > 0 and 0.0 <= gmm_conf <= 1.0

    lmax_opt, bal_err, recall, contam = harness.optimal_threshold(edges, erroneous)
    assert lmax_opt > 0
    assert 0.0 <= bal_err <= 1.0
    assert 0.0 <= recall <= 1.0 and 0.0 <= contam <= 1.0
