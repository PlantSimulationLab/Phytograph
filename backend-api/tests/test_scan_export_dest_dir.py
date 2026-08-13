"""Scan-bundle export to a caller-chosen destination directory.

The regression these guard: /api/scan/export-xml used to ALWAYS return every
file base64-encoded inside one JSON body. Base64 inflates ~1.33x, and unlike the
point-cloud export this response carries EVERY selected scan at once — so
exporting several scans to LAZ produced a body past V8's ~512 MB string-length
cap, where the renderer's `response.json()` fails with "Unexpected end of JSON
input". It is not a timeout, and it scales with the number of scans selected:
one scan works, several fail.

`dest_dir` makes the backend write the files itself and return only metadata,
which removes the size ceiling (and avoids holding every scan's bytes in one
JSON string, plus a second copy in renderer memory).

The base64 path is kept for callers with no destination, so both shapes are
asserted here.
"""
import numpy as np
import pytest

import main


def _scan(n: int, seed: int) -> dict:
    """One exportable scan entry with inline points (the renderer's shape)."""
    rng = np.random.default_rng(seed)
    pts = np.column_stack([
        rng.uniform(-5.0, 5.0, n),
        rng.uniform(-5.0, 5.0, n),
        rng.uniform(0.0, 4.0, n),
    ])
    return {
        "origin": [0.0, 0.0, 0.0],
        "n_theta": 40, "n_phi": 40,
        "theta_min": 0.0, "theta_max": 1.5,
        "phi_min": 0.0, "phi_max": 6.28,
        "points": pts.tolist(),
    }


def _request(**kw) -> "main.ScanExportRequest":
    base = {"scans": [], "include_misses": True, "write_xml": False}
    base.update(kw)
    return main.ScanExportRequest(**base)


@pytest.mark.parametrize("fmt", ["laz", "xyz"])
def test_dest_dir_writes_every_scan_and_returns_no_base64(tmp_path, fmt):
    """The multi-scan case that failed: files land on disk, response stays tiny."""
    n_scans = 3
    resp = main._do_scan_export(_request(
        scans=[_scan(500, i) for i in range(n_scans)],
        base_name="multi", data_format=fmt, dest_dir=str(tmp_path),
    ))

    assert resp["success"] is True
    assert resp["scan_count"] == n_scans
    assert resp["point_count"] == 500 * n_scans
    assert len(resp["files"]) == n_scans

    for entry in resp["files"]:
        # The whole point: no bytes in the response body.
        assert entry["data"] is None
        assert entry["written"] is True
        written = tmp_path / entry["name"]
        assert written.is_file()
        # `bytes` must describe the real file — the renderer reports it.
        assert written.stat().st_size == entry["bytes"] > 0

    # One file per scan, distinct names, nothing else dropped in the folder.
    assert sorted(p.name for p in tmp_path.iterdir()) == sorted(
        e["name"] for e in resp["files"])


def test_dest_dir_laz_files_are_readable_with_all_points(tmp_path):
    """Writing directly must not corrupt the file — read the points back."""
    laspy = pytest.importorskip("laspy")
    n = 400
    resp = main._do_scan_export(_request(
        scans=[_scan(n, 11), _scan(n, 12)],
        base_name="rt", data_format="laz", dest_dir=str(tmp_path),
    ))
    assert resp["success"] is True

    for entry in resp["files"]:
        f = laspy.read(str(tmp_path / entry["name"]))
        assert len(f.points) == n
        # Coordinates survive the round trip within LAS scale quantisation.
        assert -5.01 <= float(f.x.min()) and float(f.x.max()) <= 5.01
        assert -0.01 <= float(f.z.min()) and float(f.z.max()) <= 4.01


def test_dest_dir_xml_bundle_writes_xml_plus_one_data_file_per_scan(tmp_path):
    """XML mode routes through PyHelios exportScans but obeys dest_dir too."""
    pytest.importorskip("pyhelios")
    resp = main._do_scan_export(_request(
        scans=[_scan(300, 21), _scan(300, 22)],
        base_name="bundle", write_xml=True, dest_dir=str(tmp_path),
    ))
    assert resp["success"] is True

    names = sorted(p.name for p in tmp_path.iterdir())
    assert "bundle.xml" in names
    # One data file per scan alongside the XML.
    assert len(names) == 3
    assert all(e["data"] is None and e["written"] is True for e in resp["files"])
    xml = next(e for e in resp["files"] if e["is_xml"])
    assert xml["name"] == "bundle.xml"
    assert (tmp_path / "bundle.xml").read_text().count("<scan") >= 2


def test_without_dest_dir_files_come_back_as_base64(tmp_path):
    """The legacy path still works for callers with no chosen destination."""
    import base64

    resp = main._do_scan_export(_request(
        scans=[_scan(50, 31)], base_name="legacy", data_format="xyz",
    ))
    assert resp["success"] is True
    entry = resp["files"][0]
    assert entry["written"] is False
    assert entry["data"] is not None
    decoded = base64.b64decode(entry["data"])
    assert len(decoded) == entry["bytes"]
    # It is the real file content, not a placeholder: a header line + one row
    # per point.
    rows = [ln for ln in decoded.decode().strip().splitlines()
            if not ln.startswith("#")]
    assert len(rows) == 50
    # Nothing was written to disk on this path.
    assert list(tmp_path.iterdir()) == []


def test_missing_dest_dir_is_rejected_before_any_work(tmp_path):
    """A bad destination must 400 rather than serialize millions of points first."""
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        main._do_scan_export(_request(
            scans=[_scan(50, 41)], base_name="bad", data_format="xyz",
            dest_dir=str(tmp_path / "nope"),
        ))
    assert exc.value.status_code == 400
    assert "does not exist" in str(exc.value.detail)


def test_relative_dest_dir_is_rejected(tmp_path):
    """Only absolute paths — no cwd-relative surprises from a request body."""
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        main._do_scan_export(_request(
            scans=[_scan(50, 51)], base_name="rel", data_format="xyz",
            dest_dir="relative/out",
        ))
    assert exc.value.status_code == 400
    assert "absolute" in str(exc.value.detail).lower()
