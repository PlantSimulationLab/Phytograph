"""Wood/leaf segmentation tests (geometric, non-ML — verticality + low-sphericity).

`segment_wood` classifies each point as wood (1, trunk/branches) or leaf (2)
from XYZ geometry alone. These tests evaluate it quantitatively against
labelled fixtures rather than merely asserting "didn't crash".

Fixtures (`tests/fixtures/leafwood/`, column 4 = point_class, 1=wood 2=leaf):
  - weiser_{oak,spruce,beech}_small.xyz — REAL European TLS trees, manually
    labelled, decimated (5 mm voxel, ~50k pts) from Weiser et al. heiDATA
    doi:10.11588/data/UUMEDI (CC-BY 4.0). Broadleaf (oak, beech) + conifer
    (spruce).
  - lewos_tropical_small.xyz — REAL tropical tree (LeWoS tree 1, Wang et al.
    2020, Dryad doi:10.5061/dryad.np5hqbzp6), decimated to ~50k pts. This is the
    tree whose horizontal scaffold branches the verticality score originally
    missed; it guards the connected-branch-grow recovery step.
  - synthetic_almond_small.xyz — decimated synthetic almond scan. INFORMATIONAL
    only (not a gate): the branch-grow step over-grows on its unrealistically
    linear leaves, an accepted trade for real-tree accuracy.

These REAL-tree fixtures are the gate, since production input is real TLS. The
method's known weak case is synthetic densely-scattered-leaf forms (central-
leader archetype) — deliberately not committed as a gate.

Bars are set below observed values (real trees OA≈0.82–0.94, wood-F1≈0.76–0.83)
with margin. The wood-F1 bar is the real tripwire: wood is the minority class,
so overall accuracy alone could be gamed by a leaf-biased classifier — wood-F1
catches a silent feature/orientation regression.
"""
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

import main


FIXDIR = Path(__file__).parent / "fixtures" / "leafwood"

# (fixture stem, min overall accuracy, min wood F1, min thin-wood recall). Bars
# chosen with margin below observed; oak is the hardest real tree (wood-heavy,
# OA≈0.80). thin-wood recall (twigs caught as wood) baselines on these decimated
# fixtures: spruce 0.83 / oak 0.91 / beech 0.85 / lewos 0.80 — floors set ~0.10
# below. NB decimation distorts neighbourhood density (→sphericity), so this is a
# coarse REGRESSION TRIPWIRE; the authoritative thin-wood numbers are measured
# full-resolution in the one-off local validation, not here.
FIXTURES = [
    ("weiser_spruce_small", 0.80, 0.55, 0.70),     # European conifer
    ("weiser_oak_small", 0.78, 0.65, 0.78),        # European broadleaf
    ("weiser_beech_small", 0.83, 0.65, 0.72),      # European broadleaf
    ("lewos_tropical_small", 0.85, 0.60, 0.68),    # tropical broadleaf (the screenshot tree)
]
# Note: the synthetic almond scan is NOT a pass/fail gate. The method is tuned
# for real TLS (verticality + low-sphericity, plus connected-branch growing),
# and that branch-recovery step over-grows on synthetic narrow leaves (which are
# unrealistically linear/low-sphericity) — an accepted trade documented in
# segment_wood. Real-tree fixtures (Weiser European + LeWoS tropical) are the
# gate; see test_wood_segment_synthetic_almond_informational below.


def _load(stem: str):
    df = pd.read_csv(FIXDIR / f"{stem}.xyz", sep=r"\s+", comment="#", header=None)
    points = df.iloc[:, :3].to_numpy(dtype=np.float64)
    truth = df.iloc[:, 3].to_numpy().astype(int)  # 1=wood, 2=leaf
    return points, truth


def _f1(pred, truth, cls):
    tp = int(((pred == cls) & (truth == cls)).sum())
    fp = int(((pred == cls) & (truth != cls)).sum())
    fn = int(((pred != cls) & (truth == cls)).sum())
    p = tp / max(tp + fp, 1)
    r = tp / max(tp + fn, 1)
    return float(2 * p * r / max(p + r, 1e-9))


# Sphericity below this on a ground-truth WOOD point ⇒ a locally 1-D/compact
# neighbourhood, i.e. a thin branch / twig (λ₃≈0). Trunk points are also low-
# sphericity, so we additionally exclude the lowest height band (see below) to
# isolate the *crown* twigs that geometric methods notoriously misclassify.
_THIN_WOOD_SPH = 0.02


def _thin_wood_recall(points, pred, truth, sph_thresh=_THIN_WOOD_SPH, trunk_frac=0.15):
    """Recall over ground-truth WOOD points that are THIN branches/twigs.

    Aggregate OA/wood-F1 hide the failure that actually looks bad: thin crown
    branches getting labelled leaf (documented for geometric methods — Wan 2024
    RSE). This metric isolates that. The "thin twig" set is ground-truth wood
    with low sphericity (λ₃/λ₁ small ⇒ locally 1-D), EXCLUDING the bottom
    `trunk_frac` of the height range so the (easy, always-caught) trunk doesn't
    dilute the score. Sphericity comes from the same `_wood_local_pca_features`
    the classifier uses, computed here on the FULL cloud independent of `pred`.

    Returns (recall, n_thin). recall is NaN when there are no thin-wood points.
    """
    feats, _ = main._wood_local_pca_features(points, k_min=10, k_max=100, k_step=10)
    sph = feats[:, 2]
    z = points[:, 2]
    zmin, zmax = float(z.min()), float(z.max())
    above_trunk = z >= (zmin + trunk_frac * (zmax - zmin))
    thin_wood = (truth == main.WOOD_CLASS_WOOD) & (sph < sph_thresh) & above_trunk
    n_thin = int(thin_wood.sum())
    if n_thin == 0:
        return float("nan"), 0
    recall = float((pred[thin_wood] == main.WOOD_CLASS_WOOD).mean())
    return recall, n_thin


@pytest.mark.parametrize("stem,min_oa,min_wood_f1,min_thin_recall", FIXTURES,
                         ids=[f[0] for f in FIXTURES])
def test_wood_segment_quantitative(stem, min_oa, min_wood_f1, min_thin_recall):
    """segment_wood labels vs ground truth on labelled wood/leaf clouds."""
    points, truth = _load(stem)
    pred = main.segment_wood(points)

    assert pred.shape == (len(points),)
    assert set(np.unique(pred)).issubset({main.WOOD_CLASS_WOOD, main.WOOD_CLASS_LEAF})

    oa = float((pred == truth).mean())
    f1_wood = _f1(pred, truth, main.WOOD_CLASS_WOOD)
    f1_leaf = _f1(pred, truth, main.WOOD_CLASS_LEAF)
    thin_recall, n_thin = _thin_wood_recall(points, pred, truth)

    # Confusion matrix + metrics, surfaced under `pytest -s` so a regression is
    # debuggable rather than a bare assertion failure. thin-wood recall is the
    # metric that tracks the visually-obvious failure (twigs labelled leaf).
    print(
        f"\n{stem}: OA={oa:.4f} F1_wood={f1_wood:.4f} F1_leaf={f1_leaf:.4f} "
        f"thin_wood_recall={thin_recall:.4f} (n_thin={n_thin}) "
        f"wood%true={(truth == main.WOOD_CLASS_WOOD).mean():.2f} "
        f"wood%pred={(pred == main.WOOD_CLASS_WOOD).mean():.2f}"
    )
    for t in (main.WOOD_CLASS_WOOD, main.WOOD_CLASS_LEAF):
        for p in (main.WOOD_CLASS_WOOD, main.WOOD_CLASS_LEAF):
            print(f"  truth={t} pred={p}: {int(((truth == t) & (pred == p)).sum())}")

    assert oa >= min_oa, f"{stem} overall accuracy {oa:.4f} below {min_oa}"
    assert f1_wood >= min_wood_f1, f"{stem} wood F1 {f1_wood:.4f} below {min_wood_f1}"
    assert thin_recall >= min_thin_recall, (
        f"{stem} thin-wood (twig) recall {thin_recall:.4f} below {min_thin_recall} "
        f"— crown branches/twigs being misclassified as leaf"
    )


def test_wood_segment_synthetic_almond_informational():
    """The synthetic almond scan is INFORMATIONAL, not a gate. The method targets
    real TLS; its connected-branch grow step over-grows on almond's unrealistically
    linear/low-sphericity leaves (an accepted trade — see segment_wood). This test
    only asserts the pipeline runs and labels both classes; it surfaces the metrics
    under `pytest -s` to track drift without failing the build on synthetic data."""
    points, truth = _load("synthetic_almond_small")
    pred = main.segment_wood(points)
    assert pred.shape == (len(points),)
    assert set(np.unique(pred)) == {main.WOOD_CLASS_WOOD, main.WOOD_CLASS_LEAF}
    oa = float((pred == truth).mean())
    print(f"\nsynthetic_almond (informational): OA={oa:.4f} "
          f"F1_wood={_f1(pred, truth, main.WOOD_CLASS_WOOD):.4f}")


def test_wood_segment_method_geometric_equals_default():
    """The `method='geometric'` path must be byte-identical to the legacy default
    (segment_wood with no method arg) — guards the refactor that split the
    geometric core out so the connectivity method could share it. Run on every
    real fixture so a divergence on any species is caught."""
    for stem, *_ in FIXTURES:
        points, _ = _load(stem)
        a = main.segment_wood(points)                       # legacy fn default
        b = main.segment_wood(points, method="geometric")
        assert np.array_equal(a, b), f"{stem}: method='geometric' diverged from the default"


@pytest.mark.parametrize("stem", [f[0] for f in FIXTURES], ids=[f[0] for f in FIXTURES])
def test_wood_segment_connectivity_runs(stem):
    """The connectivity method runs on every real fixture and returns aligned,
    valid labels with both classes present. This is a SMOKE/shape gate — the
    accuracy improvement claim is measured full-resolution one-off (decimation
    distorts the skeleton), not asserted here."""
    points, _ = _load(stem)
    pred = main.segment_wood(points, method="connectivity")
    assert pred.shape == (len(points),)
    assert pred.dtype == np.int32
    assert set(np.unique(pred)).issubset({main.WOOD_CLASS_WOOD, main.WOOD_CLASS_LEAF})
    # A real tree has both wood and leaf; connectivity must not collapse to one.
    assert main.WOOD_CLASS_WOOD in pred and main.WOOD_CLASS_LEAF in pred


def test_wood_segment_connectivity_degenerate_falls_back():
    """When the skeleton can't give a usable backbone (too few points, or two
    far-apart clusters that don't form one rooted tree), the connectivity method
    must fall back to a valid geometric result rather than raise or return garbage."""
    rng = np.random.RandomState(3)
    # Two well-separated blobs: the skeleton roots one; the other is unreachable
    # and must keep its geometric label (not be forced to a single class / crash).
    a = rng.normal([0, 0, 1.0], 0.05, (300, 3))
    b = rng.normal([20, 20, 1.0], 0.05, (300, 3))
    points = np.vstack([a, b])
    pred = main.segment_wood(points, method="connectivity")
    assert pred.shape == (len(points),)
    assert set(np.unique(pred)).issubset({main.WOOD_CLASS_WOOD, main.WOOD_CLASS_LEAF})


# --- SOTA segment-wise method (the new default) ---------------------------------

@pytest.mark.parametrize("stem", [f[0] for f in FIXTURES], ids=[f[0] for f in FIXTURES])
def test_wood_segment_sota_runs(stem):
    """The SOTA (segment-wise + cylinder-fit) method runs on every real fixture and
    returns aligned, valid labels with both classes present. SMOKE/shape gate —
    the accuracy claim is measured full-resolution (decimation distorts the
    skeleton segments / cylinder fits), not asserted on these decimated fixtures."""
    points, _ = _load(stem)
    pred = main.segment_wood(points, method="sota")
    assert pred.shape == (len(points),)
    assert pred.dtype == np.int32
    assert set(np.unique(pred)).issubset({main.WOOD_CLASS_WOOD, main.WOOD_CLASS_LEAF})
    assert main.WOOD_CLASS_WOOD in pred and main.WOOD_CLASS_LEAF in pred


def test_wood_segment_sota_degenerate_falls_back():
    """SOTA must fall back to a valid geometric result when the skeleton degenerates."""
    rng = np.random.RandomState(7)
    pts = np.vstack([
        rng.normal([0, 0, 1.0], 0.05, (300, 3)),
        rng.normal([20, 20, 1.0], 0.05, (300, 3)),
    ])
    pred = main.segment_wood(pts, method="sota")
    assert pred.shape == (len(pts),)
    assert set(np.unique(pred)).issubset({main.WOOD_CLASS_WOOD, main.WOOD_CLASS_LEAF})
    tiny = main.segment_wood(rng.normal(0, 1, (5, 3)), method="sota")
    assert tiny.shape == (5,)


def test_wood_segment_sota_leafoff_invariant():
    """THE diagnostic that drove the SOTA rebuild, now a permanent gate. On a
    LEAF-OFF (all-wood) scan the answer is ~100% wood — yet the point-wise
    geometric core mislabels 20-30% of branch points as leaf. The SOTA method
    recovers them. Fixture: a real leaf-off tree (L1-Tree Tree_2, decimated to
    ~52k; column 4 is the all-wood truth label). SOTA must recover materially more
    wood than geometric here. (Bar set with margin below the observed full-res
    ~0.93; even decimated, SOTA clears it while geometric trails ~0.82.)"""
    points, truth = _load("leafoff_allwood_small")
    assert (truth == main.WOOD_CLASS_WOOD).all(), "fixture must be all-wood"
    sota = main.segment_wood(points, method="sota")
    geom = main.segment_wood(points, method="geometric")
    w_sota = float((sota == main.WOOD_CLASS_WOOD).mean())
    w_geom = float((geom == main.WOOD_CLASS_WOOD).mean())
    print(f"\nleaf-off invariant: SOTA wood%={w_sota:.3f}  geometric wood%={w_geom:.3f}")
    assert w_sota >= 0.88, f"SOTA recovered only {w_sota:.3f} wood on an all-wood scan"
    assert w_sota >= w_geom + 0.05, (
        f"SOTA ({w_sota:.3f}) must beat geometric ({w_geom:.3f}) on leaf-off branch recovery"
    )


def test_wood_segment_labels_aligned_and_typed():
    """Labels align 1:1 with input order and are the documented int values."""
    rng = np.random.RandomState(0)
    # A vertical compact "branch" + a scattered "leaf" blob.
    trunk = np.column_stack([
        np.zeros(300), np.zeros(300), np.linspace(0, 2, 300)
    ]) + rng.normal(0, 0.002, (300, 3))
    leaf = rng.normal([0.4, 0.4, 1.5], 0.12, (600, 3))
    points = np.vstack([trunk, leaf])

    labels = main.segment_wood(points)
    assert labels.shape == (len(points),)
    assert labels.dtype == np.int32
    assert set(np.unique(labels)).issubset({main.WOOD_CLASS_WOOD, main.WOOD_CLASS_LEAF})
    # The trunk should be mostly wood, the blob mostly leaf — sanity that the
    # method discriminates the two synthetic structures (not an accuracy claim).
    assert (labels[:300] == main.WOOD_CLASS_WOOD).mean() > 0.5
    assert (labels[300:] == main.WOOD_CLASS_LEAF).mean() > 0.5


def test_wood_segment_caps_large_cloud(monkeypatch):
    """Regression: a cloud over the point cap must auto-downsample the geometry
    step (not run full-res k-NN, which OOMs the machine — a 6.4M-point tree
    peaked ~13 GB and forced a restart). The result must still be full-length and
    aligned. Force a tiny cap so a small fabricated cloud trips it deterministically."""
    monkeypatch.setattr(main, "_WOOD_SEGMENT_MAX_POINTS", 2000)
    rng = np.random.RandomState(0)
    trunk = np.column_stack([
        np.zeros(2000), np.zeros(2000), np.linspace(0, 2, 2000)
    ]) + rng.normal(0, 0.003, (2000, 3))
    leaf = rng.normal([0.4, 0.4, 1.5], 0.15, (4000, 3))
    points = np.vstack([trunk, leaf])  # 6000 > 2000 cap → auto-downsample path

    labels = main.segment_wood(points)
    # Full-length, aligned, valid labels even though the geometry ran on a
    # voxel-downsampled subset and propagated back by nearest neighbour.
    assert labels.shape == (len(points),)
    assert labels.dtype == np.int32
    assert set(np.unique(labels)).issubset({main.WOOD_CLASS_WOOD, main.WOOD_CLASS_LEAF})
    # Still discriminates the two structures (trunk mostly wood, blob mostly leaf).
    assert (labels[:2000] == main.WOOD_CLASS_WOOD).mean() > 0.4
    assert (labels[2000:] == main.WOOD_CLASS_LEAF).mean() > 0.5


def test_wood_segment_endpoint_inline():
    """The stateless /api/segment/wood path returns aligned labels + counts."""
    from fastapi.testclient import TestClient

    rng = np.random.RandomState(1)
    trunk = np.column_stack([
        np.zeros(200), np.zeros(200), np.linspace(0, 1.5, 200)
    ]) + rng.normal(0, 0.002, (200, 3))
    leaf = rng.normal([0.3, 0.3, 1.0], 0.1, (400, 3))
    points = np.vstack([trunk, leaf]).tolist()

    client = TestClient(main.app)
    resp = client.post("/api/segment/wood", json={"points": points})
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    assert len(body["labels"]) == len(points)
    assert body["num_wood"] + body["num_leaf"] == body["num_points"] == len(points)
    assert set(body["labels"]).issubset({main.WOOD_CLASS_WOOD, main.WOOD_CLASS_LEAF})


def test_wood_segment_reflectance_inert_when_no_contrast():
    """Reflectance assist must be a no-op when the reflectance carries no
    wood/leaf contrast — proves graceful fallback to pure geometry (the property
    that keeps it harmless on low-contrast species like almond/redbud). A
    CONSTANT reflectance has an empty upper tail, so the one-sided promotion
    selects nothing and the labels must match the geometry-only result exactly."""
    points, _ = _load("weiser_oak_small")
    geom = main.segment_wood(points)
    const = main.segment_wood(points, reflectance=np.full(len(points), -8.0),
                              reflectance_weight_max=0.4)
    assert np.array_equal(geom, const), (
        "constant (contrast-free) reflectance changed the result — the assist is "
        "not falling back to geometry"
    )
    # A length-mismatched reflectance is ignored (defensive: caller bug shouldn't
    # corrupt the result), so it also matches geometry-only.
    bad = main.segment_wood(points, reflectance=np.full(len(points) - 1, -8.0),
                            reflectance_weight_max=0.4)
    assert np.array_equal(geom, bad)


def test_wood_segment_reflectance_only_promotes_wood():
    """The reflectance assist is ONE-SIDED: it can only PROMOTE points to wood
    (recover missed wood), never demote. So with the same geometry, enabling it
    can only ever INCREASE the wood count — it must never remove wood. Uses a
    reflectance that correlates with the (geometry) trunk so the upper tail is
    real wood."""
    points, truth = _load("weiser_oak_small")
    geom = main.segment_wood(points)
    # Reflectance: brightest on true wood (so the upper tail is genuinely woody),
    # dim on leaf — the favourable case the assist is designed for.
    rng = np.random.RandomState(0)
    refl = np.where(truth == main.WOOD_CLASS_WOOD,
                    rng.normal(-5.0, 1.0, len(points)),
                    rng.normal(-13.0, 2.0, len(points)))
    assisted = main.segment_wood(points, reflectance=refl, reflectance_weight_max=0.4)
    n_wood_geom = int((geom == main.WOOD_CLASS_WOOD).sum())
    n_wood_assisted = int((assisted == main.WOOD_CLASS_WOOD).sum())
    assert n_wood_assisted >= n_wood_geom, (
        f"assist removed wood ({n_wood_geom}→{n_wood_assisted}); it must only promote"
    )


def test_wood_segment_endpoint_inline_reflectance():
    """The stateless endpoint accepts an inline `reflectance` array aligned to
    `points` and returns aligned labels (smoke test of the request plumbing)."""
    from fastapi.testclient import TestClient

    rng = np.random.RandomState(2)
    trunk = np.column_stack([
        np.zeros(200), np.zeros(200), np.linspace(0, 1.5, 200)
    ]) + rng.normal(0, 0.002, (200, 3))
    leaf = rng.normal([0.3, 0.3, 1.0], 0.1, (400, 3))
    points = np.vstack([trunk, leaf])
    # Brighter reflectance on the trunk than the leaf blob.
    refl = np.concatenate([np.full(200, -4.0), np.full(400, -14.0)])

    client = TestClient(main.app)
    resp = client.post("/api/segment/wood", json={
        "points": points.tolist(),
        "reflectance": refl.tolist(),
        "reflectance_weight_max": 0.4,
        "method": "geometric",  # this test exercises reflectance, not connectivity
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    assert len(body["labels"]) == len(points)
    assert set(body["labels"]).issubset({main.WOOD_CLASS_WOOD, main.WOOD_CLASS_LEAF})


def test_wood_segment_endpoint_connectivity():
    """The stateless endpoint accepts `method='connectivity'` and returns aligned
    labels (request-plumbing smoke for the new method + the warnings field)."""
    from fastapi.testclient import TestClient

    rng = np.random.RandomState(5)
    trunk = np.column_stack([
        np.zeros(400), np.zeros(400), np.linspace(0, 2.5, 400)
    ]) + rng.normal(0, 0.004, (400, 3))
    branch = np.column_stack([
        np.linspace(0, 0.8, 200), np.zeros(200), 1.8 + np.linspace(0, 0.4, 200)
    ]) + rng.normal(0, 0.004, (200, 3))
    leaf = rng.normal([0.4, 0.4, 2.0], 0.2, (800, 3))
    points = np.vstack([trunk, branch, leaf])

    client = TestClient(main.app)
    resp = client.post("/api/segment/wood", json={
        "points": points.tolist(),
        "method": "connectivity",
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    assert len(body["labels"]) == len(points)
    assert set(body["labels"]).issubset({main.WOOD_CLASS_WOOD, main.WOOD_CLASS_LEAF})
    assert "warnings" in body  # field present (may be empty)


def test_wood_segment_too_few_points():
    """Fewer than 3 points → graceful failure, not a 500."""
    from fastapi.testclient import TestClient

    client = TestClient(main.app)
    resp = client.post("/api/segment/wood", json={"points": [[0, 0, 0], [1, 1, 1]]})
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is False
    assert "at least 3" in body["error"]


def test_wood_segment_aggregate_sources_align(tmp_path):
    """Aggregate (multi-source) request: the response reports each source's point
    count in order, and the labels concatenate in that order so a caller can
    slice them back per scan. Models the 'segment scans together' UI mode."""
    from fastapi.testclient import TestClient

    # Split the beech fixture into two disjoint halves, written as separate XYZ
    # files — two 'scans' of the same structure that get segmented together.
    pts, _ = _load("weiser_beech_small")
    rng = np.random.RandomState(0)
    perm = rng.permutation(len(pts))
    half = len(pts) // 2
    a_path = tmp_path / "view_a.xyz"
    b_path = tmp_path / "view_b.xyz"
    np.savetxt(a_path, pts[perm[:half]], fmt="%.5f")
    np.savetxt(b_path, pts[perm[half:]], fmt="%.5f")

    client = TestClient(main.app)
    resp = client.post("/api/segment/wood", json={
        "sources": [
            {"source_path": str(a_path), "ascii_format": "x y z"},
            {"source_path": str(b_path), "ascii_format": "x y z"},
        ],
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    # source_counts is per-source, in order, and sums to the total.
    assert body["source_counts"] == [half, len(pts) - half]
    assert len(body["labels"]) == len(pts)
    assert sum(body["source_counts"]) == len(body["labels"])
    assert set(body["labels"]).issubset({main.WOOD_CLASS_WOOD, main.WOOD_CLASS_LEAF})
    # Both wood and leaf are present (the combined cloud is a real tree).
    assert main.WOOD_CLASS_WOOD in body["labels"]
    assert main.WOOD_CLASS_LEAF in body["labels"]
