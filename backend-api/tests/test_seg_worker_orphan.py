"""A segmentation worker must not outlive the backend that spawned it.

`_SegProc` puts each worker in its OWN process group (so a Cancel can killpg
it without signalling the backend). The consequence is that killing the
backend's process group never reaches the worker, so the worker has to notice
on its own that its parent died. `seg_worker._watch_parent` does that, but it
must be armed on the path the backend actually uses: `backend_wrapper.py`
re-entered with PHYTOGRAPH_SEG_WORKER set, which calls `seg_worker.run()`.

The worker is made to block by staging `request.json` as a FIFO: `run()`
opens it for reading and waits forever for a writer. The parent is a small
script that spawns the worker the way `_SegProc` does (posix_spawn,
setpgroup=0) and then sleeps; the test SIGKILLs that parent.
"""

import os
import signal
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

WRAPPER = Path(__file__).resolve().parent.parent / "backend_wrapper.py"

pytestmark = pytest.mark.skipif(
    not hasattr(os, "posix_spawn"), reason="POSIX spawn path only")

PARENT = textwrap.dedent("""
    import os, sys, time
    wrapper, workdir = sys.argv[1], sys.argv[2]
    env = dict(os.environ, PHYTOGRAPH_SEG_WORKER=workdir)
    pid = os.posix_spawn(sys.executable, [sys.executable, wrapper], env,
                         setpgroup=0)
    print(pid, flush=True)
    time.sleep(600)
""")


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def test_worker_exits_when_backend_is_sigkilled(tmp_path):
    os.mkfifo(tmp_path / "request.json")
    parent = subprocess.Popen(
        [sys.executable, "-c", PARENT, str(WRAPPER), str(tmp_path)],
        stdout=subprocess.PIPE, text=True)
    worker = int(parent.stdout.readline())
    try:
        time.sleep(1.0)
        assert _alive(worker), "worker should be blocked on the FIFO"

        parent.send_signal(signal.SIGKILL)
        parent.wait()

        deadline = time.monotonic() + 10.0
        while time.monotonic() < deadline and _alive(worker):
            time.sleep(0.25)
        assert not _alive(worker), (
            "seg worker survived its parent's SIGKILL: it was orphaned")
    finally:
        try:
            os.kill(worker, signal.SIGKILL)
        except ProcessLookupError:
            pass
        if parent.poll() is None:
            parent.kill()

