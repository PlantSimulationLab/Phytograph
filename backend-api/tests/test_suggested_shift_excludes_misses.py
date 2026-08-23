"""The import wizard's suggested global shift must be measured over HIT points.

A sky/miss point is a ray that hit nothing, projected ~1 km out along the beam,
so a scan's LAS header mins describe the miss shell rather than the data. The
suggester used to read those header mins directly, which on a real RIEGL
vineyard scan (`grapex_unregistered_ScanPos001.laz`: hits within ~500 m of the
origin, misses out to +/-20 km) suggested a shift of about (-20018, -20000).
Ticking "apply the suggested offset" then SUBTRACTED 20 km from a cloud that was
already centred on the origin, teleporting it to (+19997, +20001) -- which reads
to the user as "the offset was not applied" when in fact it was applied
faithfully to a nonsense value.

Two consequences beyond the teleport, both load-bearing:
  * scans of one site got DIFFERENT suggestions (each scanner's own miss shell),
    and `importShift.test.ts` exists precisely because per-file shifts draw
    registered scans in different frames.
  * a cloud that needs no shift at all was offered one.
"""
import numpy as np
import pytest

import main


def _write_las(tmp_path, hits, misses, name="scan.laz", with_miss_dim=True):
    """A LAS/LAZ file whose header mins are dominated by the miss shell."""
    laspy = pytest.importorskip("laspy")
    xyz = np.vstack([hits, misses]) if len(misses) else np.asarray(hits)
    header = laspy.LasHeader(version="1.4", point_format=6)
    if with_miss_dim:
        header.add_extra_dim(laspy.ExtraBytesParams(name="is_miss", type=np.float32))
    header.offsets = np.floor(xyz.min(axis=0))
    header.scales = [0.001, 0.001, 0.001]
    las = laspy.LasData(header)
    las.x, las.y, las.z = xyz[:, 0], xyz[:, 1], xyz[:, 2]
    if with_miss_dim:
        las.is_miss = np.concatenate(
            [np.zeros(len(hits)), np.ones(len(misses))]).astype(np.float32)
    path = tmp_path / name
    las.write(str(path))
    return str(path)


def _blank_preview():
    return main.PointCloudPreviewResponse(
        kind="laz", delimiter=None, has_header=False, columns=[], sample_rows=[])


@pytest.fixture
def near_origin_scan(tmp_path):
    """The GrapeX shape: hits hugging the origin, misses ~20 km out."""
    rng = np.random.default_rng(0)
    hits = rng.uniform(-450, 450, (3000, 3))
    hits[:, 2] = rng.uniform(-30, 55, 3000)
    misses = rng.uniform(-20000, 20000, (3000, 3))
    return _write_las(tmp_path, hits, misses), hits


def test_near_origin_scan_with_misses_is_offered_no_shift(near_origin_scan):
    """The bug's headline symptom: a cloud already at the origin got a 20 km shift."""
    path, _ = near_origin_scan
    assert main._suggest_global_shift(path, _blank_preview()) is None


def test_header_mins_would_have_suggested_a_20km_shift(near_origin_scan):
    """Guard the premise -- if the header mins were harmless the test above is moot."""
    laspy = pytest.importorskip("laspy")
    path, _ = near_origin_scan
    header_mins = np.asarray(laspy.open(path).header.mins, dtype=np.float64)
    assert np.abs(header_mins).max() > main._SHIFT_SUGGEST_THRESHOLD


def test_hit_mins_ignore_the_miss_shell(near_origin_scan):
    path, hits = near_origin_scan
    probed = main._las_hit_mins(path)
    assert probed is not None
    np.testing.assert_allclose(probed, hits.min(axis=0), atol=1e-2)


def test_genuinely_distant_cloud_still_gets_a_shift(tmp_path):
    """The feature still works: a UTM cloud with misses is shifted by the HIT min,
    not by the (further-out) header min."""
    rng = np.random.default_rng(1)
    hits = rng.normal(0, 5, (2000, 3)) + np.array([500123.0, 4200456.0, 120.0])
    misses = hits + np.array([-900.0, -900.0, 900.0])
    path = _write_las(tmp_path, hits, misses)

    shift = main._suggest_global_shift(path, _blank_preview())
    assert shift is not None
    np.testing.assert_allclose(shift, np.floor(hits.min(axis=0)), atol=1e-6)

    # Applying it lands the cloud at the origin -- the whole point of the shift.
    shifted_min = hits.min(axis=0) - np.asarray(shift)
    assert np.all(np.abs(shifted_min) < 1.0)


def test_file_without_a_miss_dimension_still_uses_header_mins(tmp_path):
    """No is_miss column means nothing to exclude; don't regress the plain case."""
    rng = np.random.default_rng(2)
    hits = rng.normal(0, 5, (1000, 3)) + np.array([500123.0, 4200456.0, 120.0])
    path = _write_las(tmp_path, hits, np.empty((0, 3)), with_miss_dim=False)

    assert main._las_hit_mins(path) is None  # nothing to probe
    shift = main._suggest_global_shift(path, _blank_preview())
    np.testing.assert_allclose(shift, np.floor(hits.min(axis=0)), atol=1e-6)


def test_ascii_export_reimport_excludes_misses(tmp_path):
    """This app writes is_miss as an ASCII column too, so a re-imported scan hits
    the same shell. Roles come from the preview, the same way import does."""
    rng = np.random.default_rng(3)
    hits = rng.uniform(-450, 450, (500, 3))
    misses = rng.uniform(-20000, 20000, (500, 3))
    rows = np.vstack([
        np.column_stack([hits, np.zeros(len(hits))]),
        np.column_stack([misses, np.ones(len(misses))]),
    ])
    path = tmp_path / "scan.xyz"
    np.savetxt(str(path), rows, fmt="%.4f", delimiter=" ",
               header="x y z is_miss")

    preview = main.preview_pointcloud(
        main.PointCloudPreviewRequest(file_path=str(path)))
    slugs = [c.suggested_slug for c in preview.columns]
    assert main._MISS_SLUG in slugs, f"is_miss not detected in {slugs}"

    assert main._suggest_global_shift(str(path), preview) is None


def test_ascii_axis_mapping_survives_out_of_order_columns(tmp_path):
    """Adding is_miss to `usecols` means pandas no longer returns the columns in
    role order -- it returns them in FILE order -- so the names have to be
    re-sorted to match. Get that wrong and x/y/z are silently transposed, which a
    symmetric fixture would never catch. Hence distinct per-axis magnitudes and a
    reversed file layout (is_miss, z, y, x)."""
    rng = np.random.default_rng(4)
    hits = rng.uniform(0, 10, (300, 3)) + np.array([500000.0, 4200000.0, 300.0])
    misses = hits + np.array([-900.0, -900.0, 900.0])
    rows = np.vstack([
        np.column_stack([np.zeros(len(hits)), hits[:, 2], hits[:, 1], hits[:, 0]]),
        np.column_stack([np.ones(len(misses)), misses[:, 2], misses[:, 1], misses[:, 0]]),
    ])
    path = tmp_path / "reversed.xyz"
    np.savetxt(str(path), rows, fmt="%.4f", delimiter=" ", header="is_miss z y x")

    preview = main.preview_pointcloud(
        main.PointCloudPreviewRequest(file_path=str(path)))
    shift = main._suggest_global_shift(str(path), preview)

    assert shift is not None
    np.testing.assert_allclose(shift, np.floor(hits.min(axis=0)), atol=1e-6)
