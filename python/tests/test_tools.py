"""Phase 2: the analysis tools, against a live backend, on fixtures of KNOWN
geometry — so every assertion is a measured number, not "it ran".

forest-plot.xyz (backend-api/tests/synthetic_trees.py): three stems on the
plane z = 100 + 0.15 x - 0.08 y:
    base (0, 0)    dbh 0.36 m  height 12 m  lean 0
    base (7, 1)    dbh 0.24 m  height 10 m  lean 6 deg
    base (2, 7.5)  dbh 0.30 m  height 11 m  lean 0
"""
from __future__ import annotations

import numpy as np
import pytest

import phytograph as pg
from conftest import E2E_FIXTURES

STEMS = [  # (x, y, dbh, height)
    (0.0, 0.0, 0.36, 12.0),
    (7.0, 1.0, 0.24, 10.0),
    (2.0, 7.5, 0.30, 11.0),
]


def plane_z(x, y):
    return 100 + 0.15 * x - 0.08 * y


PLANE_NORMAL = np.array([-0.15, 0.08, 1.0]) / np.linalg.norm([-0.15, 0.08, 1.0])


@pytest.fixture(scope="module")
def plot(backend):
    """The forest plot, ground- and tree-segmented once for the module."""
    c = backend.open(E2E_FIXTURES / "forest-plot.xyz")
    c.segment_ground()
    c.segment_trees()
    yield c
    c.close()


def _nearest_stem(xy):
    d = [np.hypot(xy[0] - sx, xy[1] - sy) for sx, sy, _, _ in STEMS]
    return int(np.argmin(d)), float(min(d))


def test_defaults_are_seeded_from_the_extent(backend, forest_plot):
    with backend.open(forest_plot) as c:
        d = c.defaults()
        ext = max(d["robust_extent"][:2])
        assert 11 < ext < 14
        # Flat-terrain branch: cloth = threshold = extent / 100 (contract JSON).
        assert d["ground"]["cloth_resolution"] == pytest.approx(round(ext / 100, 3), abs=1e-3)
        assert d["ground"]["rigidness"] == 3
        assert d["dem"]["cell_size"] == pytest.approx(round(ext / 100, 3), abs=1e-3)
        # A small plot clamps TreeIso to the paper defaults.
        assert d["trees"] == {"decimate_res1": 0.05, "decimate_res2": 0.1,
                              "max_gap": 2.0, "max_outlier_gap": 0.65}


def test_ground_lies_on_the_plane(backend, forest_plot):
    with backend.open(forest_plot) as c:
        res = c.segment_ground()
        tol = res["class_threshold_used"]
        data = c.to_numpy(fields=["ground_class"], colors=False)
    xyz, cls = data["positions"], data["ground_class"]
    resid = xyz[:, 2] - plane_z(xyz[:, 0], xyz[:, 1])
    ground = cls == pg.GROUND
    assert ground.sum() > 500
    # Ground is what lies within the class threshold of the cloth, and the
    # cloth must have settled onto the true plane for that to hold. Right at a
    # trunk the cloth rides up the stem base and takes its lowest points as
    # ground (normal CSF behavior), so the open terrain is what is checked.
    stem_dist = np.min([np.hypot(xyz[:, 0] - sx, xyz[:, 1] - sy) for sx, sy, _, _ in STEMS], axis=0)
    open_ground = ground & (stem_dist > 0.4)
    assert np.mean(np.abs(resid[open_ground]) <= tol + 0.01) > 0.99
    # Anything a metre above the terrain is stem, never ground.
    assert np.mean(cls[resid > 1.0] == pg.NON_GROUND) > 0.99


def test_normals_on_the_ground_match_the_plane(backend, forest_plot):
    with backend.open(forest_plot) as c:
        c.segment_ground()
        info = c.compute_normals()
        assert set(["nx", "ny", "nz"]) <= set(info["columns"])
        d = c.to_numpy(fields=["nx", "ny", "nz", "ground_class"], colors=False)
        g = d["ground_class"] == pg.GROUND
        n = np.column_stack([d["nx"], d["ny"], d["nz"]])[g]
        angle = np.degrees(np.arccos(np.clip(np.abs(n @ PLANE_NORMAL), 0, 1)))
        assert np.median(angle) < 3.0


def test_dem_matches_the_terrain_in_world_coordinates(backend, forest_plot):
    """With a large import shift too: the grid comes back in world coordinates."""
    shift = [400_000.0, 4_000_000.0, 50.0]
    with backend.open(forest_plot, world_shift=shift) as c:
        dem = c.dem(add_height_column=True)
        assert dem.z.shape == (dem.raw["grid_ny"], dem.raw["grid_nx"])
        xy = dem.xy()
        ok = np.isfinite(dem.z)
        assert ok.mean() > 0.8
        err = dem.z[ok] - plane_z(xy[..., 0][ok], xy[..., 1][ok])
        assert np.median(np.abs(err)) < 0.05
        # Height above ground at each stem's top ~ its height.
        d = c.to_numpy(fields=["height_above_ground"], colors=False)
        hag = d["height_above_ground"]
        assert 11.0 < hag.max() < 12.5
        assert dem.mesh is not None and dem.mesh.area > 100


def test_dem_writes_a_georeferenced_raster(backend, forest_plot, tmp_path):
    with backend.open(forest_plot) as c:
        dem = c.dem()
        asc = dem.to_raster(tmp_path / "dem.asc")
        head = dict(line.split()[:2] for line in asc.read_text().splitlines()[:6])
        assert int(head["ncols"]) == dem.z.shape[1] and int(head["nrows"]) == dem.z.shape[0]
        assert float(head["xllcorner"]) == pytest.approx(dem.origin[0], abs=1e-6)
        assert float(head["cellsize"]) == pytest.approx(dem.cell_size)
        tif = dem.to_raster(tmp_path / "dem.tif")
        assert tif.read_bytes()[:2] in (b"II", b"MM")


def test_detect_stems_finds_the_three_trunks(plot):
    # Stem detection slices at breast height ABOVE THE TERRAIN, so it needs
    # height_above_ground — as in the app, a DEM with that column comes first.
    plot.dem(add_height_column=True)
    seeds = plot.detect_stems()
    assert len(seeds) == 3
    for s in seeds:
        _, dist = _nearest_stem(s)
        assert dist < 0.5


def test_trees_split_into_the_three_stems(plot):
    trees = plot.split("tree_instance")
    try:
        big = {k: t for k, t in trees.items() if len(t) > 500}
        assert len(big) == 3
        found = sorted(_nearest_stem(t.positions.mean(0)[:2])[0] for t in big.values())
        assert found == [0, 1, 2]
    finally:
        for t in trees.values():
            t.close()


def test_inventory_measures_dbh_and_height(plot, tmp_path):
    inv = plot.tree_inventory()
    assert len(inv) == 3
    for tree in inv.trees:
        i, dist = _nearest_stem(tree["stem_base"][:2])
        _, _, dbh, height = STEMS[i]
        assert dist < 0.3
        assert tree["dbh_m"] == pytest.approx(dbh, abs=0.02)
        assert tree["height_m"] == pytest.approx(height, abs=0.5)
    out = inv.to_csv(tmp_path / "trees.csv")
    lines = out.read_text().splitlines()
    assert len(lines) == 4 and "dbh_m" in lines[0].split(",")


def test_per_tree_qsms_measure_the_trunks(plot, tmp_path):
    qsms = plot.tree_qsms()
    by_stem = {}
    for tid, q in qsms.items():
        if len(q) < 10:
            continue
        base = q.cylinders[0]
        start = base.get("start") or base.get("p0") or base.get("start_point")
        assert start is not None, list(base)
        i, _ = _nearest_stem(start[:2])
        by_stem[i] = q
    assert sorted(by_stem) == [0, 1, 2]
    for i, q in by_stem.items():
        _, _, dbh, height = STEMS[i]
        assert q.metrics["trunk_diameter_mm"] / 1000 == pytest.approx(dbh, rel=0.15)
        assert q.metrics["tree_height_m"] == pytest.approx(height, abs=0.75)
    out = by_stem[0].to_csv(tmp_path / "qsm.csv")
    assert len(out.read_text().splitlines()) == len(by_stem[0]) + 1


def test_single_tree_tools(plot, tmp_path):
    trees = plot.split("tree_instance")
    try:
        tree = max(trees.values(), key=len)       # the 12 m, 0.36 m stem at (0, 0)
        q = tree.qsm()
        assert q.metrics["tree_height_m"] == pytest.approx(12.0, abs=0.75)

        sk = tree.skeleton()
        assert len(sk.points) > 10 and sk.edges.max() < len(sk.points)
        # On the trunk axis, from the base up. (The skeleton's block filter
        # drops this fixture's sparser top ~4 m, where the stem has a third of
        # the point density — a property of the extractor, not of the client.)
        assert np.all(np.hypot(sk.points[:, 0], sk.points[:, 1]) < 0.5)
        assert sk.points[:, 2].min() < plane_z(0, 0) + 0.5
        assert sk.points[:, 2].max() - sk.points[:, 2].min() > 6

        mesh = tree.triangulate(method="alpha_shape")
        assert len(mesh.faces) > 1000 and mesh.faces.max() < len(mesh.vertices)
        # A 0.36 m x 12 m cylinder's lateral area is ~13.6 m²; the visible
        # shell of the mesh is the same order.
        assert 5 < mesh.area < 30
        ply = mesh.to_ply(tmp_path / "tree.ply")
        assert f"element vertex {len(mesh.vertices)}" in ply.read_bytes()[:300].decode("ascii", "replace")
        obj = mesh.to_obj(tmp_path / "tree.obj")
        txt = obj.read_text()
        assert txt.count("\nv ") == len(mesh.vertices) and txt.count("\nf ") == len(mesh.faces)

        crown = tree.fit_crown("ellipsoid")
        assert crown["crowns"] and crown["crowns"][0].get("vertices")
    finally:
        for t in trees.values():
            t.close()


def test_icp_recovers_a_known_offset(backend, forest_plot):
    with backend.open(forest_plot) as target, backend.open(forest_plot) as moving:
        moving.translate(0.3, -0.2, 0.1)
        reg = moving.register_to(target)
        np.testing.assert_allclose(reg.matrix[:3, 3], [-0.3, 0.2, -0.1], atol=1e-3)
        np.testing.assert_allclose(moving.positions.mean(0), target.positions.mean(0), atol=1e-3)


def test_wood_segmentation_labels_the_stems_wood(plot):
    plot.segment_wood()
    d = plot.to_numpy(fields=["wood_class", "tree_instance"], colors=False)
    on_tree = d["tree_instance"] > 0
    assert set(np.unique(d["wood_class"][on_tree])) <= {pg.WOOD, pg.LEAF}
    # Bare synthetic stems: the large majority must read as wood.
    assert np.mean(d["wood_class"][on_tree] == pg.WOOD) > 0.8


def test_denoise_flags_the_far_halo(backend):
    path = E2E_FIXTURES / "outlier-halo.xyz"
    with backend.open(path) as c:
        c.denoise(method="sor")
        d = c.to_numpy(fields=["noise_class"], colors=False)
        xyz, noise = d["positions"], d["noise_class"]
        far = np.abs(xyz[:, :2]).max(axis=1) > 20
        assert far.sum() > 0
        assert np.all(noise[far] == pg.NOISE)
        assert np.mean(noise[~far] == pg.NOISE_CLEAN) > 0.95
        c.filter(where={"noise_class": [pg.NOISE_CLEAN]})
        assert np.abs(c.positions[:, :2]).max() < 20


def test_lad_recovers_the_leaf_cube(backend):
    """The lidar plugin's leaf cube: LAD = 2 m²/m³ throughout the 1 m voxel at
    (0, 0, 0.5), G(θ) = 0.5 (spherical leaves). Misses are kept for LAD."""
    path = E2E_FIXTURES / "lad-leafcube" / "leafcube.xyz"
    with backend.open(path, ascii_format="x y z is_miss", origin=[-5, 0, 0.5]) as c:
        assert c.info()["row_count"] > len(c)       # misses present, not counted as hits
        scan = pg.Scan(c, origin=[-5, 0, 0.5], n_theta=2600, n_phi=5200)
        grid = pg.Grid(center=[0, 0, 0.5], size=[1, 1, 1], n=[2, 2, 2])
        res = backend.lad([scan], grid, lmax=0.04, max_aspect_ratio=10, min_voxel_hits=1)
        assert res.lad.shape == (2, 2, 2) and np.isfinite(res.lad).all()
        assert np.nanmean(res.lad) == pytest.approx(2.0, rel=0.2)
        assert res.total_leaf_area == pytest.approx(2.0, rel=0.2)
        for cell in res.cells:   # each voxel is placed where its center says
            ix, iy, iz = (int((cell["center"][k] - [-0.5, -0.5, 0][k]) // 0.5) for k in range(3))
            assert res.lad[ix, iy, iz] == pytest.approx(cell["lad"])


def test_cost_gate_confirms_by_default_and_can_refuse(forest_plot):
    """With the cost guideline at 0 s every gated run warns. A script confirms
    by default; confirm_costly=False surfaces the backend's estimate instead."""
    env = {"PHYTOGRAPH_COST_WARNING_SECONDS": "0"}
    with pg.Backend(source="dev", env=env, confirm_costly=False) as strict:
        with strict.open(forest_plot) as c:
            with pytest.raises(pg.CostWarning) as e:
                c.compute_normals()
            assert isinstance(e.value.detail, dict) and e.value.detail.get("message")
            assert "nx" not in c.columns
    with pg.Backend(source="dev", env=env) as lenient:
        with lenient.open(forest_plot) as c:
            c.compute_normals()
            assert "nx" in c.columns


def test_every_tool_reports_world_coordinates_under_a_large_shift(backend, forest_plot):
    """The backend stores positions with the import shift subtracted, and a few
    tools report in that stored frame (stem seeds). Every result reaching a
    script must be in world coordinates regardless — compared here against the
    same cloud imported with no shift."""
    shift = np.array([400_000.0, 4_000_000.0, 50.0])

    def run(world_shift):
        c = backend.open(forest_plot, world_shift=world_shift)
        try:
            c.segment_ground()
            c.dem(add_height_column=True)
            seeds = c.detect_stems()
            c.segment_trees(seeds=seeds)
            inv = c.tree_inventory()
            trees = c.split("tree_instance")
            tree = max(trees.values(), key=len)
            out = {
                "seeds": np.sort(seeds, axis=0),
                "stem_base": np.sort([t["stem_base"] for t in inv.trees], axis=0),
                "skeleton": tree.skeleton().points.mean(0),
                "mesh": tree.triangulate(method="alpha_shape").vertices.mean(0),
                "qsm": np.asarray(tree.qsm().cylinders[0]["start"]),
                "n_trees": len([t for t in trees.values() if len(t) > 500]),
            }
            for t in trees.values():
                t.close()
            return out
        finally:
            c.close()

    plain, shifted = run(None), run(shift.tolist())
    assert plain["n_trees"] == shifted["n_trees"] == 3   # seeds were honored in both frames
    for key in ("seeds", "stem_base", "skeleton", "mesh", "qsm"):
        # LAS-quantum differences only (1 mm per coordinate at import).
        np.testing.assert_allclose(shifted[key], plain[key], atol=0.02, err_msg=key)


@pytest.mark.skipif(__import__("sys").platform == "win32", reason="sends SIGINT to itself")
def test_ctrl_c_during_a_tool_cancels_it_in_the_engine(backend, forest_plot):
    """Ground/trees/wood/normals/denoise answer with no progress stream; the
    backend runs them in a killable worker that it SIGKILLs when the client
    disconnects. So Ctrl-C must leave no result behind — checked by waiting
    well past the run's own duration and finding no column."""
    import os
    import signal
    import threading
    import time

    with backend.open(forest_plot) as c:
        c.segment_ground()
        t0 = time.monotonic()
        c.segment_trees()
        full = time.monotonic() - t0
        assert "tree_instance" in c.columns

    with backend.open(forest_plot) as c:
        c.segment_ground()
        # A real SIGINT, as Ctrl-C sends: it interrupts the blocking socket
        # read. (`_thread.interrupt_main` can't; it fires only once the
        # response has arrived, which would test nothing.)
        timer = threading.Timer(full / 4, lambda: os.kill(os.getpid(), signal.SIGINT))
        timer.start()
        t1 = time.monotonic()
        try:
            with pytest.raises(KeyboardInterrupt):
                c.segment_trees()
        finally:
            timer.cancel()
        assert time.monotonic() - t1 < full * 0.75, "the interrupt landed after the run finished"
        time.sleep(full * 2 + 1)
        assert "tree_instance" not in c.columns
        assert backend.health()["status"] == "healthy"
