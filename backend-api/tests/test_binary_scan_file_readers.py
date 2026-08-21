"""ASCII-only scan readers must not be handed a BINARY point-cloud file.

Regression guard for a user-reported crash:

    Helios Triangulation Failed
    Helios triangulation failed: 'utf-8' codec can't decode byte 0xd5 in
    position 90: invalid continuation byte

Position 90 is inside a LAS public header block. `_detect_ascii_format` (and
its siblings `_file_xyz_bounds`, `_file_to_lad_arrays`,
`_read_scan_columns_from_file`) all opened the scan file in TEXT mode and split
lines on whitespace, on the assumption that a `file_path` source is always an
ASCII column file. That assumption is false: the app imports LAS/LAZ as a
first-class format, and the file-path branch is the RESTART FALLBACK — it runs
whenever a scan's cloud session is gone (backend restarted since import) but the
entry still carries its sourcePath. So triangulating a LAS-backed scan after a
backend restart died on the LAS header with a raw decoder message that named
neither the file nor the real problem.

The fix routes binary sources to the real loaders where the data exists
(`_read_points_from_source` for geometry, the LAS dimensions for per-pulse
columns) and raises a legible error only where it genuinely cannot proceed.
"""

import numpy as np
import pytest

from main import (
    _MISS_SLUG,
    _detect_ascii_format,
    _file_to_lad_arrays,
    _file_xyz_bounds,
    _is_binary_scan_file,
    _read_scan_columns_from_file,
    _require_ascii_scan_file,
)


def _write_las(path, xyz, *, is_miss=None, extra=None):
    """Write a LAS the way the app's own writers do (see `_session_to_las`)."""
    laspy = pytest.importorskip("laspy")
    header = laspy.LasHeader(point_format=3, version="1.4")
    header.scales = np.array([0.001, 0.001, 0.001])
    header.offsets = np.floor(xyz.min(axis=0))
    if is_miss is not None:
        header.add_extra_dim(laspy.ExtraBytesParams(name=_MISS_SLUG, type=np.float32))
    for name in (extra or {}):
        header.add_extra_dim(laspy.ExtraBytesParams(name=name, type=np.float64))
    las = laspy.LasData(header)
    las.x, las.y, las.z = xyz[:, 0], xyz[:, 1], xyz[:, 2]
    if is_miss is not None:
        las[_MISS_SLUG] = is_miss.astype(np.float32)
    for name, vals in (extra or {}).items():
        las[name] = np.asarray(vals, dtype=np.float64)
    las.write(str(path))
    return path


@pytest.fixture
def cloud():
    rng = np.random.default_rng(0)
    return np.column_stack([
        rng.normal(0, 1.5, 500),
        rng.normal(0, 1.5, 500),
        rng.uniform(0, 8, 500),
    ])


@pytest.fixture
def las_path(tmp_path, cloud):
    return _write_las(tmp_path / "scan.las", cloud)


# --------------------------------------------------------------------------
# The byte that started it: a real LAS header must never reach a text decoder.
# --------------------------------------------------------------------------

def test_las_header_contains_the_undecodable_byte(las_path):
    """Sanity-check the premise: the fixture really is undecodable as UTF-8, so
    the guards below are load-bearing and not testing a hypothetical."""
    raw = las_path.read_bytes()
    assert raw[:4] == b"LASF"
    with pytest.raises(UnicodeDecodeError):
        raw.decode("utf-8")


@pytest.mark.parametrize("name", ["scan.las", "scan.laz", "scan.ply", "scan.pcd"])
def test_binary_extensions_are_recognised(name):
    assert _is_binary_scan_file(f"/tmp/{name}") is True


@pytest.mark.parametrize("name", ["scan.xyz", "scan.txt", "scan.csv", "scan.pts", "scan.asc"])
def test_ascii_extensions_are_not_flagged_binary(name):
    assert _is_binary_scan_file(f"/tmp/{name}") is False


def test_require_ascii_names_the_file_and_the_format(las_path):
    """The error a user sees must identify the file and the cause — the whole
    point of the fix. A bare UnicodeDecodeError did neither."""
    with pytest.raises(ValueError) as exc:
        _require_ascii_scan_file(str(las_path), "Helios triangulation")
    msg = str(exc.value)
    assert "scan.las" in msg
    assert ".las" in msg
    assert "Helios triangulation" in msg
    # Must not leak the decoder's vocabulary.
    assert "codec" not in msg
    assert "continuation byte" not in msg


# --------------------------------------------------------------------------
# Site 1: _detect_ascii_format / _file_xyz_bounds (the Helios triangulation path)
# --------------------------------------------------------------------------

def test_detect_ascii_format_rejects_las_with_a_legible_error(las_path):
    with pytest.raises(ValueError, match="ASCII point file"):
        _detect_ascii_format(str(las_path))


def test_detect_ascii_format_does_not_raise_unicode_error(las_path):
    """Specifically pin the regression: whatever else happens, it is no longer a
    UnicodeDecodeError escaping to the caller."""
    with pytest.raises(ValueError) as exc:
        _detect_ascii_format(str(las_path))
    assert not isinstance(exc.value, UnicodeDecodeError)


def test_file_xyz_bounds_rejects_las(las_path):
    with pytest.raises(ValueError, match="ASCII point file"):
        _file_xyz_bounds(str(las_path))


def test_detect_ascii_format_still_works_on_ascii(tmp_path):
    """The guard must not disturb the normal ASCII path."""
    p = tmp_path / "scan.xyz"
    p.write_text("# comment\n1 2 3 0.5 100 7\n4 5 6 0.6 101 8\n")
    assert _detect_ascii_format(str(p)) == "x y z timestamp intensity color"

    p3 = tmp_path / "bare.xyz"
    p3.write_text("1 2 3\n4 5 6\n")
    assert _detect_ascii_format(str(p3)) == "x y z"


def test_file_xyz_bounds_still_works_on_ascii(tmp_path):
    p = tmp_path / "scan.xyz"
    p.write_text("1 2 3\n4 5 6\n-1 0 2\n")
    n, lo, hi = _file_xyz_bounds(str(p))
    assert n == 3
    assert list(lo) == [-1, 0, 2]
    assert list(hi) == [4, 5, 6]


# --------------------------------------------------------------------------
# Site 2: _file_to_lad_arrays (LAD's stale-session file fallback)
# --------------------------------------------------------------------------

def test_lad_reads_a_las_fallback_instead_of_crashing(tmp_path, cloud):
    """LAD's file fallback must decode a LAS rather than die on its header."""
    n = cloud.shape[0]
    is_miss = np.zeros(n)
    is_miss[:50] = 1.0
    path = _write_las(
        tmp_path / "lad.las", cloud, is_miss=is_miss,
        extra={"timestamp": np.linspace(0, 1, n),
               "target_index": np.ones(n),
               "target_count": np.ones(n)},
    )
    xyz, dirs, labels, vals, flags = _file_to_lad_arrays(str(path), None, [0.0, 0.0, 0.0])

    assert xyz.shape == (n, 3)
    assert dirs.shape[0] == n
    # The per-pulse columns must survive the LAS round-trip, otherwise the
    # multi-return path silently degrades to single-return and G(theta) is wrong.
    for c in ("timestamp", "target_index", "target_count"):
        assert c in labels, f"{c} missing from LAD labels {labels}"
    assert _MISS_SLUG in labels
    assert vals is not None and vals.shape[0] == n


def test_lad_las_fallback_preserves_misses(tmp_path, cloud):
    """LAD is the ONE tool that must KEEP sky/miss points — they are the
    Beer's-law transmission denominator. The reader must not filter them."""
    n = cloud.shape[0]
    is_miss = np.zeros(n)
    is_miss[:50] = 1.0
    path = _write_las(tmp_path / "lad_miss.las", cloud, is_miss=is_miss,
                      extra={"timestamp": np.linspace(0, 1, n)})
    xyz, _dirs, labels, vals, flags = _file_to_lad_arrays(
        str(path), None, [0.0, 0.0, 0.0])

    assert xyz.shape[0] == n, "misses were dropped; LAD needs them"
    mi = labels.index(_MISS_SLUG)
    assert vals[:, mi].sum() == 50
    assert flags.get("has_misses") is True


def test_lad_rejects_ply_with_a_legible_error(tmp_path, cloud):
    """PLY/PCD carry no per-pulse columns, so LAD cannot use them — but the
    error must say so rather than surfacing a decoder crash."""
    p = tmp_path / "cloud.ply"
    p.write_bytes(b"ply\nformat binary_little_endian 1.0\n\xd5\xd5\xd5")
    with pytest.raises(ValueError, match="ASCII point file"):
        _file_to_lad_arrays(str(p), None, [0.0, 0.0, 0.0])


# --------------------------------------------------------------------------
# Site 3: _read_scan_columns_from_file (native export)
# --------------------------------------------------------------------------

def test_export_reads_las_scalar_columns(tmp_path, cloud):
    n = cloud.shape[0]
    is_miss = np.zeros(n)
    is_miss[:10] = 1.0
    path = _write_las(
        tmp_path / "exp.las", cloud, is_miss=is_miss,
        extra={"timestamp": np.linspace(0, 1, n)},
    )
    cols = _read_scan_columns_from_file(str(path), None)

    assert _MISS_SLUG in cols
    assert cols[_MISS_SLUG].sum() == 10
    assert "timestamp" in cols
    assert cols["timestamp"].shape == (n,)


def test_export_degrades_to_no_columns_for_ply(tmp_path):
    """Both export callers already load GEOMETRY via _load_pointcloud_arrays,
    so a container with no scalar columns must yield {} and let the export
    proceed — not abort it."""
    p = tmp_path / "cloud.ply"
    p.write_bytes(b"ply\nformat binary_little_endian 1.0\n\xd5\xd5\xd5")
    assert _read_scan_columns_from_file(str(p), None) == {}


def test_export_unreadable_las_yields_no_columns(tmp_path):
    """A corrupt LAS must not fail the export over missing scalars."""
    p = tmp_path / "broken.las"
    p.write_bytes(b"LASF" + b"\xd5" * 200)
    assert _read_scan_columns_from_file(str(p), None) == {}


def test_export_still_reads_ascii_columns(tmp_path):
    p = tmp_path / "scan.xyz"
    p.write_text("1 2 3 0.5 7\n4 5 6 0.6 8\n")
    cols = _read_scan_columns_from_file(str(p), "x y z timestamp intensity")
    assert set(cols) == {"timestamp", "intensity"}
    assert list(cols["timestamp"]) == [0.5, 0.6]
    assert list(cols["intensity"]) == [7.0, 8.0]
