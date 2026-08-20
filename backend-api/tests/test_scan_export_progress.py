"""Progress + cancellation for the batch export (POST /api/scan/export-xml).

The export used to be one buffered, non-cancellable POST covering every checked
object, so the UI could only show an indeterminate "Exporting…" pill for what is
routinely tens of seconds of formatting. It now rides the same PHP1-marker
stream as /api/pointcloud/export. What has to hold:

  * one progress marker per object, monotonically increasing, ending at 1.0,
  * the JSON tail is unchanged (`decode_streamed_json` gives the old payload),
  * a run_id is emitted so /api/cancel/{run_id} has something to cancel,
  * an object with NO scanner parameters exports fine as data (the Export
    window now lists every cloud, not just scans),
  * a cancel raises ScanCancelled and takes the already-written files with it —
    a half-written batch that looks complete is worse than no batch at all.
"""

import queue
import threading

import pytest

import main
from tests.binframe import decode_progress_markers, decode_streamed_json


_PTS = [[0.1, 0.1, 0.5], [-0.1, 0.0, 0.6], [0.2, -0.1, 0.4]]


def _scan_entry(label, points=None):
    """An entry WITH scanner parameters (a real scan)."""
    return main.ScanExportEntry(
        origin=[0.0, 0.0, 3.0], n_theta=20, n_phi=20,
        theta_min=0, theta_max=180, phi_min=0, phi_max=360,
        label=label, points=[list(p) for p in (points or _PTS)])


def _plain_entry(label, points=None):
    """An entry with NO scan geometry — a plain imported cloud."""
    return main.ScanExportEntry(
        origin=[0.0, 0.0, 0.0], label=label,
        points=[list(p) for p in (points or _PTS)])


def _fractions(markers):
    return [m["progress"] for m in markers if m.get("progress") is not None]


class TestExportProgressStream:
    def test_data_mode_reports_one_marker_per_object(self, client, tmp_path):
        resp = client.post("/api/scan/export-xml", json={
            "scans": [_scan_entry("plot A").model_dump(),
                      _scan_entry("plot B").model_dump(),
                      _scan_entry("plot C").model_dump()],
            "base_name": "batch", "include_misses": True,
            "write_xml": False, "data_format": "xyz",
            "dest_dir": str(tmp_path),
        })
        assert resp.status_code == 200

        markers = decode_progress_markers(resp.content)
        # The first marker carries the cancellation token, so the pill's X has
        # something to POST to /api/cancel/{run_id}.
        assert markers, "no progress markers were streamed"
        assert markers[0].get("run_id")

        fracs = _fractions(markers)
        assert fracs == sorted(fracs), f"progress went backwards: {fracs}"
        assert fracs[-1] == pytest.approx(1.0)
        # A determinate bar, not a spinner: something lands strictly inside 0..1.
        assert any(0.0 < f < 1.0 for f in fracs)

        messages = " | ".join(m.get("message", "") for m in markers)
        for label in ("plot A", "plot B", "plot C"):
            assert label in messages, f"{label} never appeared in {messages}"

        # The JSON tail is the same shape the renderer always consumed.
        res = decode_streamed_json(resp.content)
        assert res["success"] is True, res.get("error")
        assert res["scan_count"] == 3
        assert sorted(p.name for p in tmp_path.iterdir()) == [
            "batch_0.xyz", "batch_1.xyz", "batch_2.xyz"]

    def test_progress_is_weighted_by_point_count(self, client, tmp_path):
        # A lopsided batch (one big object, one tiny) must not spend the bar
        # evenly: the big object owns most of it. Otherwise the pill jumps to 50%
        # in a blink and then sits still for the rest of the export.
        big = _scan_entry("big", points=[[float(i), 0.0, 0.0] for i in range(4000)])
        small = _scan_entry("small", points=_PTS)
        resp = client.post("/api/scan/export-xml", json={
            "scans": [big.model_dump(), small.model_dump()],
            "base_name": "weighted", "write_xml": False, "data_format": "xyz",
            "dest_dir": str(tmp_path),
        })
        assert resp.status_code == 200
        markers = decode_progress_markers(resp.content)
        # The marker that starts the SECOND object sits well past halfway,
        # because the first object is ~1300x larger.
        starts = [m["progress"] for m in markers
                  if m.get("progress") is not None and "small" in m.get("message", "")]
        assert starts, "the small object never reported progress"
        assert min(starts) > 0.5

    def test_xml_mode_loads_per_scan_then_writes_the_bundle(self, client, tmp_path):
        pytest.importorskip("pyhelios")
        resp = client.post("/api/scan/export-xml", json={
            "scans": [_scan_entry("north").model_dump(),
                      _scan_entry("south").model_dump()],
            "base_name": "bundle", "include_misses": True,
            "write_xml": True, "dest_dir": str(tmp_path),
        })
        assert resp.status_code == 200
        markers = decode_progress_markers(resp.content)
        messages = [m.get("message", "") for m in markers]
        joined = " | ".join(messages)
        # The per-scan LOAD head is what makes a multi-scan bundle advance at
        # all; the single opaque exportScans() call gets its own labelled stage.
        assert "Loading north (1/2)" in joined
        assert "Loading south (2/2)" in joined
        assert any("Writing Helios scan bundle" in m for m in messages)

        fracs = _fractions(markers)
        assert fracs == sorted(fracs)
        assert fracs[-1] == pytest.approx(1.0)

        res = decode_streamed_json(resp.content)
        assert res["success"] is True, res.get("error")
        names = sorted(p.name for p in tmp_path.iterdir())
        assert names == ["bundle.xml", "bundle_0.xyz", "bundle_1.xyz"]


class TestParamlessObjects:
    """The Export window lists every cloud, so entries arrive with no scan
    geometry at all. Data formats must take them as-is."""

    @pytest.mark.parametrize("fmt,suffix", [("xyz", ".xyz"), ("csv", ".csv"),
                                            ("las", ".las")])
    def test_exports_a_cloud_with_no_scanner_parameters(self, tmp_path, fmt, suffix):
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[_plain_entry("field cloud")],
            base_name="plain", write_xml=False, data_format=fmt,
            dest_dir=str(tmp_path)))
        assert res["success"] is True, res.get("error")
        written = list(tmp_path.iterdir())
        assert [p.name for p in written] == [f"plain_0{suffix}"]
        assert res["point_count"] == len(_PTS)

        if fmt in ("xyz", "csv"):
            rows = [ln for ln in written[0].read_text().splitlines()
                    if ln.strip() and not ln.startswith("#")]
            # CSV writes a header row; XYZ comments its own out with '#'.
            data_rows = rows[1:] if fmt == "csv" else rows
            assert len(data_rows) == len(_PTS)

    def test_mixed_batch_of_scans_and_plain_clouds(self, tmp_path):
        # The common case now: a couple of real scans next to an imported cloud.
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[_scan_entry("scan A"), _plain_entry("plain B")],
            base_name="mixed", write_xml=False, data_format="xyz",
            dest_dir=str(tmp_path)))
        assert res["success"] is True, res.get("error")
        assert sorted(p.name for p in tmp_path.iterdir()) == ["mixed_0.xyz", "mixed_1.xyz"]


class TestExportCancel:
    def test_cancel_unwinds_and_removes_partial_files(self, tmp_path):
        # An already-cancelled run: the export must raise rather than return a
        # {"success": False} the endpoint would stream as a normal result.
        evt = threading.Event()
        evt.set()
        progress = main._ProgressReporter(queue.Queue(), evt)
        with pytest.raises(main.ScanCancelled):
            main._do_scan_export(
                main.ScanExportRequest(
                    scans=[_scan_entry("a"), _scan_entry("b")],
                    base_name="cancelled", write_xml=False, data_format="xyz",
                    dest_dir=str(tmp_path)),
                progress=progress, cancel_event=evt)
        # Nothing left behind — a partial batch that looks complete is the
        # failure mode this guards.
        assert list(tmp_path.iterdir()) == []

    def test_cancel_midway_removes_the_files_already_written(self, tmp_path):
        # Cancel after the first object has landed: the finished file must go
        # too, so the user never finds half a bundle in the destination folder.
        evt = threading.Event()

        class _CancelAfterFirst(main._ProgressReporter):
            def __call__(self, fraction, message):
                if message.startswith("Writing") and "1/3" not in message:
                    evt.set()
                super().__call__(fraction, message)

        progress = _CancelAfterFirst(queue.Queue(), evt)
        with pytest.raises(main.ScanCancelled):
            main._do_scan_export(
                main.ScanExportRequest(
                    scans=[_scan_entry("a"), _scan_entry("b"), _scan_entry("c")],
                    base_name="partial", write_xml=False, data_format="xyz",
                    dest_dir=str(tmp_path)),
                progress=progress, cancel_event=evt)
        assert list(tmp_path.iterdir()) == []
