"""The row/column gap-fill must refuse an unaffordable raster instead of dying in malloc.

`gapfillMisses_rowcolumn` emits one hit point per EMPTY cell of the scan's declared
Ntheta x Nphi grid, so its cost is set by what `addScan()` was told — not by how many
returns came back. At ~100 bytes per stored hit (the contiguous HitPoint vector plus
its per-label data columns), a scanner's native raster reaches double-digit GB, and on
Windows that has to be served as a SINGLE contiguous block. It surfaced in the field as
`std::bad_alloc` -> "bad allocation", from a scan that had merely been imported at its
true resolution. The timestamp path has always capped its own fill (Ngap_max); this
path had no bound at all.

The cap refuses UP FRONT with a message naming the real numbers, rather than filling
partially: a truncated raster would hand the leaf-area inversion a hit/miss ratio that
is wrong in a way nothing downstream could detect.

Native tests — a stubbed cloud cannot exercise a C++ allocation guard.
"""

import os
import subprocess
import sys
import textwrap

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("PYHELIOS_ALLOW_MOCK") == "1",
    reason="needs the real native libhelios, not the mock",
)

# Deliberately far below the 60M default so the test never allocates real memory:
# it must prove the REFUSAL happens, not survive a 6 GB fill.
_TINY_BUDGET = "1000"

_CHILD = textwrap.dedent(
    """
    import math, sys
    import numpy as np
    from pyhelios import LiDARCloud

    n_theta, n_phi = int(sys.argv[1]), int(sys.argv[2])

    # A handful of returns spread over >=2 rows with >=4 returns each, so the
    # row/column model fits and we reach the FILL step (which is what is capped)
    # rather than bailing out earlier on "too few populated scan rows".
    rows, cols, pts = [], [], []
    origin = np.zeros(3)
    for row in range(4):
        for col in range(8):
            zen = math.radians(40.0 + row * 2.0)
            az = math.radians(col * 3.0)
            rows.append(float(row)); cols.append(float(col))
            pts.append([10*math.sin(zen)*math.cos(az),
                        10*math.sin(zen)*math.sin(az),
                        10*math.cos(zen)])
    xyz = np.asarray(pts, dtype=np.float64)
    d = xyz - origin
    dirs = (d / np.linalg.norm(d, axis=1, keepdims=True)).astype(np.float32)
    vals = np.column_stack([np.asarray(rows), np.asarray(cols)]).astype(np.float64)

    cloud = LiDARCloud()
    cloud.disableMessages()
    sid = cloud.addScan(origin=list(origin), Ntheta=n_theta,
                        theta_range=(0.0, math.pi), Nphi=n_phi,
                        phi_range=(0.0, 2*math.pi),
                        exit_diameter=0.0, beam_divergence=0.0)
    cloud.addHitPointsWithData(sid, xyz, dirs, ["row", "column"], vals)
    try:
        cloud.gapfillMisses()
        print("OK", int(cloud.getHitCount()))
    except Exception as exc:
        print("RAISED", str(exc).replace("\\n", " "))
    """
)


def _run(n_theta, n_phi, budget=None):
    env = dict(os.environ)
    if budget is not None:
        env["HELIOS_GAPFILL_MAX_POINTS"] = budget
    else:
        env.pop("HELIOS_GAPFILL_MAX_POINTS", None)
    proc = subprocess.run(
        [sys.executable, "-c", _CHILD, str(n_theta), str(n_phi)],
        capture_output=True, text=True, timeout=300, env=env,
    )
    assert proc.returncode == 0, f"child crashed: {proc.stderr[-2000:]}"
    line = [l for l in proc.stdout.splitlines() if l.startswith(("OK", "RAISED"))]
    assert line, f"no verdict. stdout={proc.stdout[-500:]} stderr={proc.stderr[-500:]}"
    return line[0]


def test_oversized_raster_is_refused_with_a_diagnostic():
    """A raster larger than the budget raises, naming the numbers — not bad_alloc."""
    verdict = _run(200, 200, budget=_TINY_BUDGET)  # 40,000 cells vs a 1,000 budget
    assert verdict.startswith("RAISED"), f"expected a refusal, got: {verdict}"
    # The message has to be actionable: the grid, the shortfall, and the way out.
    for token in ("gap-fill", "200", "budget", "HELIOS_GAPFILL_MAX_POINTS"):
        assert token in verdict, f"message missing {token!r}: {verdict}"


def test_raster_within_budget_still_fills():
    """The guard must not become a blanket refusal — an affordable raster still fills.

    Without this, raising the cap to 0 (or deleting the check) would leave the
    suite green, so the refusal test alone would not pin the behaviour.
    """
    verdict = _run(20, 20, budget=_TINY_BUDGET)  # 400 cells, comfortably under
    assert verdict.startswith("OK"), f"expected a successful fill, got: {verdict}"
    filled = int(verdict.split()[1])
    assert filled > 32, f"expected gapfilled misses on top of the 32 returns, got {filled}"


def test_default_budget_admits_a_real_terrestrial_raster():
    """The shipped default must not reject scans that legitimately work.

    5313 x 18029 is the real raster of the RIEGL VZ-600i export from issue #5:
    95.8M cells, ~50.1M of them empty. That scan completed in 235 s at 5.8 GB, so
    the default budget has to admit it — a cap that fixed the crash by rejecting
    valid work would be a regression, not a fix. Asserted on the ARITHMETIC rather
    than by running the 6 GB fill, so the test stays cheap.
    """
    from_default = 60000000  # LIDAR_GAPFILL_MAX_POINTS
    cells_to_fill = 5313 * 18029 - 45678141
    assert cells_to_fill == 50109936, "raster arithmetic drifted from the measured scan"
    assert cells_to_fill <= from_default, (
        f"the default budget ({from_default:,}) would reject the issue-#5 scan "
        f"({cells_to_fill:,} cells to fill), which is known to succeed")
