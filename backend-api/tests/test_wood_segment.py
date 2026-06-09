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

# (fixture stem, min overall accuracy, min wood F1). Per-cloud bars chosen with
# margin below observed; oak is the hardest real tree (wood-heavy, OA≈0.80).
FIXTURES = [
    ("weiser_spruce_small", 0.80, 0.55),     # European conifer
    ("weiser_oak_small", 0.78, 0.65),        # European broadleaf
    ("weiser_beech_small", 0.83, 0.65),      # European broadleaf
    ("lewos_tropical_small", 0.85, 0.60),    # tropical broadleaf (the screenshot tree)
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


@pytest.mark.parametrize("stem,min_oa,min_wood_f1", FIXTURES, ids=[f[0] for f in FIXTURES])
def test_wood_segment_quantitative(stem, min_oa, min_wood_f1):
    """segment_wood labels vs ground truth on labelled wood/leaf clouds."""
    points, truth = _load(stem)
    pred = main.segment_wood(points)

    assert pred.shape == (len(points),)
    assert set(np.unique(pred)).issubset({main.WOOD_CLASS_WOOD, main.WOOD_CLASS_LEAF})

    oa = float((pred == truth).mean())
    f1_wood = _f1(pred, truth, main.WOOD_CLASS_WOOD)
    f1_leaf = _f1(pred, truth, main.WOOD_CLASS_LEAF)

    # Confusion matrix + metrics, surfaced under `pytest -s` so a regression is
    # debuggable rather than a bare assertion failure.
    print(
        f"\n{stem}: OA={oa:.4f} F1_wood={f1_wood:.4f} F1_leaf={f1_leaf:.4f} "
        f"wood%true={(truth == main.WOOD_CLASS_WOOD).mean():.2f} "
        f"wood%pred={(pred == main.WOOD_CLASS_WOOD).mean():.2f}"
    )
    for t in (main.WOOD_CLASS_WOOD, main.WOOD_CLASS_LEAF):
        for p in (main.WOOD_CLASS_WOOD, main.WOOD_CLASS_LEAF):
            print(f"  truth={t} pred={p}: {int(((truth == t) & (pred == p)).sum())}")

    assert oa >= min_oa, f"{stem} overall accuracy {oa:.4f} below {min_oa}"
    assert f1_wood >= min_wood_f1, f"{stem} wood F1 {f1_wood:.4f} below {min_wood_f1}"


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
