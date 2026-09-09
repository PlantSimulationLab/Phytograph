"""PotreeConverter LOD sampling: poisson for small clouds, random for large.

Measured on a 10 M-point cloud: poisson 32 s (0.31 M pts/s), random 5.1 s
(1.97 M pts/s) - a 6x difference on identical output size, and the converter is
the largest cost of every edit on a large cloud. The policy is pinned here from
both ends: the pure decision, and the argv the converter is actually spawned
with (a policy that is decided but never passed is a silent no-op).
"""
import os
import stat

import numpy as np
import pytest

import main


def _write_las(path, n):
    import laspy

    hdr = laspy.LasHeader(point_format=3, version="1.4")
    hdr.scales = [0.001] * 3
    with laspy.open(str(path), mode="w", header=hdr) as w:
        rec = laspy.ScaleAwarePointRecord.zeros(n, header=hdr)
        rec.x = np.linspace(0, 1, n)
        rec.y = np.zeros(n)
        rec.z = np.zeros(n)
        w.write_points(rec)


def test_policy_is_poisson_below_the_knee_and_random_above(monkeypatch):
    monkeypatch.delenv("PHYTOGRAPH_POTREE_SAMPLING", raising=False)
    monkeypatch.delenv("PHYTOGRAPH_POTREE_RANDOM_SAMPLING_MIN_POINTS", raising=False)
    knee = main._POTREE_RANDOM_SAMPLING_MIN_POINTS
    assert main._potree_sampling_method(knee - 1) == "poisson"
    assert main._potree_sampling_method(knee) == "random"
    assert main._potree_sampling_method(100 * knee) == "random"
    # Unknown count: the quality-first path.
    assert main._potree_sampling_method(None) == "poisson"


def test_env_pins_the_method_or_moves_the_knee(monkeypatch):
    monkeypatch.setenv("PHYTOGRAPH_POTREE_SAMPLING", "poisson")
    assert main._potree_sampling_method(10 ** 9) == "poisson"
    monkeypatch.setenv("PHYTOGRAPH_POTREE_SAMPLING", "random")
    assert main._potree_sampling_method(10) == "random"
    monkeypatch.setenv("PHYTOGRAPH_POTREE_SAMPLING", "bogus")
    monkeypatch.setenv("PHYTOGRAPH_POTREE_RANDOM_SAMPLING_MIN_POINTS", "50")
    assert main._potree_sampling_method(49) == "poisson"
    assert main._potree_sampling_method(50) == "random"


def test_las_point_count_reads_only_the_header(tmp_path):
    las = tmp_path / "n.las"
    _write_las(las, 1234)
    assert main._las_point_count(las) == 1234
    bogus = tmp_path / "bogus.las"
    bogus.write_bytes(b"not a las")
    assert main._las_point_count(bogus) is None


@pytest.mark.parametrize("n,expected", [(10, "poisson"), (3000, "random")])
def test_the_converter_is_spawned_with_the_chosen_method(tmp_path, monkeypatch, n, expected):
    """The argv PotreeConverter receives carries `-m <method>` - decided from the
    LAS header when the caller did not pass a count."""
    if os.name == "nt":
        pytest.skip("POSIX shim")
    monkeypatch.delenv("PHYTOGRAPH_POTREE_SAMPLING", raising=False)
    monkeypatch.setenv("PHYTOGRAPH_POTREE_RANDOM_SAMPLING_MIN_POINTS", "1000")
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "cache"))
    argv_file = tmp_path / "argv.txt"
    shim = tmp_path / "fake_converter.sh"
    shim.write_text(f"#!/bin/sh\necho \"$@\" > {argv_file}\nexit 0\n")
    shim.chmod(shim.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PHYTOGRAPH_POTREECONVERTER", str(shim))

    las = tmp_path / "in.las"
    _write_las(las, n)
    out_dir = tmp_path / "staging"
    out_dir.mkdir()
    main._run_potree_converter(las, out_dir)
    argv = argv_file.read_text().split()
    assert argv[argv.index("-m") + 1] == expected


def test_an_explicit_point_count_skips_the_header_and_still_decides(tmp_path, monkeypatch):
    if os.name == "nt":
        pytest.skip("POSIX shim")
    monkeypatch.delenv("PHYTOGRAPH_POTREE_SAMPLING", raising=False)
    monkeypatch.setenv("PHYTOGRAPH_POTREE_RANDOM_SAMPLING_MIN_POINTS", "1000")
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "cache"))
    argv_file = tmp_path / "argv.txt"
    shim = tmp_path / "fake_converter.sh"
    shim.write_text(f"#!/bin/sh\necho \"$@\" > {argv_file}\nexit 0\n")
    shim.chmod(shim.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PHYTOGRAPH_POTREECONVERTER", str(shim))
    las = tmp_path / "in.las"
    las.write_bytes(b"not really a las")   # header unreadable: the count must win
    out_dir = tmp_path / "staging"
    out_dir.mkdir()
    main._run_potree_converter(las, out_dir, point_count=5_000_000)
    argv = argv_file.read_text().split()
    assert argv[argv.index("-m") + 1] == "random"
