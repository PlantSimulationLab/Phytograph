"""Streaming readers: PCD (ascii/binary) keeps every field and streams; every
converted format keeps the SOURCE's precision in the session positions (the
LAS they write is 1 mm-quantized); positions land straight in their
destination (RAM or the session store) without an extra full copy."""
import struct
import time
import tracemalloc

import laspy
import numpy as np
import pytest

import main


def _cloud(n=5000, seed=0):
    rng = np.random.default_rng(seed)
    # Sub-millimeter detail on UTM-scale coordinates: a 1 mm LAS would lose it.
    xyz = rng.uniform(0, 20, (n, 3)) + [612000.0, 4270000.0, 100.0]
    xyz += rng.uniform(0, 1e-3, (n, 3))
    rgb = rng.integers(0, 256, (n, 3))
    inten = rng.uniform(-20, 0, n)
    normals = rng.normal(size=(n, 3))
    normals /= np.linalg.norm(normals, axis=1, keepdims=True)
    curv = rng.uniform(0, 1, n)
    return xyz, rgb, inten, normals, curv


def _write_pcd(path, xyz, rgb, inten, normals, curv, *, binary, nan_rows=(), extra_count_field=False):
    n = len(xyz)
    xyz = xyz.copy()
    for i in nan_rows:
        xyz[i] = np.nan
    packed = ((rgb[:, 0].astype(np.uint32) << 16) | (rgb[:, 1].astype(np.uint32) << 8)
              | rgb[:, 2].astype(np.uint32))
    rgb_f = packed.view(np.float32)
    fields = ["x", "y", "z", "rgb", "intensity", "normal_x", "normal_y", "normal_z", "curvature"]
    sizes = ["8", "8", "8", "4", "4", "4", "4", "4", "4"]
    types = ["F"] * 9
    counts = ["1"] * 9
    if extra_count_field:
        fields.append("fpfh")
        sizes.append("4")
        types.append("F")
        counts.append("3")
    hdr = ("# .PCD v0.7\nVERSION 0.7\n"
           f"FIELDS {' '.join(fields)}\nSIZE {' '.join(sizes)}\nTYPE {' '.join(types)}\n"
           f"COUNT {' '.join(counts)}\nWIDTH {n}\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\n"
           f"POINTS {n}\nDATA {'binary' if binary else 'ascii'}\n")
    with open(path, "wb") as f:
        f.write(hdr.encode())
        if binary:
            parts = [("x", "<f8"), ("y", "<f8"), ("z", "<f8"), ("rgb", "<f4"), ("intensity", "<f4"),
                     ("normal_x", "<f4"), ("normal_y", "<f4"), ("normal_z", "<f4"), ("curvature", "<f4")]
            if extra_count_field:
                parts.append(("fpfh", "<f4", (3,)))
            rec = np.zeros(n, dtype=parts)
            rec["x"], rec["y"], rec["z"] = xyz[:, 0], xyz[:, 1], xyz[:, 2]
            rec["rgb"], rec["intensity"] = rgb_f, inten
            rec["normal_x"], rec["normal_y"], rec["normal_z"] = normals.T
            rec["curvature"] = curv
            f.write(rec.tobytes())
        else:
            for i in range(n):
                row = [repr(float(v)) for v in xyz[i]] + [repr(float(rgb_f[i])), repr(float(np.float32(inten[i])))]
                row += [repr(float(np.float32(v))) for v in normals[i]] + [repr(float(np.float32(curv[i])))]
                if extra_count_field:
                    row += ["0.1", "0.2", "0.3"]
                f.write((" ".join(row) + "\n").encode())


@pytest.mark.parametrize("binary", [True, False])
def test_pcd_keeps_fields_precision_and_drops_nan_rows(tmp_path, binary):
    xyz, rgb, inten, normals, curv = _cloud()
    src = tmp_path / ("b.pcd" if binary else "a.pcd")
    _write_pcd(src, xyz, rgb, inten, normals, curv, binary=binary, nan_rows=(3, 99))
    las_path, _tmp, extra_dims, full_xyz, _o = main._source_to_las(src, None, tmp_path, None)
    keep = np.ones(len(xyz), bool)
    keep[[3, 99]] = False
    # Full precision: the float64 source coordinates - bit-exact from binary;
    # from ASCII to the parser's last bit (~1e-10 m here), far below 1 mm.
    assert full_xyz.shape == (keep.sum(), 3)
    if binary:
        assert np.array_equal(full_xyz, xyz[keep])
    else:
        assert np.allclose(full_xyz, xyz[keep], rtol=0, atol=1e-8)
    slugs = {d["slug"] for d in extra_dims}
    assert {"nx", "ny", "nz", "curvature"} <= slugs
    las = laspy.read(str(las_path))
    assert len(las.points) == keep.sum()
    assert np.array_equal(np.asarray(las.red) // 256, rgb[keep, 0])
    assert np.array_equal(np.asarray(las.blue) // 256, rgb[keep, 2])
    assert np.allclose(np.asarray(las["curvature"]), curv[keep], atol=1e-6)
    assert np.allclose(np.asarray(las["nx"]), normals[keep, 0], atol=1e-6)
    # Intensity mapped by its global range: brightest point -> 65535.
    assert int(np.asarray(las.intensity)[np.argmax(inten[keep])]) == 65535


def test_ascii_and_binary_pcd_agree(tmp_path):
    xyz, rgb, inten, normals, curv = _cloud(n=500)
    a, b = tmp_path / "a.pcd", tmp_path / "b.pcd"
    _write_pcd(a, xyz, rgb, inten, normals, curv, binary=False)
    _write_pcd(b, xyz, rgb, inten, normals, curv, binary=True)
    ra = main._source_to_las(a, None, tmp_path / "a", None) if (tmp_path / "a").mkdir() is None else None
    rb = main._source_to_las(b, None, tmp_path / "b", None) if (tmp_path / "b").mkdir() is None else None
    assert np.allclose(ra[3], rb[3], rtol=0, atol=1e-8)
    la, lb = laspy.read(str(ra[0])), laspy.read(str(rb[0]))
    for dim in ("red", "green", "blue", "intensity", "nx", "curvature"):
        assert np.allclose(np.asarray(la[dim], dtype=float), np.asarray(lb[dim], dtype=float), atol=1e-6), dim


def test_pcd_multi_count_field_is_skipped_not_fatal(tmp_path):
    xyz, rgb, inten, normals, curv = _cloud(n=200)
    src = tmp_path / "f.pcd"
    _write_pcd(src, xyz, rgb, inten, normals, curv, binary=True, extra_count_field=True)
    _las, _t, extra_dims, full_xyz, _o = main._source_to_las(src, None, tmp_path, None)
    assert np.array_equal(full_xyz, xyz)
    assert not any("fpfh" in d["slug"] for d in extra_dims)


def test_truncated_binary_pcd_is_a_clear_error(tmp_path):
    xyz, rgb, inten, normals, curv = _cloud(n=100)
    src = tmp_path / "t.pcd"
    _write_pcd(src, xyz, rgb, inten, normals, curv, binary=True)
    data = src.read_bytes()
    src.write_bytes(data[:-50])
    with pytest.raises(main.HTTPException) as e:
        main._source_to_las(src, None, tmp_path, None)
    assert "truncated" in e.value.detail


def test_ply_positions_keep_sub_millimeter_precision(tmp_path):
    from plyfile import PlyData, PlyElement
    xyz, *_ = _cloud(n=1000)
    v = np.zeros(len(xyz), dtype=[("x", "f8"), ("y", "f8"), ("z", "f8")])
    v["x"], v["y"], v["z"] = xyz.T
    src = tmp_path / "p.ply"
    PlyData([PlyElement.describe(v, "vertex")]).write(str(src))
    _las, _t, _e, full_xyz, _o = main._source_to_las(src, None, tmp_path, None)
    assert np.array_equal(full_xyz, xyz)


@pytest.fixture
def cache_root(tmp_path, monkeypatch):
    root = tmp_path / "octree_cache"
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(root))
    return root


@pytest.mark.parametrize("fmt", ["xyz", "pcd", "ply"])
@pytest.mark.parametrize("store_backed", [False, True])
def test_session_positions_are_the_source_at_full_precision(client, cache_root, tmp_path,
                                                           monkeypatch, fmt, store_backed):
    from tests.binframe import decode_streamed_json
    monkeypatch.setenv("PHYTOGRAPH_SESSION_STORE_MIN_POINTS", "1" if store_backed else "100000000")
    xyz, rgb, inten, normals, curv = _cloud(n=3000)
    if fmt == "xyz":
        src = tmp_path / "c.xyz"
        np.savetxt(src, xyz, fmt="%.9f")
        body = {"source_path": str(src), "ascii_format": "x y z"}
    elif fmt == "pcd":
        src = tmp_path / "c.pcd"
        _write_pcd(src, xyz, rgb, inten, normals, curv, binary=True)
        body = {"source_path": str(src)}
    else:
        from plyfile import PlyData, PlyElement
        v = np.zeros(len(xyz), dtype=[("x", "f8"), ("y", "f8"), ("z", "f8")])
        v["x"], v["y"], v["z"] = xyz.T
        src = tmp_path / "c.ply"
        PlyData([PlyElement.describe(v, "vertex")]).write(str(src))
        body = {"source_path": str(src)}
    created = decode_streamed_json(client.post("/api/cloud/session/create", json=body).content)
    sess = main._cloud_sessions[created["session_id"]]
    tol = 1e-8 if fmt == "xyz" else 0.0   # the text round-trips to 9 decimals
    assert np.allclose(np.asarray(sess.positions), xyz, rtol=0, atol=tol)
    if store_backed:
        assert sess.store is not None and isinstance(sess.positions, np.memmap)
        # The sink's own column, not a replaced copy.
        assert sess.store.is_own("positions", sess.positions)
    if fmt == "pcd":
        assert {"nx", "ny", "nz", "curvature"} <= set(sess.extras)


def test_xyz_conversion_holds_one_copy_of_the_positions(tmp_path):
    """The full-precision positions used to be gathered as chunks AND
    concatenated (two copies at the peak); now they are written into place."""
    n = 1_500_000
    rng = np.random.default_rng(1)
    xyz = rng.uniform(0, 100, (n, 3))
    src = tmp_path / "big.xyz"
    np.savetxt(src, xyz, fmt="%.6f")
    tracemalloc.start()
    try:
        _las, _t, _e, full_xyz, _o = main._source_to_las(src, "x y z", tmp_path, None)
        _cur, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    positions_bytes = n * 3 * 8
    assert full_xyz.shape == (n, 3)
    # One copy of the positions plus a bounded chunk working set, well under
    # the two copies (and a concatenate) the old path held.
    assert peak < 1.5 * positions_bytes + 256 * 2 ** 20, peak / positions_bytes


def test_ptx_blocks_decode_straight_into_their_session_store(client, cache_root, tmp_path, monkeypatch):
    """create-multi on a two-block PTX: with the store threshold at 1 every
    block's arrays are allocated IN its session store (the columns are the
    store's own maps) and the sessions match an in-RAM import exactly."""
    from tests.binframe import decode_streamed_json
    from tests.test_ptx_import import _write_ptx, _simple, _pose
    z0, a0 = _simple(30, 40)
    z1, a1 = _simple(20, 50, zen_lo=70.0, zen_hi=100.0)
    m0 = np.zeros((30, 40), bool); m0[5:8, 6:9] = True
    src = _write_ptx(
        tmp_path / "two.ptx",
        dict(zen=z0, az=a0, rng=np.full((30, 40), 5.0), pose=_pose(t=(1.0, 2.0, 0.5)), miss_mask=m0),
        dict(zen=z1, az=a1, rng=np.full((20, 50), 7.0), pose=_pose(yaw=30.0, t=(10.0, -3.0, 0.2))),
    )

    def run(threshold):
        monkeypatch.setenv("PHYTOGRAPH_SESSION_STORE_MIN_POINTS", threshold)
        res = decode_streamed_json(client.post(
            "/api/cloud/session/create-multi", json={"source_path": str(src)}).content)
        return [main._cloud_sessions[s["session"]["session_id"]] for s in res["scans"]]

    ram = run("100000000")
    stored = run("1")
    assert len(ram) == len(stored) == 2
    for a, b in zip(ram, stored):
        assert a.store is None
        assert b.store is not None and b.store.is_own("positions", b.positions)
        assert np.array_equal(np.asarray(a.positions), np.asarray(b.positions))
        assert list(a.extras) == list(b.extras)
        for k in a.extras:
            assert np.array_equal(np.asarray(a.extras[k]), np.asarray(b.extras[k])), k
        if a.intensity is not None:
            assert np.array_equal(np.asarray(a.intensity), np.asarray(b.intensity))
