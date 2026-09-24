"""Leaf/wood by trained model: registry, endpoints, packaging, and accuracy.

The accuracy gate runs the BUNDLED model on the four real-tree fixtures that
gate the geometric method (tests/test_wood_segment.py). The benchmark held
these trees out of training (backend-api/research/ml/corpus.py), so the gate
tests the shipped model on trees it has never seen.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

pytest.importorskip("torch")

import main  # noqa: E402
from ml import registry  # noqa: E402
from ml.package import PackageError  # noqa: E402

FIXDIR = Path(__file__).parent / "fixtures" / "leafwood"
REPO = Path(__file__).resolve().parents[2]
BUNDLED = REPO / "resources" / "ml_models" / registry.DEFAULT_WOOD_MODEL


def _load(stem):
    df = pd.read_csv(FIXDIR / f"{stem}.xyz", sep=r"\s+", comment="#", header=None)
    return df.iloc[:, :3].to_numpy(np.float64), df.iloc[:, 3].to_numpy().astype(int)


def _f1(pred, truth, cls):
    tp = int(((pred == cls) & (truth == cls)).sum())
    fp = int(((pred == cls) & (truth != cls)).sum())
    fn = int(((pred != cls) & (truth == cls)).sum())
    return 2 * tp / max(2 * tp + fp + fn, 1)


# (stem, min OA, min wood F1). Bundled model vs `sota` on these same fixtures:
#
#   fixture   spacing   model OA / wood F1   sota OA / wood F1
#   spruce    36 mm     0.86 / 0.82          0.86 / 0.78
#   oak       21 mm     0.91 / 0.92          0.82 / 0.83
#   beech     42 mm     0.78 / 0.72          0.90 / 0.80
#   lewos     37 mm     0.96 / 0.88          0.94 / 0.77
#
# The fixtures are decimated to 2-4 cm spacing, far sparser than the 1 cm the
# model works at. That is why beech, the sparsest, is the one tree where sota
# still wins. On the benchmark's 59 held-out trees the model leads both at full
# resolution (mIoU 0.83 vs 0.66) and thinned to 3 cm (0.78 vs 0.60); see
# research/ml/README.md. Floors sit ~0.04 below the model's numbers, so they
# catch a broken model or inference path, not seed noise.
GATES = [
    ("weiser_spruce_small", 0.82, 0.78),
    ("weiser_oak_small", 0.87, 0.88),
    ("weiser_beech_small", 0.74, 0.68),
    ("lewos_tropical_small", 0.92, 0.84),
]


@pytest.mark.parametrize("stem,min_oa,min_f1", GATES, ids=[g[0] for g in GATES])
def test_bundled_model_meets_its_accuracy_gates(stem, min_oa, min_f1):
    points, truth = _load(stem)
    pred = main.segment_wood(points, method="ml")
    assert pred.shape == (len(points),)
    assert set(np.unique(pred)) <= {main.WOOD_CLASS_WOOD, main.WOOD_CLASS_LEAF}
    oa = float((pred == truth).mean())
    f1 = _f1(pred, truth, main.WOOD_CLASS_WOOD)
    print(f"\n{stem}: OA={oa:.4f} F1_wood={f1:.4f}")
    assert oa >= min_oa, f"{stem} OA {oa:.4f} < {min_oa}"
    assert f1 >= min_f1, f"{stem} wood F1 {f1:.4f} < {min_f1}"


def test_leafoff_fixture_stays_wood():
    points, truth = _load("leafoff_allwood_small")
    pred = main.segment_wood(points, method="ml")
    w = float((pred == main.WOOD_CLASS_WOOD).mean())
    print(f"\nleaf-off wood fraction {w:.3f}")
    assert w >= 0.80, f"ML called {1 - w:.1%} of an all-wood tree leaf"


def test_bundled_package_is_valid_and_default():
    pkg = registry.find(None, task="wood_leaf")
    assert pkg.id == registry.DEFAULT_WOOD_MODEL
    assert pkg.output_slug == main.WOOD_CLASS_SLUG
    assert {c["name"] for c in pkg.classes} == {"Wood", "Leaf"}
    # The weights must be small enough to commit and ship.
    assert (pkg.path / "weights.pt").stat().st_size < 20 * 2**20


def test_packaged_layout_matches_package_json_extraresources(monkeypatch, tmp_path):
    """Reconstruct the packaged tree from package.json and prove the registry
    finds the bundled model in it (the PHYTOGRAPH_RESOURCES trap that shipped
    a broken RIEGL reader; see CLAUDE.md)."""
    pkg_json = json.loads((REPO / "package.json").read_text())
    entry = next(e for e in pkg_json["build"]["extraResources"]
                 if any(f.startswith("ml_models") for f in e.get("filter", [])))
    contents_resources = tmp_path / "Contents" / "Resources"
    dest = contents_resources / entry["to"] / "ml_models" / registry.DEFAULT_WOOD_MODEL
    shutil.copytree(BUNDLED, dest)
    monkeypatch.setenv("PHYTOGRAPH_RESOURCES", str(contents_resources / "resources"))
    roots = registry.bundled_roots()
    assert any((r / registry.DEFAULT_WOOD_MODEL / "model.json") == dest / "model.json" for r in roots)
    assert registry.find(None).path == dest


def test_import_list_delete_round_trip(monkeypatch, tmp_path):
    monkeypatch.setenv("PHYTOGRAPH_ML_MODELS_DIR", str(tmp_path / "user"))
    src = tmp_path / "mine"
    shutil.copytree(BUNDLED, src)
    meta = json.loads((src / "model.json").read_text())
    # Same id as the bundled model: refused, it would shadow the default.
    with pytest.raises(PackageError, match="built-in"):
        registry.import_package(src)
    meta["id"] = "my-wood-model"
    (src / "model.json").write_text(json.dumps(meta))
    pkg = registry.import_package(src)
    assert pkg.path == tmp_path / "user" / "my-wood-model"
    assert ("my-wood-model", "user") in [(p.id, o) for p, o in registry.list_models()]
    with pytest.raises(PackageError, match="built in"):
        registry.delete_user_model(registry.DEFAULT_WOOD_MODEL)
    registry.delete_user_model("my-wood-model")
    assert "my-wood-model" not in [p.id for p, _ in registry.list_models()]


def test_import_refuses_weights_that_do_not_match(monkeypatch, tmp_path):
    monkeypatch.setenv("PHYTOGRAPH_ML_MODELS_DIR", str(tmp_path / "user"))
    src = tmp_path / "bad"
    shutil.copytree(BUNDLED, src)
    meta = json.loads((src / "model.json").read_text())
    meta["id"] = "bad"
    meta["hparams"]["variant"] = "B"
    (src / "model.json").write_text(json.dumps(meta))
    with pytest.raises(PackageError, match="do not match"):
        registry.import_package(src)
    assert not (tmp_path / "user" / "bad").exists()


def test_endpoints_list_segment_and_reject_unknown_model(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient

    monkeypatch.setenv("PHYTOGRAPH_ML_MODELS_DIR", str(tmp_path / "user"))
    client = TestClient(main.app)
    listing = client.get("/api/ml/models").json()
    ids = [m["id"] for m in listing["models"]]
    assert registry.DEFAULT_WOOD_MODEL in ids
    assert listing["default_wood_model"] == registry.DEFAULT_WOOD_MODEL
    default = next(m for m in listing["models"] if m["id"] == registry.DEFAULT_WOOD_MODEL)
    assert default["origin"] == "bundled" and default["is_default"]

    points, truth = _load("weiser_oak_small")
    resp = client.post("/api/segment/wood", json={"points": points.tolist(), "method": "ml"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["success"] and body["num_points"] == len(points)
    assert body["num_wood"] + body["num_leaf"] == len(points)
    assert float((np.array(body["labels"]) == truth).mean()) > 0.85

    bad = client.post("/api/segment/wood",
                      json={"points": points[:100].tolist(), "method": "ml", "model_id": "nope"})
    assert bad.status_code == 400 and "not installed" in bad.json()["detail"]


def test_device_and_import_endpoints_run_in_the_worker(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient

    monkeypatch.setenv("PHYTOGRAPH_ML_MODELS_DIR", str(tmp_path / "user"))
    monkeypatch.setattr(main, "_ML_DEVICE_CACHE", None)
    client = TestClient(main.app)
    dev = client.get("/api/ml/device").json()
    assert dev["device"] in ("cuda", "mps", "cpu") and dev["torch"]

    src = tmp_path / "pkg"
    shutil.copytree(BUNDLED, src)
    meta = json.loads((src / "model.json").read_text())
    meta["id"] = "imported-one"
    (src / "model.json").write_text(json.dumps(meta))
    ok = client.post("/api/ml/models/import", json={"path": str(src / "model.json")})
    assert ok.status_code == 200, ok.text
    assert ok.json()["model"]["id"] == "imported-one"
    dup = client.post("/api/ml/models/import", json={"path": str(BUNDLED)})
    assert dup.status_code == 400 and "built-in" in dup.json()["detail"]
    assert client.delete("/api/ml/models/imported-one").json()["success"]
