"""Scan export of a SESSION-backed cloud must carry its intensity and colour.

Both scan-export resolvers used to read every scalar out of `CloudSession.extras`
alone. Intensity never lives there: `_read_las_into_arrays` routes it to the
dedicated `CloudSession.intensity` field and `_LAS_STD_DIMS_SKIP` deliberately
keeps `intensity` out of `extras`. So `_get('intensity')` always returned None
for a real imported cloud, and every scan export of one shipped with no
intensity at all — silently, since the file was otherwise well-formed.

Colour had the mirror-image bug in `_resolve_scan_for_format`: `sess.colors` is
uint16 on the LAS 0-65535 scale, but the resolver's contract (and every writer)
is 0-1, and the raw array was passed through undivided. `np.clip(colors, 0, 1)`
then flattened every point to pure white.

Every existing scan-export test uses INLINE points, which take a different
branch — which is why both survived. These use a session, so they don't.
"""

import time

import numpy as np
import pytest

import main


N = 6
# Intensity spanning the LAS range so a dropped column reads as obviously wrong
# (all zeros) rather than plausibly dim.
_INTEN = np.array([0, 13107, 26214, 39321, 52428, 65535], dtype=np.uint16)
# Mid-grey through to full white: a session colour array on the 0-65535 scale.
_COLORS = np.column_stack([
    np.array([32768, 65535, 0, 16384, 65535, 8192], dtype=np.uint16),
    np.array([32768, 0, 65535, 16384, 65535, 8192], dtype=np.uint16),
    np.array([32768, 0, 0, 16384, 65535, 8192], dtype=np.uint16),
])


@pytest.fixture
def session():
    """A session-backed cloud carrying intensity + colour in their own fields
    (never in `extras`), exactly as a LAS/E57 import leaves it."""
    xyz = np.column_stack([
        np.linspace(0.0, 1.0, N),
        np.linspace(0.0, -1.0, N),
        np.full(N, 2.0),
    ]).astype(np.float64)
    sess = main.CloudSession(
        session_id="export_channels_sess",
        source_path="<test>",
        ascii_format=None,
        column_plan=None,
        positions=xyz,
        colors=_COLORS.copy(),
        intensity=_INTEN.copy(),
        extras={},                 # <- the point: nothing here to fall back on
        extra_dims_meta=[],
        deleted=np.zeros(N, dtype=bool),
        deleted_history=[],
        octree_cache_id=None,
        created_at=time.time(),
    )
    main._cloud_sessions[sess.session_id] = sess
    yield sess
    main._cloud_sessions.pop(sess.session_id, None)


def _entry(session_id):
    return main.ScanExportEntry(
        origin=[0.0, 0.0, 3.0], n_theta=3, n_phi=2,
        theta_min=0, theta_max=180, phi_min=0, phi_max=360,
        session_id=session_id)


class TestResolveScanForFormat:
    def test_intensity_comes_from_the_session_field(self, session):
        r = main._resolve_scan_for_format(_entry(session.session_id), True)
        assert r["intensity"] is not None, "session intensity was dropped"
        np.testing.assert_allclose(r["intensity"], _INTEN.astype(np.float64))

    def test_colors_are_normalised_to_the_documented_0_1_contract(self, session):
        r = main._resolve_scan_for_format(_entry(session.session_id), True)
        assert r["colors"] is not None
        np.testing.assert_allclose(
            r["colors"], _COLORS.astype(np.float64) / 65535.0, atol=1e-12)
        # The specific failure: undivided uint16 clips to white everywhere.
        assert r["colors"].max() <= 1.0
        assert r["colors"].min() < 0.9, "colour range collapsed — everything is white"

    def test_deleted_points_are_dropped_from_both_channels(self, session):
        session.deleted[2] = True
        session.deleted[4] = True
        r = main._resolve_scan_for_format(_entry(session.session_id), True)
        keep = ~session.deleted
        assert r["positions"].shape[0] == int(keep.sum())
        np.testing.assert_allclose(r["intensity"], _INTEN[keep].astype(np.float64))
        np.testing.assert_allclose(
            r["colors"], _COLORS[keep].astype(np.float64) / 65535.0, atol=1e-12)

    def test_a_mismatched_intensity_length_is_ignored_not_crashed(self, session):
        # A stale/misaligned field must fall back to "no intensity", matching how
        # the timestamps field is guarded.
        session.intensity = np.zeros(N + 3, dtype=np.uint16)
        r = main._resolve_scan_for_format(_entry(session.session_id), True)
        assert r["intensity"] is None


class TestExportedFilesCarryIntensity:
    def test_xyz_export_writes_an_intensity_column(self, session):
        pytest.importorskip("pyhelios")
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[_entry(session.session_id)], base_name="ch",
            include_misses=True, write_xml=False, data_format="xyz"))
        assert res["success"] is True, res.get("error")
        import base64
        text = base64.b64decode(res["files"][0]["data"]).decode()
        lines = [l for l in text.splitlines() if l.strip()]
        assert "intensity" in lines[0], lines[0]
        icol = lines[0].lstrip("# ").split(" ").index("intensity")
        vals = [float(l.split(" ")[icol]) for l in lines[1:]]
        np.testing.assert_allclose(vals, _INTEN.astype(np.float64), atol=1e-3)

    def test_las_export_writes_a_non_zero_intensity_field(self, session):
        pytest.importorskip("pyhelios")
        laspy = pytest.importorskip("laspy")
        import io
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[_entry(session.session_id)], base_name="chl",
            include_misses=True, write_xml=False, data_format="las"))
        assert res["success"] is True, res.get("error")
        import base64
        raw = base64.b64decode(res["files"][0]["data"])
        las = laspy.read(io.BytesIO(raw))
        # The LAS writer renormalises to its own range, so assert on spread
        # rather than absolute values — all-zero is the bug's signature.
        assert int(np.asarray(las.intensity).max()) > 0
        assert len(np.unique(np.asarray(las.intensity))) > 1

    def test_ply_export_colour_is_not_all_white(self, session):
        pytest.importorskip("pyhelios")
        import base64
        res = main._do_scan_export(main.ScanExportRequest(
            scans=[_entry(session.session_id)], base_name="chp",
            include_misses=True, write_xml=False, data_format="ply"))
        assert res["success"] is True, res.get("error")
        text = base64.b64decode(res["files"][0]["data"]).decode()
        body = text.split("end_header\n", 1)[1].splitlines()
        rgb = np.array([[int(t) for t in l.split(" ")[3:6]] for l in body if l.strip()])
        assert rgb.min() < 250, "every point exported as white"
        np.testing.assert_allclose(
            rgb, np.rint(_COLORS.astype(np.float64) / 65535.0 * 255.0), atol=1)


class TestResolveScanExportArrays:
    """The XML-bundle path has its own resolver and had the same intensity gap."""

    def test_intensity_is_among_the_exported_columns(self, session):
        xyz, labels, vals = main._resolve_scan_export_arrays(
            _entry(session.session_id), True)
        assert "intensity" in labels, labels
        np.testing.assert_allclose(
            vals[:, labels.index("intensity")], _INTEN.astype(np.float64))
