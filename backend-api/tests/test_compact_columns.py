"""Whole-number scalar columns are stored in their narrowest integer type.

Storage only: every value must read back exactly as before, the octree and
exports must still carry the same float32 values, and a write that would not
fit must WIDEN the column - never wrap it (numpy's setitem cast would turn 256
into 0 in a uint8 column without a word).
"""
import time

import numpy as np
import pytest

import main
from tests.binframe import decode_streamed_json


class TestCompactColumn:
    @pytest.mark.parametrize("vals,dtype", [
        ([0, 1, 2], np.uint8),
        ([-1, 0, 5], np.int8),            # the grid-index "no cell" sentinel
        ([0, 300], np.uint16),
        ([-1, 1000], np.int16),
        ([0, 70000], np.uint32),
        ([-1, 70000], np.int32),
        ([0, 1.5], np.float32),           # not whole
        ([0, np.nan], np.float32),        # NaN has no integer
        ([0, 2 ** 33], np.float32),       # beyond int32: left as it was
    ])
    def test_narrowest_exact_type(self, vals, dtype):
        a = np.array(vals, dtype=np.float32 if max(np.abs(np.nan_to_num(vals))) < 2 ** 24 else np.float64)
        out = main._compact_column(a)
        assert out.dtype == np.dtype(dtype)
        assert np.array_equal(out.astype(np.float64), a.astype(np.float64), equal_nan=True)

    def test_already_compact_is_returned_as_is(self):
        a = np.array([1, 2, 3], dtype=np.uint8)
        assert main._compact_column(a) is a

    def test_memmap_column_is_scanned_in_blocks(self, tmp_path, monkeypatch):
        monkeypatch.setattr(main, "_COMPACT_SCAN_ROWS", 1000)
        m = np.lib.format.open_memmap(tmp_path / "c.npy", mode="w+", dtype=np.float32, shape=(10_500,))
        m[:] = 2
        m[-1] = 2.5   # the last block decides
        assert main._compact_column(m).dtype == np.float32
        m[-1] = 7
        assert main._compact_column(m).dtype == np.uint8


def _session(extras, n=None, sid="cc"):
    n = n or len(next(iter(extras.values())))
    rng = np.random.default_rng(0)
    sess = main.CloudSession(
        session_id=sid, source_path="<t>", ascii_format=None, column_plan=None,
        positions=rng.uniform(0, 1, (n, 3)), colors=None, intensity=None,
        extras=dict(extras), extra_dims_meta=[{"slug": k, "label": k} for k in extras],
        deleted=np.zeros(n, bool), deleted_history=[], octree_cache_id=None, created_at=time.time())
    return sess


class TestWiden:
    def test_a_paint_beyond_the_type_widens_instead_of_wrapping(self):
        sess = _session({"tree_instance": np.zeros(10, np.uint8)})
        col = main._column_widen_for_locked(sess, "tree_instance", np.array([70000]))
        assert col.dtype == np.uint32 and sess.extras["tree_instance"] is col
        col[3] = 70000
        assert int(sess.extras["tree_instance"][3]) == 70000

    def test_negative_into_unsigned_goes_signed(self):
        sess = _session({"row_index": np.arange(10, dtype=np.uint8)})
        col = main._column_widen_for_locked(sess, "row_index", np.array([-1]))
        assert col.dtype == np.int8
        assert np.array_equal(col, np.arange(10))

    def test_values_that_fit_leave_the_column_alone(self):
        a = np.zeros(10, np.uint8)
        sess = _session({"c": a})
        assert main._column_widen_for_locked(sess, "c", np.array([5, 255])) is a

    def test_a_fraction_makes_it_float(self):
        sess = _session({"c": np.arange(10, dtype=np.uint8)})
        assert main._column_widen_for_locked(sess, "c", np.array([0.5])).dtype == np.float32


def test_add_extra_column_compacts_and_keeps_floats():
    sess = _session({"x": np.zeros(6, np.float32)})
    sess.deleted[:] = [False, False, True, False, False, False]
    with main._cloud_session_lock:
        main._session_add_extra_column(sess, "ground_class", "Ground", np.array([1, 2, 1, 2, 1]))
        main._session_add_extra_column(sess, "height_above_ground", "HAG", np.array([0.1, 2.5, 0, 3, 1.25]))
    g = sess.extras["ground_class"]
    assert g.dtype == np.uint8 and g.tolist() == [1, 2, 0, 1, 2, 1]
    assert sess.extras["height_above_ground"].dtype == np.float32


@pytest.fixture
def cache_root(tmp_path, monkeypatch):
    root = tmp_path / "octree_cache"
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(root))
    return root


@pytest.mark.parametrize("store_backed", [False, True])
def test_import_stores_whole_number_columns_narrow(client, cache_root, tmp_path, monkeypatch, store_backed):
    monkeypatch.setenv("PHYTOGRAPH_SESSION_STORE_MIN_POINTS", "1" if store_backed else "100000000")
    n = 400
    rng = np.random.default_rng(3)
    cls = rng.integers(0, 4, n)
    row = rng.integers(-1, 300, n)      # -1 sentinel, beyond int8
    refl = rng.uniform(-20, 0, n)   # fractional: must stay float32
    f = tmp_path / "c.xyz"
    np.savetxt(f, np.column_stack([rng.uniform(0, 5, (n, 3)), cls, row, refl]), fmt="%.6f")
    created = decode_streamed_json(client.post("/api/cloud/session/create", json={
        "source_path": str(f), "ascii_format": "x y z classcol rowcol heightcol"}).content)
    sess = main._cloud_sessions[created["session_id"]]
    by_name = {ed["label"].lower(): ed["slug"] for ed in sess.extra_dims_meta}
    cslug = next(s for s in sess.extras if "class" in s.lower())
    rslug = next(s for s in sess.extras if "row" in s.lower())
    assert sess.extras[cslug].dtype == np.uint8
    assert sess.extras[rslug].dtype == np.int16
    assert np.array_equal(np.asarray(sess.extras[cslug]), cls)
    assert np.array_equal(np.asarray(sess.extras[rslug]), row)
    floats = [s for s, a in sess.extras.items() if a.dtype.kind == "f"]
    assert floats, "the fractional column must stay float32"
    if store_backed:
        assert sess.store.is_own(sess.store.column_name_of(sess.extras[cslug]), sess.extras[cslug])
    # The octree source still carries float32 values equal to the column.
    las = tmp_path / "o.las"
    with main._cloud_session_lock:
        main._session_to_las(sess, las)
    import laspy
    rd = laspy.read(str(las))
    assert np.array_equal(np.asarray(rd[cslug], dtype=np.float64), cls.astype(np.float64))
    del by_name


EVERYWHERE = {"kind": "box", "min": [-100, -100, -100], "max": [100, 100, 100]}


def test_painting_an_instance_id_widens_and_undo_restores(client, cache_root, tmp_path):
    f = tmp_path / "p.xyz"
    rng = np.random.default_rng(1)
    np.savetxt(f, rng.uniform(0, 1, (50, 3)), fmt="%.6f")
    sid = decode_streamed_json(client.post("/api/cloud/session/create", json={
        "source_path": str(f), "ascii_format": "x y z"}).content)["session_id"]
    slug = "tree_instance_ed"
    res = client.post(f"/api/cloud/session/{sid}/label_region", json={
        "slug": "tree_instance", "strokes": [{"region": EVERYWHERE, "to_class": 3, "stroke_id": "a"}]})
    assert res.status_code == 200, res.text
    sess = main._cloud_sessions[sid]
    assert sess.extras["tree_instance"].dtype == np.uint8
    res = client.post(f"/api/cloud/session/{sid}/label_region", json={
        "slug": "tree_instance", "strokes": [{"region": EVERYWHERE, "to_class": 70000, "stroke_id": "b"}]})
    assert res.status_code == 200, res.text
    col = sess.extras["tree_instance"]
    assert col.dtype == np.uint32 and np.all(np.asarray(col) == 70000)
    res = client.post(f"/api/cloud/session/{sid}/reset_label_edits", json={"edit_count": 1, "slug": "tree_instance"})
    assert res.status_code == 200, res.text
    assert np.all(np.asarray(sess.extras["tree_instance"]) == 3)
    del slug


def test_merge_keeps_values_across_types():
    a = _session({"c": np.array([1, 2], np.uint8), "h": np.array([0.5, 1.5], np.float32)}, sid="ma")
    b = _session({"c": np.array([-1, 400], np.int16)}, sid="mb")
    with main._cloud_session_lock:
        merged = main._merge_sessions_locked([a, b])
    m = merged[0] if isinstance(merged, tuple) else merged
    assert m.extras["c"].dtype == np.int16
    assert m.extras["c"].tolist() == [1, 2, -1, 400]
    assert m.extras["h"].dtype == np.float32
    assert m.extras["h"].tolist() == [0.5, 1.5, 0.0, 0.0]


def test_project_round_trip_keeps_types_and_compacts_old_float_columns(tmp_path):
    import io, zipfile
    import project_file as pf
    sess = _session({"c": np.array([0, 1, 2, 1], np.uint8)})
    fields = main._project_session_snapshot(sess)
    fields["extras"]["old"] = np.array([0, 1, 1, 0], np.float32)   # a pre-compaction project
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        pf.write_session(zf, "k", fields)
        pf.write_manifest(zf, app_version="x", sessions=[{"key": "k", "n": 4}], octrees=[])
        zf.writestr("scene.bin", b"")
    buf.seek(0)
    with zipfile.ZipFile(buf) as zf:
        restored = main._project_restore_session(zf, "k")
    assert restored.extras["c"].dtype == np.uint8
    assert restored.extras["old"].dtype == np.uint8
    assert restored.extras["old"].tolist() == [0, 1, 1, 0]


def test_continuous_quantities_stay_float_even_when_whole():
    # A flat plane's normals are exactly 0 and 1; they are still normals.
    flat = np.zeros(10, np.float32)
    for slug, _l in main.normals_mod.COLUMNS:
        assert main._compact_column(flat, slug).dtype == np.float32
    assert main._compact_column(np.full(4, 3.5e8, np.float64), "timestamp").dtype == np.float32
    assert main._compact_column(np.zeros(4, np.float32), main.HEIGHT_ABOVE_GROUND_SLUG).dtype == np.float32
    # Any other slug with whole numbers compacts.
    assert main._compact_column(flat, "ground_class").dtype == np.uint8
