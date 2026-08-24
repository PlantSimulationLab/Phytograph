"""Tests for `octree_transform` — the in-place rigid transform of a built octree.

These build a REAL octree with the bundled PotreeConverter and then transform it,
because the whole point of the module is fidelity to that binary format. A
fabricated octree.bin would pass while telling us nothing about whether the
converter's actual output survives a rewrite.

The load-bearing assertion is EQUIVALENCE: translating a built octree in place
must land in the same place as converting the already-translated cloud from
scratch. That is the property the fast path trades on, so it is tested against an
independent reconvert rather than against the transform's own arithmetic.
"""

import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

import main
import octree_transform
from octree_transform import (OctreeTransformError, classify_matrix,
                              read_metadata, translate_octree_dir)


def _converter_available() -> bool:
    try:
        main._resolve_potree_converter_path()
        return True
    except Exception:
        return False


needs_converter = pytest.mark.skipif(
    not _converter_available(),
    reason="PotreeConverter not built (npm run build:backend)",
)


def _write_las(path: Path, pts: np.ndarray) -> None:
    """Minimal LAS writer mirroring the header layout `_session_to_las` uses.

    Every non-position attribute is filled with DISTINCT, NON-ZERO, per-point
    values. This is load-bearing, not decoration: with laspy's defaults those
    fields are all zero, so a bug that clobbered them would leave the bytes at
    zero and `test_structure_and_attributes_are_preserved` would pass while the
    attributes were being destroyed. Verified by sabotage — zeroing a byte next
    to the position field went undetected until these values were added.
    """
    import laspy

    n = len(pts)
    rng = np.random.default_rng(101)
    header = laspy.LasHeader(point_format=3, version="1.4")
    header.scales = np.array([0.001, 0.001, 0.001], dtype=np.float64)
    header.offsets = np.floor(pts.min(axis=0))
    las = laspy.LasData(header)
    las.x, las.y, las.z = pts[:, 0], pts[:, 1], pts[:, 2]
    las.intensity = rng.integers(1, 65535, size=n, dtype=np.uint16)
    las.return_number = rng.integers(1, 6, size=n, dtype=np.uint8)
    las.number_of_returns = rng.integers(1, 6, size=n, dtype=np.uint8)
    las.classification = rng.integers(1, 31, size=n, dtype=np.uint8)
    las.user_data = rng.integers(1, 255, size=n, dtype=np.uint8)
    las.point_source_id = rng.integers(1, 65535, size=n, dtype=np.uint16)
    las.gps_time = rng.uniform(1.0, 1e6, size=n)
    las.red = rng.integers(1, 65535, size=n, dtype=np.uint16)
    las.green = rng.integers(1, 65535, size=n, dtype=np.uint16)
    las.blue = rng.integers(1, 65535, size=n, dtype=np.uint16)
    las.write(str(path))


def _convert(las: Path, out_dir: Path) -> Path:
    converter = main._resolve_potree_converter_path()
    out_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run([str(converter), str(las), "-o", str(out_dir)],
                   check=True, capture_output=True)
    return out_dir


def _cloud(n: int = 40_000, seed: int = 11) -> np.ndarray:
    """A clustered cloud with unequal per-axis extent, so a bug that mixes up
    axes (or collapses to a cube) shows up as a mismatch rather than passing by
    symmetry."""
    rng = np.random.default_rng(seed)
    pts = rng.normal(0.0, 3.0, size=(n, 3))
    pts[:, 1] *= 0.5          # anisotropic
    pts[:, 2] = np.abs(pts[:, 2]) * 0.4
    return pts


def _decode_positions(octree_dir: Path) -> np.ndarray:
    """Decode every point's world position: world = int32 * scale + offset."""
    meta = read_metadata(octree_dir)
    pos_offset, stride, _ = octree_transform._position_layout(meta)
    raw = np.fromfile(octree_dir / "octree.bin", dtype=np.uint8)
    rows = raw.reshape(-1, stride)
    ints = rows[:, pos_offset:pos_offset + 12].copy().view(np.int32).reshape(-1, 3)
    return ints * np.asarray(meta["scale"]) + np.asarray(meta["offset"])


def _non_position_bytes(octree_dir: Path) -> np.ndarray:
    meta = read_metadata(octree_dir)
    pos_offset, stride, _ = octree_transform._position_layout(meta)
    rows = np.fromfile(octree_dir / "octree.bin", dtype=np.uint8).reshape(-1, stride)
    return np.delete(rows, np.s_[pos_offset:pos_offset + 12], axis=1)


def _rowmajor(R: np.ndarray = None, t=(0.0, 0.0, 0.0)) -> list:
    m = np.eye(4)
    if R is not None:
        m[:3, :3] = R
    m[:3, 3] = t
    return m.reshape(-1).tolist()


def _rot_z(deg: float) -> np.ndarray:
    th = np.deg2rad(deg)
    c, s = np.cos(th), np.sin(th)
    return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])


# ---------------------------------------------------------------- classifier

def test_pure_translation_is_detected():
    ok, delta = classify_matrix(_rowmajor(t=(10.0, -4.0, 0.5)))
    assert ok
    np.testing.assert_allclose(delta, [10.0, -4.0, 0.5])


@pytest.mark.parametrize("deg", [0.5, 5.0, 30.0, 90.0])
def test_rotation_is_rejected(deg):
    """Rotation must never take the fast path: node membership is octant
    containment in an axis-aligned cube, so a rotated cloud re-buckets (88 % of
    points at 30 degrees) and the existing hierarchy stops describing it."""
    ok, _ = classify_matrix(_rowmajor(R=_rot_z(deg), t=(1.0, 2.0, 3.0)))
    assert not ok


def test_float_noise_rotation_still_counts_as_translation():
    """Registration matrices are float64 products of several transforms; an
    exact identity test would push genuine translations onto the slow path."""
    ok, _ = classify_matrix(_rowmajor(R=_rot_z(np.rad2deg(1e-12)), t=(1.0, 0.0, 0.0)))
    assert ok


def test_scale_and_projective_are_rejected():
    """Neither is rigid, so neither preserves the octree structure."""
    scaled = np.eye(4)
    scaled[:3, :3] = np.diag([2.0, 2.0, 2.0])
    assert not classify_matrix(scaled.reshape(-1).tolist())[0]

    projective = np.eye(4)
    projective[3, :] = [0.1, 0.0, 0.0, 1.0]
    assert not classify_matrix(projective.reshape(-1).tolist())[0]


def test_bad_matrix_size_raises():
    with pytest.raises(OctreeTransformError):
        classify_matrix([1.0, 2.0, 3.0])


# ------------------------------------------------------------------ rewrite

@needs_converter
def test_translation_matches_independent_reconvert(tmp_path):
    """THE core property: rewriting in place == converting the moved cloud.

    Compared by nearest-neighbour distance rather than index-wise, because the
    converter is free to order points differently; what must match is the point
    SET, to within the format's 1 mm quantisation.
    """
    from scipy.spatial import cKDTree

    pts = _cloud()
    delta = np.array([100.0, 50.0, 7.0])

    _write_las(tmp_path / "a.las", pts)
    _write_las(tmp_path / "b.las", pts + delta)
    src = _convert(tmp_path / "a.las", tmp_path / "oct_a")
    reconverted = _convert(tmp_path / "b.las", tmp_path / "oct_b")

    translate_octree_dir(src, tmp_path / "oct_fast", delta)

    fast = _decode_positions(tmp_path / "oct_fast")
    ref = _decode_positions(reconverted)
    assert len(fast) == len(ref)

    dist, _ = cKDTree(ref).query(fast)
    quantum = float(read_metadata(src)["scale"][0])
    # One quantisation step in each axis is the worst honest rounding error.
    assert dist.max() <= quantum * np.sqrt(3) * 1.001


@needs_converter
def test_translation_is_exact_against_analytic_transform(tmp_path):
    """Independent of the converter: every point must land within half a
    quantisation step of source + delta."""
    pts = _cloud()
    delta = np.array([-12.5, 3.25, 900.0])
    _write_las(tmp_path / "a.las", pts)
    src = _convert(tmp_path / "a.las", tmp_path / "oct_a")

    before = _decode_positions(src)
    translate_octree_dir(src, tmp_path / "oct_fast", delta)
    after = _decode_positions(tmp_path / "oct_fast")

    quantum = float(read_metadata(src)["scale"][0])
    assert np.abs(after - (before + delta)).max() <= quantum * 0.5 * 1.001


@needs_converter
def test_structure_and_attributes_are_preserved(tmp_path):
    """The node graph and every non-position attribute must survive untouched —
    this is what makes reusing the hierarchy legitimate rather than merely fast.
    """
    pts = _cloud()
    _write_las(tmp_path / "a.las", pts)
    src = _convert(tmp_path / "a.las", tmp_path / "oct_a")
    dst = tmp_path / "oct_fast"
    translate_octree_dir(src, dst, [5.0, -6.0, 7.0])

    # hierarchy.bin carries no coordinates (22-byte records: type, child mask,
    # point count, byte range) so it must be byte-identical.
    assert (src / "hierarchy.bin").read_bytes() == (dst / "hierarchy.bin").read_bytes()

    # Intensity, classification, gps-time, rgb ... all untouched.
    src_attrs = _non_position_bytes(src)
    # Guard the guard: if the fixture's attributes were all zero this comparison
    # would hold no matter what the rewrite did to them (see `_write_las`).
    assert (src_attrs != 0).any(), "fixture has no non-zero attribute bytes to preserve"
    np.testing.assert_array_equal(src_attrs, _non_position_bytes(dst))

    src_meta, dst_meta = read_metadata(src), read_metadata(dst)
    assert src_meta["spacing"] == dst_meta["spacing"]
    assert src_meta["hierarchy"] == dst_meta["hierarchy"]
    assert src_meta["scale"] == dst_meta["scale"]
    assert src_meta["points"] == dst_meta["points"]


@needs_converter
def test_metadata_bounds_follow_the_points(tmp_path):
    """Bounds that don't move would frame the camera on empty space and seed the
    crop box in the wrong place — a silent, purely-visual failure."""
    pts = _cloud()
    delta = np.array([100.0, 50.0, 7.0])
    _write_las(tmp_path / "a.las", pts)
    src = _convert(tmp_path / "a.las", tmp_path / "oct_a")

    before = read_metadata(src)
    translate_octree_dir(src, tmp_path / "oct_fast", delta)
    after = read_metadata(tmp_path / "oct_fast")

    for key in ("min", "max"):
        np.testing.assert_allclose(
            np.asarray(after["boundingBox"][key]),
            np.asarray(before["boundingBox"][key]) + delta, atol=1e-6)

    def _position_attr(meta):
        return next(a for a in meta["attributes"] if a["name"] == "position")

    np.testing.assert_allclose(
        np.asarray(_position_attr(after)["min"], dtype=float),
        np.asarray(_position_attr(before)["min"], dtype=float) + delta, atol=1e-6)
    np.testing.assert_allclose(
        np.asarray(_position_attr(after)["max"], dtype=float),
        np.asarray(_position_attr(before)["max"], dtype=float) + delta, atol=1e-6)

    # offset must stay the decode origin the points were re-based against.
    decoded = _decode_positions(tmp_path / "oct_fast")
    assert np.all(decoded.min(axis=0) >= np.asarray(after["offset"]) - 1e-6)


@needs_converter
def test_far_from_origin_translation_does_not_lose_precision(tmp_path):
    """A UTM-scale move must not blow the int32 budget. Re-basing the offset onto
    the moved data (rather than shifting the old one) is what keeps the stored
    ints small; without it a 5.4e6 m northing overflows at 1 mm scale."""
    pts = _cloud(n=20_000)
    delta = np.array([500_000.0, 5_400_000.0, 120.0])
    _write_las(tmp_path / "a.las", pts)
    src = _convert(tmp_path / "a.las", tmp_path / "oct_a")

    before = _decode_positions(src)
    translate_octree_dir(src, tmp_path / "oct_fast", delta)
    after = _decode_positions(tmp_path / "oct_fast")

    quantum = float(read_metadata(src)["scale"][0])
    assert np.abs(after - (before + delta)).max() <= quantum * 0.5 * 1.001

    meta = read_metadata(tmp_path / "oct_fast")
    ints = np.rint((after - np.asarray(meta["offset"])) / np.asarray(meta["scale"]))
    assert np.abs(ints).max() < 2**31 - 1


@needs_converter
def test_repeated_translations_do_not_accumulate_error(tmp_path):
    """Registration can move a cloud more than once; rounding must stay bounded
    rather than compounding."""
    pts = _cloud(n=20_000)
    _write_las(tmp_path / "a.las", pts)
    src = _convert(tmp_path / "a.las", tmp_path / "oct_a")
    before = _decode_positions(src)

    steps = [np.array([1.5, -2.5, 0.75]), np.array([-10.0, 4.0, 3.0]),
             np.array([7.25, 8.5, -1.25])]
    cur = src
    for i, step in enumerate(steps):
        nxt = tmp_path / f"oct_step{i}"
        translate_octree_dir(cur, nxt, step)
        cur = nxt

    after = _decode_positions(cur)
    quantum = float(read_metadata(src)["scale"][0])
    total = np.sum(steps, axis=0)
    # Bounded by one half-step per hop, not by the number of points.
    assert np.abs(after - (before + total)).max() <= quantum * 0.5 * len(steps) * 1.001


@needs_converter
def test_zero_translation_is_a_faithful_copy(tmp_path):
    """Identity must be a no-op, not a slow re-quantisation drift."""
    pts = _cloud(n=10_000)
    _write_las(tmp_path / "a.las", pts)
    src = _convert(tmp_path / "a.las", tmp_path / "oct_a")
    translate_octree_dir(src, tmp_path / "oct_same", [0.0, 0.0, 0.0])

    np.testing.assert_array_equal(
        (src / "octree.bin").read_bytes(),
        (tmp_path / "oct_same" / "octree.bin").read_bytes())


@needs_converter
def test_sidecars_are_carried_across(tmp_path):
    """The slug->label sidecar drives the renderer's scalar picker; dropping it
    would blank every custom column name after a transform."""
    pts = _cloud(n=5_000)
    _write_las(tmp_path / "a.las", pts)
    src = _convert(tmp_path / "a.las", tmp_path / "oct_a")
    (src / main._OCTREE_LABELS_FILENAME).write_text(json.dumps({"foo": "Foo Label"}))

    dst = tmp_path / "oct_fast"
    translate_octree_dir(src, dst, [1.0, 1.0, 1.0])
    assert json.loads((dst / main._OCTREE_LABELS_FILENAME).read_text()) == {"foo": "Foo Label"}


# ------------------------------------------------------------------ refusals

def test_compressed_encoding_is_refused(tmp_path):
    """BROTLI point records are not fixed-stride raw bytes, so rewriting the
    position field in place would corrupt them."""
    d = tmp_path / "oct"
    d.mkdir()
    (d / "metadata.json").write_text(json.dumps({
        "encoding": "BROTLI", "scale": [0.001] * 3, "offset": [0.0] * 3,
        "attributes": [{"name": "position", "size": 12, "numElements": 3,
                        "type": "int32"}],
    }))
    (d / "octree.bin").write_bytes(b"")
    with pytest.raises(OctreeTransformError, match="not addressable"):
        translate_octree_dir(d, tmp_path / "out", [1.0, 0.0, 0.0])


def test_unexpected_position_layout_is_refused(tmp_path):
    """A future converter that changes the position type must fall back to a
    rebuild rather than have its bytes reinterpreted as int32."""
    d = tmp_path / "oct"
    d.mkdir()
    (d / "metadata.json").write_text(json.dumps({
        "encoding": "DEFAULT", "scale": [0.001] * 3, "offset": [0.0] * 3,
        "attributes": [{"name": "position", "size": 24, "numElements": 3,
                        "type": "double"}],
    }))
    (d / "octree.bin").write_bytes(b"")
    with pytest.raises(OctreeTransformError):
        translate_octree_dir(d, tmp_path / "out", [1.0, 0.0, 0.0])


def test_missing_metadata_is_refused(tmp_path):
    d = tmp_path / "empty"
    d.mkdir()
    with pytest.raises(OctreeTransformError, match="metadata.json missing"):
        translate_octree_dir(d, tmp_path / "out", [1.0, 0.0, 0.0])


def test_truncated_octree_bin_is_refused(tmp_path):
    """A size that isn't a whole number of point records means the stride is
    wrong; reshaping anyway would silently scramble the cloud."""
    d = tmp_path / "oct"
    d.mkdir()
    (d / "metadata.json").write_text(json.dumps({
        "encoding": "DEFAULT", "scale": [0.001] * 3, "offset": [0.0] * 3,
        "attributes": [{"name": "position", "size": 12, "numElements": 3,
                        "type": "int32"}],
    }))
    (d / "octree.bin").write_bytes(b"\x00" * 17)   # not a multiple of 12
    with pytest.raises(OctreeTransformError, match="not a multiple"):
        translate_octree_dir(d, tmp_path / "out", [1.0, 0.0, 0.0])


def test_inf_and_nan_literals_in_metadata_parse(tmp_path):
    """PotreeConverter emits bare inf/nan on uninitialised min/max; strict JSON
    rejects them, so the reader must scrub before parsing (mirrors
    main._read_octree_metadata)."""
    d = tmp_path / "oct"
    d.mkdir()
    (d / "metadata.json").write_text(
        '{"encoding":"DEFAULT","scale":[0.001,0.001,0.001],"offset":[0,0,0],'
        '"attributes":[{"name":"position","size":12,"numElements":3,"type":"int32",'
        '"min":[-inf,-inf,-inf],"max":[inf,inf,nan]}]}')
    meta = read_metadata(d)
    assert meta["attributes"][0]["min"] == [None, None, None]
