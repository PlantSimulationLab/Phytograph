"""The ML core (backend-api/ml): hierarchy, package format, inference, readers.

These pin the contracts the benchmark and (later) the app rely on, using a
tiny random-weights model so they run in seconds on a CPU. How well a trained
model scores is the benchmark's job (research/ml/bench.py), not this file's.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

torch = pytest.importorskip("torch")

from ml import hierarchy as H  # noqa: E402
from ml.data import readers  # noqa: E402
from ml.data.cache import CachedItem, write_item  # noqa: E402
from ml.data.crops import CropSampler, Source  # noqa: E402
from ml.grid import grid_sample  # noqa: E402
from ml.infer import Cancelled, predict  # noqa: E402
from ml.models import build_model  # noqa: E402
from ml.package import PackageError, ModelPackage, load_meta, load_model, save, validate  # noqa: E402
from ml.tasks import TASKS, task_map  # noqa: E402

FIXDIR = Path(__file__).parent / "fixtures" / "leafwood"


def _cloud(n=6000, seed=0):
    """A vertical 'trunk' line of wood plus a scattered 'crown' of leaf."""
    rng = np.random.default_rng(seed)
    nt = n // 3
    trunk = np.column_stack([rng.normal(0, 0.02, nt), rng.normal(0, 0.02, nt), rng.uniform(0, 2, nt)])
    crown = rng.normal([0, 0, 2.5], [0.6, 0.6, 0.4], size=(n - nt, 3))
    xyz = np.concatenate([trunk, crown])
    sem = np.concatenate([np.full(nt, readers.SEM_WOOD, np.uint8),
                          np.full(n - nt, readers.SEM_LEAF, np.uint8)])
    return xyz, sem


def _package(spec=None, max_points=2000) -> ModelPackage:
    spec = spec or H.HierarchySpec(voxel=0.02)
    t = TASKS["wood_leaf"]
    hp = {"in_channels": 3, "num_classes": 2,
          "radii": [spec.level_radius(i) for i in range(spec.levels)], "variant": "S"}
    return ModelPackage(id="test-model", name="Test", task="wood_leaf", arch="pointnext",
                        hparams=hp, hierarchy=spec, channels=["dxyz"], classes=t["classes"],
                        output_slug=t["output_slug"], crop_max_points=max_points)


def test_grid_sample_inverse_round_trips():
    xyz, _ = _cloud()
    keep, inv = grid_sample(xyz, 0.05)
    assert len(inv) == len(xyz)
    # Every point's voxel representative lies in the same 5 cm voxel.
    assert np.all(np.abs(xyz[keep][inv] - xyz) < 0.05 * np.sqrt(3) + 1e-9)
    assert len(np.unique(keep)) == len(keep)


def test_hierarchy_shrinks_by_stride_and_indices_are_in_range():
    xyz, _ = _cloud(8000)
    keep, _ = grid_sample(xyz, 0.01)
    spec = H.HierarchySpec(voxel=0.01)
    h = H.build(xyz[keep].astype(np.float32), spec)
    sizes = [len(p) for p in h["pos"]]
    for a, b in zip(sizes, sizes[1:]):
        assert b <= int(np.ceil(a / spec.stride)), sizes
    for i in range(1, spec.levels):
        assert h["down"][i].max() < sizes[i - 1]
        assert h["local"][i].max() < sizes[i]
        assert h["up_idx"][i].max() < sizes[i]
        np.testing.assert_allclose(h["up_w"][i].sum(axis=1), 1.0, rtol=1e-5)
    assert h["local"][0] is None  # opt-in only


def test_collate_offsets_indices_into_the_concatenated_levels():
    spec = H.HierarchySpec(voxel=0.02)
    a = H.build(_cloud(3000, 1)[0].astype(np.float32), spec)
    b = H.build(_cloud(2000, 2)[0].astype(np.float32), spec)
    c = H.collate([a, b])
    for i in range(1, spec.levels):
        na_prev = len(a["pos"][i - 1])
        tail = c["down"][i][len(a["pos"][i]):]
        np.testing.assert_array_equal(tail, b["down"][i] + na_prev)
    assert list(c["batch_sizes"]) == [len(a["pos"][0]), len(b["pos"][0])]


def test_package_validation_names_the_problem(tmp_path):
    pkg = _package()
    meta = pkg.to_json()
    validate(meta)
    for mutate, needle in [
        (lambda m: m.update(format="x"), "format"),
        (lambda m: m.update(schema_version=99), "schema version"),
        (lambda m: m["classes"][0].update(value=0), "1..255"),
        (lambda m: m["classes"][1].update(value=m["classes"][0]["value"]), "twice"),
        (lambda m: m["classes"][0].update(color="brown"), "#rrggbb"),
        (lambda m: m["inputs"].update(channels=["reflectance"]), "dxyz"),
        (lambda m: m["hparams"].update(num_classes=3), "num_classes"),
    ]:
        bad = json.loads(json.dumps(meta))
        mutate(bad)
        with pytest.raises(PackageError, match=needle):
            validate(bad)


def test_package_round_trip_is_weights_only(tmp_path):
    pkg = _package()
    model = build_model(pkg.arch, **pkg.hparams)
    save(pkg, model.state_dict(), tmp_path / "pkg")
    loaded = load_meta(tmp_path / "pkg")
    m2 = load_model(loaded)
    for (k, v1), v2 in zip(model.state_dict().items(), m2.state_dict().values()):
        assert torch.equal(v1, v2), k
    # A mismatched architecture is a PackageError, not a raw RuntimeError.
    meta = json.loads((tmp_path / "pkg" / "model.json").read_text())
    meta["hparams"]["variant"] = "B"
    (tmp_path / "pkg" / "model.json").write_text(json.dumps(meta))
    with pytest.raises(PackageError, match="do not match"):
        load_model(load_meta(tmp_path / "pkg"))


def test_predict_covers_every_point_deterministically():
    torch.manual_seed(0)
    pkg = _package(max_points=1500)
    model = build_model(pkg.arch, **pkg.hparams).eval()
    xyz, _ = _cloud(9000)
    xyz = xyz + np.array([478751.0, 5427032.0, 300.0])  # UTM-sized coordinates
    v1, p1 = predict(model, pkg, xyz, return_probs=True)
    v2 = predict(model, pkg, xyz)
    assert v1.shape == (len(xyz),) and v1.dtype == np.int32
    assert set(np.unique(v1)) <= {1, 2}
    np.testing.assert_array_equal(v1, v2)
    np.testing.assert_allclose(p1.sum(axis=1), 1.0, rtol=1e-4)


def test_predict_honours_cancel():
    pkg = _package(max_points=500)
    model = build_model(pkg.arch, **pkg.hparams).eval()
    with pytest.raises(Cancelled):
        predict(model, pkg, _cloud(6000)[0], cancel=lambda: True)


def test_predict_empty_cloud():
    pkg = _package()
    model = build_model(pkg.arch, **pkg.hparams).eval()
    assert predict(model, pkg, np.empty((0, 3))).shape == (0,)


def test_fixture_reader_and_cache_round_trip(tmp_path):
    cloud = readers.read_phytograph_xyz(FIXDIR / "weiser_oak_small.xyz")
    assert set(np.unique(cloud.sem)) == {readers.SEM_WOOD, readers.SEM_LEAF}
    meta = write_item(cloud, tmp_path / "oak", {"dataset": "fx", "name": "oak", "split": "test"})
    it = CachedItem(tmp_path / "oak")
    assert len(it) == meta["n_points"] <= len(cloud)
    c = meta["counts"]
    assert c["wood"] + c["leaf"] == len(it)
    # ball() returns exactly the rows a brute-force radius search would.
    centre = np.asarray(it.xyz[len(it) // 2])
    got = np.sort(it.ball(centre, 0.8))
    d = np.linalg.norm(np.asarray(it.xyz) - centre, axis=1)
    np.testing.assert_array_equal(got, np.flatnonzero(d <= 0.8))


def test_helios_reader_needs_its_header(tmp_path):
    f = tmp_path / "scene.xyz"
    f.write_text("# x y z scan_position target_index target_count reflectance deviation echo_width "
                 "intensity class_id organ_id plant_id instance_id\n"
                 "0 0 0 0 0 1 -6 0 0 0 3 6 -1 -1\n"
                 "0 0 1 0 0 1 -6 0 0 0 1 3 0 5\n"
                 "0 0 2 0 0 1 -6 0 0 0 0 0 0 6\n"
                 "0 0 3 0 0 1 -6 0 0 0 2 5 0 7\n")
    c = readers.read_helios_synthetic(f)
    assert list(c.sem) == [readers.SEM_GROUND, readers.SEM_WOOD, readers.SEM_LEAF, readers.SEM_FRUIT]
    assert list(c.organ) == [6, 3, 0, 5]
    bare = tmp_path / "bare.xyz"
    bare.write_text("0 0 0 1\n")
    with pytest.raises(ValueError, match="header"):
        readers.read_helios_synthetic(bare)


def test_wan_reader_takes_the_minority_as_wood(tmp_path):
    f = tmp_path / "plot.txt"
    rows = [f"{i} 0 0 255 255 255 {1 if i < 3 else 0}" for i in range(10)]
    f.write_text("\n".join(rows) + "\n")
    c = readers.read_wan(f)
    assert (c.sem == readers.SEM_WOOD).sum() == 3


def test_crop_sampler_produces_a_trainable_batch(tmp_path):
    xyz, sem = _cloud(20000)
    write_item(readers.Cloud(xyz, sem), tmp_path / "t", {"dataset": "t", "name": "t", "split": "train"})
    it = CachedItem(tmp_path / "t")
    spec = H.HierarchySpec(voxel=0.02)
    sampler = CropSampler([Source(it, 1.0, True)], task_map("wood_leaf"), spec, ["dxyz"])
    sampler.crop.max_points = 2000
    rng = np.random.default_rng(0)
    items = [sampler.sample(rng) for _ in range(2)]
    for x in items:
        assert x["feat"].shape == (len(x["pos"][0]), 3)
        assert set(np.unique(x["label"])) <= {-1, 0, 1}
        assert ((x["weight"] == 1.0) | (x["weight"] == sampler.crop.boundary_weight)).all()
    from ml.infer import to_torch
    pkg = _package(spec)
    model = build_model(pkg.arch, **pkg.hparams)
    b = to_torch(H.collate(items), "cpu")
    loss = torch.nn.functional.cross_entropy(model(b), b["label"], ignore_index=-1)
    loss.backward()
    assert torch.isfinite(loss)
