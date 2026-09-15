"""Gap-filling must terminate regardless of which way the scanner sweeps.

`gapfillMisses_timestamp`'s edge-extrapolation loops walk theta outward from each
sweep's first/last return until it leaves the scan's zenith range. They stepped by
the SIGNED mean zenith increment, `dtheta_avg` — but that sign encodes only the
scanner's sweep direction, not the direction the loop needs to travel.

A top-down scanner (RIEGL VZ-series exports among them: zenith DECREASES along the
pulse train) makes `dtheta_avg` negative, which walked theta away from the bound it
was tested against. Neither loop could then satisfy its exit condition, and because
theta is a `float` the step eventually fell below the ULP (~8192 rad) and stopped
changing the value at all — a true infinite loop. The bounds/dedup guards inside the
loop body meant no points were added, so it burned CPU silently instead of crashing:
the backfill request never returned and the UI sat at its progress-bar asymptote.

This is the regression guard. It is a NATIVE test — it calls the real C++ through
pyhelios, because a stubbed cloud cannot exhibit the bug at all.

The test is written so that it FAILS (by timing out) against the unfixed library
rather than passing vacuously: the scan is built with strictly DECREASING zenith,
which is the only orientation that triggers it. `test_ascending_sweep_also_terminates`
is the control — it passed before the fix too, so on its own it would prove nothing;
its job is to show the fix didn't break the orientation that already worked.

The fixture must also be a scan the gapfiller will ACCEPT, which is a moving target:
helios-core 1.3.86 added two validity guards (a raster needs more than one column to
measure column spacing, and the reconstructed column period must be long enough to
hold a column's pulses), and the original single-azimuth fixture tripped the first.
Keep the assertion that gapfilling actually ADDS points — it is what distinguishes
"the loops ran and terminated" from "the loops never ran", and only the former says
anything about the bug.
"""

import os
import sys
import textwrap

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("PYHELIOS_ALLOW_MOCK") == "1",
    reason="needs the real native libhelios, not the mock",
)

# The unfixed loop spins forever, so the only way to observe the bug is a wall-clock
# bound. Generous enough that a slow machine cannot flake it: the fixed code does
# this work in well under a second, while the broken code never finishes at all.
_TIMEOUT_S = 90

# The fixture's raw return count: `_N_PER_COLUMN` returns in each of `_N_COLUMNS`
# raster columns. Kept here rather than as a bare literal in the assertions
# because the gapfill must be shown to ADD points on top of them, so the number
# has to track the fixture — and the fixture grew a second column when
# helios-core 1.3.86 started rejecting single-column rasters.
_N_PER_COLUMN = 600
_N_COLUMNS = 3
_N_RETURNS = _N_PER_COLUMN * _N_COLUMNS


# Run the native call in a SEPARATE PROCESS so a hang can be killed: an infinite
# loop inside C++ never returns to the interpreter, so it ignores Python signals
# and a pytest-level timeout could not reclaim the process. Driven as a standalone
# script (rather than multiprocessing) because a `spawn` child re-imports its
# target's module, which pytest's test modules are not importable as.
_CHILD = textwrap.dedent(
    """
    import math, sys
    import numpy as np
    from pyhelios import LiDARCloud

    descending = sys.argv[1] == "1"
    n_theta, n_phi = 2000, 4000
    theta_lo_deg, theta_hi_deg = 25.0, 130.0

    origin = np.zeros(3)
    # Sweeps of returns marching monotonically through zenith. `descending`
    # is the whole point of the test: it flips the sign of dtheta_avg.
    n_per = int(sys.argv[2])
    n_cols = int(sys.argv[3])
    zen1 = np.linspace(theta_lo_deg + 5.0, theta_hi_deg - 5.0, n_per)
    if descending:
        zen1 = zen1[::-1]
    # The +-5 deg inset leaves a gap at each end of the sweep so BOTH edge
    # extrapolation loops actually run; with no gap they are skipped entirely
    # and the bug is never reached.
    #
    # SEVERAL columns, not one. gapfillMisses() reconstructs the raster, and
    # measures the column spacing from the gaps between the columns' first-pulse
    # times — so a scan whose returns all share one azimuth has no spacing to
    # measure and is rejected outright (helios-core >= 1.3.86). A single column
    # was enough to reach the extrapolation loops on the old library, but it is a
    # degenerate raster, and the fixture has to be a scan the gapfiller will
    # accept before it can say anything about how that gapfiller loops.
    zen = np.tile(zen1, n_cols)
    az = np.repeat(30.0 + 0.09 * np.arange(n_cols), n_per)
    r = np.full(zen.shape[0], 10.0)
    zr, ar = np.radians(zen), np.radians(az)
    xyz = np.column_stack([
        r * np.sin(zr) * np.cos(ar),
        r * np.sin(zr) * np.sin(ar),
        r * np.cos(zr),
    ]).astype(np.float64)
    d = xyz - origin
    dirs = (d / np.linalg.norm(d, axis=1, keepdims=True)).astype(np.float32)
    # Strictly increasing timestamps: the gapfiller sorts on them and derives
    # dt_avg / dtheta_avg from consecutive pairs.
    #
    # The column period has to be long enough to hold the pulses of a column, or
    # the reconstruction concludes the beam angles contradict the declared zenith
    # range and refuses the scan. The declared range spans more pulses than the
    # +-5 deg inset actually fills, so step WITHIN a column by `period` and start
    # each column a full declared-column later, with margin.
    period = 1e-6
    step_deg = abs(zen1[1] - zen1[0])
    col_pulses = int(math.ceil((theta_hi_deg - theta_lo_deg) / step_deg))
    col_span = (col_pulses + 50) * period
    ts = (np.repeat(np.arange(n_cols, dtype=np.float64) * col_span, n_per)
          + np.tile(np.arange(n_per, dtype=np.float64) * period, n_cols)
          ).reshape(-1, 1)

    cloud = LiDARCloud()
    cloud.disableMessages()
    sid = cloud.addScan(
        origin=list(origin), Ntheta=n_theta,
        theta_range=(math.radians(theta_lo_deg), math.radians(theta_hi_deg)),
        Nphi=n_phi, phi_range=(0.0, 2 * math.pi),
        exit_diameter=0.0, beam_divergence=0.0,
    )
    cloud.addHitPointsWithData(sid, xyz, dirs, ["timestamp"], ts)
    cloud.gapfillMisses()
    print("HITS", int(cloud.getHitCount()))
    """
)


def _gapfill_or_timeout(descending):
    """Return the child's final hit count, or fail if it does not terminate."""
    import subprocess

    proc = subprocess.Popen(
        [sys.executable, "-c", _CHILD, "1" if descending else "0",
         str(_N_PER_COLUMN), str(_N_COLUMNS)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        out, err = proc.communicate(timeout=_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        pytest.fail(
            f"gapfillMisses() did not terminate within {_TIMEOUT_S}s on a "
            f"{'descending' if descending else 'ascending'} sweep — the zenith "
            "extrapolation loop is stepping away from its bound (dtheta_avg sign)."
        )
    assert proc.returncode == 0, f"child failed ({proc.returncode}): {err[-2000:]}"
    line = [l for l in out.splitlines() if l.startswith("HITS")]
    assert line, f"child produced no hit count. stdout={out[-500:]} stderr={err[-500:]}"
    return int(line[0].split()[1])


def test_descending_sweep_terminates():
    """A top-down sweep (dtheta_avg < 0) must gapfill and RETURN.

    This is the failing case: against the unfixed library the child process spins
    in direction2rc forever and the test fails on the timeout.
    """
    hits = _gapfill_or_timeout(descending=True)
    # Termination is the property under test, but assert the call did real work
    # rather than bailing out early — a version that returned immediately without
    # filling anything would also "terminate".
    assert hits > _N_RETURNS, (
        f"expected gapfilled misses on top of the {_N_RETURNS} returns, got {hits}"
    )


def test_ascending_sweep_also_terminates():
    """Control: the bottom-up orientation already worked, and must keep working.

    On its own this proves nothing about the bug — it passes before and after the
    fix. It is here so a regression that merely inverts the sign is still caught.
    """
    hits = _gapfill_or_timeout(descending=False)
    assert hits > _N_RETURNS, (
        f"expected gapfilled misses on top of the {_N_RETURNS} returns, got {hits}"
    )
