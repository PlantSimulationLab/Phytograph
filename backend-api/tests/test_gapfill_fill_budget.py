"""The row/column gap-fill must survive a scanner's native raster without exhausting memory.

`gapfillMisses` conceptually emits one miss per EMPTY cell of the scan's declared
Ntheta x Nphi grid, so its cost is set by what `addScan()` was told — not by how many
returns came back. At ~100 bytes per stored hit, a scanner's native raster reaches
double-digit GB, and on Windows that has to be served as a SINGLE contiguous block. It
surfaced in the field as `std::bad_alloc` -> "bad allocation", from a scan that had
merely been imported at its true resolution.

Helios v1.3.84 fixed this by VIRTUALIZING the miss population: the misses are stored as
one bit per grid cell plus the fitted angular model, rather than as a HitPoint and a row
across every hit-data column each. The misses stay visible through `getHitCount()` and
the index-based accessors, so nothing downstream changes — but a raster that used to
need ~10 GB now needs ~12 MB.

(An earlier Phytograph-local Helios patch instead REFUSED an oversized raster up front,
via a `HELIOS_GAPFILL_MAX_POINTS` budget. Virtualization supersedes it: filling the
raster is now cheap, so refusing it would reject valid work. These tests pin the
property that mattered — a full-resolution raster fills, and stays affordable — rather
than the mechanism that used to deliver it.)

Native tests — a stubbed cloud cannot exercise real allocation behaviour.

MEASURING THIS IS THE HARD PART, and getting it wrong cost a full round trip
across three platforms. Peak RSS is not the fill's cost: the process has already
peaked before the fill runs (`addScan` on a fine raster allocates hundreds of MB),
and every platform reports the baseline differently — macOS has no cheap
current-RSS so the child substitutes the peak, Linux reads /proc/self/statm, and
Windows needed psapi added before it could measure at all. Subtracting a peak from
a current reading, as this file first did, charged the fill for all of that history
and produced a phantom "Linux materializes ~145 B/cell" that survived long enough
to earn a strict xfail. The child therefore records the peak BEFORE the fill too,
and the assertions read `transient` (peak after minus peak before) and `resident`
(what the fill kept). Measured that way all three platforms agree the fill is free.
Do not reintroduce an assertion on `added`; it is kept only for continuity.
"""

import functools
import os
import subprocess
import sys
import textwrap

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("PYHELIOS_ALLOW_MOCK") == "1",
    reason="needs the real native libhelios, not the mock",
)

_CHILD = textwrap.dedent(
    """
    import ctypes, math, os, sys
    import numpy as np
    from pyhelios import LiDARCloud

    n_theta, n_phi = int(sys.argv[1]), int(sys.argv[2])

    # A handful of returns spread over >=2 rows with >=4 returns each, so the
    # row/column model fits and we reach the FILL step rather than bailing out
    # earlier on "too few populated scan rows".
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

    if sys.platform == "win32":
        # psapi. The types are load-bearing: GetCurrentProcess returns the
        # pseudo-handle (HANDLE)-1, which the default c_int restype mangles on
        # x64 and the call then fails outright.
        class _PMC(ctypes.Structure):
            _fields_ = [("cb", ctypes.c_uint32), ("PageFaultCount", ctypes.c_uint32),
                        ("PeakWorkingSetSize", ctypes.c_size_t),
                        ("WorkingSetSize", ctypes.c_size_t),
                        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                        ("PagefileUsage", ctypes.c_size_t),
                        ("PeakPagefileUsage", ctypes.c_size_t),
                        ("PrivateUsage", ctypes.c_size_t)]
        _k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        _psapi = ctypes.WinDLL("psapi", use_last_error=True)
        _k32.GetCurrentProcess.restype = ctypes.c_void_p
        _psapi.GetProcessMemoryInfo.argtypes = [ctypes.c_void_p,
                                                ctypes.POINTER(_PMC),
                                                ctypes.c_uint32]

        def _pmc():
            c = _PMC()
            c.cb = ctypes.sizeof(_PMC)
            if not _psapi.GetProcessMemoryInfo(_k32.GetCurrentProcess(),
                                               ctypes.byref(c), c.cb):
                raise OSError("GetProcessMemoryInfo failed: %d"
                              % ctypes.get_last_error())
            return c

        def peak_rss_mb():
            return _pmc().PeakWorkingSetSize / (1024*1024)
    else:
        import resource

        def peak_rss_mb():
            # ru_maxrss is bytes on macOS, KB on Linux.
            peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            return peak / (1024*1024) if sys.platform == "darwin" else peak / 1024

    def current_rss_mb():
        # What the process holds RIGHT NOW, before the fill. The absolute peak
        # is useless as a budget because the baseline is platform-dependent:
        # this identical child measured 109 MB peak on macOS (fill added 2 MB
        # over a 107 MB baseline) and 1268 MB on the Linux CI runner, where
        # nothing about the fill itself differs. The fill's own cost is the DELTA.
        if sys.platform.startswith("linux"):
            with open("/proc/self/statm") as f:
                pages = int(f.read().split()[1])
            return pages * os.sysconf("SC_PAGE_SIZE") / (1024*1024)
        if sys.platform == "win32":
            return _pmc().WorkingSetSize / (1024*1024)
        # macOS has no cheap current-RSS; the peak so far is a fair proxy, since
        # nothing large has happened yet.
        return peak_rss_mb()

    try:
        before = current_rss_mb()
        # The peak the process had ALREADY reached before the fill ran. Without
        # it, `peak - before` silently charges the fill for every transient
        # allocation that happened during setup -- and setup is not small here:
        # addScan on a 95.8M-cell raster is hundreds of MB on its own.
        before_peak = peak_rss_mb()
        cloud.gapfillMisses()
        peak = peak_rss_mb()
        added = max(0.0, peak - before)
        # `added` stays first for compatibility; `transient` is the honest
        # measure of what the FILL itself peaked at, and `resident` of what it
        # kept.
        transient = max(0.0, peak - before_peak)
        resident = max(0.0, current_rss_mb() - before)
        print("OK", int(cloud.getHitCount()), round(added), round(peak),
              round(before), round(transient), round(resident))
    except Exception as exc:
        print("RAISED", str(exc).replace("\\n", " "))
    """
)


def _run(n_theta, n_phi):
    proc = subprocess.run(
        [sys.executable, "-c", _CHILD, str(n_theta), str(n_phi)],
        capture_output=True, text=True, timeout=600,
    )
    assert proc.returncode == 0, f"child crashed: {proc.stderr[-2000:]}"
    line = [l for l in proc.stdout.splitlines() if l.startswith(("OK", "RAISED"))]
    assert line, f"no verdict. stdout={proc.stdout[-500:]} stderr={proc.stderr[-500:]}"
    return line[0]


def test_small_raster_fills_every_empty_cell():
    """The baseline: every empty cell of the declared grid becomes a miss."""
    verdict = _run(20, 20)  # 400 cells, 32 of them with returns
    assert verdict.startswith("OK"), f"expected a successful fill, got: {verdict}"
    filled = int(verdict.split()[1])
    assert filled == 400, f"expected one hit per grid cell (400), got {filled}"


@functools.lru_cache(maxsize=None)
def _full_raster_verdict():
    """One 2000 x 4000 fill, shared by the two tests below (it takes seconds)."""
    return _run(2000, 4000)


def test_full_resolution_raster_fills_every_cell():
    """A scanner-native raster must fill completely: 8,000,000 cells, one miss each."""
    verdict = _full_raster_verdict()
    assert verdict.startswith("OK"), f"expected a successful fill, got: {verdict}"
    count = int(verdict.split()[1])
    assert count == 2000 * 4000, (
        f"expected the full raster to be gap-filled (8,000,000), got {count:,}")


def test_full_resolution_raster_fill_is_virtualized():
    """...and must stay affordable while doing it.

    Materialized at ~100 bytes/point, 8M cells is ~800 MB (the real VZ-600i raster
    from issue #5 is 95.8M cells, ~10 GB — the allocation that actually died on
    Windows). Virtualized it is ~1 MB of bitset. The memory ceiling is what makes this
    a regression test rather than a slow smoke test: if the misses are materialized,
    the fill's footprint blows straight through it.

    MEASURE `transient`, NOT `added`. `added` is peak-after minus resident-before,
    which charges the fill for every transient the process had already released —
    and setup is not small here, since `addScan` on a fine raster allocates
    hundreds of MB before the fill is even called. That formula is what produced
    the "Linux materializes ~145 B/cell" claim this test carried a strict xfail
    for. Measured on the CI runner with the honest fields, both rasters:

        [linux]  8.0M cells   added=3900  transient=0   resident=0
        [linux] 95.8M cells   added=3230  transient=0   resident=0

    `peak` was 4001 MB in both, i.e. a fixed ceiling the process had already hit
    before the fill ran — the runner's baseline, not the fill's cost. The
    divergence was in the metric, never in helios-core: Windows (MSVC) and macOS
    (clang) had already measured transient at 0 and 1-17 MB respectively, so all
    three platforms agree the virtualization works. No xfail; this now runs
    everywhere.
    """
    verdict = _full_raster_verdict()
    assert verdict.startswith("OK"), f"expected a successful fill, got: {verdict}"
    _, _count, added_mb, peak_mb, before_mb, transient_mb, resident_mb = verdict.split()
    assert int(transient_mb) < 600, (
        f"gap-filling an 8M-cell raster peaked {transient_mb} MB above its own "
        f"pre-fill peak (peak {peak_mb} MB, resident before {before_mb} MB, kept "
        f"{resident_mb} MB) — the misses look materialized rather than virtualized "
        f"(~800 MB of HitPoints at ~100 bytes each)")
    # What the fill KEPT. The virtualized set is a bit per cell plus the angular
    # model (~1 MB at 8M cells); a materialized one would retain ~800 MB. Bounded
    # well above the design cost and well below the materialized one, so it holds
    # on any platform without becoming a noise detector.
    assert int(resident_mb) < 200, (
        f"gap-filling an 8M-cell raster KEPT {resident_mb} MB — the virtualized "
        f"miss set should cost about a bit per cell (~1 MB), not a stored point each")
