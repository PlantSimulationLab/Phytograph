"""Every PotreeConverter run is admitted against the memory budget.

Measured on the 100 M-point bench cloud: the converter peaks at 7.06 GB of
resident memory (~70 B/pt) in its own process, which no Python-side estimate
saw, and a ground segmentation with split launches three converts at once.
Admitting each build at `_POTREE_BYTES_PER_POINT` per point is what keeps
those from stacking past the budget on a 16 GB machine.
"""
import os
import stat

import numpy as np
import pytest

import main
import memory_budget


def _write_las(path, n):
    import laspy

    hdr = laspy.LasHeader(point_format=3, version="1.4")
    hdr.scales = [0.001] * 3
    with laspy.open(str(path), mode="w", header=hdr) as w:
        rec = laspy.ScaleAwarePointRecord.zeros(n, header=hdr)
        rec.x = np.linspace(0, 1, n)
        w.write_points(rec)


def test_octree_build_is_admitted_at_the_converters_measured_rate(tmp_path, monkeypatch):
    if os.name == "nt":
        pytest.skip("POSIX shim")
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "cache"))
    shim = tmp_path / "fake_converter.sh"
    # A converter that produces a metadata.json, so the install succeeds.
    shim.write_text('#!/bin/sh\nout=""\nwhile [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; fi; shift; done\n'
                    'mkdir -p "$out"\necho \'{"points": 1234, "boundingBox": {"min": [0,0,0], "max": [1,1,1]}, '
                    '"attributes": [], "hierarchy": {"firstChunkSize": 0, "stepSize": 0, "depth": 0}}\' > "$out/metadata.json"\n'
                    'touch "$out/hierarchy.bin" "$out/octree.bin"\nexit 0\n')
    shim.chmod(shim.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PHYTOGRAPH_POTREECONVERTER", str(shim))

    seen = []
    real = main._ADMISSION.admit

    def spy(estimate, label):
        seen.append((int(estimate), label))
        return real(estimate, label)

    monkeypatch.setattr(main._ADMISSION, "admit", spy)
    las = tmp_path / "in.las"
    _write_las(las, 1234)
    try:
        main._build_octree_from_las(las, [])
    except Exception:
        # The fake metadata may not satisfy every reader; the admission is
        # what this test is about and it happens before the converter runs.
        pass
    builds = [(b, l) for b, l in seen if l.startswith("octree build")]
    assert builds == [(1234 * main._POTREE_BYTES_PER_POINT, "octree build 1,234 pts")]


def test_three_concurrent_builds_serialise_under_a_small_budget():
    """The property the 16 GB target needs: with a budget that fits one
    100 M-point convert, three admissions run one after another."""
    import threading
    import time

    adm = memory_budget.Admission(lambda: 8 * memory_budget.GiB)
    per = 100_000_000 * main._POTREE_BYTES_PER_POINT      # 7.2 GB each
    running = []
    peak = [0]
    lock = threading.Lock()

    def build():
        with adm.admit(per, "octree build"):
            with lock:
                running.append(1)
                peak[0] = max(peak[0], len(running))
            time.sleep(0.05)
            with lock:
                running.pop()

    threads = [threading.Thread(target=build) for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    assert peak[0] == 1
