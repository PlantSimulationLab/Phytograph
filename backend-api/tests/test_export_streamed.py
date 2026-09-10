"""A session exported to a LAS/LAZ file streams from the session in blocks.

The generic export copies every surviving point and column and then builds
one laspy record for all of them (~10 GB of transient at 100 M points); the
file path now goes through `_export_session_to_las`, which gathers one block
at a time. The contract pinned here: the streamed file is point-for-point
what the generic path produces (same coordinates after world shift and
translation, same columns, same classification byte, same point format when
RGB is deselected), it works for LAZ, it honours `columns`, and it never
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
    assert out["has_colors"] is True and streamed.point_format.id == 3
    for ax in "xyz":
        np.testing.assert_allclose(np.asarray(getattr(streamed, ax)), np.asarray(getattr(ref, ax)), atol=1.5e-3)
    # World coordinates came back (shift + translation), not session-frame ones.
    assert streamed.x.min() > 500000.0
    for dim in ("classification", "reflectance", "is_miss", "timestamp"):
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


def test_column_selection_drops_rgb_to_format_1_and_filters_scalars(client, edited_session):
    sid, las, tmp = edited_session
    dest = tmp / "subset.las"
    out = _export(client, sid, las, "las", dest=dest, columns=["x", "y", "z", "reflectance"])
    f = _read(dest)
    assert out["has_colors"] is False and f.point_format.id == 1
    names = set(f.point_format.extra_dimension_names)
    assert names == {"reflectance"}
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
