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
from ml.infer import Canceled, predict  # noqa: E402
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


def test_predict_honors_cancel():
    pkg = _package(max_points=500)
    model = build_model(pkg.arch, **pkg.hparams).eval()
    with pytest.raises(Canceled):
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
    center = np.asarray(it.xyz[len(it) // 2])
    got = np.sort(it.ball(center, 0.8))
    d = np.linalg.norm(np.asarray(it.xyz) - center, axis=1)
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


# ---- plant organs: partial labels, instance offsets, clustering -------------

def _organ_cloud(seed=0):
    """Two flat 'leaflets' on either side of a vertical 'stem', over a soil disk,
    in the herbaceous codes: soil / stem / two blade instances, plus one
    undivided Sugar4D-style leaf that is only 'not soil'."""
    rng = np.random.default_rng(seed)
    n = 3000
    soil = np.column_stack([rng.uniform(-0.1, 0.1, n), rng.uniform(-0.1, 0.1, n), rng.normal(0, 0.001, n)])
    stem = np.column_stack([rng.normal(0, 0.002, n // 3), rng.normal(0, 0.002, n // 3), rng.uniform(0, 0.15, n // 3)])
    a = np.column_stack([rng.uniform(0.01, 0.05, n), rng.uniform(-0.015, 0.015, n), np.full(n, 0.10)])
    b = np.column_stack([rng.uniform(-0.05, -0.01, n), rng.uniform(-0.015, 0.015, n), np.full(n, 0.12)])
    w = np.column_stack([rng.uniform(-0.02, 0.02, n), rng.uniform(0.03, 0.07, n), np.full(n, 0.14)])
    xyz = np.concatenate([soil, stem, a, b, w])
    sem = np.concatenate([np.full(n, readers.SEM_GROUND), np.full(n // 3, readers.SEM_STEM),
                          np.full(2 * n, readers.SEM_BLADE), np.full(n, readers.SEM_LEAF_WHOLE)]).astype(np.uint8)
    inst = np.concatenate([np.full(n + n // 3, -1), np.full(n, 0), np.full(n, 1), np.full(n, 2)]).astype(np.int32)
    return xyz, sem, inst


def test_partial_nll_is_cross_entropy_for_a_single_class_and_ignores_empty_sets():
    from ml.train import partial_nll

    g = torch.Generator().manual_seed(0)
    logits = torch.randn(50, 3, generator=g, requires_grad=True)
    label = torch.randint(0, 3, (50,), generator=g)
    allowed = torch.nn.functional.one_hot(label, 3).bool()
    ref = torch.nn.functional.cross_entropy(logits, label, reduction="none", label_smoothing=0.1)
    assert torch.allclose(partial_nll(logits, allowed, 0.1), ref, atol=1e-5)
    # A two-class set scores the summed probability; an all-False row is 0
    # with a finite gradient.
    allowed[:10] = torch.tensor([False, True, True])
    allowed[10:20] = False
    loss = partial_nll(logits, allowed)
    p = torch.softmax(logits, -1)
    assert torch.allclose(loss[:10], -torch.log(p[:10, 1] + p[:10, 2]), atol=1e-5)
    assert (loss[10:20] == 0).all()
    loss.sum().backward()
    assert torch.isfinite(logits.grad).all()


def test_organ_task_maps_partial_codes_to_class_sets():
    tm = task_map("plant_organ")
    lut, allowed = tm.lut(), tm.allowed_lut()
    assert lut[readers.SEM_GROUND] == 0 and lut[readers.SEM_STEM] == 1 and lut[readers.SEM_BLADE] == 2
    # Sugar4D's undivided leaf is blade or petiole: scored as nothing,
    # trained as "stem or leaf".
    assert lut[readers.SEM_LEAF_WHOLE] == -1
    assert allowed[readers.SEM_LEAF_WHOLE].tolist() == [False, True, True]
    # A taproot is not a leaf, whatever else it is.
    assert allowed[readers.SEM_ROOT].tolist() == [True, True, False]
    assert not allowed[readers.SEM_FRUIT].any()


def test_organ_crops_carry_rotated_centroid_offsets(tmp_path):
    xyz, sem, inst = _organ_cloud()
    write_item(readers.Cloud(xyz, sem, inst=inst), tmp_path / "p",
               {"dataset": "p", "name": "p", "split": "train"}, voxel=0.001, cell=0.1)
    it = CachedItem(tmp_path / "p")
    spec = H.HierarchySpec(voxel=0.002)
    sampler = CropSampler([Source(it, 1.0, True)], task_map("plant_organ"), spec, ["dxyz"])
    sampler.crop.fetch_radius = 0.15
    sampler.aug.jitter = 0.0   # jitter moves points, not their votes
    rng = np.random.default_rng(1)
    for _ in range(3):
        x = sampler.sample(rng)
        pos = x["pos"][0].astype(np.float64)
        has = x["has_offset"]
        assert has.any() and x["allowed"].shape == (len(pos), 3)
        # Every instance point's vote lands on one of the three centroids,
        # whatever rotation and scale the crop drew.
        votes = pos[has] + x["offset"][has]
        centers = np.unique(np.round(votes, 4), axis=0)
        assert 1 <= len(centers) <= 6   # 3 centroids, each possibly split by rounding
        assert np.abs(votes[:, None, :] - centers[None]).max(axis=2).min(axis=1).max() < 1e-4
        # Radii are the instances' (scaled) RMS radii: ~1.1-1.4 cm here.
        r = np.exp(x["log_radius"][has])
        assert (r > 0.008).all() and (r < 0.02).all()
        assert np.abs(x["offset"][~has]).max() == 0


def test_cluster_separates_touching_instances_by_their_votes():
    from ml.instances import cluster, match

    xyz, sem, inst = _organ_cloud()
    member = inst >= 0
    cent = np.stack([xyz[inst == k].mean(axis=0) for k in range(3)])
    rad = np.array([np.sqrt(((xyz[inst == k] - cent[k]) ** 2).sum(axis=1).mean()) for k in range(3)])
    off = np.zeros_like(xyz)
    off[member] = cent[inst[member]] - xyz[member]
    r = np.zeros(len(xyz))
    r[member] = rad[inst[member]]
    noisy = off + np.random.default_rng(0).normal(0, 1, off.shape) * (0.3 * r)[:, None]
    pred = cluster(xyz, noisy, r, member)
    m = match(np.where(member, inst, -1), pred)
    assert m["n_pred"] == 3 and m["f1"] == 1.0 and m["mcov"] > 0.95
    assert (pred[~member] == -1).all()
    # Scoring: merging two equal leaflets leaves each at IoU 0.5, which is
    # not a match, so both are missed and the merged blob is a false positive.
    merged = np.where(pred == pred[inst == 1][0], pred[inst == 0][0], pred)
    m2 = match(np.where(member, inst, -1), merged)
    assert m2["tp"] == 1 and m2["n_pred"] == 2 and m2["count_error"] == -1


def test_cluster_rescues_a_small_leaflet_by_its_radius_but_not_a_fragment():
    """Below the size floor, a cluster that measures the radius its votes
    predict is a small leaflet and is kept; one far smaller than predicted is
    a fragment of a big leaflet and is not."""
    from ml.instances import cluster

    g = np.arange(0, 0.1, 0.002)
    big = np.stack(np.meshgrid(g, g, indexing="ij"), -1).reshape(-1, 2)
    s = np.arange(0, 0.008, 0.002)
    small = np.stack(np.meshgrid(s, s, indexing="ij"), -1).reshape(-1, 2) + [0.13, 0.05]
    xyz = np.column_stack([np.vstack([big, small]), np.zeros(len(big) + len(small))])
    inst = np.r_[np.zeros(len(big), int), np.ones(len(small), int)]
    cent = np.stack([xyz[inst == k].mean(axis=0) for k in range(2)])
    off = cent[inst] - xyz
    rad = np.array([np.sqrt(((xyz[inst == k] - cent[k]) ** 2).sum(axis=1).mean()) for k in range(2)])
    r = rad[inst]
    # A 4 x 4 patch of the big leaflet whose votes stray 30 cm off (radius still the big one's).
    frag = (np.abs(xyz[:, 0] - 0.05) < 0.004) & (np.abs(xyz[:, 1] - 0.05) < 0.004)
    off[frag] = [0.0, 0.3, 0.0] - xyz[frag]
    member = np.ones(len(xyz), bool)
    kw = dict(voxel=0.002, min_area=1e-4)
    assert len(np.unique(cluster(xyz, off, r, member, **kw))) == 1  # floor (25) drops both 16-point clusters
    lab = cluster(xyz, off, r, member, radius_ratio_min=0.75, **kw)
    assert len(np.unique(lab)) == 2
    assert len(np.unique(lab[inst == 1])) == 1 and lab[inst == 1][0] != lab[inst == 0][0]
    assert (lab[frag] == lab[~frag & (inst == 0)][0]).all()


def test_offset_model_predicts_offsets_and_radii_for_every_point():
    spec = H.HierarchySpec(voxel=0.004)
    t = TASKS["plant_organ"]
    hp = {"in_channels": 3, "num_classes": 3, "radii": [spec.level_radius(i) for i in range(spec.levels)],
          "variant": "S", "offset": True}
    pkg = ModelPackage(id="organ-test", name="T", task="plant_organ", arch="pointnext", hparams=hp,
                       hierarchy=spec, channels=["dxyz"], classes=t["classes"], output_slug=t["output_slug"],
                       crop_max_points=1500)
    validate(pkg.to_json())
    torch.manual_seed(0)
    model = build_model(pkg.arch, **pkg.hparams).eval()
    xyz, _, _ = _organ_cloud()
    values, offsets, radii = predict(model, pkg, xyz, return_offsets=True)
    assert values.shape == (len(xyz),) and set(np.unique(values)) <= {1, 2, 3}
    assert offsets.shape == (len(xyz), 3) and np.isfinite(offsets).all()
    assert radii.shape == (len(xyz),) and (radii > 0).all()
    with pytest.raises(ValueError, match="no offset head"):
        predict(build_model(_package().arch, **_package().hparams), _package(), xyz, return_offsets=True)


def test_helios_herb_reader_maps_fine_organs_to_the_organ_scheme(tmp_path):
    """Petioles, petiolules and shoots are stem, blades are leaflet instances with their age,
    the pot is soil and flowers are ignored: the organ scheme, not the tree
    corpus's class_id (which puts petioles in the leaf)."""
    f = tmp_path / "scene_00000.xyz"
    cols = "x y z scan_position target_index target_count reflectance deviation echo_width intensity class_id organ_id plant_id instance_id leaf_age"
    rows = [  # organ_id, instance_id, leaf_age
        (0, 9001, 12.5), (0, 9001, 12.5), (0, 7005, 3.0),   # two leaflets
        (1, 9002, -1), (2, 9003, -1), (3, 9004, -1),         # petiole, petiolule, shoot
        (6, -1, -1), (11, -1, -1),                           # soil, pot
        (8, 9100, -1),                                       # petal
    ]
    f.write_text("# " + cols + "\n" + "".join(
        f"{i * 0.01} 0 0 0 1 1 0 0 0 0 0 {o} 0 {inst} {age}\n" for i, (o, inst, age) in enumerate(rows)))
    c = readers.read_helios_herb(f)
    S = readers
    assert c.sem.tolist() == [S.SEM_BLADE] * 3 + [S.SEM_STEM] * 3 + [S.SEM_GROUND] * 2 + [S.SEM_FRUIT]
    # Two leaflets, renumbered densely; nothing else has an instance.
    assert c.inst[:3].tolist() in ([1, 1, 0], [0, 0, 1]) and (c.inst[3:] == -1).all()
    assert c.age.tolist()[:3] == [12.5, 12.5, 3.0] and (c.age[3:] == -1).all()
    # A leaf younger than YOUNG_LEAF_DAYS is an unexpanded apex leaf: its own code, still an instance.
    f.write_text("# " + cols + "\n" + "".join(
        f"{i * 0.01} 0 0 0 1 1 0 0 0 0 0 0 0 9001 {age}\n" for i, age in enumerate((1.0, 2.9, 3.0))))
    c = readers.read_helios_herb(f)
    assert c.sem.tolist() == [S.SEM_YOUNG_LEAF, S.SEM_YOUNG_LEAF, S.SEM_BLADE]
    assert (c.inst >= 0).all()
    allowed = task_map("plant_organ").allowed_lut()
    assert allowed[S.SEM_YOUNG_LEAF].tolist() == [False, True, True]
    assert S.SEM_YOUNG_LEAF in TASKS["plant_organ"]["instance_codes"]

def test_rows_clear_of_is_foliage_far_from_wood(tmp_path):
    """Clear-of-wood seeding (CropConfig.clear_seed_prob) draws from leaf
    points with no wood within the clearance, and never from ignored classes
    such as ground."""
    xyz, sem = _cloud(20000)
    ground = np.column_stack([np.random.default_rng(5).uniform(-1, 1, (2000, 2)), np.zeros(2000)])
    xyz = np.concatenate([xyz, ground])
    sem = np.concatenate([sem, np.full(2000, readers.SEM_GROUND, np.uint8)])
    write_item(readers.Cloud(xyz, sem), tmp_path / "t", {"dataset": "t", "name": "t", "split": "train"})
    it = CachedItem(tmp_path / "t")
    rows = it.rows_clear_of((readers.SEM_WOOD,), 0.3, (readers.SEM_LEAF,))
    assert len(rows) > 0
    assert (np.asarray(it.sem)[rows] == readers.SEM_LEAF).all()
    wood = np.asarray(it.xyz)[it.rows_of((readers.SEM_WOOD,))]
    from scipy.spatial import cKDTree
    d, _ = cKDTree(wood).query(np.asarray(it.xyz)[rows])
    # 2 cm thinning of the wood moves the boundary by at most ~1.7 cm.
    assert d.min() > 0.3 - 0.02
