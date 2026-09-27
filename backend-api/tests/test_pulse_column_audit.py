"""Pulse-column audit: timestamps and return numbers that no longer identify pulses.

Helios groups returns into beams by exact shared `timestamp` and orders them
within a beam by `target_index`. A real TLS delivery (a CloudCompare round-trip
of a RIEGL scan) broke both without anything erroring: gps_time stored at
float32 precision put 10-68 distinct pulses on one timestamp, and returns of a
single pulse (collinear from the scanner, same time) both carried
return_number 1. LAD ran and inverted merged pseudo-beams.

These pin the detector (`_audit_pulse_columns`), what the LAD label builder does
with its verdict, and that the import drops a meaningless return number and
says why.
"""

import numpy as np
import pytest

import main

laspy = pytest.importorskip("laspy")


def _multireturn_scan(n_pulses=4000, period=5e-6, t0=400.0, seed=0):
    """A well-formed multi-return scan: per-pulse times, 1-based return numbers,
    and each pulse's returns all present."""
    rng = np.random.default_rng(seed)
    counts = rng.integers(1, 4, size=n_pulses)                 # 1..3 returns
    pulse_t = t0 + period * np.arange(n_pulses)
    ts = np.repeat(pulse_t, counts)
    tc = np.repeat(counts, counts).astype(np.float64)
    ti = np.concatenate([np.arange(1, c + 1) for c in counts]).astype(np.float64)
    return ts, tc, ti


def _float32_rounded(ts):
    return ts.astype(np.float32).astype(np.float64)


def test_well_formed_multireturn_passes():
    ts, tc, ti = _multireturn_scan()
    a = main._audit_pulse_columns(ts, tc, ti)
    assert not a["timestamps_rounded"]
    assert not a["return_order_lost"]
    assert a["max_group"] == 3


def test_zero_based_indices_pass():
    ts, tc, ti = _multireturn_scan()
    a = main._audit_pulse_columns(ts, tc, ti - 1)
    assert not a["return_order_lost"]


def test_float32_rounded_gps_time_is_detected():
    # At t~400 s a float32 resolves 30.5 us; a 5 us pulse clock puts ~6 pulses
    # (up to ~18 returns) on each value -- the shape of the real delivery.
    ts, tc, ti = _multireturn_scan()
    a = main._audit_pulse_columns(_float32_rounded(ts), tc, ti)
    assert a["timestamps_rounded"]
    assert a["max_group"] > 3
    assert a["oversize_returns"] > 0.5 * ts.size


def test_rewritten_return_number_is_detected():
    # Every return of every pulse present, all numbered 1.
    ts, tc, ti = _multireturn_scan()
    a = main._audit_pulse_columns(ts, tc, np.ones_like(ti))
    assert a["return_order_lost"]


def test_first_returns_of_a_segmented_tree_are_not_a_defect():
    # A tree cut out of a scan keeps "return 1 of k" when the later returns
    # landed behind it: constant index, varying count, and exactly the file
    # hidden-return inference is for. Nothing in it says the order was lost.
    ts, tc, ti = _multireturn_scan()
    first = ti == 1
    a = main._audit_pulse_columns(ts[first], tc[first], ti[first])
    assert not a["return_order_lost"]
    assert not a["timestamps_rounded"]


def test_constant_index_on_single_return_data_is_not_a_defect():
    ts = 400.0 + 5e-6 * np.arange(1000)
    a = main._audit_pulse_columns(ts, np.ones(1000), np.ones(1000))
    assert not a["return_order_lost"]
    assert not a["timestamps_rounded"]


def test_duplicate_index_within_a_pulse_is_detected():
    # Timestamps still identify pulses, but a pulse claims return #1 twice.
    ts, tc, ti = _multireturn_scan()
    ti = ti.copy()
    ti[tc > 1] = 1.0
    ti[0] = 2.0                        # not constant, so only the per-pulse test sees it
    a = main._audit_pulse_columns(ts, tc, ti)
    assert not a["timestamps_rounded"]
    assert a["return_order_lost"]


def test_misses_are_not_audited():
    # A gap-filled miss can land on a hit's pulse time; it must not count.
    ts, tc, ti = _multireturn_scan()
    miss_ts = ts[::3]
    all_ts = np.concatenate([ts, miss_ts])
    all_tc = np.concatenate([tc, np.full(miss_ts.size, np.nan)])
    all_ti = np.concatenate([ti, np.full(miss_ts.size, np.nan)])
    is_miss = np.concatenate([np.zeros(ts.size), np.ones(miss_ts.size)])
    a = main._audit_pulse_columns(all_ts, all_tc, all_ti, is_miss)
    assert not a["timestamps_rounded"]
    assert not a["return_order_lost"]


def test_single_return_without_counts_uses_a_hard_cap():
    # With no target_count only a group past any scanner's return limit is
    # impossible; small repeats are left alone.
    base = 400.0 + 1e-3 * np.arange(2000)
    assert not main._audit_pulse_columns(np.repeat(base, 3))["timestamps_rounded"]
    assert main._audit_pulse_columns(np.repeat(base, 20))["timestamps_rounded"]


def test_a_few_coincidences_are_tolerated():
    ts, tc, ti = _multireturn_scan()
    ts = ts.copy()
    ts[:30] = ts[0]                    # 30 of ~8000 returns on one time
    a = main._audit_pulse_columns(ts, tc, ti)
    assert not a["timestamps_rounded"]


def _getter(cols):
    return lambda slug: cols.get(slug)


def test_lad_labels_strip_rounded_timestamps_for_static_inversion():
    ts, tc, ti = _multireturn_scan()
    cols = {"timestamp": _float32_rounded(ts), "target_count": tc, "target_index": ti}
    n = ts.size

    labels, _vals, flags = main._lad_labels_vals(_getter(cols), n, strip_rounded_timestamps=True)
    assert "timestamp" not in labels and "target_index" not in labels
    assert flags["timestamps_stripped"] and not flags["multi"]
    assert flags["pulse_audit"]["timestamps_rounded"]

    # Backfill / moving scans keep them (gap-fill has nothing else) but are told.
    labels, _vals, flags = main._lad_labels_vals(_getter(cols), n)
    assert "timestamp" in labels
    assert not flags["timestamps_stripped"]


def test_lad_labels_ignore_a_lost_return_order():
    ts, tc, ti = _multireturn_scan()
    cols = {"timestamp": ts, "target_count": tc, "target_index": np.ones_like(ti)}
    labels, _vals, flags = main._lad_labels_vals(_getter(cols), ts.size, strip_rounded_timestamps=True)
    assert labels[:1] == ["timestamp"]
    assert "target_index" not in labels and not flags["multi"]


def test_lad_labels_keep_good_multireturn_columns():
    ts, tc, ti = _multireturn_scan()
    cols = {"timestamp": ts, "target_count": tc, "target_index": ti}
    labels, _vals, flags = main._lad_labels_vals(_getter(cols), ts.size, strip_rounded_timestamps=True)
    assert flags["multi"] and "target_index" in labels
    assert not flags["timestamps_stripped"]


def test_warning_text_names_both_defects():
    ts, tc, ti = _multireturn_scan()
    a = main._audit_pulse_columns(_float32_rounded(ts), tc, np.ones_like(ti))
    w = " ".join(main._pulse_audit_warnings(a, "Scan 'x'", at_import=False, stripped=True))
    assert "rounded" in w and "its own pulse" in w
    b = main._audit_pulse_columns(ts, tc, np.ones_like(ti))
    w = " ".join(main._pulse_audit_warnings(b, "Scan 'x'", at_import=False))
    assert "share a return number" in w


def _write_las(path, xyz, gps, rn, nr):
    hdr = laspy.LasHeader(point_format=6, version="1.4")
    hdr.scales = [0.001, 0.001, 0.001]
    las = laspy.LasData(hdr)
    las.x, las.y, las.z = xyz[:, 0], xyz[:, 1], xyz[:, 2]
    las.gps_time = gps
    las.return_number = rn.astype(np.uint8)
    las.number_of_returns = nr.astype(np.uint8)
    las.write(str(path))


def test_import_drops_a_rewritten_return_number_and_warns(tmp_path):
    ts, tc, ti = _multireturn_scan(n_pulses=3000)
    rng = np.random.default_rng(1)
    xyz = rng.uniform(0, 5, size=(ts.size, 3))
    p = tmp_path / "clobbered.las"
    _write_las(p, xyz, ts, np.ones_like(ti), tc)

    res = main._read_las_into_arrays(p)
    assert "target_index" not in res.extras
    assert "target_count" in res.extras          # still real; the audit uses it
    assert all(m["slug"] != "target_index" for m in res.extra_dims_meta)
    text = " ".join(res.warnings)
    assert "return-number column was not imported" in text
    assert "rounded" not in text


def test_import_flags_rounded_gps_time_and_keeps_it(tmp_path):
    # Kept: Backfill has nothing else to rebuild the raster from, and a moving
    # scan joins its trajectory on it. LAD strips it per run instead.
    ts, tc, ti = _multireturn_scan(n_pulses=3000)
    rng = np.random.default_rng(3)
    xyz = rng.uniform(0, 5, size=(ts.size, 3))
    p = tmp_path / "rounded.las"
    _write_las(p, xyz, _float32_rounded(ts), ti, tc)

    res = main._read_las_into_arrays(p)
    assert res.timestamps is not None
    assert "target_index" in res.extras
    assert "rounded" in " ".join(res.warnings)


def test_import_of_a_well_formed_file_is_silent(tmp_path):
    ts, tc, ti = _multireturn_scan(n_pulses=3000)
    rng = np.random.default_rng(2)
    xyz = rng.uniform(0, 5, size=(ts.size, 3))
    p = tmp_path / "good.las"
    _write_las(p, xyz, ts, ti, tc)

    res = main._read_las_into_arrays(p)
    assert "target_index" in res.extras and "target_count" in res.extras
    assert res.warnings == []


# --- Leaf/wood split column (LADWoodSplit) ---------------------------------

def _wood_cols():
    cls = np.array([1, 2, 3, 4, 5, 0], dtype=np.float64)       # an external classifier
    miss = np.array([0, 0, 0, 0, 0, 1], dtype=np.float64)
    return {"las_classification": cls, "is_miss": miss,
            "wood_class": np.array([1, 2, 1, 2, 1, 0], dtype=np.float64)}


def test_wood_split_default_reads_wood_class():
    cols = _wood_cols()
    out = main._resolve_lad_wood_column(_getter(cols), None, cols["is_miss"])
    np.testing.assert_array_equal(out, cols["wood_class"])


def test_wood_split_off():
    cols = _wood_cols()
    assert main._resolve_lad_wood_column(_getter(cols), main.LADWoodSplit(slug=None)) is None


def test_wood_split_remaps_another_column_and_zeroes_misses():
    cols = _wood_cols()
    spec = main.LADWoodSplit(slug="las_classification", wood_values=[4], leaf_values=[1, 2, 3])
    out = main._resolve_lad_wood_column(_getter(cols), spec, cols["is_miss"])
    # 1-3 leaf, 4 wood, 5 unlisted -> unclassified, the miss -> 0 whatever it held.
    np.testing.assert_array_equal(out, [2, 2, 2, 1, 0, 0])


def test_wood_split_rejects_bad_specs():
    cols = _wood_cols()
    with pytest.raises(ValueError, match="not on this scan"):
        main._resolve_lad_wood_column(_getter(cols), main.LADWoodSplit(slug="nope", wood_values=[1]))
    with pytest.raises(ValueError, match="which values"):
        main._resolve_lad_wood_column(_getter(cols), main.LADWoodSplit(slug="las_classification"))
    with pytest.raises(ValueError, match="both wood and leaf"):
        main._resolve_lad_wood_column(
            _getter(cols), main.LADWoodSplit(slug="las_classification", wood_values=[1], leaf_values=[1]))


def test_wood_split_reaches_the_lad_labels():
    cols = _wood_cols()
    spec = main.LADWoodSplit(slug="las_classification", wood_values=[4], leaf_values=[1, 2, 3])
    labels, vals, flags = main._lad_labels_vals(_getter(cols), 6, wood_split=spec)
    assert flags["has_wood_class"]
    np.testing.assert_array_equal(vals[:, labels.index(main.WOOD_CLASS_SLUG)], [2, 2, 2, 1, 0, 0])
    _l, _v, flags = main._lad_labels_vals(_getter(cols), 6, wood_split=main.LADWoodSplit(slug=None))
    assert not flags["has_wood_class"]
