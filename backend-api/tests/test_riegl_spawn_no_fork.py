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

WHY IT HID: the crash needs the GLFW runtime to be INITIALIZED, not merely
imported, so a reader spawn only dies once something has already built a cloud
session in the same process. In the test suite that is exactly the ordering
`extract` (builds a session) then `inspect` (spawns the reader again) --
deterministic, and reported only as an opaque `RIEGL reader failed (exit -11)`.

THE DOCKER RUNTIME TOO. The docker paths were first left on Popen on the
reasoning that "the docker CLI is a thin client that loads none of this". That
is wrong: the crash happens in the forked copy of the BACKEND, before exec, so
what the child would have become is irrelevant. Captured on macOS from a dev
backend that had already imported data: every fork died in
`_pthread_atfork_child_handlers` -> PROJ's `SQLiteHandleCache` clear ->
`sqlite3Close` -> `os_log` -> SIGSEGV. The user saw it as the reader-image
rebuild failing with "docker build failed (exit -11)" and an EMPTY log, since
docker never ran — and because a stale image is rebuilt automatically before
every import, RIEGL import died with it after any reader change.
"""

import os
import subprocess

import pytest

import main


@pytest.fixture
def forked(monkeypatch):
    """Records every fork()+exec() made through `subprocess`.

    Behavioral, not a source grep: an earlier version of this test asserted
    that `_SegProc` appeared in the function source, and it passed happily when
    the branch selecting it was disabled. What has to hold is that the child is
    actually created without forking, so this records how it was created.

    `subprocess._fork_exec` is spied on: `Popen` routes through it only on the
    fork()+exec() path — the one that crashes — while `_SegProc`/posix_spawn
    never touches it. (Patching os.fork catches nothing here.)
    """
    if not hasattr(os, "posix_spawn"):
        pytest.skip("POSIX-only")
    calls = []
    real_fork_exec = subprocess._fork_exec

    def spy(*a, **k):  # pragma: no cover - only runs if the fix regresses
        calls.append(True)
        return real_fork_exec(*a, **k)

    monkeypatch.setattr(subprocess, "_fork_exec", spy)
    return calls


_FORK_MSG = (
    "spawned with fork()+exec(). Forking this backend's loaded image kills the "
    "child in the post-fork/pre-exec window (SIGSEGV, exit -11) -- via PROJ's "
    "atfork handler once proj.db is open, or the duplicate GLFW classes -- "
    "whatever the child was going to exec, docker included. Spawn it via "
    "_SegProc/posix_spawn, as _run_potree_converter does."
)


def _stand_in(monkeypatch, runtime):
    """/bin/echo stands in for the reader AND for docker: these tests assert
    HOW the child is made, not what it prints."""
    monkeypatch.setenv("PHYTOGRAPH_RIEGL_RUNTIME", runtime)
    monkeypatch.setattr(main, "_rxp_reader_command", lambda: ["/bin/echo"])
    monkeypatch.setattr(main, "_docker_exe", lambda: "/bin/echo")


@pytest.mark.parametrize("runtime", ["native", "docker"])
def test_reader_run_does_not_fork(monkeypatch, tmp_path, forked, runtime):
    """`_run_riegl_container` (inspect) spawns without forking, on BOTH runtimes."""
    _stand_in(monkeypatch, runtime)
    try:
        main._run_riegl_container(["inspect", "/project"],
                                  [(str(tmp_path), "/project", "ro")],
                                  timeout_s=60.0)
    except Exception:
        # The stand-in emits no JSON, so the caller raises. Irrelevant here —
        # the child was already spawned, which is what is under test.
        pass
    assert not forked, f"the RIEGL reader ({runtime}) was " + _FORK_MSG


@pytest.mark.parametrize("runtime", ["native", "docker"])
def test_reader_stream_does_not_fork(monkeypatch, tmp_path, forked, runtime):
    """`_stream_riegl_container` (extract) spawns without forking, on BOTH
    runtimes — it is the import path, so it is the one users hit."""
    _stand_in(monkeypatch, runtime)
    out = tmp_path / "out"
    out.mkdir()
    try:
        main._stream_riegl_container(["stream", "/project", "--out", "/out"],
                                     [(str(tmp_path), "/project", "ro"),
                                      (str(out), "/out", "rw")],
                                     out, timeout_s=60.0)
    except Exception:
        # No stream header from the stand-in; the spawn already happened.
        pass
    assert not forked, f"the streaming RIEGL reader ({runtime}) was " + _FORK_MSG


def test_reader_image_build_does_not_fork(monkeypatch, tmp_path, forked):
    """`_run_docker_build` — the Settings rebuild AND the automatic stale-image
    heal before every import — spawns `docker build` without forking. This is
    the call that failed as "docker build failed (exit -11)"."""
    monkeypatch.setattr(main, "_docker_exe", lambda: "/bin/echo")
    main._run_docker_build(tmp_path)  # echo exits 0, so this returns normally
    assert not forked, "`docker build` was " + _FORK_MSG


def test_reader_image_build_still_reports_output_on_failure(monkeypatch, tmp_path):
    """The no-fork spawn must keep the build's output reaching the error: the
    log tail is the only diagnosis a user gets for a genuinely failing build."""
    if not hasattr(os, "posix_spawn"):
        pytest.skip("POSIX-only")
    script = tmp_path / "fake-docker"
    script.write_text("#!/bin/sh\necho BUILD_STDOUT\necho BUILD_STDERR 1>&2\nexit 3\n")
    script.chmod(0o755)
    monkeypatch.setattr(main, "_docker_exe", lambda: str(script))
    with pytest.raises(main.HTTPException) as exc:
        main._run_docker_build(tmp_path)
    detail = exc.value.detail
    assert "exit 3" in detail
    assert "BUILD_STDOUT" in detail and "BUILD_STDERR" in detail


def test_segproc_can_separate_stdout_from_stderr(tmp_path):
    """`_run_riegl_container` reads a JSON document off the child's stdout while
    its progress goes to a log, so the no-fork spawn has to keep the two
    streams apart. (`_SegProc`'s original caller merged both into one log.)
    """
    if not hasattr(os, "posix_spawn"):
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
