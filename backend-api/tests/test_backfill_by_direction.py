"""Backfill Misses and LAD for static scans whose returns carry no usable pulse clock.

helios-core v1.3.89 added two things these pin, against the REAL libhelios (a
stub would only restate what we think Helios does):

* `gapfillMisses()` places the returns of a static raster scan with neither
  timestamps nor row/column indices on the scan's DECLARED raster by direction.
  Backfill used to refuse such scans outright; it now takes this route when the
  renderer supplies the raster (a point-count estimate is not the scanner's).
* Helios refuses timestamps that do not identify pulses (returns sharing one
  point different ways -- a 32-bit float round-trip) in both gap-fill and the
  leaf-area inversion. `_audit_pulse_columns` judges rounding by group size, so
  single-return data rounded into groups of a few pulses passes it; Helios then
  raised where it used to return a silently wrong answer. For a static scan both
  paths now drop the timestamps and fall back to per-return pulses, as
  helios-core's own remedy says.

The fixture is a synthetic scan fired by PyHelios itself with misses recorded,
so the true miss set is known exactly and the raster convention is Helios's own.
"""

import asyncio
import math
import time

import numpy as np
import pytest

import main

pytest.importorskip("pyhelios")

NT, NP = 40, 80
ORIGIN = [0.0, 0.0, 1.5]
THETA = (40.0, 140.0)       # degrees
PHI = (0.0, 360.0)
PERIOD = 1.0e-5             # s between pulses
T0 = 400.0                  # s; float32 resolves ~30 us here, i.e. ~3 pulses


def _scan(azimuth_offset_deg=0.0, foliage=False, seed=7):
    """Fire a static raster scan with misses recorded. Returns (xyz, is_miss,
    pulse) where `pulse` is each return's pulse index in firing order, read from
    Helios's own inverse of the raster (getNominalScanGridCell)."""
    from pyhelios import Context, LiDARCloud
    from pyhelios.types import SphericalCoord, vec2, vec3

    cloud = LiDARCloud()
    cloud.disableMessages()
    cloud.addScan(origin=ORIGIN, Ntheta=NT,
                  theta_range=(math.radians(THETA[0]), math.radians(THETA[1])),
                  Nphi=NP, phi_range=(math.radians(PHI[0]), math.radians(PHI[1])),
                  exit_diameter=0.0, beam_divergence=0.0,
                  scan_azimuth_offset=math.radians(azimuth_offset_deg))
    with Context() as ctx:
        ctx.addPatch(center=vec3(4, 0, 1.5), size=vec2(8, 6),
                     rotation=SphericalCoord(1, 0, math.pi / 2))
        ctx.addPatch(center=vec3(0, -3, 1.5), size=vec2(6, 4),
                     rotation=SphericalCoord(1, math.pi / 2, 0))
        if foliage:
            # A box of randomly oriented leaves around (0, 2.5, 1.5): the voxel
            # grid of the LAD test sits on it.
            rng = np.random.default_rng(seed)
            for _ in range(400):
                c = rng.uniform([-0.5, 2.0, 1.0], [0.5, 3.0, 2.0])
                ctx.addPatch(center=vec3(*c), size=vec2(0.05, 0.05),
                             rotation=SphericalCoord(1, float(rng.uniform(0, math.pi / 2)),
                                                     float(rng.uniform(0, 2 * math.pi))))
        cloud.syntheticScan(ctx, record_misses=True)
    xyz, _ = cloud.getHitsXYZRGBArrays()
    xyz = np.asarray(xyz, dtype=np.float64)
    miss = np.asarray(cloud.getHitMissArray(), dtype=np.int32)
    cells = [cloud.getNominalScanGridCell(0, vec3(*p)) for p in xyz]
    pulse = np.array([c * NT + r for r, c in cells], dtype=np.int64)
    return xyz, miss, pulse


def _timestamps(pulse, pulses_per_tick=1):
    """Per-return GPS time: exact, or rounded so `pulses_per_tick` consecutive
    pulses share one value (what a float32 export does)."""
    return T0 + PERIOD * pulses_per_tick * (pulse // pulses_per_tick).astype(np.float64)


def _session(xyz, extras, session_id):
    n = len(xyz)
    sess = main.CloudSession(
        session_id=session_id, source_path="<test>", ascii_format=None,
        column_plan=None, positions=np.asarray(xyz, dtype=np.float64),
        colors=None, intensity=None,
        extras={k: np.asarray(v, dtype=np.float64) for k, v in extras.items()},
        extra_dims_meta=[{"slug": k, "label": k} for k in extras],
        deleted=np.zeros(n, dtype=bool), deleted_history=[],
        octree_cache_id=None, created_at=time.time(),
    )
    with main._cloud_session_lock:
        main._cloud_sessions[session_id] = sess
    return sess


@pytest.fixture(autouse=True)
def _clear_sessions(monkeypatch):
    with main._cloud_session_lock:
        before = dict(main._cloud_sessions)
    # The miss octree is a display artifact built by PotreeConverter; what these
    # tests measure is the reconstruction, so skip it.
    monkeypatch.setattr(main, "_build_miss_octree", lambda *a, **k: None)
    yield
    with main._cloud_session_lock:
        main._cloud_sessions.clear()
        main._cloud_sessions.update(before)


def _backfill(session_id, **body):
    from tests.binframe import decode_streamed_json_with_markers

    body.setdefault("origin", ORIGIN)
    req = main.BackfillMissesRequest(**body)
    resp = main.backfill_cloud_misses(session_id, req, http_request=None)

    async def _collect():
        return b"".join([c if isinstance(c, (bytes, bytearray)) else c.encode()
                         async for c in resp.body_iterator])

    result, _markers = decode_streamed_json_with_markers(asyncio.run(_collect()))
    return result


RASTER = dict(n_theta=NT, n_phi=NP, theta_min=THETA[0], theta_max=THETA[1],
              phi_min=PHI[0], phi_max=PHI[1])


@pytest.fixture(scope="module")
def level_scan():
    return _scan()


# ---------------------------------------------------------------------------
# Backfill: placement by direction
# ---------------------------------------------------------------------------

def test_scan_without_columns_is_gapfilled_by_direction(level_scan):
    xyz, miss, _pulse = level_scan
    hits = xyz[miss == 0]
    assert 200 < len(hits) < NT * NP // 2   # Helios checks need >= 200 returns
    sess = _session(hits, {}, "bf-dir")

    res = _backfill("bf-dir", **RASTER)

    assert "error" not in res, res.get("error")
    # Every pulse the scanner fired without a return, and nothing else.
    assert res["backfilled"] == int((miss != 0).sum())
    assert sess.backfilled_misses["positions"].shape[0] == res["backfilled"]
    # The direction route leaves each miss its raster cell.
    assert "row_index" in sess.backfilled_misses
    assert any("declared angular raster" in w for w in res["warnings"])


def test_scan_without_columns_or_raster_is_refused(level_scan):
    xyz, miss, _pulse = level_scan
    _session(xyz[miss == 0], {}, "bf-noraster")
    with pytest.raises(main.HTTPException) as exc:
        _backfill("bf-noraster")
    assert exc.value.status_code == 400
    assert "scan's parameters" in str(exc.value.detail)


def test_moving_scan_without_columns_is_still_refused(level_scan):
    xyz, miss, _pulse = level_scan
    _session(xyz[miss == 0], {}, "bf-moving")
    traj = main.PoseStream(poses=[
        main.PoseSample(t=0.0, x=0.0, y=0.0, z=1.5, qx=0.0, qy=0.0, qz=0.0, qw=1.0),
        main.PoseSample(t=1.0, x=1.0, y=0.0, z=1.5, qx=0.0, qy=0.0, qz=0.0, qw=1.0),
    ])
    with pytest.raises(main.HTTPException) as exc:
        _backfill("bf-moving", trajectory=traj, **RASTER)
    assert exc.value.status_code == 400
    assert "moving-platform" in str(exc.value.detail)


def test_heading_reaches_the_placement():
    """The declared heading is what the returns are taken back through. Sent,
    the rotated scan is recovered exactly; withheld, Helios finds the returns
    off the raster and refuses -- so this fails if the field is not forwarded."""
    xyz, miss, _pulse = _scan(azimuth_offset_deg=2.0)
    hits = xyz[miss == 0]
    _session(hits, {}, "bf-heading")
    res = _backfill("bf-heading", azimuth_offset_deg=2.0, **RASTER)
    assert "error" not in res, res.get("error")
    assert res["backfilled"] == int((miss != 0).sum())

    _session(hits, {}, "bf-heading-missing")
    res = _backfill("bf-heading-missing", **RASTER)
    assert res["backfilled"] == 0
    assert "Scan Parameters" in res["error"]


# ---------------------------------------------------------------------------
# Backfill: rounded timestamps on a static scan
# ---------------------------------------------------------------------------

def test_rounding_the_audit_sees_is_dropped_up_front(level_scan):
    xyz, miss, pulse = level_scan
    ts = _timestamps(pulse[miss == 0], pulses_per_tick=40)   # one whole column
    assert main._audit_pulse_columns(ts)["timestamps_rounded"]
    _session(xyz[miss == 0], {"timestamp": ts}, "bf-round-audit")

    res = _backfill("bf-round-audit", **RASTER)

    assert "error" not in res, res.get("error")
    assert res["backfilled"] == int((miss != 0).sum())
    assert any("were not used" in w for w in res["warnings"])


def test_rounding_only_helios_sees_is_recovered(level_scan):
    """Groups of 3 pulses pass our audit (single-return data is judged against a
    15-return cap) but not Helios's direction check. Before, gap-fill raised; the
    static scan now drops the timestamps and is placed by direction."""
    xyz, miss, pulse = level_scan
    ts = _timestamps(pulse[miss == 0], pulses_per_tick=3)
    assert not main._audit_pulse_columns(ts)["timestamps_rounded"]
    _session(xyz[miss == 0], {"timestamp": ts}, "bf-round-helios")

    res = _backfill("bf-round-helios", **RASTER)

    assert "error" not in res, res.get("error")
    assert res["backfilled"] == int((miss != 0).sum())
    assert any("were not used" in w for w in res["warnings"])


def test_rounded_timestamps_without_a_raster_fail_with_helios_reason(level_scan):
    # Rounding only Helios sees is found mid-stream, so it comes back in the JSON
    # tail -- in the app's words, not Helios's API remedy.
    xyz, miss, pulse = level_scan
    ts = _timestamps(pulse[miss == 0], pulses_per_tick=3)
    _session(xyz[miss == 0], {"timestamp": ts}, "bf-round-noraster")
    res = _backfill("bf-round-noraster")
    assert res["backfilled"] == 0
    assert "do not identify individual pulses" in res["error"]
    assert "scan's parameters" in res["error"]
    assert "deleteHitData" not in res["error"]


def test_rounding_the_audit_sees_without_a_raster_is_refused_up_front(level_scan):
    # The audit's verdict drops the timestamps before eligibility is judged, so
    # a scan left with no route is a clean 400 naming the fix -- not a stream
    # that dies inside Helios.
    xyz, miss, pulse = level_scan
    ts = _timestamps(pulse[miss == 0], pulses_per_tick=40)
    _session(xyz[miss == 0], {"timestamp": ts}, "bf-round-audit-noraster")
    with pytest.raises(main.HTTPException) as exc:
        _backfill("bf-round-audit-noraster")
    assert exc.value.status_code == 400
    assert "scan's parameters" in str(exc.value.detail)


# ---------------------------------------------------------------------------
# LAD: timestamps only Helios can tell are rounded
# ---------------------------------------------------------------------------

def _lad(xyz, cols):
    scan = main.HeliosScanEntry(
        points=xyz.tolist(), scalar_columns=cols, origin=ORIGIN,
        n_theta=NT, n_phi=NP, theta_min=THETA[0], theta_max=THETA[1],
        phi_min=PHI[0], phi_max=PHI[1], return_type="single")
    req = main.LADComputeRequest(
        scans=[scan],
        grid=main.HeliosGrid(center=[0.0, 2.5, 1.5], size=[1.0, 1.0, 1.0],
                             nx=1, ny=1, nz=1),
        gtheta=0.5, gtheta_override=True, min_voxel_hits=1)
    return main._do_lad_computation(req)


def test_lad_inverts_per_return_when_only_helios_sees_rounding():
    xyz, miss, pulse = _scan(foliage=True)
    is_miss = miss.astype(np.float64).tolist()
    exact = _lad(xyz, {"is_miss": is_miss})
    assert exact["success"], exact.get("error")
    assert exact["cells"][0]["lad"] > 0

    ts = _timestamps(pulse, pulses_per_tick=3)
    assert not main._audit_pulse_columns(ts, is_miss=miss)["timestamps_rounded"]
    rounded = _lad(xyz, {"is_miss": is_miss, "timestamp": ts.tolist()})

    assert rounded["success"], rounded.get("error")
    # Identical to never having had the timestamps: each return its own pulse.
    assert rounded["cells"][0]["lad"] == pytest.approx(exact["cells"][0]["lad"], rel=1e-9)
    assert any("do not identify individual pulses" in w for w in rounded["warnings"])
