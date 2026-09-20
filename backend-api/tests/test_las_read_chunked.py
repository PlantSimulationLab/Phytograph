"""`_read_las_into_arrays` reads in chunks, into preallocated arrays.

It used to `reader.read()` the whole LAS and then `np.stack(...).astype(
float64)` it, so the entire laspy record and the float64 copy were resident
at once - the 2x import transient that made a 100 M-point import need
11-17 GB. Chunked, the peak is the arrays plus ONE chunk. The contract that
must survive the rewrite is pinned here against laspy's own whole-file read:
every column, dtype, the constant-column pruning, the gps_time / beam-origin
routing, and a chunk size that does not divide the point count.

The pruning has one deliberate exemption: the multi-return pair
(`return_number` / `number_of_returns`), which is read per PULSE and so carries
signal even when constant. See the section at the bottom of this file.
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
        rec.number_of_returns = np.full(n, 2, dtype=np.uint8)          # constant but KEPT (per-pulse signal)
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
    # Multi-return: BOTH columns kept, including the constant number_of_returns.
    # This test used to assert `"target_count" not in got.extras`, pinning the
    # constant-column pruning as if it applied here — it must not. target_count
    # is read per PULSE (inferHiddenReturns compares it against that beam's
    # surviving returns to place a cropped return relative to the voxel grid), so
    # a column reading 2 everywhere is exactly the signal, not noise. Only a
    # single-return file (target_count == 1 everywhere) is genuinely empty; see
    # test_multireturn_columns_survive_a_uniform_crop below.
    np.testing.assert_array_equal(got.extras["target_index"], np.asarray(ref.return_number).astype(np.float32))
    np.testing.assert_array_equal(got.extras["target_count"],
                                  np.asarray(ref.number_of_returns).astype(np.float32))
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


# ---------------------------------------------------------------------------
# Multi-return columns vs the constant-column pruning
# ---------------------------------------------------------------------------
#
# `return_number` / `number_of_returns` are the ONLY way a pre-cropped file can
# say what it lost. Helios's inferHiddenReturns places a removed return before or
# beyond the voxel grid from index order alone — indices below every survivor
# terminated nearer, above terminated farther — which is what lets a segmented
# tree file be inverted for LAD at all. It needs BOTH columns (LiDAR.cpp
# early-returns without either) and prints nothing when it bails, so losing them
# silently disables the whole crop-aware path and LAD reads low.
#
# The pruning rule for the other standard dims ("drop a column that does not
# vary") is wrong for these two, and wrong on exactly the files that need them:
# crop a mixed-density scan to one crown and the return-count distribution
# narrows, so uniformity is evidence of cropping, not of absence.

def _write_multireturn_las(path, return_number, number_of_returns):
    """Minimal LAS carrying just the multi-return pair (+ gps_time)."""
    import laspy

    n = len(return_number)
    hdr = laspy.LasHeader(point_format=1, version="1.2")
    hdr.scales = [0.001, 0.001, 0.001]
    hdr.offsets = [0.0, 0.0, 0.0]
    with laspy.open(str(path), mode="w", header=hdr) as w:
        rec = laspy.ScaleAwarePointRecord.zeros(n, header=hdr)
        rec.x = np.linspace(0.0, 10.0, n)
        rec.y = np.linspace(0.0, 10.0, n)
        rec.z = np.linspace(0.0, 5.0, n)
        rec.gps_time = np.arange(n, dtype=np.float64) * 0.01
        rec.return_number = np.asarray(return_number, dtype=np.uint8)
        rec.number_of_returns = np.asarray(number_of_returns, dtype=np.uint8)
        w.write_points(rec)
    return path


@pytest.mark.parametrize("label, return_number, number_of_returns, expect_kept", [
    # A crop that kept only mid-canopy returns: every survivor is return 2 of 3.
    # Both columns constant, and both are still the whole signal.
    ("uniform crop, both constant", [2] * 60, [3] * 60, True),
    # The case that made this a real bug: an ordinary pre-cropped extract where
    # return_number varies but every pulse declared the same total. target_index
    # survived the old rule and target_count did not, which half-disables the
    # inference just as completely as losing both.
    ("uniform pulse count", [(i % 3) + 1 for i in range(60)], [3] * 60, True),
    # Ordinary uncropped multi-return data: both vary, kept before and after.
    ("both vary", [(i % 3) + 1 for i in range(60)],
     [3 if i % 2 else 1 for i in range(60)], True),
    # Genuinely single-return: every pulse recorded exactly one return, so
    # nothing was removed and there is nothing to infer. Must still be pruned.
    ("single-return file", [1] * 60, [1] * 60, False),
    # Point-format dims present but never populated — the case the pruning rule
    # exists for. Must still be pruned.
    ("all-zero dims", [0] * 60, [0] * 60, False),
])
def test_multireturn_columns_survive_a_uniform_crop(
        tmp_path, label, return_number, number_of_returns, expect_kept):
    las_path = _write_multireturn_las(
        tmp_path / "mr.las", return_number, number_of_returns)

    got = main._read_las_into_arrays(las_path)

    kept = ("target_index" in got.extras) and ("target_count" in got.extras)
    assert kept is expect_kept, (
        f"{label}: target_index={'target_index' in got.extras} "
        f"target_count={'target_count' in got.extras}, expected both={expect_kept}")
    if expect_kept:
        # Values, not just presence — a column of the wrong dtype or scale would
        # make the per-pulse comparison meaningless.
        np.testing.assert_array_equal(
            got.extras["target_count"], np.asarray(number_of_returns, dtype=np.float32))
        np.testing.assert_array_equal(
            got.extras["target_index"], np.asarray(return_number, dtype=np.float32))
        # And the columns must be advertised, or the scalar picker/export lose them.
        slugs = [m["slug"] for m in got.extra_dims_meta]
        assert "target_index" in slugs and "target_count" in slugs
    else:
        assert not any(m["slug"] in ("target_index", "target_count")
                       for m in got.extra_dims_meta)


def test_kept_multireturn_columns_reach_the_lad_arrays(tmp_path):
    """Presence in `extras` is not the point — the columns have to arrive at
    Helios. `_session_to_lad_arrays` is what builds the label list the C++ side
    probes, so assert the inference's precondition there rather than at import."""
    import time

    las_path = _write_multireturn_las(
        tmp_path / "mr.las", [(i % 3) + 1 for i in range(60)], [3] * 60)
    res = main._read_las_into_arrays(las_path)
    sess = main.CloudSession(
        session_id="mr-lad",
        source_path=str(las_path),
        ascii_format=None,
        column_plan=None,
        positions=res.positions,
        colors=None,
        intensity=None,
        extras=res.extras,
        extra_dims_meta=res.extra_dims_meta,
        deleted=np.zeros(len(res.positions), dtype=bool),
        deleted_history=[],
        octree_cache_id=None,
        created_at=time.time(),
    )
    sess.timestamps = res.timestamps

    _xyz, _dirs, labels, _vals, _flags = main._session_to_lad_arrays(
        sess, [0.0, 0.0, 50.0])

    # inferHiddenReturns needs BOTH, and bails silently with either missing.
    assert "target_index" in labels and "target_count" in labels, labels
