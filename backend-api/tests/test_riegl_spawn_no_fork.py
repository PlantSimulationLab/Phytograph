"""The RIEGL reader must be spawned without forking the loaded image.

THE BUG THIS PINS. On macOS the backend has BOTH libhelios (GLFW, via the
lidar->visualizer plugin) and open3d's own bundled GLFW loaded, and the two
register duplicate Objective-C classes (GLFWHelper, GLFWApplicationDelegate,
...). `subprocess.Popen` takes the fork()+exec() path whenever `close_fds` is
true -- which is the default -- and forking THAT image kills the child in the
post-fork/pre-exec window with SIGSEGV, i.e. `exit -11`, before it runs a single
line of the reader.

`_SegProc`/`os.posix_spawn` never forks the loaded image, which is why
`_run_potree_converter` and `_spawn_seg_worker` already use it. The two RIEGL
reader spawns were written with `Popen` and were the last fork()ing children in
the backend.

WHY IT HID: the crash needs the GLFW runtime to be INITIALISED, not merely
imported, so a reader spawn only dies once something has already built a cloud
session in the same process. In the test suite that is exactly the ordering
`extract` (builds a session) then `inspect` (spawns the reader again) --
deterministic, and reported only as an opaque `RIEGL reader failed (exit -11)`.
"""

import os
import subprocess

import main


def test_native_reader_spawn_does_not_fork(monkeypatch, tmp_path):
    """Spawn the reader through the REAL code path and prove it never forks.

    Behavioural, not a source grep: an earlier version of this test asserted
    that `_SegProc` appeared in the function source, and it passed happily when
    the branch selecting it was disabled. What has to hold is that the child is
    actually created without forking, so this records how it was created.

    `subprocess._fork_exec` is spied on: `Popen` routes through it only on the
    fork()+exec() path — the one that crashes — while `_SegProc`/posix_spawn
    never touches it.
    """
    if not hasattr(os, "posix_spawn"):
        import pytest
        pytest.skip("POSIX-only")

    forked = []

    # subprocess's fork()+exec() path goes through `subprocess._fork_exec`
    # (a thin alias for _posixsubprocess.fork_exec), NOT os.fork — patching
    # os.fork catches nothing here.
    real_fork_exec = subprocess._fork_exec

    def spy(*a, **k):  # pragma: no cover - only runs if the fix regresses
        forked.append(True)
        return real_fork_exec(*a, **k)

    monkeypatch.setattr(subprocess, "_fork_exec", spy)
    # Force the native runtime; the docker path legitimately uses Popen.
    monkeypatch.setenv("PHYTOGRAPH_RIEGL_RUNTIME", "native")

    out = tmp_path / "out"
    out.mkdir()
    # /bin/echo stands in for the reader: this asserts HOW the child is made,
    # not what it prints, and a real reader run needs the fake RiVLib fixtures.
    monkeypatch.setattr(main, "_rxp_reader_command", lambda: ["/bin/echo"])
    try:
        main._run_riegl_container(["inspect", "/project"],
                                  [(str(tmp_path), "/project", "ro")],
                                  timeout_s=60.0)
    except Exception:
        # The stand-in emits no JSON, so the caller raises. Irrelevant here —
        # the child was already spawned, which is what is under test.
        pass

    assert not forked, (
        "the RIEGL reader was spawned with fork()+exec(). With libhelios' GLFW "
        "and open3d's own copy both loaded, that kills the child in the "
        "post-fork/pre-exec window (SIGSEGV, exit -11) before the reader runs. "
        "Spawn it via _SegProc/posix_spawn, as _run_potree_converter does."
    )


def test_segproc_can_separate_stdout_from_stderr(tmp_path):
    """`_run_riegl_container` reads a JSON document off the child's stdout while
    its progress goes to a log, so the no-fork spawn has to keep the two
    streams apart. (`_SegProc`'s original caller merged both into one log.)
    """
    if not hasattr(os, "posix_spawn"):
        import pytest
        pytest.skip("POSIX-only")

    out = tmp_path / "out.txt"
    err = tmp_path / "err.txt"
    proc = main._SegProc(
        ["/bin/sh", "-c", "echo TO_STDOUT; echo TO_STDERR 1>&2"],
        dict(os.environ),
        str(err),
        stdout_log=str(out),
    )
    assert proc.wait() == 0
    assert out.read_text().strip() == "TO_STDOUT"
    assert err.read_text().strip() == "TO_STDERR"




def test_reader_test_helpers_do_not_fork_either():
    """The direct-spawn helpers in test_riegl_fake_rivlib must not fork.

    Several tests there run the reader themselves rather than through the
    backend. Those spawns hit the identical crash as soon as a session-building
    test has run earlier in the same pytest process — which is exactly how that
    file went from green on its own to ten failures beside test_session_spill.
    `close_fds=False` is what selects posix_spawn over fork()+exec().
    """
    from pathlib import Path

    src = (Path(__file__).parent / "test_riegl_fake_rivlib.py").read_text()
    spawns = [
        ln for ln in src.splitlines()
        if "subprocess.run(" in ln or "subprocess.Popen(" in ln
    ]
    assert spawns, "expected the helpers to spawn the reader directly"
    assert "_NO_FORK" in src, (
        "test_riegl_fake_rivlib spawns the reader with a forking subprocess "
        "call. Pass close_fds=False (the _NO_FORK helper) so CPython uses "
        "posix_spawn; otherwise these tests die with exit -11 whenever a "
        "session-building test runs before them in the same process."
    )
