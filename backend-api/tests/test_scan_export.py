"""Tests for the scan-export endpoint (`_do_scan_export` / POST /api/scan/export-xml).

The export writes a Helios scan XML plus ONE ASCII data file per scan. The key
correctness properties:
  * per-scan data files (never merged) so the XML can reference each by scan,
  * the `is_miss` flag (and other per-hit scalar columns) preserved,
  * `include_misses=False` drops miss rows AND the now-uniform is_miss column,
  * viewer translation applied to the exported coordinates,
  * the bundle round-trips back through PyHelios `loadXML()` with misses intact.

These exercise the real native export path, so they importorskip pyhelios.
"""

import base64
import os
import re

import pytest

import main


def _decode(files, suffix):
    """Return the decoded text of the first returned file ending with `suffix`."""
    f = next(f for f in files if f["name"].endswith(suffix))
    return base64.b64decode(f["data"]).decode()


def _inline_entry(points, miss=None, translation=None):
    cols = {"is_miss": list(miss)} if miss is not None else None
    return main.ScanExportEntry(
        origin=[0.0, 0.0, 3.0], n_theta=20, n_phi=20,
        theta_min=0, theta_max=180, phi_min=0, phi_max=360,
        points=[list(p) for p in points], scalar_columns=cols,
        translation=list(translation) if translation is not None else None)


_PTS = [[0.1, 0.1, 0.5], [-0.1, 0.0, 0.6], [0.2, -0.1, 0.4], [9.0, 9.0, 9.0]]
_MISS = [0, 0, 0, 1]  # last row is a sky/miss point


class TestScanExportShape:
    def test_writes_one_data_file_per_scan(self):
        pytest.importorskip("pyhelios")
        # Two scans → exactly two data files + one XML, named by scan id.
        req = main.ScanExportRequest(
            scans=[_inline_entry(_PTS, _MISS), _inline_entry(_PTS, _MISS)],
            base_name="bundle", include_misses=True)
        res = main._do_scan_export(req)
        assert res["success"] is True, res.get("error")
        names = sorted(f["name"] for f in res["files"])
        assert names == ["bundle.xml", "bundle_0.xyz", "bundle_1.xyz"]
        # The XML references each per-scan file (not a single merged file).
        xml = _decode(res["files"], ".xml")
        assert "bundle_0.xyz" in xml and "bundle_1.xyz" in xml

    def test_base_name_extension_is_stripped(self):
        # A base_name carrying a foreign extension (or a path) must not leak into
        # the file names: the metadata file is always <clean>.xml and the data
        # files are always Helios .xyz, so the bundle stays re-loadable.
        pytest.importorskip("pyhelios")
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[_inline_entry(_PTS, _MISS)],
            base_name="/some/dir/myscan.las", include_misses=True))
        assert res["success"] is True, res.get("error")
        names = sorted(f["name"] for f in res["files"])
        assert names == ["myscan.xml", "myscan_0.xyz"]
        # Every non-XML data file is .xyz, and the XML references the .xyz file.
        assert all(f["name"].endswith(".xyz") for f in res["files"] if not f["is_xml"])
        assert "myscan_0.xyz" in _decode(res["files"], ".xml")
        assert ".las" not in _decode(res["files"], ".xml")

    def test_includes_misses_and_is_miss_column(self):
        pytest.importorskip("pyhelios")
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[_inline_entry(_PTS, _MISS)], base_name="s", include_misses=True))
        assert res["success"] is True, res.get("error")
        xml = _decode(res["files"], ".xml")
        fmt = re.search(r"<ASCII_format>(.*?)</ASCII_format>", xml).group(1)
        assert fmt.split() == ["x", "y", "z", "is_miss"]
        data = [l for l in _decode(res["files"], ".xyz").splitlines() if l and l[0] != "#"]
        # All four rows written, including the miss (flagged 1 in the last column).
        assert len(data) == 4
        assert data[-1].split()[-1] == "1"

    def test_data_only_mode_writes_no_xml(self):
        # write_xml=False → only the per-scan .xyz data files, no XML metadata.
        pytest.importorskip("pyhelios")
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[_inline_entry(_PTS, _MISS), _inline_entry(_PTS, _MISS)],
            base_name="bundle", include_misses=True, write_xml=False))
        assert res["success"] is True, res.get("error")
        names = sorted(f["name"] for f in res["files"])
        # Two data files, no XML, still one file per scan.
        assert names == ["bundle_0.xyz", "bundle_1.xyz"]
        assert not any(f["is_xml"] for f in res["files"])
        # The data still carries the header + is_miss column (only the XML is gone).
        data = _decode(res["files"], "_0.xyz")
        assert data.splitlines()[0].startswith("# x y z is_miss")

    def test_exclude_misses_drops_rows_and_column(self):
        pytest.importorskip("pyhelios")
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[_inline_entry(_PTS, _MISS)], base_name="s", include_misses=False))
        assert res["success"] is True, res.get("error")
        xml = _decode(res["files"], ".xml")
        fmt = re.search(r"<ASCII_format>(.*?)</ASCII_format>", xml).group(1)
        # is_miss column gone — every surviving row is a return.
        assert fmt.split() == ["x", "y", "z"]
        data = [l for l in _decode(res["files"], ".xyz").splitlines() if l and l[0] != "#"]
        assert len(data) == 3  # the one miss row was dropped

    def test_columns_override_controls_order(self):
        # An explicit `columns` list sets the ASCII_format order; x/y/z are always
        # written, and only the listed scalar columns (here is_miss) are included.
        pytest.importorskip("pyhelios")
        entry = main.ScanExportEntry(
            origin=[0.0, 0.0, 3.0], n_theta=20, n_phi=20,
            theta_min=0, theta_max=180, phi_min=0, phi_max=360,
            points=[list(p) for p in _PTS], scalar_columns={"is_miss": list(_MISS)},
            columns=["x", "y", "z", "is_miss"])
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[entry], base_name="s", include_misses=True))
        assert res["success"] is True, res.get("error")
        fmt = re.search(r"<ASCII_format>(.*?)</ASCII_format>", _decode(res["files"], ".xml")).group(1)
        assert fmt.split() == ["x", "y", "z", "is_miss"]

    def test_is_miss_forced_when_columns_omit_it(self):
        # Regression: a synthetic scan exported with "include misses" ON but a
        # column picker that DROPPED is_miss (e.g. ASCII_format "x y z timestamp")
        # used to write the far-field miss ROWS with no sentinel COLUMN, so the
        # round-trip lost every miss signal and the points re-imported as real
        # returns. is_miss must be forced back in whenever misses are written.
        pytest.importorskip("pyhelios")
        entry = main.ScanExportEntry(
            origin=[0.0, 0.0, 3.0], n_theta=20, n_phi=20,
            theta_min=0, theta_max=180, phi_min=0, phi_max=360,
            points=[list(p) for p in _PTS],
            scalar_columns={"is_miss": list(_MISS), "timestamp": [0, 1, 2, 3]},
            columns=["x", "y", "z", "timestamp"])  # is_miss deliberately omitted
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[entry], base_name="s", include_misses=True))
        assert res["success"] is True, res.get("error")
        fmt = re.search(r"<ASCII_format>(.*?)</ASCII_format>",
                        _decode(res["files"], ".xml")).group(1).split()
        assert "is_miss" in fmt, f"is_miss must survive export; got {fmt}"
        # And the flagged row carries a 1 (the far-field miss).
        data = [l for l in _decode(res["files"], ".xyz").splitlines()
                if l and l[0] != "#"]
        mi = fmt.index("is_miss")
        flags = [int(float(row.split()[mi])) for row in data]
        assert sum(flags) == sum(_MISS) == 1

    def test_is_miss_forced_in_data_only_csv(self):
        # Same guarantee on the data-only (write_xml=False) per-format path, which
        # flows through the other resolver (_resolve_scan_for_format).
        pytest.importorskip("pyhelios")
        entry = main.ScanExportEntry(
            origin=[0, 0, 3], n_theta=20, n_phi=20,
            points=[list(p) for p in _PTS],
            scalar_columns={"is_miss": list(_MISS), "reflectance": [0.1, 0.2, 0.3, 0.4]},
            columns=["x", "y", "z", "reflectance"])  # is_miss omitted
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[entry], base_name="b", include_misses=True,
            write_xml=False, data_format="csv"))
        head = base64.b64decode(res["files"][0]["data"]).decode().splitlines()[0]
        assert "is_miss" in head.split(","), head

    def test_translation_is_applied(self):
        pytest.importorskip("pyhelios")
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[_inline_entry(_PTS, _MISS, translation=[10, 20, 30])],
            base_name="s", include_misses=True))
        assert res["success"] is True, res.get("error")
        data = [l for l in _decode(res["files"], ".xyz").splitlines() if l and l[0] != "#"]
        x, y, z = (float(v) for v in data[0].split()[:3])
        # First point [0.1, 0.1, 0.5] + [10, 20, 30].
        assert abs(x - 10.1) < 1e-3 and abs(y - 20.1) < 1e-3 and abs(z - 30.5) < 1e-3


class TestScanExportDataFormats:
    """Data-only mode (write_xml=False): one file per scan in the chosen format."""

    @pytest.mark.parametrize("fmt", ["xyz", "csv", "txt", "ply", "obj", "las", "laz", "e57"])
    def test_each_format_writes_one_file_per_scan(self, fmt):
        pytest.importorskip("pyhelios")
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[_inline_entry(_PTS, _MISS), _inline_entry(_PTS, _MISS)],
            base_name="b", include_misses=True, write_xml=False, data_format=fmt))
        assert res["success"] is True, res.get("error")
        names = sorted(f["name"] for f in res["files"])
        assert names == [f"b_0.{fmt}", f"b_1.{fmt}"]
        assert not any(f["is_xml"] for f in res["files"])

    def test_ascii_data_honors_column_order(self):
        pytest.importorskip("pyhelios")
        # Column ordering is honored among the chosen scalars. Use a no-miss cloud
        # so the forced is_miss column (see test_is_miss_forced_*) doesn't muddy the
        # assertion — this test is purely about respecting the requested order.
        entry = main.ScanExportEntry(
            origin=[0, 0, 3], n_theta=20, n_phi=20,
            points=[list(p) for p in _PTS],
            scalar_columns={"reflectance": [0.1, 0.2, 0.3, 0.4],
                            "target_index": [0, 0, 0, 0]},
            columns=["x", "y", "z", "target_index", "reflectance"])
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[entry], base_name="b", include_misses=True,
            write_xml=False, data_format="csv"))
        head = base64.b64decode(res["files"][0]["data"]).decode().splitlines()[0]
        assert head == "x,y,z,target_index,reflectance"

    def test_e57_round_trips(self, tmp_path):
        pytest.importorskip("pyhelios")
        import pye57
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[_inline_entry(_PTS, _MISS)], base_name="b",
            include_misses=True, write_xml=False, data_format="e57"))
        p = tmp_path / res["files"][0]["name"]
        p.write_bytes(base64.b64decode(res["files"][0]["data"]))
        rd = pye57.E57(str(p))
        assert rd.scan_count == 1
        sc = rd.read_scan_raw(0)
        assert len(sc["cartesianX"]) == 4

    def test_las_preserves_scalar_as_extra_dim(self, tmp_path):
        pytest.importorskip("pyhelios")
        import laspy
        entry = main.ScanExportEntry(
            origin=[0, 0, 3], n_theta=20, n_phi=20,
            points=[list(p) for p in _PTS],
            scalar_columns={"reflectance": [0.1, 0.2, 0.3, 0.4]},
            columns=["x", "y", "z", "reflectance"])
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[entry], base_name="b", include_misses=True,
            write_xml=False, data_format="las"))
        p = tmp_path / res["files"][0]["name"]
        p.write_bytes(base64.b64decode(res["files"][0]["data"]))
        las = laspy.read(str(p))
        assert "reflectance" in las.point_format.dimension_names

    def test_unknown_format_fails(self):
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[_inline_entry(_PTS)], base_name="b",
            include_misses=True, write_xml=False, data_format="bogus"))
        assert res["success"] is False
        assert "format" in res["error"].lower()


class TestScanExportRoundTrip:
    def test_bundle_reloads_with_misses(self, tmp_path):
        pytest.importorskip("pyhelios")
        from pyhelios import LiDARCloud

        res = main._do_scan_export(main.ScanExportRequest(
            scans=[_inline_entry(_PTS, _MISS)], base_name="rt", include_misses=True))
        assert res["success"] is True, res.get("error")
        # Write the bundle to disk and reload it through PyHelios loadXML.
        for f in res["files"]:
            (tmp_path / f["name"]).write_bytes(base64.b64decode(f["data"]))
        cwd = os.getcwd()
        os.chdir(tmp_path)
        try:
            cloud = LiDARCloud()
            cloud.disableMessages()
            cloud.loadXML("rt.xml")
            assert cloud.getHitCount() == 4
            assert cloud.hasMisses() is True
            miss = [cloud.getHitData(i, "is_miss") for i in range(cloud.getHitCount())]
            assert sum(1 for m in miss if m == 1.0) == 1
        finally:
            os.chdir(cwd)


class TestMultibeamExport:
    """Spinning-multibeam scans export as <scanPattern>/<beamElevationAngles>."""

    def _multibeam_entry(self):
        return main.ScanExportEntry(
            origin=[0.0, 0.0, 3.0],
            scan_pattern="spinning_multibeam",
            beam_elevation_angles_deg=[15.0, 5.0, -5.0, -15.0],
            n_phi=20, phi_min=0, phi_max=360,
            points=[list(p) for p in _PTS], scalar_columns={"is_miss": list(_MISS)})

    def test_xml_carries_pattern_and_elevation_tags(self):
        pytest.importorskip("pyhelios")
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[self._multibeam_entry()], base_name="mb", include_misses=True))
        assert res["success"] is True, res.get("error")
        xml = _decode(res["files"], ".xml")
        # helios-core's exportScans writes the multibeam marker + per-channel angles.
        assert re.search(r"<scanPattern>\s*spinning_multibeam\s*</scanPattern>", xml)
        elev = re.search(r"<beamElevationAngles>(.*?)</beamElevationAngles>", xml)
        assert elev is not None
        vals = [float(v) for v in elev.group(1).split()]
        # Four channels, recovered to within rounding of the input elevations.
        assert len(vals) == 4
        assert vals[0] == pytest.approx(15.0, abs=1e-3)
        assert vals[-1] == pytest.approx(-15.0, abs=1e-3)

    def test_multibeam_bundle_reloads_as_multibeam(self, tmp_path):
        pytest.importorskip("pyhelios")
        from pyhelios import LiDARCloud
        from pyhelios.LiDARCloud import ScanPattern, ScanMode

        res = main._do_scan_export(main.ScanExportRequest(
            scans=[self._multibeam_entry()], base_name="mbrt", include_misses=True))
        assert res["success"] is True, res.get("error")
        names = [f["name"] for f in res["files"]]
        # PyHelios v0.1.24's addScanSpinning round-trip emits a trajectory sidecar
        # CSV per spinning scan (the "spin in place" trajectory), referenced by the
        # XML's <trajectoryFile>; it must be in the bundle or loadXML can't reload.
        assert "mbrt_0_traj.csv" in names, names
        for f in res["files"]:
            (tmp_path / f["name"]).write_bytes(base64.b64decode(f["data"]))
        cwd = os.getcwd()
        os.chdir(tmp_path)
        try:
            cloud = LiDARCloud()
            cloud.disableMessages()
            cloud.loadXML("mbrt.xml")
            assert cloud.getScanPattern(0) == ScanPattern.SPINNING_MULTIBEAM
            assert cloud.getScanMode(0) == ScanMode.SPINNING
            # Ntheta == number of channels we exported.
            assert cloud.getScanSizeTheta(0) == 4
        finally:
            os.chdir(cwd)

    def test_empty_elevation_list_fails(self):
        pytest.importorskip("pyhelios")
        entry = main.ScanExportEntry(
            origin=[0.0, 0.0, 3.0], scan_pattern="spinning_multibeam",
            beam_elevation_angles_deg=[], n_phi=20,
            points=[list(p) for p in _PTS])
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[entry], base_name="mb", include_misses=True))
        assert res["success"] is False
        assert "elevation" in res["error"].lower()


class TestScanExportGrids:
    """`grids` (XML mode) injects <grid> blocks so a bundle round-trips its grid.

    PyHelios exportScans() writes only <scan> blocks, so the export post-processes
    the XML to add the requested grids — mirroring sphere.xml's <grid> element.
    """

    def _grid(self, rotation=0.0):
        # The 2x2x2, 45deg grid from example-datasets/sphere.xml.
        return main.ScanExportGrid(
            center=[0.0, 0.0, 0.5], size=[0.5, 0.5, 0.5],
            nx=2, ny=2, nz=2, rotation=rotation)

    def test_grid_block_written_with_rotation(self):
        pytest.importorskip("pyhelios")
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[_inline_entry(_PTS, _MISS)], base_name="g",
            include_misses=True, grids=[self._grid(rotation=45.0)]))
        assert res["success"] is True, res.get("error")
        xml = _decode(res["files"], ".xml")
        # One well-formed <grid> block carrying sphere.xml's center/size/N/rotation.
        grid = re.search(r"<grid>(.*?)</grid>", xml, re.S)
        assert grid is not None, xml
        body = grid.group(1)
        assert re.search(r"<center>\s*0\.0?\s+0\.0?\s+0\.5\s*</center>", body), body
        assert re.search(r"<size>\s*0\.5\s+0\.5\s+0\.5\s*</size>", body), body
        assert re.search(r"<Nx>\s*2\s*</Nx>", body)
        assert re.search(r"<Ny>\s*2\s*</Ny>", body)
        assert re.search(r"<Nz>\s*2\s*</Nz>", body)
        assert re.search(r"<rotation>\s*45(\.0)?\s*</rotation>", body), body
        # Injected inside the helios document, before the closing tag.
        assert xml.rstrip().endswith("</helios>")
        assert xml.index("<grid>") < xml.index("</helios>")

    def test_no_grids_writes_no_grid_block(self):
        pytest.importorskip("pyhelios")
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[_inline_entry(_PTS, _MISS)], base_name="ng",
            include_misses=True))  # grids defaults to None
        assert res["success"] is True, res.get("error")
        assert "<grid>" not in _decode(res["files"], ".xml")

    def test_zero_rotation_omits_rotation_tag(self):
        pytest.importorskip("pyhelios")
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[_inline_entry(_PTS, _MISS)], base_name="z",
            include_misses=True, grids=[self._grid(rotation=0.0)]))
        xml = _decode(res["files"], ".xml")
        assert "<grid>" in xml and "<rotation>" not in xml

    def test_bundle_with_grid_reloads_through_pyhelios(self, tmp_path):
        # The injected XML must stay parseable by Helios: reload and confirm the
        # 2x2x2 grid materializes as 8 cells. This is the real round-trip.
        pytest.importorskip("pyhelios")
        from pyhelios import LiDARCloud

        res = main._do_scan_export(main.ScanExportRequest(
            scans=[_inline_entry(_PTS, _MISS)], base_name="grt",
            include_misses=True, grids=[self._grid(rotation=45.0)]))
        assert res["success"] is True, res.get("error")
        for f in res["files"]:
            (tmp_path / f["name"]).write_bytes(base64.b64decode(f["data"]))
        cwd = os.getcwd()
        os.chdir(tmp_path)
        try:
            cloud = LiDARCloud()
            cloud.disableMessages()
            cloud.loadXML("grt.xml")
            assert cloud.getGridCellCount() == 8
        finally:
            os.chdir(cwd)


class TestScanExportColumnOffsets:
    """A terrain-following ("snapped") grid round-trips its per-column z offsets
    via a <columnOffsets> tag (+ <keptColumns> when some columns were dropped).
    Helios's loader ignores these unknown tags, so the bundle stays loadable."""

    def _snapped_grid(self, kept=None):
        # 2x2 columns (nx*ny == 4) → four offsets, row-major [j*nx+i].
        return main.ScanExportGrid(
            center=[0.0, 0.0, 1.0], size=[2.0, 2.0, 2.0], nx=2, ny=2, nz=1,
            column_offsets=[0.0, 0.1, 0.2, 0.3], kept_columns=kept)

    def test_column_offsets_written_in_order(self):
        pytest.importorskip("pyhelios")
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[_inline_entry(_PTS, _MISS)], base_name="co",
            include_misses=True, grids=[self._snapped_grid()]))
        assert res["success"] is True, res.get("error")
        body = re.search(r"<grid>(.*?)</grid>", _decode(res["files"], ".xml"), re.S).group(1)
        off = re.search(r"<columnOffsets>(.*?)</columnOffsets>", body)
        assert off is not None, body
        vals = [float(v) for v in off.group(1).split()]
        assert vals == pytest.approx([0.0, 0.1, 0.2, 0.3])

    def test_kept_columns_written_when_some_dropped(self):
        pytest.importorskip("pyhelios")
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[_inline_entry(_PTS, _MISS)], base_name="kc", include_misses=True,
            grids=[self._snapped_grid(kept=[True, True, False, True])]))
        body = re.search(r"<grid>(.*?)</grid>", _decode(res["files"], ".xml"), re.S).group(1)
        assert re.search(r"<keptColumns>\s*1\s+1\s+0\s+1\s*</keptColumns>", body), body

    def test_all_kept_omits_kept_columns_tag(self):
        pytest.importorskip("pyhelios")
        # An all-True mask is the default — don't bloat the XML with it.
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[_inline_entry(_PTS, _MISS)], base_name="ak", include_misses=True,
            grids=[self._snapped_grid(kept=[True, True, True, True])]))
        xml = _decode(res["files"], ".xml")
        assert "<columnOffsets>" in xml
        assert "<keptColumns>" not in xml

    def test_wrong_length_offsets_skipped(self):
        pytest.importorskip("pyhelios")
        # Length != nx*ny is corrupt — drop it rather than write a bad tag.
        bad = main.ScanExportGrid(
            center=[0.0, 0.0, 1.0], size=[2.0, 2.0, 2.0], nx=2, ny=2, nz=1,
            column_offsets=[0.0, 0.1])  # only 2, need 4
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[_inline_entry(_PTS, _MISS)], base_name="wl",
            include_misses=True, grids=[bad]))
        xml = _decode(res["files"], ".xml")
        assert "<grid>" in xml and "<columnOffsets>" not in xml

    def test_snapped_grid_reloads_through_pyhelios(self, tmp_path):
        pytest.importorskip("pyhelios")
        from pyhelios import LiDARCloud
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[_inline_entry(_PTS, _MISS)], base_name="cort", include_misses=True,
            grids=[self._snapped_grid(kept=[True, True, False, True])]))
        assert res["success"] is True, res.get("error")
        for f in res["files"]:
            (tmp_path / f["name"]).write_bytes(base64.b64decode(f["data"]))
        cwd = os.getcwd()
        os.chdir(tmp_path)
        try:
            cloud = LiDARCloud()
            cloud.disableMessages()
            cloud.loadXML("cort.xml")
            # The unknown tags don't break Helios; the box still materializes (4 cells).
            assert cloud.getGridCellCount() == 4
        finally:
            os.chdir(cwd)


class TestScanExportScannerModel:
    """A non-generic scanner instrument round-trips via a <scannerModel> tag,
    injected per <scan> block after PyHelios writes the XML."""

    def test_model_tag_written_for_non_generic(self):
        pytest.importorskip("pyhelios")
        entry = _inline_entry(_PTS, _MISS)
        entry.scanner_model = "riegl_vz400i"
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[entry], base_name="sm", include_misses=True))
        assert res["success"] is True, res.get("error")
        xml = _decode(res["files"], ".xml")
        assert "<scannerModel>riegl_vz400i</scannerModel>" in xml

    def test_generic_and_none_write_no_tag(self):
        pytest.importorskip("pyhelios")
        generic = _inline_entry(_PTS, _MISS)
        generic.scanner_model = "generic"
        none_entry = _inline_entry(_PTS, _MISS)  # scanner_model defaults to None
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[generic, none_entry], base_name="smg", include_misses=True))
        assert "<scannerModel>" not in _decode(res["files"], ".xml")

    def test_model_lands_in_correct_scan_block(self):
        pytest.importorskip("pyhelios")
        # Two scans, only the SECOND names a model → the tag must appear after the
        # first </scan>, not before it.
        s0 = _inline_entry(_PTS, _MISS)            # generic
        s1 = _inline_entry(_PTS, _MISS)
        s1.scanner_model = "leica_p40"
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[s0, s1], base_name="smo", include_misses=True))
        xml = _decode(res["files"], ".xml")
        assert xml.count("<scannerModel>") == 1
        # The model tag sits after the first scan's close, i.e. in the second block.
        first_close = xml.index("</scan>")
        assert xml.index("<scannerModel>leica_p40</scannerModel>") > first_close


class TestScanExportReturnMode:
    """The precise pulse return mode round-trips via explicit <returnMode> /
    <returnSelection> / <maxReturns> tags injected per <scan> block, since Helios
    scan XML has no native field for it and it can't be inferred from columns."""

    def test_single_mode_writes_mode_and_selection(self):
        pytest.importorskip("pyhelios")
        entry = _inline_entry(_PTS, _MISS)
        entry.return_mode = "single"
        entry.return_selection = "last"
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[entry], base_name="rm", include_misses=True))
        assert res["success"] is True, res.get("error")
        xml = _decode(res["files"], ".xml")
        assert "<returnMode>single</returnMode>" in xml
        assert "<returnSelection>last</returnSelection>" in xml
        # Single mode does not write a maxReturns tag.
        assert "<maxReturns>" not in xml

    def test_multi_mode_writes_mode_and_max_returns(self):
        pytest.importorskip("pyhelios")
        entry = _inline_entry(_PTS, _MISS)
        entry.return_mode = "multi"
        entry.max_returns = 7
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[entry], base_name="rmm", include_misses=True))
        xml = _decode(res["files"], ".xml")
        assert "<returnMode>multi</returnMode>" in xml
        assert "<maxReturns>7</maxReturns>" in xml

    def test_none_mode_writes_no_tag(self):
        pytest.importorskip("pyhelios")
        entry = _inline_entry(_PTS, _MISS)  # return_mode defaults to None
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[entry], base_name="rmn", include_misses=True))
        assert "<returnMode>" not in _decode(res["files"], ".xml")

    def test_mode_lands_in_correct_scan_block(self):
        pytest.importorskip("pyhelios")
        # Only the SECOND scan names a mode → the tag must land after the first
        # </scan>, mirroring the scanner-model injection.
        s0 = _inline_entry(_PTS, _MISS)            # no mode
        s1 = _inline_entry(_PTS, _MISS)
        s1.return_mode = "single"
        s1.return_selection = "first"
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[s0, s1], base_name="rmo", include_misses=True))
        xml = _decode(res["files"], ".xml")
        assert xml.count("<returnMode>") == 1
        first_close = xml.index("</scan>")
        assert xml.index("<returnMode>single</returnMode>") > first_close


class TestScanExportErrors:
    def test_no_scans_fails(self):
        res = main._do_scan_export(main.ScanExportRequest(scans=[], include_misses=True))
        assert res["success"] is False
        assert "no scans" in res["error"].lower()

    def test_endpoint_registered(self, client):
        # The route exists and accepts the request shape (empty scans → success:false).
        resp = client.post("/api/scan/export-xml", json={"scans": [], "include_misses": True})
        assert resp.status_code == 200
        assert resp.json()["success"] is False
