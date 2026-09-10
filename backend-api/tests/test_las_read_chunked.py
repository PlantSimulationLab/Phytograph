"""`_read_las_into_arrays` reads in chunks, into preallocated arrays.

It used to `reader.read()` the whole LAS and then `np.stack(...).astype(
float64)` it, so the entire laspy record and the float64 copy were resident
at once - the 2x import transient that made a 100 M-point import need
11-17 GB. Chunked, the peak is the arrays plus ONE chunk. The contract that
must survive the rewrite is pinned here against laspy's own whole-file read:
every column, dtype, the constant-column pruning, the gps_time / beam-origin
routing, and a chunk size that does not divide the point count.
"""
import numpy as np
import pytest

import main


def _write_las(path, n, *, origins=True, constant_user_data=True, colors=True, seed=0):
    import laspy

    rng = np.random.default_rng(seed)
    hdr = laspy.LasHeader(point_format=3, version="1.4")
    hdr.scales = [0.001, 0.001, 0.001]
    hdr.offsets = [100.0, 200.0, 0.0]
    hdr.add_extra_dim(laspy.ExtraBytesParams(name="Reflectance", type=np.float32))
    hdr.add_extra_dim(laspy.ExtraBytesParams(name="is_miss", type=np.uint8))
    if origins:
        for ax in ("ox", "oy", "oz"):
            hdr.add_extra_dim(laspy.ExtraBytesParams(name=ax, type=np.float64))
    with laspy.open(str(path), mode="w", header=hdr) as w:
        rec = laspy.ScaleAwarePointRecord.zeros(n, header=hdr)
        rec.x = 100.0 + rng.uniform(0, 50, n)
        rec.y = 200.0 + rng.uniform(0, 50, n)
        rec.z = rng.uniform(0, 5, n)
        rec.intensity = rng.integers(1, 60000, n).astype(np.uint16)
        if colors:
            rec.red = rng.integers(0, 65535, n).astype(np.uint16)
            rec.green = rng.integers(0, 65535, n).astype(np.uint16)
            rec.blue = rng.integers(0, 65535, n).astype(np.uint16)
        rec.gps_time = 1.0e9 + np.arange(n, dtype=np.float64) * 0.01
        rec.return_number = rng.integers(1, 3, n).astype(np.uint8)
        rec.number_of_returns = np.full(n, 2, dtype=np.uint8)          # constant -> pruned
        rec.classification = rng.integers(1, 5, n).astype(np.uint8)   # varies -> las_classification
        rec.user_data = (np.full(n, 7, dtype=np.uint8) if constant_user_data
                         else rng.integers(0, 9, n).astype(np.uint8))
        rec.point_source_id = np.zeros(n, dtype=np.uint16)            # constant -> pruned
        rec.Reflectance = rng.uniform(-20, 5, n).astype(np.float32)
        rec.is_miss = (rng.random(n) < 0.1).astype(np.uint8)
        if origins:
            rec.ox = 125.0 + rng.normal(0, 0.01, n)
            rec.oy = 225.0 + rng.normal(0, 0.01, n)
            rec.oz = 1.6 + rng.normal(0, 0.01, n)
        w.write_points(rec)
    return path


@pytest.mark.parametrize("chunk", [7, 1000])
def test_chunked_read_matches_a_whole_file_read(tmp_path, monkeypatch, chunk):
    import laspy

    n = 100
    las_path = _write_las(tmp_path / "a.las", n)
    monkeypatch.setattr(main, "_LAS_READ_CHUNK", chunk)
    got = main._read_las_into_arrays(las_path)
    ref = laspy.read(str(las_path))

    assert got.positions.dtype == np.float64 and got.positions.shape == (n, 3)
    np.testing.assert_allclose(got.positions[:, 0], ref.x)
    np.testing.assert_allclose(got.positions[:, 1], ref.y)
    np.testing.assert_allclose(got.positions[:, 2], ref.z)
    assert got.colors.dtype == np.uint16
    np.testing.assert_array_equal(got.colors[:, 1], np.asarray(ref.green))
    assert got.intensity.dtype == np.uint16
    np.testing.assert_array_equal(got.intensity, np.asarray(ref.intensity))
    # Extra dims: canonical slug, float32, file spelling kept as the label.
    assert got.extras["reflectance"].dtype == np.float32
    np.testing.assert_array_equal(got.extras["reflectance"], np.asarray(ref.Reflectance))
    assert {"slug": "reflectance", "label": "Reflectance"} in got.extra_dims_meta
    np.testing.assert_array_equal(got.extras["is_miss"], np.asarray(ref.is_miss).astype(np.float32))
    # Multi-return: varying return_number mapped, constant number_of_returns pruned.
    np.testing.assert_array_equal(got.extras["target_index"], np.asarray(ref.return_number).astype(np.float32))
    assert "target_count" not in got.extras
    # Standard dims: varying classification carried with the las_ prefix and
    # "LAS classification" label; constant user_data / point_source_id pruned.
    np.testing.assert_array_equal(got.extras["las_classification"],
                                  np.asarray(ref.classification).astype(np.float32))
    assert {"slug": "las_classification", "label": "LAS classification"} in got.extra_dims_meta
    assert "las_user_data" not in got.extras and "las_point_source_id" not in got.extras
    # gps_time -> float64 timestamps with its encoding; never in extras.
    assert got.timestamps.dtype == np.float64
    np.testing.assert_array_equal(got.timestamps, np.asarray(ref.gps_time))
    assert got.gps_time_encoding in ("adjusted_standard", "gps_week")
    assert "gps_time" not in got.extras and "las_gps_time" not in got.extras
    # Beam origins -> float64 (n,3), and never as float32 scalars.
    assert got.beam_origins.dtype == np.float64 and got.beam_origins.shape == (n, 3)
    np.testing.assert_array_equal(got.beam_origins[:, 2], np.asarray(ref.oz))
    assert not any(k in got.extras for k in ("ox", "oy", "oz", "origin_x"))
    # Every extras column is exactly n long (a chunk-boundary bug would show here).
    assert all(v.shape == (n,) for v in got.extras.values())
    assert [m["slug"] for m in got.extra_dims_meta] == list(got.extras.keys())


def test_varying_user_data_is_kept_and_all_zero_intensity_is_dropped(tmp_path, monkeypatch):
    import laspy

    n = 50
    las_path = _write_las(tmp_path / "b.las", n, origins=False, constant_user_data=False, colors=False)
    # Zero the intensity in place to exercise the "no intensity" branch.
    las = laspy.read(str(las_path))
    las.intensity = np.zeros(n, dtype=np.uint16)
    las.write(str(las_path))
    monkeypatch.setattr(main, "_LAS_READ_CHUNK", 8)
    got = main._read_las_into_arrays(las_path)
    assert got.intensity is None
    assert got.beam_origins is None
    assert "las_user_data" in got.extras
    assert got.extras["las_user_data"].shape == (n,)
    # colors: the dims exist in point format 3, so the array is present (all zero).
    assert got.colors is not None and got.colors.shape == (n, 3)


def test_empty_las_reads_to_empty_arrays(tmp_path):
    import laspy

    hdr = laspy.LasHeader(point_format=3, version="1.4")
    with laspy.open(str(tmp_path / "empty.las"), mode="w", header=hdr):
        pass
    got = main._read_las_into_arrays(tmp_path / "empty.las")
    assert got.positions.shape == (0, 3)
    assert got.timestamps is None
    assert got.extras == {}
