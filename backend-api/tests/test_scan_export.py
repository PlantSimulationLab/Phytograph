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
        entry = main.ScanExportEntry(
            origin=[0, 0, 3], n_theta=20, n_phi=20,
            points=[list(p) for p in _PTS],
            scalar_columns={"is_miss": list(_MISS), "reflectance": [0.1, 0.2, 0.3, 0.4]},
            columns=["x", "y", "z", "reflectance"])
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[entry], base_name="b", include_misses=True,
            write_xml=False, data_format="csv"))
        head = base64.b64decode(res["files"][0]["data"]).decode().splitlines()[0]
        assert head == "x,y,z,reflectance"

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
