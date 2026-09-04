"""A per-pulse timestamp must survive import at FULL precision.

THE BUG THIS PINS: every import writer declared its extra dimensions
`type=np.float32`, and a `timestamp` column rode through as one of them. float32
has ~24 mantissa bits, so the gap between representable values scales with
magnitude — harmless near zero, 0.03 s at GPS week-seconds (~4.7e5), and 32 s at
adjusted-standard GPS (~3.5e8). Measured on the real import path before the fix,
a 120 s scan of 5,000 distinct GPS-magnitude times came back as 5 DISTINCT VALUES
(max error 16 s), and the shipped `example-datasets/BR04_ALS_origins.xyz`
collapsed 188,653 distinct times to 497.

Why that is fatal rather than merely lossy: `gapfillMisses()`'s timestamp path
groups returns into pulses purely by comparing per-hit times, so thousands of
returns sharing one value cannot be resolved into the shots they came from. The
same collapse also lands every return of a moving-platform scan onto a single
trajectory pose.

Why it hid: `_read_las_into_arrays` rescues a `timestamp` extra dim into the
float64 `LasReadResult.timestamps`, so the damage arrived wearing a float64 dtype
and looked healthy at every downstream inspection point.

The fix routes the column to the LAS STANDARD `gps_time` field (float64), which
is what the export writer already did. These tests drive the REAL import path
(`_source_to_las` -> `_read_las_into_arrays`) rather than reimplementing it, so
they fail if any writer regresses to a float32 extra dim.
"""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main  # noqa: E402


# Spacing chosen so consecutive samples differ far below the float32 quantum at
# GPS magnitude (32 s): if the column is ever stored as float32 again, these
# collapse en masse rather than merely rounding.
_N = 5000
_STEP = 0.024  # ~120 s total span


def _write_xyz(path: Path, t0: float) -> np.ndarray:
    ts = t0 + np.arange(_N) * _STEP
    with open(path, "w") as f:
        f.write("x y z timestamp\n")
        for i in range(_N):
            f.write(f"{i*0.001:.6f} {i*0.002:.6f} {i*0.003:.6f} {ts[i]:.6f}\n")
    return ts


def _import(path: Path, tmp_path: Path):
    las = main._source_to_las(path, None, tmp_path, None)
    if isinstance(las, tuple):
        las = las[0]
    return las, main._read_las_into_arrays(las)


@pytest.mark.parametrize("t0,label", [
    (3.5e8, "adjusted-standard GPS"),   # float32 quantum here is 32 s
    (4.7e5, "GPS week-seconds"),        # float32 quantum here is ~0.03 s
    (0.0, "relative/Helios time"),      # float32 is fine here — the control
])
def test_timestamp_survives_import_at_full_precision(t0, label, tmp_path):
    src = tmp_path / "scan.xyz"
    ts_in = _write_xyz(src, t0)

    _, r = _import(src, tmp_path)

    assert r.timestamps is not None, f"{label}: timestamps were dropped entirely"
    assert r.timestamps.dtype == np.float64
    # THE ASSERTION THAT BITES: every distinct input time is still distinct.
    # Pre-fix this was 5 for the adjusted-standard case.
    assert len(np.unique(r.timestamps)) == len(np.unique(ts_in)), (
        f"{label}: {len(np.unique(ts_in))} distinct times collapsed to "
        f"{len(np.unique(r.timestamps))} — the column is being quantized"
    )
    # float64 through a text file round-trip is exact to well under a microsecond;
    # the pre-fix error at adjusted-standard magnitude was 16 SECONDS.
    assert np.abs(r.timestamps - ts_in).max() < 1e-6


def test_timestamp_is_not_a_float32_extra_dim(tmp_path):
    """The mechanism, asserted directly on the written LAS.

    Precision is the symptom; the cause is the column's storage class. Checking
    the on-disk schema means a future writer that reintroduces the float32 extra
    dim fails here even if some other path happens to paper over the values.
    """
    import laspy

    src = tmp_path / "scan.xyz"
    _write_xyz(src, 3.5e8)
    las_path, r = _import(src, tmp_path)

    f = laspy.read(str(las_path))
    extra_names = {d.name for d in f.header.point_format.extra_dimensions}
    assert not any(main._canonical_slug_for_name(n) == "timestamp"
                   for n in extra_names), (
        f"timestamp is back as a float32 extra dim: {sorted(extra_names)}"
    )
    # It is in the standard field instead, and that field is genuinely populated.
    assert len(np.unique(np.asarray(f.gps_time))) == _N
    # And it did NOT also linger in extras — one quantity, one column, or the
    # Color-by picker shows two entries with the same label.
    assert not any(main._canonical_slug_for_name(k) == "timestamp"
                   for k in r.extras)


def test_absolute_clock_is_not_mislabelled_gps_week(tmp_path):
    """An ASCII file declares no clock, so the encoding must be inferred.

    Getting it wrong is not cosmetic: `_read_las_into_arrays` maps
    global_encoding bit 0 onto `gps_time_encoding`, and the create endpoint turns
    a `gps_week` reading into a user-facing warning that a trajectory join cannot
    align. Leaving the bit clear put that warning on every ASCII import, ALS
    exports with a genuine absolute clock included. GPS week time is bounded by
    the 604800 s week, so anything past it cannot be week-seconds.
    """
    src = tmp_path / "abs.xyz"
    _write_xyz(src, 3.5e8)
    _, r = _import(src, tmp_path)
    assert r.gps_time_encoding == "adjusted_standard"


def test_week_magnitude_still_reads_as_week(tmp_path):
    """The converse: a genuine week clock must keep warning. The inference must
    not simply flip every file to 'absolute' and silence a real problem."""
    src = tmp_path / "week.xyz"
    _write_xyz(src, 4.7e5)
    _, r = _import(src, tmp_path)
    assert r.gps_time_encoding == "gps_week"


def test_session_rebuild_preserves_timestamp_precision(tmp_path):
    """`_session_to_las` rebuilds the octree from the in-RAM session on every
    bake/edit. It must not re-quantize the times on the way through — otherwise
    the import fix is undone the first time the user edits the cloud.
    """
    src = tmp_path / "scan.xyz"
    ts_in = _write_xyz(src, 3.5e8)
    _, r = _import(src, tmp_path)

    sess = main.CloudSession(
        session_id="t", source_path=str(src), ascii_format=None, column_plan=None,
        positions=r.positions, colors=r.colors, intensity=r.intensity,
        extras=dict(r.extras), extra_dims_meta=list(r.extra_dims_meta),
        timestamps=r.timestamps, gps_time_encoding=r.gps_time_encoding,
        world_shift=None, deleted=np.zeros(r.positions.shape[0], dtype=bool),
        deleted_history=[], octree_cache_id=None, created_at=0.0, last_accessed=0.0,
    )

    out = tmp_path / "rebuilt.las"
    main._session_to_las(sess, out)
    r2 = main._read_las_into_arrays(out)

    assert r2.timestamps is not None
    assert len(np.unique(r2.timestamps)) == len(np.unique(ts_in))
    assert np.abs(r2.timestamps - ts_in).max() < 1e-6
    # The clock identity survives the round trip too.
    assert r2.gps_time_encoding == "adjusted_standard"


def test_real_als_dataset_keeps_every_distinct_time():
    """The shipped multi-return ALS export — the file that actually regressed.

    Skipped rather than fabricated when the dataset isn't present: a synthetic
    substitute would not exercise the real column plan (timestamp +
    target_index/target_count + an ox/oy/oz origin triple).
    """
    p = (Path(__file__).resolve().parents[2]
         / "example-datasets" / "BR04_ALS_origins.xyz")
    if not p.is_file():
        pytest.skip("example-datasets/BR04_ALS_origins.xyz not present")

    import pandas as pd
    import tempfile

    src = pd.read_csv(p, sep=r"\s+", header=None, comment="#",
                      skiprows=main._ascii_skiprows(str(p)))
    ts_in = src.iloc[:, 3].to_numpy(dtype=np.float64)

    with tempfile.TemporaryDirectory() as td:
        _, r = _import(p, Path(td))

    # Pre-fix: 188,653 distinct collapsed to 497.
    assert len(np.unique(r.timestamps)) == len(np.unique(ts_in))
    assert np.abs(r.timestamps - ts_in).max() < 1e-6
