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
