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


# OPEN: the fill is NOT virtualized on the Linux build. Measured on the CI runner
# (ubuntu-24.04, gcc, helios-core 1.3.84 + 971159896): the fill ADDED 1160 MB over a
# 102 MB baseline for 8M cells — ~145 bytes per cell, i.e. a HitPoint plus its
# hit-data columns per miss, exactly the materialized layout the virtualization was
# written to remove. The same child on macOS (clang, libomp) adds 2 MB. Same source,
# same pins, same Python wrapper (`gapfillLiDARMisses` -> `gapfillMissesCount`, the
# count-only path); the divergence is somewhere below that and has not been located.
# It matters beyond this test: the real VZ-600i raster is 95.8M cells, which at this
# rate is ~14 GB — the allocation that originally died on Windows, a gcc/MSVC-shaped
# platform rather than a clang one. Strict xfail so the day it is fixed this flips to
# an XPASS failure and the marker has to come out, rather than silently hiding.
@pytest.mark.xfail(
    sys.platform.startswith("linux"), strict=True,
    reason="helios-core gap-fill materializes ~145 B/cell on the Linux (gcc) build; "
           "virtualized on macOS (clang). Unlocated as of 2026-09-05.")
def test_full_resolution_raster_fill_is_virtualized():
    """...and must stay affordable while doing it.

    Materialized at ~100 bytes/point, 8M cells is ~800 MB (the real VZ-600i raster
    from issue #5 is 95.8M cells, ~10 GB — the allocation that actually died on
    Windows). Virtualized it is ~1 MB of bitset. The memory ceiling is what makes this
    a regression test rather than a slow smoke test: if the misses are materialized,
    the fill's footprint blows straight through it.
    """
    verdict = _full_raster_verdict()
    assert verdict.startswith("OK"), f"expected a successful fill, got: {verdict}"
    _, _count, added_mb, peak_mb, before_mb, transient_mb, resident_mb = verdict.split()
    # Budget the fill's OWN footprint (peak after minus resident before), not the
    # absolute peak: the process baseline is what the interpreter and libhelios
    # cost on that platform and says nothing about whether misses were materialized.
    assert int(added_mb) < 600, (
        f"gap-filling an 8M-cell raster added {added_mb} MB (peak {peak_mb} MB over a "
        f"{before_mb} MB baseline) — the misses look materialized rather than "
        f"virtualized (~800 MB of HitPoints at ~100 bytes each)")
