"""The one-shot `run` inside a confined sandbox, approximating Heliades' on macOS.

seatbelt (`sandbox-exec`) profile:
* no network at all: `(deny network*)` also refuses TCP to 127.0.0.1;
* writes only under the work directory, --out, and /private/tmp;
* $HOME hidden: reads under the home folder are refused except the engine
  (this checkout and its interpreter) and the input file's folder, and HOME
  points nowhere.

The engine's own files are therefore read-only. A bundle can be tested instead
of the dev checkout with PHYTOGRAPH_TEST_ENGINE=<path to phytograph_backend>.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from conftest import E2E_FIXTURES, ROOT

pytestmark = pytest.mark.skipif(
    sys.platform != "darwin" or shutil.which("sandbox-exec") is None,
    reason="macOS seatbelt only")

TREE = E2E_FIXTURES / "noisy-tree.xyz"


def _q(p: Path) -> str:
    return json.dumps(str(Path(p).resolve()))


def profile(*, home: Path, readable, writable) -> str:
    rules = ["(version 1)", "(allow default)", "(deny network*)",
             f"(deny file-read* (subpath {_q(home)}))"]
    rules += [f"(allow file-read* (subpath {_q(p)}))" for p in readable]
    # Path resolution (realpath, std::filesystem::canonical in PotreeConverter)
    # stats every ancestor; allow metadata, not contents, for those under home.
    ancestors = {a for p in readable for a in Path(p).resolve().parents
                 if a == home or home in a.parents}
    rules += [f"(allow file-read-metadata (literal {_q(a)}))" for a in sorted(ancestors)]
    rules.append("(deny file-write*)")
    rules += [f"(allow file-write* (subpath {_q(p)}))" for p in writable]
    rules.append('(allow file-write* (subpath "/dev"))')
    return "\n".join(rules)


def sandboxed(prof: str, argv, env) -> subprocess.CompletedProcess:
    return subprocess.run(["sandbox-exec", "-p", prof, *argv], capture_output=True, text=True,
                          timeout=1800, env=env, cwd="/")


@pytest.fixture
def confined(tmp_path):
    work, out = tmp_path / "work", tmp_path / "out"
    work.mkdir()
    out.mkdir()
    python = Path(sys.executable).resolve()
    readable = [ROOT, python.parents[1], Path(sys.prefix), TREE.parent]
    engine = os.environ.get("PHYTOGRAPH_TEST_ENGINE")
    if engine:
        readable.append(Path(engine).resolve().parent)
    prof = profile(home=Path.home(), readable=readable, writable=[work, out, "/private/tmp"])
    env = {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "PYTHONDONTWRITEBYTECODE": "1",
           "PYTHONPATH": str(ROOT / "python"), "PHYTOGRAPH_OFFLINE": "1"}
    if engine:
        env["PHYTOGRAPH_BACKEND_EXE"] = engine
    return prof, env, work, out


def test_the_profile_really_confines(confined):
    """The sandbox refuses what it should, so a pass below means something."""
    prof, env, work, _ = confined
    probe = (
        "import socket, sys, pathlib\n"
        "s = socket.socket()\n"
        "try:\n"
        "    s.connect(('127.0.0.1', 9)); print('net-open')\n"
        "except PermissionError: print('net-denied')\n"
        "except OSError as e: print('net-other', e.errno)\n"
        f"try:\n    pathlib.Path({str(ROOT / 'sandbox-probe.txt')!r}).write_text('x'); print('repo-writable')\n"
        "except PermissionError: print('repo-readonly')\n"
        f"pathlib.Path({str(work / 'ok.txt')!r}).write_text('x'); print('work-writable')\n"
        f"try:\n    list(pathlib.Path({str(Path.home() / 'Library')!r}).iterdir()); print('home-visible')\n"
        "except PermissionError: print('home-hidden')\n")
    proc = sandboxed(prof, [sys.executable, "-c", probe], env)
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.split() == ["net-denied", "repo-readonly", "work-writable", "home-hidden"]


def test_run_tree_qsm_inside_the_sandbox(confined):
    prof, env, work, out = confined
    argv = [sys.executable, "-m", "phytograph", "run", "tree_qsm", "--in", str(TREE),
            "--out", str(out), "--work", str(work), "--threads", "2",
            "--param", "remove_ground=false", "--param", "wood_method=null"]
    proc = sandboxed(prof, argv, env)
    assert proc.returncode == 0, proc.stderr[-4000:]
    rec = json.loads((out / "record.json").read_text())
    assert rec["status"] == "ok"
    assert rec["engine"]["key"] and rec["engine"]["libhelios_sha256"]
    assert (out / "qsm_treeqsm.csv").read_text().startswith("ID,parentID,branchID")
