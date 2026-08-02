"""Ground/non-ground segmentation tests (Cloth Simulation Filter).

The committed fixture `fixtures/bean_scan_small.xyz` is a decimated
(~3.7k-point) subset of a real Helios scan of bean plants on the ground. Its
4th column is the ground-truth annotation (1=ground, 2=plant), so these tests
quantitatively evaluate the segmenter against known labels rather than merely
asserting "didn't crash".

Layers:
  - `segment_ground()` helper run directly → accuracy / per-class recall / IoU.
  - `/api/segment/ground` endpoint → label alignment + counts.
"""
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

import main


FIXTURE = Path(__file__).parent / "fixtures" / "bean_scan_small.xyz"
ASCII_FORMAT = "x y z object_label"

# Quantitative bars. The ground is the dominant lower surface in this scan, so
# CSF should recover it almost perfectly; plant recall is lower because low
# plant material within `class_threshold` of the soil reads as ground (a known,
# acceptable CSF behaviour). Bars set below the observed numbers
# (acc≈0.98, ground_recall≈0.996, plant_recall≈0.95) with margin.
MIN_ACCURACY = 0.90
MIN_GROUND_RECALL = 0.90
MIN_PLANT_RECALL = 0.70


def _load_fixture():
    df = pd.read_csv(FIXTURE, sep=r"\s+", header=None)
    points = df.iloc[:, :3].to_numpy(dtype=np.float64)
    truth = df.iloc[:, 3].to_numpy().astype(int)
    return points, truth


def _csf_available() -> bool:
    try:
        import CSF  # noqa: F401
        return True
    except ImportError:
        return False


requires_csf = pytest.mark.skipif(
    not _csf_available(),
    reason="CSF (cloth-simulation-filter) not installed",
)


def _metrics(pred, truth):
    acc = float((pred == truth).mean())
    ground_recall = float(((pred == 1) & (truth == 1)).sum() / max((truth == 1).sum(), 1))
    plant_recall = float(((pred == 2) & (truth == 2)).sum() / max((truth == 2).sum(), 1))
    inter = ((pred == 1) & (truth == 1)).sum()
    union = ((pred == 1) | (truth == 1)).sum()
    ground_iou = float(inter / max(union, 1))
    return acc, ground_recall, plant_recall, ground_iou


@requires_csf
def test_segment_ground_quantitative():
    """CSF labels vs ground-truth annotations on the real bean scan."""
    points, truth = _load_fixture()
    pred = main.segment_ground(
        points, cloth_resolution=0.05, rigidness=3, class_threshold=0.05,
    )
    assert pred.shape == (len(points),)
    assert set(np.unique(pred)).issubset({main.GROUND_CLASS_GROUND, main.GROUND_CLASS_PLANT})

    acc, ground_recall, plant_recall, ground_iou = _metrics(pred, truth)

    # Confusion matrix, surfaced in test output (run pytest -s to see it) so a
    # regression is debuggable rather than a bare assertion failure.
    print(
        f"\nground-segment metrics: accuracy={acc:.4f} "
        f"ground_recall={ground_recall:.4f} plant_recall={plant_recall:.4f} "
        f"ground_IoU={ground_iou:.4f}"
    )
    for t in (1, 2):
        for p in (1, 2):
            print(f"  truth={t} pred={p}: {int(((truth == t) & (pred == p)).sum())}")

    assert acc >= MIN_ACCURACY, f"accuracy {acc:.4f} below {MIN_ACCURACY}"
    assert ground_recall >= MIN_GROUND_RECALL, f"ground recall {ground_recall:.4f} below {MIN_GROUND_RECALL}"
    assert plant_recall >= MIN_PLANT_RECALL, f"plant recall {plant_recall:.4f} below {MIN_PLANT_RECALL}"


@requires_csf
def test_auto_class_threshold_reproduces_hand_tuned_value():
    """Auto mode should land on the tolerance a human tuned by hand.

    The bar that matters: `class_threshold=0.05` above was chosen by trial
    against these ground-truth labels. Auto mode is told nothing about it and
    must rediscover it from the settled cloth — the whole claim of
    `_estimate_class_threshold`. It also has to beat the extent-scaled seed
    (0.02 here), which under-segments: ground recall 0.917 vs 0.996."""
    points, truth = _load_fixture()
    meta: dict = {}
    pred = main.segment_ground(
        points, cloth_resolution=0.05, rigidness=3,
        class_threshold=0.02, auto_class_threshold=True, meta=meta,
    )
    assert meta["auto"] is True
    assert meta["method"] in ("knee", "tail")
    # Hand-tuned optimum is 0.05; auto measured 0.0512 on this fixture.
    assert 0.03 <= meta["class_threshold"] <= 0.08, meta

    acc, ground_recall, plant_recall, _ = _metrics(pred, truth)
    print(f"\nauto: thr={meta['class_threshold']:.4f} ({meta['method']}) "
          f"accuracy={acc:.4f} ground_recall={ground_recall:.4f} "
          f"plant_recall={plant_recall:.4f}")
    assert acc >= MIN_ACCURACY
    assert ground_recall >= MIN_GROUND_RECALL
    assert plant_recall >= MIN_PLANT_RECALL


@requires_csf
def test_height_above_cloth_reproduces_csf_classification():
    """`_height_above_cloth` + `abs() < threshold` must match CSF's own labels.

    Auto mode classifies the points itself rather than paying for a second
    cloth simulation, so it is only correct if that reconstruction is exact.
    (Nearest-node sampling instead of bilinear disagrees on ~0.2% of points —
    this test is what keeps the interpolation honest.)"""
    import os
    import tempfile

    import CSF

    points, _ = _load_fixture()
    threshold = 0.05
    csf = CSF.CSF()
    csf.params.bSloopSmooth = False
    csf.params.cloth_resolution = 0.05
    csf.params.rigidness = 3
    csf.params.class_threshold = threshold
    csf.params.time_step = 0.65
    csf.params.interations = 500
    csf.setPointCloud(np.ascontiguousarray(points[:, :3], dtype=np.float64))
    ground_idx, off_idx = CSF.VecInt(), CSF.VecInt()
    prev = os.getcwd()
    with tempfile.TemporaryDirectory() as tmp:
        try:
            os.chdir(tmp)
            csf.do_filtering(ground_idx, off_idx)
            nodes = np.loadtxt(os.path.join(tmp, "cloth_nodes.txt"))
        finally:
            os.chdir(prev)

    csf_labels = np.full(len(points), main.GROUND_CLASS_PLANT, dtype=np.int32)
    gi = np.fromiter(ground_idx, dtype=np.int64, count=len(ground_idx))
    csf_labels[gi] = main.GROUND_CLASS_GROUND

    height = main._height_above_cloth(points[:, :3].astype(np.float64), nodes)
    ours = np.where(np.abs(height) < threshold,
                    main.GROUND_CLASS_GROUND, main.GROUND_CLASS_PLANT).astype(np.int32)
    assert np.array_equal(ours, csf_labels)


def test_estimate_class_threshold_finds_the_gap():
    """The estimator cuts between the ground band and the vegetation above it.

    Synthetic height-above-cloth: a 10 cm-wide ground mode, an empty gap, then
    canopy from 2 m. No CSF needed — this pins the estimator's own logic."""
    rng = np.random.default_rng(0)
    heights = np.concatenate([
        rng.normal(0.0, 0.10, 200_000),                  # ground return band
        rng.uniform(2.0, 5.0, 120_000),                  # canopy
    ])
    threshold, meta = main._estimate_class_threshold(heights, 0.5, fallback=0.5)
    assert meta["method"] == "knee"
    # Must clear the ground band (~3 sigma) and stay under the canopy base.
    assert 0.35 <= threshold < 2.0, meta


@requires_csf
def test_auto_class_threshold_survives_a_differently_settled_cloth():
    """The estimate must come from the histogram's shape, not from its last ULP.

    This is the regression test for a real cross-platform failure: CSF's cloth
    is bit-deterministic in-process but settles ~1e-6 differently on
    macOS-arm64 vs Linux-x86_64. On this fixture that was enough to move ONE
    point of 3698 across a bin edge, breaking an exact tie in the
    turning-point search (`smooth[k]` and `smooth[k+span]` are both 133/3 at
    k=14) and collapsing the estimate from 0.051 to 0.021 — barely above the
    0.02 clip floor, i.e. back to the extent-scaled seed auto mode exists to
    beat, costing 8 points of ground recall (0.997 -> 0.920). CI caught it;
    macOS alone never would have.

    So perturbing the cloud at a scale far below the measurement must not move
    the threshold out of the hand-tuned band. Sensitive by construction: with
    the old strict `<` this lands in-band roughly 1 run in 6."""
    points, _ = _load_fixture()
    rng = np.random.default_rng(11)
    seen = []
    for _ in range(8):
        # Displacement ~0.3 mm: three orders of magnitude below the ~5 cm
        # threshold being estimated, and well under the fixture's own noise.
        jittered = points + rng.normal(0.0, 3e-4, size=points.shape)
        meta: dict = {}
        main.segment_ground(
            jittered, cloth_resolution=0.05, rigidness=3,
            class_threshold=0.02, auto_class_threshold=True, meta=meta,
        )
        seen.append(meta["class_threshold"])

    assert all(0.03 <= t <= 0.08 for t in seen), seen
    # And it should be genuinely stable, not merely in-band by luck.
    assert max(seen) - min(seen) < 0.01, seen


def test_estimate_class_threshold_without_vegetation():
    """Ground and nothing else: no turning point exists, so the tail rule runs
    and the threshold still clears the band rather than falling back."""
    rng = np.random.default_rng(1)
    threshold, meta = main._estimate_class_threshold(
        rng.normal(0.0, 0.10, 200_000), 0.5, fallback=0.5)
    assert meta["method"] == "tail"
    assert threshold >= 0.30, meta


@pytest.mark.parametrize("bad", [
    np.zeros(10),                       # too few points
    np.zeros(100_000),                  # zero spread
    np.full(100_000, np.nan),           # all non-finite
])
def test_estimate_class_threshold_falls_back(bad):
    """Degenerate input must never raise or invent a value — it returns the
    caller's extent-scaled seed unchanged."""
    threshold, meta = main._estimate_class_threshold(bad, 0.5, fallback=0.37)
    assert threshold == pytest.approx(0.37)
    assert meta["method"] == "fallback"


@requires_csf
def test_segment_ground_labels_seed_to_plant():
    """A cloud with no ground-like surface labels everything plant (2)."""
    # A small dense blob floating above any cloth — nothing for the cloth to
    # settle onto as ground at this resolution.
    rng = np.random.RandomState(0)
    blob = rng.uniform(0, 0.1, size=(200, 3)) + np.array([0.0, 0.0, 5.0])
    pred = main.segment_ground(blob, cloth_resolution=0.5, rigidness=3)
    assert len(pred) == 200


@requires_csf
def test_segment_ground_endpoint_inline(client):
    points, truth = _load_fixture()
    res = client.post(
        "/api/segment/ground",
        json={"points": points.tolist(), "class_threshold": 0.05},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["success"] is True
    assert body["num_points"] == len(points)
    assert len(body["labels"]) == len(points)
    assert body["num_ground"] + body["num_plant"] == len(points)
    acc, ground_recall, _, _ = _metrics(np.array(body["labels"]), truth)
    assert acc >= MIN_ACCURACY
    assert ground_recall >= MIN_GROUND_RECALL


@requires_csf
def test_segment_ground_endpoint_from_source(client):
    res = client.post(
        "/api/segment/ground",
        json={"source": {"source_path": str(FIXTURE), "ascii_format": ASCII_FORMAT}},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["success"] is True
    _, truth = _load_fixture()
    assert body["num_points"] == len(truth)


@requires_csf
def test_segment_ground_endpoint_auto_threshold(client):
    """The endpoint reports the tolerance auto mode applied, so the panel can
    show it rather than leaving the user guessing what ran."""
    points, truth = _load_fixture()
    res = client.post(
        "/api/segment/ground",
        json={"points": points.tolist(), "class_threshold": 0.02,
              "auto_class_threshold": True},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["success"] is True
    assert body["class_threshold_method"] in ("knee", "tail")
    assert body["class_threshold_used"] > 0.02      # beat the extent-scaled seed
    acc, ground_recall, _, _ = _metrics(np.array(body["labels"]), truth)
    assert acc >= MIN_ACCURACY
    assert ground_recall >= MIN_GROUND_RECALL


def test_segment_ground_too_few_points(client):
    res = client.post("/api/segment/ground", json={"points": [[0, 0, 0], [1, 1, 1]]})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["success"] is False
    assert "at least 10" in body["error"]


def test_segment_ground_requires_input(client):
    res = client.post("/api/segment/ground", json={})
    assert res.status_code == 400
