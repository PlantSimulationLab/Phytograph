"""Ground/non-ground segmentation tests (Cloth Simulation Filter).

The committed fixture `fixtures/bean_scan_small.xyz` is a decimated
(~3.7k-point) subset of a real Helios scan of bean plants on the ground. Its
4th column is the ground-truth annotation (1=ground, 2=plant), so these tests
quantitatively evaluate the segmenter against known labels rather than merely
asserting "didn't crash".

Layers:
  - `segment_ground()` helper run directly → accuracy / per-class recall / IoU.
  - `/api/segment/ground` endpoint → label alignment + counts.
  - `/api/segment/ground/apply` end-to-end (gated on a real PotreeConverter)
    → asserts the `ground_class` scalar survives into the octree metadata.
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


def test_segment_ground_too_few_points(client):
    res = client.post("/api/segment/ground", json={"points": [[0, 0, 0], [1, 1, 1]]})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["success"] is False
    assert "at least 10" in body["error"]


def test_segment_ground_requires_input(client):
    res = client.post("/api/segment/ground", json={})
    assert res.status_code == 400


# --- End-to-end apply (needs PotreeConverter) -------------------------------

def _converter_available() -> bool:
    try:
        main._resolve_potree_converter_path()
        return True
    except Exception:
        return False


requires_converter = pytest.mark.skipif(
    not _converter_available(),
    reason="PotreeConverter binary not found; build it via npm run build:potree-converter",
)


@pytest.fixture
def cache_root(tmp_path, monkeypatch) -> Path:
    root = tmp_path / "octree_cache"
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(root))
    return root


@requires_csf
@requires_converter
def test_segment_ground_apply_writes_ground_class_attribute(client, cache_root):
    res = client.post(
        "/api/segment/ground/apply",
        json={
            "source_path": str(FIXTURE),
            "ascii_format": ASCII_FORMAT,
            "class_threshold": 0.05,
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    _, truth = _load_fixture()
    assert body["point_count"] == len(truth)

    attrs = {a["name"]: a for a in body["attributes"]}
    assert main.GROUND_CLASS_SLUG in attrs, f"attributes were: {list(attrs)}"
    gc = attrs[main.GROUND_CLASS_SLUG]
    assert gc.get("label") == main.GROUND_CLASS_LABEL
    # The class values span 1..2.
    assert gc["min"][0] == pytest.approx(1.0)
    assert gc["max"][0] == pytest.approx(2.0)

    # Slug→label sidecar persisted.
    sidecar = Path(body["cache_dir"]) / main._OCTREE_LABELS_FILENAME
    assert sidecar.is_file()


@requires_csf
@requires_converter
def test_segment_ground_apply_split_filters_by_class(client, cache_root):
    """keep_class produces a sub-cloud octree with only that class's points.
    Ground + plant counts must partition the full cloud."""
    points, truth = _load_fixture()
    base = {"source_path": str(FIXTURE), "ascii_format": ASCII_FORMAT, "class_threshold": 0.05}

    full = client.post("/api/segment/ground/apply", json=base).json()
    ground = client.post("/api/segment/ground/apply", json={**base, "keep_class": 1}).json()
    plant = client.post("/api/segment/ground/apply", json={**base, "keep_class": 2}).json()

    assert ground["point_count"] + plant["point_count"] == full["point_count"] == len(truth)
    assert ground["point_count"] > 0 and plant["point_count"] > 0
    # Distinct cache ids per class (so the renderer gets distinct octrees).
    assert len({full["cache_id"], ground["cache_id"], plant["cache_id"]}) == 3


@requires_csf
@requires_converter
def test_segment_ground_apply_rejects_bad_keep_class(client, cache_root):
    res = client.post(
        "/api/segment/ground/apply",
        json={"source_path": str(FIXTURE), "ascii_format": ASCII_FORMAT, "keep_class": 5},
    )
    assert res.status_code == 400


@requires_csf
@requires_converter
def test_segment_ground_apply_is_cached(client, cache_root):
    payload = {
        "source_path": str(FIXTURE),
        "ascii_format": ASCII_FORMAT,
        "class_threshold": 0.05,
    }
    first = client.post("/api/segment/ground/apply", json=payload)
    second = client.post("/api/segment/ground/apply", json=payload)
    assert first.status_code == 200 and second.status_code == 200
    assert first.json()["cache_id"] == second.json()["cache_id"]
    assert second.json()["cached"] is True
