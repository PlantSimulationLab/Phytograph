"""A session exported to a LAS/LAZ file streams from the session in blocks.

The generic export copies every surviving point and column and then builds
one laspy record for all of them (~10 GB of transient at 100 M points); the
file path now goes through `_export_session_to_las`, which gathers one block
at a time. The contract pinned here: the streamed file is point-for-point
what the generic path produces (same coordinates after world shift and
translation, same columns, same classification byte, same point format when
RGB is deselected), it works for LAZ, it honors `columns`, and it never
calls the whole-cloud read.
"""
import base64
import io

import numpy as np
import pytest

import main
from tests.binframe import decode_streamed_json


def _write_las(path, n=5000, seed=1):
    import laspy

    rng = np.random.default_rng(seed)
    hdr = laspy.LasHeader(point_format=3, version="1.4")
    hdr.scales = [0.001] * 3
    hdr.offsets = [500000.0, 4000000.0, 0.0]
    hdr.add_extra_dim(laspy.ExtraBytesParams(name="reflectance", type=np.float32))
    hdr.add_extra_dim(laspy.ExtraBytesParams(name="is_miss", type=np.uint8))
    with laspy.open(str(path), mode="w", header=hdr) as w:
        rec = laspy.ScaleAwarePointRecord.zeros(n, header=hdr)
        rec.x = 500000.0 + rng.uniform(0, 20, n)
        rec.y = 4000000.0 + rng.uniform(0, 20, n)
        rec.z = rng.uniform(0, 3, n)
        rec.intensity = rng.integers(1, 60000, n).astype(np.uint16)
        rec.red = rng.integers(0, 65535, n).astype(np.uint16)
        rec.green = rng.integers(0, 65535, n).astype(np.uint16)
        rec.blue = rng.integers(0, 65535, n).astype(np.uint16)
        rec.gps_time = 1.0e9 + np.arange(n) * 0.01
        rec.classification = rng.integers(1, 6, n).astype(np.uint8)
        rec.reflectance = rng.uniform(-15, 0, n).astype(np.float32)
        rec.is_miss = (rng.random(n) < 0.05).astype(np.uint8)
        w.write_points(rec)
    return path


@pytest.fixture
def edited_session(client, tmp_path, monkeypatch):
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "octrees"))
    las = _write_las(tmp_path / "in.las")
    res = client.post("/api/cloud/session/create",
                      json={"source_path": str(las), "world_shift": [500000.0, 4000000.0, 0.0]})
    assert res.status_code == 200, res.text
    sid = decode_streamed_json(res.content)["session_id"]
    res = client.post(f"/api/cloud/session/{sid}/delete_region",
                      json={"region": {"kind": "box", "min": [0, 0, -1], "max": [6, 6, 10], "invert": False}})
    assert res.status_code == 200 and res.json()["deleted_count"] > 0
    return sid, las, tmp_path


def _export(client, sid, las, fmt, dest=None, columns=None, translation=None):
    body = {"source": {"session_id": sid, "source_path": str(las), "translation": translation},
            "format": fmt}
    if dest is not None:
        body["dest_path"] = str(dest)
    if columns is not None:
        body["columns"] = columns
    res = client.post("/api/pointcloud/export", json=body)
    assert res.status_code == 200, res.text
    out = decode_streamed_json(res.content)
    assert out["success"] is True, out
    return out


def _read(path_or_bytes):
    import laspy

    if isinstance(path_or_bytes, bytes):
        return laspy.read(io.BytesIO(path_or_bytes))
    return laspy.read(str(path_or_bytes))


@pytest.mark.parametrize("fmt", ["las", "laz"])
def test_streamed_file_matches_the_generic_export(client, edited_session, monkeypatch, fmt):
    sid, las, tmp = edited_session
    calls = []
    real = main._read_points_and_extras

    def spy(src, *a, **k):
        calls.append(getattr(src, "session_id", None))
        return real(src, *a, **k)

    monkeypatch.setattr(main, "_read_points_and_extras", spy)

    dest = tmp / f"streamed.{fmt}"
    out = _export(client, sid, las, fmt, dest=dest, translation=[1.5, -2.0, 0.25])
    assert calls == [], "the file export must not copy the whole cloud"
    streamed = _read(dest)
    # Reference: the generic (base64) path on the same request.
    ref_out = _export(client, sid, las, fmt, translation=[1.5, -2.0, 0.25])
    assert calls == [sid]
    ref = _read(base64.b64decode(ref_out["data"]))

    assert len(streamed.points) == len(ref.points) == out["point_count"]
    assert out["has_colors"] is True and streamed.point_format.id == 7
    for ax in "xyz":
        np.testing.assert_allclose(np.asarray(getattr(streamed, ax)), np.asarray(getattr(ref, ax)), atol=1.5e-3)
    # World coordinates came back (shift + translation), not session-frame ones.
    assert streamed.x.min() > 500000.0
    for dim in ("classification", "reflectance", "is_miss", "gps_time"):
        np.testing.assert_array_equal(np.asarray(streamed[dim]), np.asarray(ref[dim]), err_msg=dim)
    # The generic path round-trips intensity and RGB through float32 (/65535,
    # *65535) and truncates one unit off about half the values; the streamed
    # path writes the session's uint16 verbatim. Within one unit of the
    # reference, and exactly the session's own columns.
    sess = main._get_cloud_session(sid)
    alive = ~sess.deleted
    for dim in ("intensity", "red", "green", "blue"):
        np.testing.assert_allclose(np.asarray(streamed[dim], dtype=np.int64),
                                   np.asarray(ref[dim], dtype=np.int64), atol=1, err_msg=dim)
    np.testing.assert_array_equal(np.asarray(streamed.intensity), sess.intensity[alive])
    np.testing.assert_array_equal(np.asarray(streamed.red), sess.colors[alive, 0])
    # Misses are included in an export, deleted points are not.
    assert len(streamed.points) == int((~sess.deleted).sum())
    assert np.asarray(streamed.is_miss).sum() > 0
    # Header bounds cover the data.
    assert streamed.header.mins[0] <= streamed.x.min() and streamed.header.maxs[2] >= streamed.z.max()


@pytest.mark.parametrize("streamed", [True, False])
def test_timestamps_export_at_full_float64_precision(client, edited_session, streamed):
    """Per-pulse times ride the standard float64 gps_time field, never a
    float32 extra dim. At the fixture's 1e9 s magnitude float32 steps 64 s, so
    its 10 ms pulse spacing collapses to ONE value - and "streamed equals
    generic" cannot see that, because both paths were equally quantized."""
    sid, las, tmp = edited_session
    if streamed:
        dest = tmp / "ts.las"
        _export(client, sid, las, "las", dest=dest)
        f = _read(dest)
    else:
        f = _read(base64.b64decode(_export(client, sid, las, "las")["data"]))
    sess = main._get_cloud_session(sid)
    expected = np.asarray(sess.timestamps[~sess.deleted], dtype=np.float64)
    assert np.unique(expected).size == expected.size  # the fixture is one time per point
    got = np.asarray(f.gps_time)
    assert got.dtype == np.float64
    np.testing.assert_array_equal(got, expected)
    assert np.unique(got).size == expected.size
    assert "timestamp" not in list(f.point_format.extra_dimension_names)
    # The clock identity survives too, or a re-import misreads the encoding.
    assert bool(f.header.global_encoding.gps_time_type) == (
        sess.gps_time_encoding == "adjusted_standard")


def test_deselecting_timestamp_leaves_gps_time_empty(client, edited_session):
    sid, las, tmp = edited_session
    for dest, streamed in ((tmp / "nots.las", True), (None, False)):
        out = _export(client, sid, las, "las", dest=dest, columns=["x", "y", "z", "reflectance"])
        f = _read(dest) if streamed else _read(base64.b64decode(out["data"]))
        assert not np.asarray(f.gps_time).any()


def test_column_selection_drops_rgb_to_format_6_and_filters_scalars(client, edited_session):
    sid, las, tmp = edited_session
    dest = tmp / "subset.las"
    out = _export(client, sid, las, "las", dest=dest, columns=["x", "y", "z", "reflectance"])
    f = _read(dest)
    assert out["has_colors"] is False and f.point_format.id == 6
    names = set(f.point_format.extra_dimension_names)
    # is_miss is not optional while the export writes miss rows; see
    # test_a_column_list_without_is_miss_still_flags_the_miss_rows.
    assert names == {"reflectance", "is_miss"}
    # Intensity was deselected: the dimension exists (core record) but is zero.
    assert not np.any(np.asarray(f.intensity))
    # No class column selected: classification byte stays zero.
    assert not np.any(np.asarray(f.classification))


def test_export_progress_advances_in_steps_and_cleans_up_a_partial_file(client, edited_session):
    from tests.binframe import decode_progress_markers

    sid, las, tmp = edited_session
    dest = tmp / "prog.laz"
    res = client.post("/api/pointcloud/export",
                      json={"source": {"session_id": sid, "source_path": str(las)},
                            "format": "laz", "dest_path": str(dest)})
    fractions = [m["progress"] for m in decode_progress_markers(res.content) if m.get("progress") is not None]
    assert fractions == sorted(fractions) and fractions[-1] == pytest.approx(1.0)
    assert max(b - a for a, b in zip(fractions, fractions[1:])) < 0.5
    assert not list(tmp.glob("*.partial*"))


def _miss_export(client, sid, fmt, dest, columns):
    res = client.post("/api/pointcloud/export", json={
        "source": {"session_id": sid}, "format": fmt, "filename": f"o.{fmt}",
        "dest_path": str(dest), "columns": columns})
    assert res.status_code == 200, res.text
    return decode_streamed_json(res.content)


@pytest.mark.parametrize("fmt", ["las", "laz", "xyz", "csv"])
def test_a_column_list_without_is_miss_still_flags_the_miss_rows(client, edited_session, fmt):
    """The picker leaves is_miss out on its own: a session's hits-only octree
    reports it as all zeros, which reads as a degenerate schema dimension. The
    miss rows are written regardless, so unflagged they re-import as real
    returns ~1 km out. Assert on the whole round trip."""
    sid, _las, tmp = edited_session
    sess = main._get_cloud_session(sid)
    alive = ~np.asarray(sess.deleted)
    n_miss = int((np.asarray(sess.extras["is_miss"])[alive] != 0).sum())
    assert n_miss > 0
    dest = tmp / f"out.{fmt}"

    out = _miss_export(client, sid, fmt, dest, ["x", "y", "z", "intensity"])
    assert out["point_count"] == int(alive.sum())

    res = client.post("/api/cloud/session/create", json={"source_path": str(dest)})
    assert res.status_code == 200, res.text
    again = main._get_cloud_session(decode_streamed_json(res.content)["session_id"])
    assert "is_miss" in again.extras, "the miss rows came back as real returns"
    assert int((np.asarray(again.extras["is_miss"]) != 0).sum()) == n_miss


@pytest.mark.parametrize("fmt", ["las", "xyz"])
def test_user_columns_keep_their_order_and_is_miss_is_not_duplicated(client, edited_session, fmt):
    sid, _las, tmp = edited_session
    assert main._columns_keeping_miss_flag(["z", "x", "y"], True) == ["z", "x", "y", "is_miss"]
    assert main._columns_keeping_miss_flag(["x", "is_miss", "y"], True) == ["x", "is_miss", "y"]
    assert main._columns_keeping_miss_flag(None, True) is None
    dest = tmp / f"keep.{fmt}"
    _miss_export(client, sid, fmt, dest, ["x", "y", "z", "is_miss"])
    assert dest.is_file()


def test_a_cloud_with_no_misses_gets_no_flag(client, edited_session):
    """A hits-only cloud must not grow an all-zero column it never had."""
    sid, _las, tmp = edited_session
    sess = main._get_cloud_session(sid)
    with main._cloud_session_lock:
        sess.deleted[np.asarray(sess.extras["is_miss"]) != 0] = True
    dest = tmp / "hits.las"
    _miss_export(client, sid, "las", dest, ["x", "y", "z", "intensity"])
    assert "is_miss" not in {d.name for d in _read(dest).point_format.extra_dimensions}


def test_a_transform_during_the_export_cannot_tear_the_file(client, edited_session, monkeypatch):
    """Re-reading `sess.positions` per block wrote half the points in the old
    frame and half 1000 m away, with success=True and a header that disagreed."""
    sid, _las, tmp = edited_session
    sess = main._get_cloud_session(sid)
    monkeypatch.setattr(main, "_LAS_WRITE_CHUNK", 500)
    monkeypatch.setattr(main, "_session_rebuild", lambda s, **k: ("c", main.Path("/tmp/x"), {}))
    survivors = np.asarray(sess.positions)[~np.asarray(sess.deleted)].copy()
    reads = []

    def progress(_frac, msg):
        if msg == "Reading points":
            reads.append(msg)
            if len(reads) == 2:
                main.session_transform(sid, main.SessionTransformRequest(
                    matrix=[1, 0, 0, 1000, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], octree_mode="pose"))

    dest = tmp / "torn.las"
    out = main._export_session_to_las(sess, dest, fmt="las", columns=None, translation=None, progress=progress)
    assert out["success"] and len(reads) > 2
    f = _read(dest)
    # All of it is the cloud as it was when the export started.
    shift = np.asarray(sess.world_shift, dtype=np.float64)
    np.testing.assert_allclose(np.asarray(f.x), survivors[:, 0] + shift[0], atol=2e-3)
    assert f.header.maxs[0] == pytest.approx(np.asarray(f.x).max(), abs=2e-3)
