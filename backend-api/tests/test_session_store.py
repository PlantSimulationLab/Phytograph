"""The memory-mapped columnar session store.

Contract pinned here: columns round-trip through disk with their dtype and
shape, whole-array numpy code works on the maps unchanged, edits through a
map persist across reopen, a column replace is atomic (a torn write leaves
the previous data, never a half-written file), and the store refuses foreign
versions and unsafe names rather than guessing.
"""
import json
import os
from pathlib import Path

import numpy as np
import pytest

import session_store as ss


def _make(tmp_path, n=1000):
    st = ss.SessionStore.create(tmp_path / "s", n, attrs={"world_shift": [1.0, 2.0, 3.0]})
    rng = np.random.default_rng(0)
    st.add_column("positions", rng.normal(size=(n, 3)))
    st.add_column("intensity", rng.integers(0, 65535, n).astype(np.uint16))
    st.add_column("deleted", np.zeros(n, dtype=bool))
    return st


def test_columns_round_trip_with_dtype_and_shape(tmp_path):
    st = _make(tmp_path)
    pos = np.array(st.column("positions"))
    st.close()
    re = ss.SessionStore.open(tmp_path / "s")
    assert re.n == 1000
    assert re.attrs["world_shift"] == [1.0, 2.0, 3.0]
    assert re.column("positions").dtype == np.float64
    assert re.column("positions").shape == (1000, 3)
    assert re.column("intensity").dtype == np.uint16
    np.testing.assert_array_equal(re.column("positions"), pos)
    assert set(re.columns()) == {"positions", "intensity", "deleted"}


def test_whole_array_numpy_code_works_on_the_maps_and_edits_persist(tmp_path):
    st = _make(tmp_path)
    deleted = st.column("deleted")
    deleted |= st.column("positions")[:, 2] > 1.0        # in-place, like sess.deleted |= mask
    n_deleted = int(deleted.sum())
    assert n_deleted > 0
    survivors = st.column("positions")[~deleted]           # fancy-index copy, like the tools do
    assert survivors.shape == (1000 - n_deleted, 3)
    st.flush()
    st.close()
    re = ss.SessionStore.open(tmp_path / "s")
    assert int(re.column("deleted").sum()) == n_deleted


def test_allocate_then_fill_in_chunks(tmp_path):
    st = ss.SessionStore.create(tmp_path / "s", 10_000)
    col = st.allocate_column("positions", np.float64, (3,))
    assert col.shape == (10_000, 3)
    for a, b in ss.iter_ranges(10_000, rows=3000):
        col[a:b] = np.full((b - a, 3), float(a))
    st.flush()
    st.close()
    re = ss.SessionStore.open(tmp_path / "s", writable=False)
    p = re.column("positions")
    assert p[0, 0] == 0.0 and p[2999, 0] == 0.0 and p[3000, 0] == 3000.0 and p[9999, 0] == 9000.0
    with pytest.raises(ss.StoreError):
        re.add_column("x", np.zeros(10_000))


def test_iter_chunks_yields_zero_copy_views_covering_every_row(tmp_path):
    st = _make(tmp_path, n=5000)
    seen = 0
    for a, b, cols in st.iter_chunks(["positions", "deleted"], rows=1999):
        assert cols["positions"].shape == (b - a, 3)
        assert cols["positions"].base is not None                    # a view, not a copy
        seen += b - a
    assert seen == 5000
    assert list(ss.iter_ranges(7, 3)) == [(0, 3), (3, 6), (6, 7)]
    assert list(ss.iter_ranges(0, 3)) == []


def test_replace_is_atomic_and_a_torn_write_keeps_the_previous_column(tmp_path, monkeypatch):
    st = _make(tmp_path)
    before = np.array(st.column("intensity"))

    def boom(*a, **k):
        raise OSError("disk full mid-write")

    monkeypatch.setattr(ss.np.lib.format, "write_array", boom)
    with pytest.raises(OSError):
        st.replace_column("intensity", np.ones(1000, dtype=np.uint16))
    monkeypatch.undo()
    # The previous file is untouched and still readable; no .tmp is registered.
    np.testing.assert_array_equal(st.column("intensity"), before)
    assert st.columns()["intensity"]["dtype"] == "<u2"
    st.replace_column("intensity", np.ones(1000, dtype=np.float32))
    assert st.column("intensity").dtype == np.float32
    st.close()
    re = ss.SessionStore.open(tmp_path / "s")
    assert re.columns()["intensity"]["dtype"] == "<f4"
    assert not list((tmp_path / "s" / ss.COLUMN_DIR).glob("*.tmp"))


def test_drop_column_removes_file_and_metadata(tmp_path):
    st = _make(tmp_path)
    st.drop_column("intensity")
    assert not st.has_column("intensity")
    assert not (tmp_path / "s" / ss.COLUMN_DIR / "intensity.npy").exists()
    with pytest.raises(KeyError):
        st.column("intensity")


def test_wrong_length_names_and_versions_are_refused(tmp_path):
    st = _make(tmp_path)
    with pytest.raises(ss.StoreError):
        st.add_column("short", np.zeros(999))
    with pytest.raises(ss.StoreError):
        st.add_column("../escape", np.zeros(1000))
    with pytest.raises(ss.StoreError):
        st.add_column("positions", np.zeros(1000))
    with pytest.raises(ss.StoreError):
        ss.SessionStore.create(tmp_path / "s", 5)          # already exists
    st.close()
    meta = json.loads((tmp_path / "s" / ss.META_FILE).read_text())
    meta["version"] = 999
    (tmp_path / "s" / ss.META_FILE).write_text(json.dumps(meta))
    with pytest.raises(ss.StoreError):
        ss.SessionStore.open(tmp_path / "s")


def test_missing_column_file_is_refused_on_open(tmp_path):
    st = _make(tmp_path)
    st.close()
    (tmp_path / "s" / ss.COLUMN_DIR / "deleted.npy").unlink()
    with pytest.raises(ss.StoreError):
        ss.SessionStore.open(tmp_path / "s")


def test_generation_attrs_and_accounting(tmp_path):
    st = _make(tmp_path)
    assert st.generation == 0
    assert st.bump_generation() == 1
    st.set_attr("source", "a.laz")
    assert st.bytes_on_disk() >= 1000 * (24 + 2 + 1)
    assert st.bytes_resident_estimate() == 1000 * (24 + 2 + 1)
    st.close()
    re = ss.SessionStore.open(tmp_path / "s")
    assert re.generation == 1 and re.attrs["source"] == "a.laz"
    re.delete()
    assert not (tmp_path / "s").exists()
