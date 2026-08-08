"""Command-line handling of the backend entrypoint (``backend_wrapper.py``).

The port normally arrives via ``PHYTOGRAPH_BACKEND_PORT`` — the Electron
supervisor spawns the bundled binary with an EMPTY argv and sets that env var.
``--port`` exists for running the packaged binary by hand; before it, an
unrecognized ``--port 9000`` was silently discarded and you got a server on 8008
with no indication why.

These run the wrapper as a SUBPROCESS rather than importing it: importing would
execute the module-level matplotlib/uvicorn/main imports (~20 s, and it starts a
server), and the argument handling is a property of the entrypoint anyway.

Everything asserted here short-circuits BEFORE those heavy imports, so each case
costs a fraction of a second.
"""

import os
import subprocess
import sys
from pathlib import Path

import pytest

WRAPPER = Path(__file__).resolve().parent.parent / "backend_wrapper.py"


def run_wrapper(args, env_extra=None, timeout=120):
    """Run backend_wrapper.py with `args`, returning the CompletedProcess."""
    env = dict(os.environ)
    # Don't inherit a port from the ambient environment — several cases below
    # assert on the fallback behaviour when it is absent.
    env.pop("PHYTOGRAPH_BACKEND_PORT", None)
    if env_extra:
        env.update(env_extra)
    return subprocess.run(
        [sys.executable, str(WRAPPER), *args],
        capture_output=True,
        text=True,
        timeout=timeout,
        env=env,
    )


def test_help_exits_zero_and_lists_the_flags():
    proc = run_wrapper(["--help"])
    assert proc.returncode == 0
    assert "--port" in proc.stdout
    assert "--host" in proc.stdout


def test_unknown_argument_is_rejected_not_ignored():
    """The headline fix: a typo'd flag must fail loudly.

    Previously argv was never read, so this started a server on the default port
    and the user was left wondering why their flag did nothing.
    """
    proc = run_wrapper(["--bogus", "9000"])
    assert proc.returncode == 2
    assert "unrecognized arguments" in proc.stderr


def test_misspelled_port_flag_is_rejected():
    proc = run_wrapper(["--prot", "9000"])
    assert proc.returncode == 2
    assert "unrecognized arguments" in proc.stderr


def test_non_integer_port_is_rejected_by_argparse():
    proc = run_wrapper(["--port", "abc"])
    assert proc.returncode == 2
    assert "invalid int value" in proc.stderr


@pytest.mark.parametrize("bad_port", ["99999", "-5", "65536"])
def test_out_of_range_port_is_rejected(bad_port):
    proc = run_wrapper(["--port", bad_port])
    assert proc.returncode != 0
    assert "must be 0-65535" in (proc.stderr + proc.stdout)


def test_non_integer_env_var_reports_the_variable_by_name():
    """A bare ValueError from int() would not say WHICH setting was wrong."""
    proc = run_wrapper([], env_extra={"PHYTOGRAPH_BACKEND_PORT": "notanumber"})
    assert proc.returncode != 0
    combined = proc.stderr + proc.stdout
    assert "PHYTOGRAPH_BACKEND_PORT" in combined
    assert "notanumber" in combined


def test_seg_worker_reentry_bypasses_argument_parsing(tmp_path):
    """The killable-segmentation child must never reach argparse.

    backend_wrapper.py re-enters itself as a segmentation worker when
    PHYTOGRAPH_SEG_WORKER is set. That path is spawned with its own argv, and if
    the parser ran first an unexpected argument would exit 2 and silently break
    Cancel. Passing a deliberately argparse-hostile flag proves the seg-worker
    early-exit still wins.
    """
    proc = run_wrapper(
        ["--this-would-fail-argparse"],
        env_extra={"PHYTOGRAPH_SEG_WORKER": str(tmp_path)},
    )
    assert "unrecognized arguments" not in proc.stderr
    assert proc.returncode != 2
