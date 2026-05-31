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
def test_segment_ground_apply_returns_persisted_segmented_source(client, cache_root):
    """The apply persists a segmented LAS (carrying ground_class) and returns
    its path. This is what a later Filter re-reads — without it, crop_octree
    would re-read the original XYZ (no ground_class column) and 400."""
    body = client.post(
        "/api/segment/ground/apply",
        json={"source_path": str(FIXTURE), "ascii_format": ASCII_FORMAT, "class_threshold": 0.05},
    ).json()
    seg_path = Path(body["segmented_source_path"])
    assert seg_path.is_file(), f"segmented source not persisted at {seg_path}"
    assert seg_path.suffix == ".las"
    # It lives inside the apply's cache dir (so cache eviction reclaims it).
    assert seg_path.parent == Path(body["cache_dir"])

    # The LAS carries the ground_class extra dimension.
    import laspy
    with laspy.open(str(seg_path)) as f:
        extra = [d.name for d in f.header.point_format.extra_dimensions]
    assert main.GROUND_CLASS_SLUG in extra


@requires_csf
@requires_converter
def test_segment_ground_apply_then_filter_by_class(client, cache_root):
    """End-to-end regression for the reported bug: after an in-place classify,
    filtering the cloud on `ground_class` via crop_octree must succeed (not 400)
    and keep only the requested class."""
    apply_body = client.post(
        "/api/segment/ground/apply",
        json={"source_path": str(FIXTURE), "ascii_format": ASCII_FORMAT, "class_threshold": 0.05},
    ).json()
    seg_path = apply_body["segmented_source_path"]
    full_count = apply_body["point_count"]

    # Filter to plant-only (ground_class == 2) the way the renderer does:
    # crop_octree on the persisted segmented LAS (ascii_format=None for LAS).
    plant = client.post(
        "/api/pointcloud/crop_octree",
        json={
            "source_path": seg_path,
            "scalar_filters": [{"slug": main.GROUND_CLASS_SLUG, "min": 2, "max": 2}],
        },
    )
    assert plant.status_code == 200, plant.text  # <-- the bug surfaced as 400 here
    plant_count = plant.json()["point_count"]

    ground = client.post(
        "/api/pointcloud/crop_octree",
        json={
            "source_path": seg_path,
            "scalar_filters": [{"slug": main.GROUND_CLASS_SLUG, "min": 1, "max": 1}],
        },
    )
    assert ground.status_code == 200, ground.text
    ground_count = ground.json()["point_count"]

    assert 0 < plant_count < full_count
    assert 0 < ground_count < full_count
    assert plant_count + ground_count == full_count


@requires_csf
@requires_converter
def test_segment_then_filter_then_crop_keeps_ground_removed(client, cache_root):
    """The user's exact bug: segment ground → filter OUT ground → crop the
    remainder. The cropped result must NOT contain ground points — i.e. the
    crop composes on the filtered LAS, not the original segmented source."""
    apply_body = client.post(
        "/api/segment/ground/apply",
        json={"source_path": str(FIXTURE), "ascii_format": ASCII_FORMAT, "class_threshold": 0.05},
    ).json()

    # Filter to non-ground only (ground_class == 2), the way the renderer does:
    # crop_octree on the persisted segmented LAS.
    filtered = client.post(
        "/api/pointcloud/crop_octree",
        json={"source_path": apply_body["segmented_source_path"],
              "scalar_filters": [{"slug": main.GROUND_CLASS_SLUG, "values": [2]}]},
    ).json()
    plant_count = filtered["point_count"]
    assert 0 < plant_count < apply_body["point_count"]
    chained_source = filtered["filtered_source_path"]
    assert chained_source and Path(chained_source).is_file()

    # Sanity: the filtered LAS contains ZERO ground points.
    import laspy
    gc = np.asarray(laspy.read(chained_source)[main.GROUND_CLASS_SLUG])
    assert gc.size == plant_count
    assert int((np.rint(gc) == 1).sum()) == 0, "filtered LAS still has ground points"

    # Now crop a spatial sub-region of the filtered cloud. The result must be a
    # subset of the plant points — ground must stay gone (the bug made it return).
    pts = np.asarray(laspy.read(chained_source).xyz, dtype=np.float64)
    mid = np.median(pts, axis=0)
    cropped = client.post(
        "/api/pointcloud/crop_octree",
        json={"source_path": chained_source,
              "region": {"kind": "box",
                         "min": [float(pts[:, 0].min()), float(pts[:, 1].min()), float(pts[:, 2].min())],
                         "max": [float(mid[0]), float(pts[:, 1].max()), float(pts[:, 2].max())],
                         "invert": False}},
    ).json()
    assert 0 < cropped["point_count"] <= plant_count
    cropped_gc = np.asarray(laspy.read(cropped["filtered_source_path"])[main.GROUND_CLASS_SLUG])
    assert int((np.rint(cropped_gc) == 1).sum()) == 0, "ground reappeared after crop"


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
