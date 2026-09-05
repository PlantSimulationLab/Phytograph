"""A cancel that lands in the converter's LAST poll interval must still cancel.

`_run_potree_converter` watches the child with `while proc.poll() is None:
check cancel; sleep(poll)`. That checks the cancel flag only while the child is
still alive: a cancel set during the final 200 ms interval — after the last
check, before the child exits 0 — fell out of the loop as a normal return, and
`_build_octree_from_las` then INSTALLED the finished octree of an import the
user had cancelled. The renderer had already dropped the scan (it saw the
cancel), so nothing was visibly wrong; only the cache grew. The E2E spec
import-cancel.spec.ts ("cancelling an import stops the backend work and adds no
scan") diffs the cache directory and caught it as a one-in-N flake: it clicks
Cancel as soon as the `.staging` dir appears, and on a fast machine a 1 M-point
conversion is short enough for the cancel to land in that last interval.

Deterministic reproduction, no timing luck: the fake converter runs long enough
that the first poll sees it alive, and the loop's OWN `time.sleep` is replaced
by a stand-in that sets the cancel flag and then outlasts the child — so the
next `proc.poll()` finds it exited 0 with the flag raised, exactly the ordering
the interval race produces. Same plain-`sh` shim as
test_import_cancel_kills_converter, for the reasons given there.
"""

import os
import stat
import threading

import pytest

import main


def test_cancel_during_the_last_poll_interval_still_cancels(tmp_path, monkeypatch):
    if os.name == "nt":
        pytest.skip("POSIX shim; the interval logic itself is platform-neutral")

    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "cache"))
    shim = tmp_path / "fake_converter.sh"
    shim.write_text("#!/bin/sh\nsleep 0.5\nexit 0\n")
    shim.chmod(shim.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PHYTOGRAPH_POTREECONVERTER", str(shim))

    las = tmp_path / "in.las"
    las.write_bytes(b"not really a las")
    out_dir = tmp_path / "staging"
    out_dir.mkdir()

    cancel_event = threading.Event()
    real_sleep = main.time.sleep
    slept = {"n": 0}

    def sleep_then_cancel(seconds):
        # First poll interval: the child is still running (0.5 s). Raise the
        # cancel flag now and wait past the child's exit, so the loop's next
        # `proc.poll()` sees returncode 0 with the flag already set.
        slept["n"] += 1
        if slept["n"] == 1:
            cancel_event.set()
            real_sleep(2.0)
        else:
            real_sleep(seconds)

    monkeypatch.setattr(main.time, "sleep", sleep_then_cancel)

    with pytest.raises(main.ScanCancelled):
        main._run_potree_converter(las, out_dir, cancel_event=cancel_event, poll=0.2)

    assert slept["n"] >= 1, "the loop never polled — the shim exited before the first check, so this run proved nothing"


def test_a_converter_that_finishes_uncancelled_still_returns_normally(tmp_path, monkeypatch):
    """The post-loop check must not turn an ordinary clean exit into a cancel."""
    if os.name == "nt":
        pytest.skip("POSIX shim")

    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "cache"))
    shim = tmp_path / "fake_converter.sh"
    shim.write_text("#!/bin/sh\nexit 0\n")
    shim.chmod(shim.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PHYTOGRAPH_POTREECONVERTER", str(shim))

    las = tmp_path / "in.las"
    las.write_bytes(b"not really a las")
    out_dir = tmp_path / "staging"
    out_dir.mkdir()

    main._run_potree_converter(las, out_dir, cancel_event=threading.Event(), poll=0.05)
