"""Plant organs by trained model: accuracy of the bundled model, units, endpoints.

The fixtures (tests/fixtures/organs/, written by
research/ml/organ_make_fixtures.py) were never trained on: a Helios synthetic
potted tomato from the val_synth split, with exact soil / stem / leaf and
leaflet labels, and a real Sugar4D sugar beet (CC BY 4.0) from the test split,
written in millimetres so the default ``units="auto"`` has to notice.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

pytest.importorskip("torch")

import main  # noqa: E402
from ml import organs, registry  # noqa: E402
from ml.instances import match  # noqa: E402

FIXDIR = Path(__file__).parent / "fixtures" / "organs"
REPO = Path(__file__).resolve().parents[2]


def _load(stem):
    d = pd.read_csv(FIXDIR / f"{stem}.xyz", sep=r"\s+", comment="#", header=None).to_numpy()
    return d[:, :3].astype(np.float64), d[:, 3].astype(int), d[:, 4].astype(int)


def _iou(pred, truth, cls, scored):
    inter = ((pred == cls) & (truth == cls)).sum()
    union = (((pred == cls) | (truth == cls)) & scored).sum()
    return inter / max(union, 1)


@pytest.fixture(scope="module")
def tomato():
    xyz, organ, leaflet = _load("potted_tomato_synth")
    pred_organ, pred_leaflet, meta = organs.label_plant(xyz, device="cpu")
    return xyz, organ, leaflet, pred_organ, pred_leaflet, meta


# Bundled model on the synthetic tomato (88,871 points, 112 leaflets):
# OA 0.992, IoU soil 1.00 / stem 0.83 / leaf 0.97, leaflet F1 0.886 (98 found).
# Floors sit ~0.04 below, so they catch a broken model or pipeline, not noise.
def test_bundled_model_labels_the_synthetic_tomato(tomato):
    xyz, organ, leaflet, po, pl, meta = tomato
    assert meta["units"] == "m" and meta["model_id"] == registry.DEFAULT_ORGAN_MODEL
    assert set(np.unique(po)) <= {organs.SOIL, organs.STEM, organs.LEAF}
    scored = organ > 0
    assert float((po[scored] == organ[scored]).mean()) >= 0.96
    assert _iou(po, organ, organs.SOIL, scored) >= 0.96
    assert _iou(po, organ, organs.STEM, scored) >= 0.78
    assert _iou(po, organ, organs.LEAF, scored) >= 0.93
    m = match(np.where(leaflet > 0, leaflet, -1), np.where(pl > 0, pl, -1))
    print(f"\ntomato leaflets: F1 {m['f1']:.3f}, {m['n_pred']} of {m['n_true']}")
    assert m["f1"] >= 0.84
    assert abs(m["n_pred"] - m["n_true"]) <= 0.25 * m["n_true"]


def test_leaflet_ids_are_dense_and_numbered_by_height(tomato):
    """1..N with no gaps, only on leaf points, and ordered lowest first:
    PlantCloudFit reads increasing leaflet labels as increasing age."""
    xyz, _, _, po, pl, meta = tomato
    ids = np.unique(pl[pl > 0])
    assert ids.tolist() == list(range(1, meta["num_leaflets"] + 1))
    assert (po[pl > 0] == organs.LEAF).all() and (pl[po != organs.LEAF] == 0).all()
    z = [xyz[pl == k, 2].mean() for k in ids]
    assert np.all(np.diff(z) >= 0)


def test_bundled_model_finds_the_real_beet_leaves_in_millimetres():
    xyz, organ, leaflet = _load("sugar_beet_real")
    po, pl, meta = organs.label_plant(xyz, device="cpu")
    assert meta["units"] == "mm" and not meta["warnings"]
    m = match(np.where(leaflet > 0, leaflet, -1), np.where(pl > 0, pl, -1), ignore=organ == 9)
    print(f"\nbeet leaves: F1 {m['f1']:.3f}, {m['n_pred']} of {m['n_true']}")
    assert m["f1"] >= 0.75 and m["mcov"] >= 0.8
    # The same plant told it is in metres is a 0.4 km "plant": the result is
    # nonsense, but the user is told why.
    _, warnings = organs.resolve_units(xyz, "m")
    assert warnings and "not the size of a plant" in warnings[0]


# (diagonal in the cloud's units, units auto picks, warning it gives or None)
AUTO_CASES = [
    (0.4, "m", None),                             # a 40 cm plant in metres
    (12.0, "m", "not the size of a plant"),       # a 12 m plot: not what the model is for
    (100.0, "mm", "pick Centimetres"),            # 10 cm in mm, or 1 m in cm: say which was taken
    (450.0, "mm", None),                          # a 45 cm plant in mm
    (9000.0, "mm", "not the size of a plant"),    # 9 m in mm (or a metre cloud 9 km across)
]


@pytest.mark.parametrize("diag,expected,warning", AUTO_CASES)
def test_auto_units_reads_the_cloud_size(diag, expected, warning):
    pts = np.random.default_rng(0).uniform(0, diag / np.sqrt(3), (2000, 3))
    units, warnings = organs.resolve_units(pts, "auto")
    assert units == expected
    if warning is None:
        assert warnings == []
    else:
        assert len(warnings) == 1 and warning in warnings[0]
    # An explicit choice always wins.
    assert organs.resolve_units(pts, "cm")[0] == "cm"
    with pytest.raises(ValueError):
        organs.resolve_units(pts, "inches")


def test_registry_has_a_default_organ_model_beside_the_wood_one():
    pkg = registry.find(None, task="plant_organ")
    assert pkg.id == registry.DEFAULT_ORGAN_MODEL
    assert pkg.path.parent == REPO / "resources" / "ml_models"
    assert pkg.output_slug == main.PLANT_ORGAN_SLUG
    assert [c["name"] for c in pkg.classes] == ["Soil", "Stem", "Leaf"]
    assert (pkg.path / "weights.pt").stat().st_size < 20 * 2**20
    # No task still means the wood default, as before.
    assert registry.find(None).id == registry.DEFAULT_WOOD_MODEL


def test_models_endpoint_marks_one_default_per_task(client):
    listing = client.get("/api/ml/models").json()
    defaults = {m["task"]: m["id"] for m in listing["models"] if m["is_default"]}
    assert defaults["plant_organ"] == registry.DEFAULT_ORGAN_MODEL
    assert defaults["wood_leaf"] == registry.DEFAULT_WOOD_MODEL
    assert listing["default_models"]["plant_organ"] == registry.DEFAULT_ORGAN_MODEL
    only = client.get("/api/ml/models", params={"task": "plant_organ"}).json()["models"]
    assert [m["id"] for m in only] == [registry.DEFAULT_ORGAN_MODEL]


def test_inline_endpoint_labels_points_and_reports_units(client):
    xyz, organ, leaflet = _load("sugar_beet_real")
    resp = client.post("/api/segment/organs", json={"points": xyz.tolist()})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["success"] and body["units"] == "mm" and body["model_id"] == registry.DEFAULT_ORGAN_MODEL
    assert len(body["organ"]) == len(body["leaflet"]) == body["num_points"] == len(xyz)
    assert body["num_soil"] + body["num_stem"] + body["num_leaf"] == len(xyz)
    assert body["num_leaflets"] == max(body["leaflet"]) >= 4
    m = match(np.where(leaflet > 0, leaflet, -1), np.where(np.array(body["leaflet"]) > 0, body["leaflet"], -1),
              ignore=organ == 9)
    assert m["f1"] >= 0.75


def test_inline_endpoint_refuses_a_wood_model_and_an_unknown_one(client):
    xyz, _, _ = _load("sugar_beet_real")
    wood = client.post("/api/segment/organs",
                       json={"points": xyz[:200].tolist(), "model_id": registry.DEFAULT_WOOD_MODEL})
    assert wood.status_code == 400 and "not 'plant_organ'" in wood.json()["detail"]
    nope = client.post("/api/segment/organs", json={"points": xyz[:200].tolist(), "model_id": "nope"})
    assert nope.status_code == 400 and "not installed" in nope.json()["detail"]


@pytest.fixture
def tomato_session_with_misses():
    """The synthetic tomato as a session, plus a shell of sky/miss points ~1 km
    out, tagged the way import tags them and SHUFFLED among the hits, with 5 %
    of the rows deleted. A miss that reached the model would make "auto" read
    the cloud as a 2 km object in millimetres; a scatter that ignored the miss
    or deletion masks would put the labels on the wrong points, which the
    per-point comparison with the truth below catches."""
    xyz, organ, _ = _load("potted_tomato_synth")
    rng = np.random.default_rng(1)
    d = rng.normal(size=(3000, 3))
    misses = xyz.mean(0) + 1000.0 * d / np.linalg.norm(d, axis=1, keepdims=True)
    order = rng.permutation(len(xyz) + len(misses))
    positions = np.vstack([xyz, misses])[order]
    is_miss = np.r_[np.zeros(len(xyz)), np.ones(len(misses))].astype(np.float32)[order]
    truth = np.r_[organ, np.zeros(len(misses), int)][order]
    deleted = rng.random(len(positions)) < 0.05
    sess = main.CloudSession(
        session_id="organ-session-test", source_path=str(FIXDIR / "potted_tomato_synth.xyz"),
        ascii_format=None, column_plan=None, positions=positions, colors=None, intensity=None,
        extras={main._MISS_SLUG: is_miss}, extra_dims_meta=[], deleted=deleted,
        deleted_history=[], octree_cache_id=None, created_at=0.0,
    )
    main._cloud_sessions[sess.session_id] = sess
    try:
        yield sess, truth
    finally:
        main._cloud_sessions.pop(sess.session_id, None)


def test_session_endpoint_writes_both_columns_on_hits_only(client, tomato_session_with_misses):
    sess, truth = tomato_session_with_misses
    miss = sess.extras[main._MISS_SLUG] != 0
    live_hit = ~miss & ~sess.deleted
    resp = client.post(f"/api/cloud/session/{sess.session_id}/segment_organs", json={})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["point_count"] == int(live_hit.sum()) and body["units"] == "m" and not body["warnings"]
    assert body.get("cache_id")
    organ = sess.extras[main.PLANT_ORGAN_SLUG]
    leaflet = sess.extras[main.LEAFLET_ID_SLUG]
    assert organ.shape == leaflet.shape == (len(sess.positions),)
    assert (organ[miss] == 0).all() and (leaflet[miss] == 0).all()
    assert set(np.unique(organ[live_hit])) == {1, 2, 3}
    # Each label sits on its own point: the same accuracy as the in-process run.
    scored = live_hit & (truth > 0)
    assert float((organ[scored] == truth[scored]).mean()) >= 0.96
    assert (leaflet[live_hit & (organ != 3)] == 0).all()
    assert int(leaflet.max()) == body["num_leaflets"] >= 85
    labels = {m["slug"]: m["label"] for m in sess.extra_dims_meta}
    assert labels[main.PLANT_ORGAN_SLUG] == main.PLANT_ORGAN_LABEL
    assert labels[main.LEAFLET_ID_SLUG] == main.LEAFLET_ID_LABEL


def test_session_endpoint_refuses_to_write_over_an_edit_made_during_the_run(
        client, tomato_session_with_misses, monkeypatch):
    """The labels are indexed against the survivors as they were when the run
    started. An erase during the run changes that set; writing anyway would put
    every label after the erased point on the wrong point."""
    sess, _ = tomato_session_with_misses

    async def run_and_erase(tool, pts, params, **kw):
        sess.deleted[np.flatnonzero(~sess.deleted)[0]] = True   # the user erases a point
        return np.ones((len(pts), 2), np.int32), {"units": "m", "num_leaflets": 1}

    monkeypatch.setattr(main, "_run_killable", run_and_erase)
    resp = client.post(f"/api/cloud/session/{sess.session_id}/segment_organs", json={})
    assert resp.status_code == 409 and "edited" in resp.json()["detail"]
    assert main.PLANT_ORGAN_SLUG not in sess.extras and main.LEAFLET_ID_SLUG not in sess.extras


def test_a_package_with_classes_it_cannot_map_is_refused(monkeypatch, tmp_path):
    """Classes are mapped by NAME. A package whose names are not Soil / Stem /
    Leaf is refused rather than silently read as stem."""
    import json
    import shutil

    monkeypatch.setenv("PHYTOGRAPH_ML_MODELS_DIR", str(tmp_path / "user"))
    src = tmp_path / "odd"
    shutil.copytree(registry.find(None, task="plant_organ").path, src)
    meta = json.loads((src / "model.json").read_text())
    meta["id"] = "odd-organs"
    meta["classes"][2]["name"] = "Blade"
    (src / "model.json").write_text(json.dumps(meta))
    registry.import_package(src)
    xyz, _, _ = _load("sugar_beet_real")
    with pytest.raises(ValueError, match="'Blade'"):
        organs.label_plant(xyz[:500], model_id="odd-organs", device="cpu")
