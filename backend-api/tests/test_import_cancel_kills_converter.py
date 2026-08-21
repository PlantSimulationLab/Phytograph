"""The cancel must KILL the PotreeConverter child, not merely stop waiting on it.

Before this change the converter ran under `subprocess.run`, which retains no
handle — the child was unreachable, so a "cancelled" import kept churning to
completion in the background. This is the test that proves the kill is real.

`_run_potree_converter` is driven directly rather than over HTTP: the subject
here is process lifecycle, and going through the endpoint would add a whole
import's worth of flake for no extra coverage.
"""

import os
import stat
import subprocess
import threading
import time
from pathlib import Path

import pytest

import main


def test_cancel_kills_the_converter_child_process(tmp_path, monkeypatch):
    """A cancelled import must leave no PotreeConverter running — and no orphaned
    grandchildren either, since the real converter forks its own workers."""
    if os.name == "nt":
        pytest.skip("POSIX process-group kill; Windows kills by pid only")

    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(tmp_path / "cache"))

    # A real child that would run for a long time if never killed. It records its
    # own pid so we can verify the OS reaped it. The trailing `sleep` is a
    # GRANDCHILD, which is what makes this a process-GROUP kill test.
    #
    # Deliberately a plain /bin/sh script, not a Python one: `_run_potree_converter`
    # scrubs DYLD_LIBRARY_PATH before spawning (PyInstaller's injected lib paths
    # break the real converter), and this venv's Python has pyhelios' native libs
    # loaded — re-exec'ing it without those vars would segfault the child for
    # reasons unrelated to what's under test. `sh` + `sleep` also models the real
    # converter (a native binary) more closely.
    pid_file = tmp_path / "child.pid"
    shim = tmp_path / "fake_converter.sh"
    shim.write_text(f'#!/bin/sh\necho $$ > "{pid_file}"\nsleep 120\n')
    shim.chmod(shim.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PHYTOGRAPH_POTREECONVERTER", str(shim))

    las = tmp_path / "in.las"
    las.write_bytes(b"not really a las")
    out_dir = tmp_path / "staging"
    out_dir.mkdir()

    cancel_event = threading.Event()

    def fire():
        deadline = time.time() + 10
        while time.time() < deadline and not pid_file.is_file():
            time.sleep(0.02)
        time.sleep(0.2)
        cancel_event.set()

    t = threading.Thread(target=fire, daemon=True)
    t.start()
    started = time.time()
    with pytest.raises(main.ScanCancelled):
        main._run_potree_converter(las, out_dir, cancel_event=cancel_event, poll=0.05)
    elapsed = time.time() - started
    t.join(timeout=5)

    # The converter would have run for 120s; the cancel must not have waited.
    assert elapsed < 30, f"cancel waited {elapsed:.1f}s for the converter"
    assert pid_file.is_file(), "the converter child never started"
    child_pid = int(pid_file.read_text().strip())

    # The child is gone from the OS — killed, not merely detached and left to run.
    deadline = time.time() + 5
    while time.time() < deadline:
        try:
            os.kill(child_pid, 0)
        except OSError:
            break
        time.sleep(0.05)
    else:
        pytest.fail(f"PotreeConverter child {child_pid} survived the cancel")

    # The whole process GROUP died, not just the direct child: the shim's own
    # `sleep` grandchild must be gone too. This is why the spawn puts the child in
    # its own group — the real converter forks worker children, and reaping only
    # the parent would leave them chewing CPU after a cancel.
    survivors = subprocess.run(["pgrep", "-g", str(child_pid)],
                               capture_output=True, text=True).stdout.split()
    assert not survivors, f"process group {child_pid} still has members: {survivors}"
