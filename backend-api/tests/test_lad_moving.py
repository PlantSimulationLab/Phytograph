"""Moving-platform (trajectory-driven) leaf-area-density tests.

Two layers, matching the rest of the LAD suite:

- A stubbed-pyhelios SHAPING test: a scan carrying a `trajectory` must take the
  beam-based path — skip triangulation, supply G(theta) to calculateLeafArea, and
  write per-beam origin_x/y/z into the hit data map. Runs without the native build.

- An end-to-end test against REAL pyhelios: generate a genuine moving scan over the
  committed leaf-cube geometry via addScanMoving (the C++ writes per-pulse origins +
  timestamps + misses), then feed its hits + the same trajectory back through the
  backend's moving LAD path. This is the sim->process->validate loop. The
  DISCRIMINATING CONTROL re-runs the identical hits through the OLD single-origin
  inversion (origin pinned at the trajectory midpoint); the per-beam path must
  recover the uniform cube materially better — proving per-beam origins do real work,
  not merely "doesn't throw".
"""

import math
import os

import numpy as np
import pytest

import main

# Reuse the leaf-cube geometry + helios-core working dir + the stubbed-pyhelios
# fixture from the static suite. Importing the fixture re-exports it so pytest
# resolves `stub_pyhelios` in this module too.
from tests.test_lad import _GEOM_XML, _HELIOS_CORE, stub_pyhelios  # noqa: F401


def _identity_trajectory(t0, t1, p0, p1):
    """A 2-sample straight-line PoseStream model (identity attitude, no lever arm)
    spanning [t0,t1] from p0 to p1. Identity attitude keeps the nadir beams nadir,
    so the recovered geometry is easy to reason about."""
    return main.PoseStream(poses=[
        main.PoseSample(t=t0, x=p0[0], y=p0[1], z=p0[2], qx=0, qy=0, qz=0, qw=1),
        main.PoseSample(t=t1, x=p1[0], y=p1[1], z=p1[2], qx=0, qy=0, qz=0, qw=1),
    ])


# --------------------------------------------------------------------------- #
# Stubbed shaping test (no native build)                                        #
# --------------------------------------------------------------------------- #

class TestMovingShaping:
    def test_moving_scan_skips_triangulation_and_supplies_gtheta(self, stub_pyhelios):
        # Two returns + a miss, each with a timestamp so the join has a key.
        cols = {
            "timestamp": [0.0, 1.0, 2.0],
            "is_miss": [0.0, 0.0, 1.0],
        }
        traj = _identity_trajectory(0.0, 2.0, [0, 0, 5], [2, 0, 5])
        scan = main.HeliosScanEntry(
            points=[[0.0, 0.0, 0.0], [0.5, 0.0, 0.0], [1.0, 0.0, 5.0]],
            scalar_columns=cols,
            origin=[0, 0, 5],
            trajectory=traj,
            return_type="single",
        )
        req = main.LADComputeRequest(
            scans=[scan],
            grid=main.HeliosGrid(center=[0.5, 0, 0], size=[2, 2, 1], nx=2, ny=1, nz=1),
            min_voxel_hits=1, gtheta=0.42)
        result = main._do_lad_computation(req)
        assert result["success"] is True, result.get("error")

        cloud = stub_pyhelios.instances[-1]
        names = [c[0] for c in cloud.calls]
        # Beam-based path: NO triangulation.
        assert "triangulate" not in names
        # calculateLeafArea received the supplied G(theta) as a keyword (4th slot).
        la_call = next(c for c in cloud.calls if c[0] == "calculateLeafArea")
        assert la_call[3] == pytest.approx(0.42)
        # Per-beam origins were written into the hit data map.
        ahp = next(c for c in cloud.calls if c[0] == "addHitPointsWithData")
        labels = ahp[3]
        assert {"origin_x", "origin_y", "origin_z"}.issubset(set(labels))

    def test_moving_scan_defaults_gtheta_with_warning(self, stub_pyhelios):
        traj = _identity_trajectory(0.0, 1.0, [0, 0, 5], [1, 0, 5])
        scan = main.HeliosScanEntry(
            points=[[0.0, 0.0, 0.0], [1.0, 0.0, 5.0]],
            scalar_columns={"timestamp": [0.0, 1.0], "is_miss": [0.0, 1.0]},
            origin=[0, 0, 5], trajectory=traj, return_type="single")
        req = main.LADComputeRequest(
            scans=[scan],
            grid=main.HeliosGrid(center=[0.5, 0, 0], size=[2, 2, 1], nx=1, ny=1, nz=1),
            min_voxel_hits=1)  # no gtheta
        result = main._do_lad_computation(req)
        assert result["success"] is True
        cloud = stub_pyhelios.instances[-1]
        la_call = next(c for c in cloud.calls if c[0] == "calculateLeafArea")
        assert la_call[3] == pytest.approx(0.5)  # spherical default
        assert any("G(theta)" in w for w in result["warnings"])

    def test_moving_scan_requires_timestamp(self, stub_pyhelios):
        # A moving scan with no timestamp column cannot join to the trajectory.
        traj = _identity_trajectory(0.0, 1.0, [0, 0, 5], [1, 0, 5])
        scan = main.HeliosScanEntry(
            points=[[0.0, 0.0, 0.0], [1.0, 0.0, 5.0]],
            scalar_columns={"is_miss": [0.0, 1.0]},  # no timestamp
            origin=[0, 0, 5], trajectory=traj, return_type="single")
        req = main.LADComputeRequest(
            scans=[scan],
            grid=main.HeliosGrid(center=[0.5, 0, 0], size=[2, 2, 1], nx=1, ny=1, nz=1),
            min_voxel_hits=1, gtheta=0.5)
        result = main._do_lad_computation(req)
        # The generic handler turns the ValueError into a failure result.
        assert result["success"] is False
        assert "timestamp" in (result.get("error") or "").lower()


# --------------------------------------------------------------------------- #
# End-to-end against real pyhelios + the leaf-cube geometry                      #
# --------------------------------------------------------------------------- #

@pytest.mark.skipif(
    not os.path.isfile(os.path.join(_HELIOS_CORE, _GEOM_XML)),
    reason="leaf-cube geometry not present (helios-core submodule)")
class TestMovingScanRoundTrip:
    """Generate a moving scan over the uniform leaf cube, then invert it through the
    backend's per-beam path and compare to a single-origin control."""

    # A short straight pass well above the cube (centered on the origin), looking
    # nadir. The platform moves ~2 m over the sweep so per-beam origins genuinely
    # differ from any single fixed origin.
    NTHETA, NPHI = 1200, 1600
    P0 = [-1.0, 0.0, 5.0]
    P1 = [1.0, 0.0, 5.0]
    GRID_CENTER = [0.0, 0.0, 0.5]
    GRID_SIZE = [1.0, 1.0, 1.0]

    def _generate_moving_scan(self):
        """Run addScanMoving over the leaf cube; return (xyz, cols, traj_model)."""
        pytest.importorskip("pyhelios")
        from pyhelios import LiDARCloud, Context

        cwd = os.getcwd()
        os.chdir(_HELIOS_CORE)
        try:
            cloud = LiDARCloud()
            cloud.disableMessages()
            # Identity attitude, nadir-ish hemisphere sweep, straight-line pose over
            # [0, 1] s. pulse_rate sets per-pulse spacing; its exact value doesn't
            # matter for the round-trip since we join on the SAME timestamps the C++
            # writes (relative seconds).
            cloud.addScanMoving(
                Ntheta=self.NTHETA, theta_range=(0.0, math.pi),
                Nphi=self.NPHI, phi_range=(0.0, 2 * math.pi),
                exit_diameter=0.0, beam_divergence=0.0,
                traj_t=[0.0, 1.0],
                traj_pos=[self.P0, self.P1],
                traj_rot=[[0, 0, 0, 1], [0, 0, 0, 1]],
                pulse_rate_hz=float(self.NTHETA * self.NPHI),  # whole sweep over ~1 s
                rot_is_quaternion=True)
            cloud.addGrid(center=self.GRID_CENTER, size=self.GRID_SIZE, ndiv=[2, 2, 2])
            with Context() as ctx:
                ctx.loadXML(_GEOM_XML, True)
                cloud.syntheticScan(ctx, record_misses=True)
                positions, _ = cloud.getHitsXYZRGB()
                cols = {c: cloud.getHitDataAll(c)
                        for c in ("timestamp", "is_miss")}
        finally:
            os.chdir(cwd)

        xyz = np.array([[p.x, p.y, p.z] for p in positions], dtype=np.float64)
        return xyz, cols

    def _run_moving(self, xyz, cols):
        traj = _identity_trajectory(0.0, 1.0, self.P0, self.P1)
        scan = main.HeliosScanEntry(
            points=xyz.tolist(), scalar_columns=cols,
            origin=self.P0, trajectory=traj, return_type="single",
            n_theta=self.NTHETA, n_phi=self.NPHI,
            theta_min=0, theta_max=180, phi_min=0, phi_max=360)
        req = main.LADComputeRequest(
            scans=[scan],
            grid=main.HeliosGrid(center=self.GRID_CENTER, size=self.GRID_SIZE,
                                 nx=2, ny=2, nz=2),
            min_voxel_hits=1, gtheta=0.5)
        return main._do_lad_computation(req)

    def _run_single_origin_control(self, xyz, cols):
        """Same hits, NO trajectory: the static path pins one origin (the trajectory
        midpoint). This is the (wrong-for-a-moving-platform) baseline."""
        midpoint = [(a + b) / 2 for a, b in zip(self.P0, self.P1)]
        scan = main.HeliosScanEntry(
            points=xyz.tolist(), scalar_columns=cols,
            origin=midpoint, return_type="single",
            n_theta=self.NTHETA, n_phi=self.NPHI,
            theta_min=0, theta_max=180, phi_min=0, phi_max=360)
        req = main.LADComputeRequest(
            scans=[scan],
            grid=main.HeliosGrid(center=self.GRID_CENTER, size=self.GRID_SIZE,
                                 nx=2, ny=2, nz=2),
            lmax=0.04, max_aspect_ratio=10, min_voxel_hits=1)
        return main._do_lad_computation(req)

    def test_moving_scan_recovers_nondegenerate_lad(self):
        xyz, cols = self._generate_moving_scan()
        # Sanity: the C++ wrote real timestamps + some misses.
        assert np.any(np.asarray(cols["is_miss"]) > 0.5), "scan recorded no misses"
        result = self._run_moving(xyz, cols)
        assert result["success"] is True, result.get("error")
        cells = result["cells"]
        assert len(cells) == 8
        # The uniform cube has leaf area in every voxel; the per-beam inversion must
        # solve real positive LAD with real beam counts (not all-zero / not NaN).
        solved = [c for c in cells if c["lad"] > 0.0 and c["beam_count"]]
        assert len(solved) >= 6, \
            f"too few solved voxels: {[round(c['lad'], 2) for c in cells]}"
        # Confidence intervals are defined for solved voxels (Pimont uncertainty ran).
        assert any(c["ci_valid"] for c in cells)

    def test_per_beam_beats_single_origin_control(self):
        """The discriminating control: per-beam origins must recover the uniform cube
        better than pinning a single midpoint origin. With the platform moving ~2 m,
        the single-origin reconstruction mis-assigns beam path lengths, so its
        per-voxel LAD spread (which should be ~uniform) is materially worse."""
        xyz, cols = self._generate_moving_scan()
        moving = self._run_moving(xyz, cols)
        control = self._run_single_origin_control(xyz, cols)
        assert moving["success"] and control["success"], \
            (moving.get("error"), control.get("error"))

        def spread(result):
            # The truth is a UNIFORM cube, so a faithful inversion yields near-equal
            # per-voxel LAD. Coefficient of variation over solved voxels measures
            # departure from that uniformity.
            lads = np.array([c["lad"] for c in result["cells"]
                             if c["lad"] > 0.0], dtype=np.float64)
            if lads.size < 2:
                return np.inf
            return float(np.std(lads) / np.mean(lads))

        moving_cv = spread(moving)
        control_cv = spread(control)
        # Per-beam must be at least as uniform as the single-origin control, and
        # meaningfully so — the moving platform makes the single-origin assumption
        # wrong. (Strict inequality with a margin guards against a no-op that just
        # aliases the two paths.)
        assert moving_cv < control_cv * 0.95, \
            f"per-beam CV {moving_cv:.3f} not better than control {control_cv:.3f}"
