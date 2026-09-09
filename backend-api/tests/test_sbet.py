"""Phase 4: binary SBET trajectory parser.

The highest-risk piece is the NED->ENU attitude conversion: a sign/frame error
silently mirrors origins and still "doesn't throw". The load-bearing tests are the
hand-computed unit-vector oracles (heading 0 -> North, +90° -> East). The rest cover
the structural validation, UTM projection, decimation, and smrmsg QC.
"""

import numpy as np
import pytest

import sbet

pytest.importorskip("pyproj")
from scipy.spatial.transform import Rotation  # noqa: E402


def _write_sbet(path, records):
    """records: (N,17) array in SBET field order -> a binary .sbet file."""
    arr = np.zeros(len(records), dtype=sbet.SBET_DTYPE)
    fields = list(sbet.SBET_DTYPE.names)
    for i, rec in enumerate(records):
        for j, f in enumerate(fields):
            arr[i][f] = rec[j]
    arr.tofile(str(path))


def _record(time=0.0, lat=0.0, lon=0.0, alt=0.0, roll=0.0, pitch=0.0, heading=0.0):
    """One SBET record (17 fields) with the named fields set, rest zero."""
    r = [0.0] * 17
    r[0] = time; r[1] = lat; r[2] = lon; r[3] = alt
    r[7] = roll; r[8] = pitch; r[9] = heading
    return r


# ---------------------------------------------------------------------------
# Attitude oracle — the load-bearing test
# ---------------------------------------------------------------------------

def _body_forward(roll, pitch, heading):
    q = sbet.ned_attitude_to_enu_quat(
        np.array([roll]), np.array([pitch]), np.array([heading]))
    return Rotation.from_quat(q[0]).apply([1.0, 0.0, 0.0])  # FRD forward -> ENU


def test_heading_zero_points_north():
    """Level, heading 0: body forward maps to ENU +Y (North)."""
    np.testing.assert_allclose(_body_forward(0, 0, 0), [0, 1, 0], atol=1e-9)


def test_heading_90_points_east():
    """Heading +90° (clockwise from North) -> body forward maps to ENU +X (East)."""
    np.testing.assert_allclose(
        _body_forward(0, 0, np.pi / 2), [1, 0, 0], atol=1e-9)


def test_heading_negative_90_points_west():
    np.testing.assert_allclose(
        _body_forward(0, 0, -np.pi / 2), [-1, 0, 0], atol=1e-9)


def test_quaternions_are_unit():
    q = sbet.ned_attitude_to_enu_quat(
        np.array([0.1, -0.2, 1.0]), np.array([0.05, 0.0, -0.3]),
        np.array([0.0, 1.5, -2.0]))
    np.testing.assert_allclose(np.linalg.norm(q, axis=1), 1.0, atol=1e-12)


# ---------------------------------------------------------------------------
# Structural validation
# ---------------------------------------------------------------------------

def test_record_is_136_bytes():
    assert sbet.SBET_RECORD_BYTES == 136


def test_bad_filesize_rejected(tmp_path):
    p = tmp_path / "bad.sbet"
    p.write_bytes(b"\x00" * 137)  # not a multiple of 136
    with pytest.raises(sbet.SbetParseError, match="not a multiple"):
        sbet.parse_sbet(str(p))


def test_empty_file_rejected(tmp_path):
    p = tmp_path / "empty.sbet"
    p.write_bytes(b"")
    with pytest.raises(sbet.SbetParseError, match="empty"):
        sbet.parse_sbet(str(p))


# ---------------------------------------------------------------------------
# UTM projection + wire shape
# ---------------------------------------------------------------------------

def test_utm_projection_and_zone(tmp_path):
    """A short trajectory near Heidelberg (8.5°E, 49.4°N) projects into UTM zone 32N
    and matches an independent pyproj transform within a millimeter."""
    from pyproj import Transformer
    lat = np.radians(np.array([49.40, 49.401, 49.402]))
    lon = np.radians(np.array([8.50, 8.501, 8.502]))
    recs = [_record(time=t, lat=lat[i], lon=lon[i], alt=300.0 + i)
            for i, t in enumerate([0.0, 0.1, 0.2])]
    p = tmp_path / "hd.sbet"
    _write_sbet(p, recs)

    result = sbet.parse_sbet(str(p))
    assert result["source_format"] == "sbet"
    assert result["frame"]["crs"] == "EPSG:32632"  # UTM 32N
    assert len(result["poses"]) == 3

    tf = Transformer.from_crs("EPSG:4326", "EPSG:32632", always_xy=True)
    ex0, ny0 = tf.transform(8.50, 49.40)
    assert result["poses"][0]["x"] == pytest.approx(ex0, abs=1e-3)
    assert result["poses"][0]["y"] == pytest.approx(ny0, abs=1e-3)
    assert result["poses"][0]["z"] == pytest.approx(300.0, abs=1e-9)


def test_southern_hemisphere_epsg(tmp_path):
    """A southern-hemisphere trajectory selects a 327zz EPSG."""
    lat = np.radians(np.array([-33.86, -33.861]))
    lon = np.radians(np.array([151.20, 151.201]))  # Sydney, UTM 56S
    recs = [_record(time=t, lat=lat[i], lon=lon[i]) for i, t in enumerate([0.0, 0.1])]
    p = tmp_path / "syd.sbet"
    _write_sbet(p, recs)
    result = sbet.parse_sbet(str(p))
    assert result["frame"]["crs"] == "EPSG:32756"


# ---------------------------------------------------------------------------
# Decimation
# ---------------------------------------------------------------------------

def test_decimation_keeps_last_record(tmp_path):
    """A long SBET decimates to <= target poses, ALWAYS keeping the last record so
    the time span (which the join coverage check needs) is preserved."""
    n = 5000
    t = np.linspace(0.0, 25.0, n)  # 200 Hz
    lat = np.radians(49.4 + np.linspace(0, 0.01, n))
    lon = np.radians(8.5 + np.linspace(0, 0.01, n))
    recs = [_record(time=t[i], lat=lat[i], lon=lon[i]) for i in range(n)]
    p = tmp_path / "long.sbet"
    _write_sbet(p, recs)

    result = sbet.parse_sbet(str(p), target_poses=500)
    poses = result["poses"]
    assert len(poses) <= 501  # target + the appended last
    assert poses[0]["t"] == pytest.approx(0.0, abs=1e-6)
    assert poses[-1]["t"] == pytest.approx(25.0, abs=1e-6)  # last record kept
    # Strictly increasing time.
    times = [pp["t"] for pp in poses]
    assert all(b > a for a, b in zip(times, times[1:]))


def test_no_decimation_when_small(tmp_path):
    recs = [_record(time=t, lat=np.radians(49.4), lon=np.radians(8.5))
            for t in [0.0, 0.5, 1.0]]
    p = tmp_path / "small.sbet"
    _write_sbet(p, recs)
    result = sbet.parse_sbet(str(p), target_poses=3000)
    assert len(result["poses"]) == 3


# ---------------------------------------------------------------------------
# smrmsg QC (advisory only)
# ---------------------------------------------------------------------------

def test_smrmsg_qc_warns_never_raises(tmp_path):
    recs = [_record(time=t, lat=np.radians(49.4), lon=np.radians(8.5))
            for t in [0.0, 0.5, 1.0]]
    p = tmp_path / "t.sbet"
    _write_sbet(p, recs)
    # A 10-field smrmsg: time + n/e/d position RMS + 6 more.
    smr = np.zeros((4, 10), dtype="<f8")
    smr[:, 1:4] = [[0.02, 0.02, 0.03]]  # ~0.04 m position RMS
    smr_path = tmp_path / "t-smrmsg.out"
    smr.astype("<f8").tofile(str(smr_path))

    result = sbet.parse_sbet(str(p), smrmsg_path=str(smr_path))
    assert any("smrmsg" in w and "RMS" in w for w in result["warnings"])


def test_missing_smrmsg_is_silent(tmp_path):
    recs = [_record(time=t, lat=np.radians(49.4), lon=np.radians(8.5))
            for t in [0.0, 0.5, 1.0]]
    p = tmp_path / "t.sbet"
    _write_sbet(p, recs)
    result = sbet.parse_sbet(str(p), smrmsg_path=str(tmp_path / "nope-smrmsg.out"))
    assert not any("smrmsg" in w for w in result["warnings"])


# ---------------------------------------------------------------------------
# Endpoint: POST /api/trajectory/parse (live app, no mock)
# ---------------------------------------------------------------------------

def test_trajectory_parse_endpoint(tmp_path):
    from fastapi.testclient import TestClient
    import main

    recs = [_record(time=t, lat=np.radians(49.40 + i * 0.001),
                    lon=np.radians(8.50 + i * 0.001), alt=300.0)
            for i, t in enumerate([0.0, 0.1, 0.2])]
    p = tmp_path / "traj.sbet"
    _write_sbet(p, recs)

    client = TestClient(main.app)
    resp = client.post("/api/trajectory/parse", json={"path": str(p)})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["source_format"] == "sbet"
    assert body["frame"]["crs"] == "EPSG:32632"
    assert len(body["poses"]) == 3
    assert {"t", "x", "y", "z", "qx", "qy", "qz", "qw"} <= set(body["poses"][0])


def test_trajectory_parse_endpoint_bad_file(tmp_path):
    from fastapi.testclient import TestClient
    import main

    p = tmp_path / "bad.sbet"
    p.write_bytes(b"\x00" * 100)  # not a multiple of 136
    client = TestClient(main.app)
    resp = client.post("/api/trajectory/parse", json={"path": str(p)})
    assert resp.status_code == 400
    assert "not a multiple" in resp.json()["detail"]


def test_trajectory_parse_endpoint_missing_file():
    from fastapi.testclient import TestClient
    import main

    client = TestClient(main.app)
    resp = client.post("/api/trajectory/parse", json={"path": "/nope/missing.sbet"})
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Content validation — a right-SIZED .out that is not an SBET
#
# POSPac writes ~15 different formats under the SAME .out extension, so the
# extension proves nothing and the 136-byte size check is a weak filter. The one
# that actually gets mis-picked is smrmsg_<mission>.out, which POSPac names like
# its sbet_<mission>.out sibling and leaves in the same directory. Its records
# are 80 bytes; gcd(80,136)=8, so a smrmsg with a multiple of 17 records has a
# size divisible by 136 and used to parse "successfully" into inf coordinates.
# ---------------------------------------------------------------------------

def _write_smrmsg(path, n_records):
    """A realistic Applanix smrmsg accuracy file: 10 float64/record."""
    r = np.zeros((n_records, 10))
    r[:, 0] = np.linspace(412402.0, 412997.0, n_records)      # GPS week seconds
    rng = np.random.default_rng(0)
    r[:, 1:4] = rng.uniform(0.010, 0.035, (n_records, 3))     # position RMS (m)
    r[:, 4:7] = rng.uniform(0.002, 0.009, (n_records, 3))     # velocity RMS
    r[:, 7:10] = rng.uniform(0.0005, 0.004, (n_records, 3))   # attitude RMS
    r.astype("<f8").tofile(str(path))


def test_smrmsg_sized_to_pass_the_size_check_is_still_rejected(tmp_path):
    """The exact hole: 17*k smrmsg records divide evenly by the SBET record."""
    p = tmp_path / "smrmsg_Mission 1.out"
    _write_smrmsg(p, 17 * 700)
    assert p.stat().st_size % sbet.SBET_RECORD_BYTES == 0, "precondition: passes size gate"
    with pytest.raises(sbet.SbetParseError) as e:
        sbet.parse_sbet(str(p))
    # The message must name the confusable sibling, not just say "invalid".
    assert "smrmsg" in str(e.value)


def test_smrmsg_rejection_covers_the_whole_multiple_of_17_family(tmp_path):
    for k in (1, 2, 5, 40):
        p = tmp_path / f"smrmsg_{k}.out"
        _write_smrmsg(p, 17 * k)
        assert p.stat().st_size % sbet.SBET_RECORD_BYTES == 0
        with pytest.raises(sbet.SbetParseError):
            sbet.parse_sbet(str(p))


def test_impossible_latitude_rejected(tmp_path):
    """Latitude past +/-pi/2 radians cannot be a real SBET."""
    p = tmp_path / "bad.out"
    _write_sbet(p, [_record(time=t, lat=2.0, lon=0.1) for t in range(10)])
    with pytest.raises(sbet.SbetParseError) as e:
        sbet.parse_sbet(str(p))
    assert "latitude" in str(e.value)


def test_non_finite_values_rejected(tmp_path):
    p = tmp_path / "nan.out"
    p2 = tmp_path / "inf.out"
    _write_sbet(p, [_record(time=t, lat=np.nan, lon=0.1) for t in range(10)])
    _write_sbet(p2, [_record(time=t, lat=0.6, lon=np.inf) for t in range(10)])
    for bad in (p, p2):
        with pytest.raises(sbet.SbetParseError):
            sbet.parse_sbet(str(bad))


def test_polar_survey_still_only_WARNS(tmp_path):
    """The guard must reject the IMPOSSIBLE without rejecting the merely unusual.

    85 deg N is past UTM's +/-84 band -- a real, if awkward, survey. It has always
    produced a warning, and must not become an error.
    """
    p = tmp_path / "polar.out"
    lat = np.radians(85.0)
    _write_sbet(p, [_record(time=float(t), lat=lat, lon=0.2) for t in range(10)])
    out = sbet.parse_sbet(str(p))
    assert len(out["poses"]) == 10
    assert any("outside UTM's valid band" in w for w in out["warnings"])


def test_valid_sbet_poses_are_all_finite(tmp_path):
    """No non-finite coordinate may ever escape into a PoseStream."""
    p = tmp_path / "good.out"
    _write_sbet(p, [
        _record(time=float(t), lat=np.radians(38.54), lon=np.radians(-121.79),
                alt=17.0, heading=0.5)
        for t in range(50)
    ])
    for pose in sbet.parse_sbet(str(p))["poses"]:
        for k in ("x", "y", "z", "qx", "qy", "qz", "qw"):
            assert np.isfinite(pose[k]), f"{k} is not finite"
