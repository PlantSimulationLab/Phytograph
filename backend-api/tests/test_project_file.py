"""The .phyto container: exact round trips, streaming, and refusal of
anything a Phytograph writer would not have produced."""
import io
import json
import zipfile

import numpy as np
import pytest

import project_file as pf


def _fields(n=1000, seed=0):
    rng = np.random.default_rng(seed)
    deleted = np.zeros(n, bool)
    deleted[::7] = True
    return {
        "positions": rng.normal(size=(n, 3)) * 1000.0 + 612000.0,
        "colors": rng.integers(0, 65535, size=(n, 3), dtype=np.uint16),
        "intensity": rng.integers(0, 65535, size=n, dtype=np.uint16),
        "deleted": deleted,
        "timestamps": rng.uniform(0, 1e6, n),
        "extras": {"tree_instance": rng.integers(0, 9, n).astype(np.float32),
                   "height_above_ground": rng.uniform(0, 30, n).astype(np.float32)},
        "world_shift": np.array([612000.0, 4270000.0, 0.0]),
        "deleted_history": [np.array([0, 7, 14]), np.array([21])],
        "label_history": {"manual_class": [
            {"stroke_id": "s1", "encoding": "sparse", "changed_count": 2,
             "idx": np.array([3, 5]), "prev": np.array([0, 1], np.uint8)},
            {"stroke_id": "s2", "encoding": "runs", "changed_count": 10,
             "starts": np.array([10]), "lengths": np.array([10]), "prev": np.array([2], np.uint8)},
        ]},
        "backfilled_misses": {"positions": rng.normal(size=(50, 3)),
                              "directions": rng.normal(size=(50, 3)).astype(np.float32)},
        "source_path": "/data/plot.laz", "ascii_format": None,
        "column_plan": {"columns": [{"role": "x"}]},
        "extra_dims_meta": [{"slug": "tree_instance", "label": "Tree instance"}],
        "crs_epsg": 32610, "octree_cache_id": "ab" * 20, "normals_stale": True,
        "derived_fields": {"hag2": "height_above_ground * 2"}, "octree_stale_gen": 3,
    }


def _roundtrip(fields, allocate=None):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", allowZip64=True) as zf:
        entry = pf.write_session(zf, "s0", fields)
        pf.write_manifest(zf, app_version="0.0.0", sessions=[entry], octrees=[])
    buf.seek(0)
    with zipfile.ZipFile(buf) as zf:
        m = pf.read_manifest(zf)
        return m, pf.read_session(zf, m["sessions"][0]["key"], allocate)


def test_session_round_trips_exactly():
    f = _fields()
    m, g = _roundtrip(f)
    assert m["version"] == pf.FORMAT_VERSION and g["n"] == 1000
    for k in ("positions", "colors", "intensity", "deleted", "timestamps"):
        assert g[k].dtype == f[k].dtype and np.array_equal(g[k], f[k])
    assert list(g["extras"]) == list(f["extras"])
    for s in f["extras"]:
        assert np.array_equal(g["extras"][s], f["extras"][s])
    assert np.array_equal(g["world_shift"], f["world_shift"])
    assert [a.tolist() for a in g["deleted_history"]] == [[0, 7, 14], [21]]
    lh = g["label_history"]["manual_class"]
    assert lh[0]["encoding"] == "sparse" and lh[0]["idx"].tolist() == [3, 5]
    assert lh[1]["starts"].tolist() == [10] and lh[1]["prev"].dtype == np.uint8
    assert np.array_equal(g["backfilled_misses"]["directions"], f["backfilled_misses"]["directions"])
    for k in ("source_path", "column_plan", "extra_dims_meta", "crs_epsg", "octree_cache_id",
              "normals_stale", "derived_fields", "octree_stale_gen"):
        assert g[k] == f[k]


def test_columns_stream_into_a_given_destination(tmp_path):
    f = _fields(n=300_000)
    made = {}

    def allocate(name, shape, dtype):
        a = np.lib.format.open_memmap(tmp_path / f"{name}.npy", mode="w+", dtype=dtype, shape=shape)
        made[name] = a
        return a
    _m, g = _roundtrip(f, allocate)
    assert isinstance(g["positions"], np.memmap) and g["positions"] is made["positions"]
    assert np.array_equal(np.asarray(g["positions"]), f["positions"])
    assert isinstance(g["extras"]["tree_instance"], np.memmap)


def test_memmap_source_is_written_without_a_copy(tmp_path):
    src = np.lib.format.open_memmap(tmp_path / "p.npy", mode="w+", dtype=np.float64, shape=(200_000, 3))
    src[:] = 1.5
    f = _fields(n=200_000)
    f["positions"] = src
    _m, g = _roundtrip(f)
    assert np.all(g["positions"] == 1.5)


def test_refuses_object_arrays_and_foreign_or_newer_files():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        pf.write_manifest(zf, app_version="9", sessions=[], octrees=[])
        bio = io.BytesIO()
        np.save(bio, np.array([{"a": 1}], dtype=object), allow_pickle=True)
        zf.writestr("evil.npy", bio.getvalue())
    buf.seek(0)
    with zipfile.ZipFile(buf) as zf:
        with pytest.raises(pf.ProjectError, match="object"):
            pf.read_npy(zf, "evil.npy")
    with pytest.raises(pf.ProjectError):
        pf.write_npy(zipfile.ZipFile(io.BytesIO(), "w"), "x.npy", np.array([object()], dtype=object))

    def manifest(obj):
        b = io.BytesIO()
        with zipfile.ZipFile(b, "w") as zf:
            zf.writestr(pf.MANIFEST, json.dumps(obj))
        b.seek(0)
        return zipfile.ZipFile(b)
    with pytest.raises(pf.ProjectError, match="newer"):
        pf.read_manifest(manifest({"format": pf.FORMAT, "version": pf.FORMAT_VERSION + 1, "app_version": "9.9"}))
    with pytest.raises(pf.ProjectError, match="not a Phytograph"):
        pf.read_manifest(manifest({"format": "something-else", "version": 1}))
    with pytest.raises(pf.ProjectError, match="invalid name"):
        pf.read_manifest(manifest({"format": pf.FORMAT, "version": 1, "sessions": [{"key": "../../etc"}]}))
    with pytest.raises(pf.ProjectError, match="octree id"):
        pf.read_manifest(manifest({"format": pf.FORMAT, "version": 1, "octrees": ["../x"]}))
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w"):
        pass
    b.seek(0)
    with pytest.raises(pf.ProjectError, match="no manifest"):
        pf.read_manifest(zipfile.ZipFile(b))


def test_truncated_array_is_an_error():
    bio = io.BytesIO()
    np.save(bio, np.arange(1000, dtype=np.float64))
    data = bio.getvalue()[:-100]
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as zf:
        zf.writestr("t.npy", data)
    b.seek(0)
    with zipfile.ZipFile(b) as zf, pytest.raises(pf.ProjectError, match="truncated"):
        pf.read_npy(zf, "t.npy")


def test_octree_copy_and_extract(tmp_path):
    cid = "0123456789abcdef" * 2
    src = tmp_path / "src"
    src.mkdir()
    (src / "metadata.json").write_text('{"points": 5}')
    (src / "octree.bin").write_bytes(b"\x01\x02" * 1000)
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w", allowZip64=True) as zf:
        assert pf.write_octree(zf, cid, src)
        assert not pf.write_octree(zf, "ff" * 16, tmp_path / "missing")
    b.seek(0)
    with zipfile.ZipFile(b) as zf:
        out = tmp_path / "out"
        pf.extract_octree(zf, cid, out)
    assert (out / "octree.bin").read_bytes() == b"\x01\x02" * 1000
    assert (out / "metadata.json").read_text() == '{"points": 5}'


def test_session_with_bad_row_count_is_refused():
    f = _fields(n=100)
    f["extras"]["short"] = np.zeros(10, np.float32)
    with pytest.raises(pf.ProjectError, match="rows"):
        _roundtrip(f)
