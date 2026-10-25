"""Scan ("Data only") export must write WORLD coordinates and raw LAS channels.

A session stores positions minus its import-time global shift. The scan-export
writers used to emit those stored coordinates verbatim, so a UTM scan imported
with Global shift on (the wizard's default) exported at X = 0..10 m with the
offset recorded nowhere in the file. The single-cloud exporter added the shift
back; the batch path — which every scan and every multi-object export takes —
did not. Only PTX/E57 handled it, in their pose header, which is why
`test_ptx_export.py` never saw the gap.

The same LAS writer also min-max stretched intensity to 0..65535 per file
(raw 1000..1990 came back as 0..65535, so scans in one export were no longer
comparable) and dropped the Adjusted-Standard GPS-time bit.
"""

import time

import numpy as np
import pytest

import main


N = 100
_SHIFT = np.array([500000.0, 4200000.0, 0.0])
_INTEN = (np.arange(N) * 10 + 1000).astype(np.uint16)


@pytest.fixture
def session():
    rng = np.random.default_rng(3)
    world = np.column_stack([
        500000.0 + rng.uniform(0.0, 10.0, N),
        4200000.0 + rng.uniform(0.0, 10.0, N),
        50.0 + rng.uniform(0.0, 1.0, N),
    ])
    sess = main.CloudSession(
        session_id="export_world_frame_sess",
        source_path="<test>",
        ascii_format=None,
        column_plan=None,
        positions=world - _SHIFT,
        colors=None,
        intensity=_INTEN.copy(),
        extras={},
        extra_dims_meta=[],
        deleted=np.zeros(N, dtype=bool),
        deleted_history=[],
        octree_cache_id=None,
        created_at=time.time(),
        world_shift=_SHIFT.copy(),
        timestamps=1.4e9 + np.arange(N, dtype=np.float64) * 1e-5,
        gps_time_encoding='adjusted_standard',
    )
    main._cloud_sessions[sess.session_id] = sess
    yield sess, world
    main._cloud_sessions.pop(sess.session_id, None)


def _export(tmp_path, session_id, fmt):
    resp = main._do_scan_export(main.ScanExportRequest(
        scans=[{
            "origin": [0.0, 0.0, 0.0],
            "n_theta": 10, "n_phi": 10,
            "theta_min": 0.0, "theta_max": 1.5,
            "phi_min": 0.0, "phi_max": 6.28,
            "session_id": session_id,
        }],
        include_misses=True, write_xml=False,
        base_name="wf", data_format=fmt, dest_dir=str(tmp_path),
    ))
    assert resp["success"] is True, resp
    return tmp_path / resp["files"][0]["name"]


@pytest.mark.parametrize("fmt", ["las", "laz"])
def test_las_carries_world_coordinates_raw_intensity_and_gps_encoding(
        tmp_path, session, fmt):
    laspy = pytest.importorskip("laspy")
    sess, world = session
    f = laspy.read(str(_export(tmp_path, sess.session_id, fmt)))
    xyz = np.column_stack([f.x, f.y, f.z])
    # LAS stores 1 mm, so compare within half a millimetre.
    np.testing.assert_allclose(np.sort(xyz[:, 0]), np.sort(world[:, 0]), atol=5e-4)
    np.testing.assert_allclose(np.sort(xyz[:, 1]), np.sort(world[:, 1]), atol=5e-4)
    np.testing.assert_allclose(np.sort(xyz[:, 2]), np.sort(world[:, 2]), atol=5e-4)
    np.testing.assert_array_equal(np.sort(np.asarray(f.intensity)), np.sort(_INTEN))
    assert f.header.global_encoding.gps_time_type == 1


@pytest.mark.parametrize("fmt", ["xyz", "csv", "ply", "pts"])
def test_text_formats_carry_world_coordinates(tmp_path, session, fmt):
    sess, world = session
    text = _export(tmp_path, sess.session_id, fmt).read_text().splitlines()
    rows = [ln for ln in text
            if ln and ln[0].isdigit() and len(ln.replace(",", " ").split()) >= 3]
    xs = np.array([float(ln.replace(",", " ").split()[0]) for ln in rows])
    assert len(xs) == N
    np.testing.assert_allclose(np.sort(xs), np.sort(world[:, 0]), atol=1e-5)


def test_non_uint16_intensity_is_still_normalized(tmp_path):
    """dB reflectance (negative floats) can't go in uint16 raw, so it keeps the
    range normalization rather than wrapping or clipping to zero."""
    laspy = pytest.importorskip("laspy")
    resolved = {
        "positions": np.zeros((3, 3)), "colors": None,
        "intensity": np.array([-14.0, -7.0, 0.0]),
        "scalars": {}, "ordered": [], "world_shift": None,
    }
    name, raw = main._write_scan_to_bytes(resolved, "las", "db")
    p = tmp_path / name
    p.write_bytes(raw)
    np.testing.assert_array_equal(np.asarray(laspy.read(str(p)).intensity),
                                  [0, 32767, 65535])
