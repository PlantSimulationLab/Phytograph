"""Phase 3: LAS ExtraBytes per-beam origins.

A LAS may carry the per-pulse emission point as three ExtraBytes columns
(ox/oy/oz and aliases). When present these are GROUND TRUTH origins: LAD uses them
directly and bypasses the timestamp -> trajectory join. They are read as float64
(UTM-scale coordinates) and kept OUT of the float32 `extras` dict.
"""

import time

import numpy as np
import pytest

import main

# Reuse the stubbed-pyhelios fixture from the static LAD suite so pytest resolves
# `stub_pyhelios` in this module too.
from tests.test_lad import stub_pyhelios  # noqa: F401

laspy = pytest.importorskip("laspy")


def _write_las_with_origins(path, names, origins, xyz=None):
    """Write a LAS whose ExtraBytes `names` (3) hold the per-point `origins` (N,3)."""
    n = origins.shape[0]
    header = laspy.LasHeader(point_format=3, version="1.4")
    header.scales = np.array([0.001, 0.001, 0.001], dtype=np.float64)
    header.offsets = np.zeros(3, dtype=np.float64)
    for nm in names:
        header.add_extra_dim(laspy.ExtraBytesParams(name=nm, type=np.float64))
    las = laspy.LasData(header)
    if xyz is None:
        xyz = np.column_stack([np.linspace(0, 1, n), np.zeros(n), np.zeros(n)])
    las.x, las.y, las.z = xyz[:, 0], xyz[:, 1], xyz[:, 2]
    las[names[0]] = origins[:, 0]
    las[names[1]] = origins[:, 1]
    las[names[2]] = origins[:, 2]
    las.write(str(path))


@pytest.mark.parametrize("names", [
    ("ox", "oy", "oz"),
    ("XOrigin", "YOrigin", "ZOrigin"),
    ("BeamOriginX", "BeamOriginY", "BeamOriginZ"),
])
def test_beam_origins_detected_by_alias(tmp_path, names):
    """Each recognised alias triple is read as float64 beam_origins and kept out of
    the float32 extras dict."""
    las_path = tmp_path / "origins.las"
    origins = np.array([[100.5, 200.5, 300.5],
                        [101.5, 200.5, 300.5],
                        [102.5, 200.5, 300.5]], dtype=np.float64)
    _write_las_with_origins(las_path, names, origins)

    r = main._read_las_into_arrays(las_path)
    assert r.beam_origins is not None
    assert r.beam_origins.dtype == np.float64
    np.testing.assert_allclose(r.beam_origins, origins, rtol=0, atol=0)
    # The three origin columns must NOT also appear as float32 scalar extras.
    for nm in names:
        assert nm not in r.extras
        assert nm.lower() not in {s.lower() for s in r.extras}


def test_partial_origin_triple_ignored(tmp_path):
    """Only two of the three origin columns → not an origin triple; no beam_origins
    (the columns fall through to ordinary extras)."""
    las_path = tmp_path / "partial.las"
    n = 3
    header = laspy.LasHeader(point_format=3, version="1.4")
    header.scales = np.array([0.001, 0.001, 0.001], dtype=np.float64)
    header.offsets = np.zeros(3, dtype=np.float64)
    header.add_extra_dim(laspy.ExtraBytesParams(name="ox", type=np.float64))
    header.add_extra_dim(laspy.ExtraBytesParams(name="oy", type=np.float64))  # no oz
    las = laspy.LasData(header)
    las.x = np.linspace(0, 1, n); las.y = np.zeros(n); las.z = np.zeros(n)
    las["ox"] = np.full(n, 5.0); las["oy"] = np.full(n, 6.0)
    las.write(str(las_path))

    r = main._read_las_into_arrays(las_path)
    assert r.beam_origins is None
    assert "ox" in r.extras and "oy" in r.extras  # carried as ordinary scalars


def test_large_utm_origins_survive_as_float64(tmp_path):
    """UTM-scale origins keep full double precision (would lose ~decimeters as
    float32)."""
    las_path = tmp_path / "utm.las"
    base = np.array([456789.123, 5432109.876, 412.345])
    origins = base + np.column_stack([np.arange(4) * 0.01, np.zeros(4), np.zeros(4)])
    _write_las_with_origins(las_path, ("ox", "oy", "oz"), origins)

    r = main._read_las_into_arrays(las_path)
    np.testing.assert_allclose(r.beam_origins, origins, rtol=0, atol=1e-9)
    # Control: float32 cannot resolve the 0.01 m steps at this magnitude.
    assert len(np.unique(r.beam_origins[:, 0])) == 4
    assert len(np.unique(r.beam_origins[:, 0].astype(np.float32))) < 4


def test_attach_origins_shared_shape():
    """`_attach_origins` appends origin_x/y/z and recomputes dirs from the explicit
    origins — the shared tail both the join and ExtraBytes paths use."""
    n = 4
    xyz = np.column_stack([np.linspace(0, 3, n), np.zeros(n), np.zeros(n)])
    labels = ["timestamp"]
    vals = np.arange(n, dtype=np.float64).reshape(-1, 1)
    origins = np.column_stack([np.zeros(n), np.zeros(n), np.full(n, 10.0)])
    dirs, new_labels, new_vals = main._attach_origins(xyz, labels, vals, origins)
    assert new_labels == ["timestamp", "origin_x", "origin_y", "origin_z"]
    np.testing.assert_allclose(new_vals[:, -3:], origins)
    assert dirs.shape == (n, 3)


def _session_with_origins(beam_origins, xyz):
    n = xyz.shape[0]
    return main.CloudSession(
        session_id="bo_sess",
        source_path="<test>",
        ascii_format=None,
        column_plan=None,
        positions=xyz,
        colors=None,
        intensity=None,
        extras={"is_miss": np.zeros(n, dtype=np.float32)},
        extra_dims_meta=[{"slug": "is_miss", "label": "is_miss"}],
        beam_origins=beam_origins,
        deleted=np.zeros(n, dtype=bool),
        deleted_history=[],
        octree_cache_id=None,
        created_at=time.time(),
    )


def test_session_to_lad_arrays_exposes_beam_origins():
    """The keep-subset beam origins are surfaced on the flags dict for the LAD
    caller."""
    xyz = np.column_stack([np.linspace(0, 1, 5), np.zeros(5), np.zeros(5)])
    origins = np.column_stack([np.zeros(5), np.zeros(5), np.full(5, 8.0)])
    sess = _session_with_origins(origins, xyz)
    sess.deleted[2] = True  # drop one
    _xyz, _dirs, _labels, _vals, flags = main._session_to_lad_arrays(sess, [0, 0, 8])
    assert flags["beam_origins"] is not None
    assert flags["beam_origins"].shape == (4, 3)  # keep-subset
    np.testing.assert_allclose(flags["beam_origins"], origins[[0, 1, 3, 4]])


def test_lad_uses_beam_origins_and_bypasses_trajectory(stub_pyhelios):
    """End-to-end (stubbed pyhelios): a session carrying beam_origins makes LAD take
    the per-beam path — writing origin_x/y/z from the EXPLICIT origins — even when a
    trajectory is also attached (which must be ignored, with a warning)."""
    # Three returns + one sky/miss point (is_miss=1) so the inversion has a beam
    # that passed through the canopy without returning, mirroring the moving shaping
    # tests. Each row carries its own per-pulse origin.
    xyz = np.array([[0.0, 0.0, 0.0], [0.5, 0.0, 0.0], [1.0, 0.0, 0.0],
                    [0.5, 0.0, 5.0]], dtype=np.float64)
    origins = np.column_stack([np.zeros(4), np.zeros(4), np.full(4, 5.0)])
    sess = _session_with_origins(origins, xyz)
    sess.extras["is_miss"] = np.array([0.0, 0.0, 0.0, 1.0], dtype=np.float32)
    with main._cloud_session_lock:
        main._cloud_sessions[sess.session_id] = sess
    try:
        traj = main.PoseStream(poses=[
            main.PoseSample(t=0.0, x=0, y=0, z=9, qx=0, qy=0, qz=0, qw=1),
            main.PoseSample(t=1.0, x=1, y=0, z=9, qx=0, qy=0, qz=0, qw=1),
        ])
        scan = main.HeliosScanEntry(
            session_id=sess.session_id, origin=[0, 0, 5],
            trajectory=traj, return_type="single")
        req = main.LADComputeRequest(
            scans=[scan],
            grid=main.HeliosGrid(center=[0.5, 0, 0], size=[2, 2, 1], nx=2, ny=1, nz=1),
            min_voxel_hits=1, gtheta=0.5)
        result = main._do_lad_computation(req)
        assert result["success"] is True, result.get("error")

        cloud = stub_pyhelios.instances[-1]
        ahp = next(c for c in cloud.calls if c[0] == "addHitPointsWithData")
        labels = ahp[3]
        assert {"origin_x", "origin_y", "origin_z"}.issubset(set(labels))
        # Trajectory was ignored in favour of explicit origins → a warning says so.
        assert any("ExtraBytes" in w or "explicit origins" in w
                   for w in result["warnings"])
    finally:
        with main._cloud_session_lock:
            main._cloud_sessions.pop(sess.session_id, None)


# ---------------------------------------------------------------------------
# Trajectory reconstruction from beam origins (for the moving-scan auto-create)
# ---------------------------------------------------------------------------

def test_reconstruct_trajectory_sorts_and_keeps_identity_attitude():
    """Origins + times → a PoseStream wire dict sorted by time, identity attitude."""
    # Out-of-order times to prove the sort.
    ts = np.array([2.0, 0.0, 1.0])
    bo = np.array([[2.0, 0, 10], [0.0, 0, 10], [1.0, 0, 10]])
    wire = main._trajectory_wire_from_beam_origins(bo, ts)
    assert wire is not None
    times = [p["t"] for p in wire["poses"]]
    assert times == sorted(times)
    assert wire["poses"][0]["x"] == 0.0 and wire["poses"][-1]["x"] == 2.0
    # Attitude is identity (origins give no rotation).
    assert all((p["qx"], p["qy"], p["qz"], p["qw"]) == (0.0, 0.0, 0.0, 1.0)
               for p in wire["poses"])
    assert wire["source_format"] == "las_extrabytes"


def test_reconstruct_trajectory_decimates_to_max_poses():
    """A dense pulse path decimates to <= max_poses, keeping first + last."""
    n = 10000
    ts = np.linspace(0.0, 100.0, n)
    bo = np.column_stack([np.linspace(0, 50, n), np.zeros(n), np.full(n, 12.0)])
    wire = main._trajectory_wire_from_beam_origins(bo, ts, max_poses=500)
    assert 2 <= len(wire["poses"]) <= 501
    assert wire["poses"][0]["t"] == 0.0
    assert wire["poses"][-1]["t"] == pytest.approx(100.0)


def test_reconstruct_trajectory_collapses_duplicate_times():
    """Repeated identical timestamps collapse so pose times strictly increase."""
    ts = np.array([0.0, 0.0, 0.0, 1.0, 1.0])
    bo = np.column_stack([np.arange(5.0), np.zeros(5), np.full(5, 5.0)])
    wire = main._trajectory_wire_from_beam_origins(bo, ts)
    times = [p["t"] for p in wire["poses"]]
    assert all(b > a for a, b in zip(times, times[1:]))


def test_reconstruct_trajectory_none_without_times():
    assert main._trajectory_wire_from_beam_origins(
        np.zeros((3, 3)), None) is None


def test_reconstruct_trajectory_single_pose_returns_none():
    """One distinct time is a static scan, not a trajectory."""
    assert main._trajectory_wire_from_beam_origins(
        np.array([[1.0, 2.0, 3.0]]), np.array([5.0])) is None
