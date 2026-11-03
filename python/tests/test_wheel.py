"""The wheel the app ships (python/build_wheel.py → resources/python/):
installable by pip, reproducible, and carrying every module at the right version."""
from __future__ import annotations

import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))
import build_wheel  # noqa: E402

import phytograph as pg  # noqa: E402


def test_wheel_installs_and_imports_at_the_backend_version(tmp_path):
    whl = build_wheel.build(tmp_path / "dist")
    assert whl.name == f"phytograph-{pg.EXPECTED_BACKEND_VERSION}-py3-none-any.whl"

    # Every module in the source tree is in the wheel.
    src = {p.relative_to(ROOT / "python").as_posix()
           for p in (ROOT / "python" / "phytograph").rglob("*.py") if "__pycache__" not in p.parts}
    with zipfile.ZipFile(whl) as z:
        names = set(z.namelist())
    assert src <= names

    # pip accepts it (it validates RECORD hashes on install) …
    site = tmp_path / "site"
    r = subprocess.run([sys.executable, "-m", "pip", "install", "--no-deps", "--no-index",
                        "--target", str(site), str(whl)], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
    # … and the installed copy, not this checkout's, imports at the right version.
    r = subprocess.run([sys.executable, "-I", "-c",
                        "import sys; sys.path.insert(0, sys.argv[1]); import phytograph as pg; "
                        "print(pg.__version__, pg.__file__)", str(site)],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    version, path = r.stdout.split()
    assert version == pg.EXPECTED_BACKEND_VERSION
    assert Path(path).is_relative_to(site)


def test_wheel_is_reproducible(tmp_path):
    a = build_wheel.build(tmp_path / "a").read_bytes()
    b = build_wheel.build(tmp_path / "b").read_bytes()
    assert a == b


def test_metadata_declares_the_runtime_dependencies(tmp_path):
    whl = build_wheel.build(tmp_path)
    with zipfile.ZipFile(whl) as z:
        meta = z.read(f"phytograph-{pg.EXPECTED_BACKEND_VERSION}.dist-info/METADATA").decode()
    assert "Requires-Dist: httpx>=0.24" in meta and "Requires-Dist: numpy>=1.22" in meta
    assert 'Requires-Dist: tqdm; extra == "progress"' in meta
