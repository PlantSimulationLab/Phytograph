"""The release tools run on a CI runner's bare Python. They must need nothing
outside the standard library — in particular not httpx or numpy, which the
package's __init__ imports. That gap failed every platform's "Package headless
backend" step on the first release dry run, while every local test (run in the
venv, where both are installed) passed. `python -S` reproduces the runner: no
site-packages at all."""
from __future__ import annotations

import hashlib
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERSION = re.search(r'^EXPECTED_BACKEND_VERSION = "([^"]+)"',
                    (ROOT / "python" / "phytograph" / "_version.py").read_text(), re.M).group(1)


def _bare(*args, cwd=ROOT):
    return subprocess.run([sys.executable, "-S", *args], cwd=cwd, capture_output=True, text=True)


def test_pack_backend_imports_with_the_standard_library_only():
    r = _bare("python/pack_backend.py", "--help")
    assert r.returncode == 0, r.stderr


def test_build_wheel_pins_digests_with_the_standard_library_only(tmp_path):
    digests = tmp_path / "digests"
    digests.mkdir()
    names = [f"phytograph-backend-{VERSION}-{o}-{a}.{'zip' if o == 'windows' else 'tar.gz'}"
             for o, a in (("macos", "arm64"), ("macos", "x64"), ("windows", "x64"), ("linux", "x64"))]
    for n in names:
        (digests / f"{n}.sha256").write_text(f"{hashlib.sha256(n.encode()).hexdigest()}  {n}\n")
    r = _bare("python/build_wheel.py", "--out", str(tmp_path / "dist"),
              "--backend-digests", str(digests), "--require-all-platforms")
    assert r.returncode == 0, r.stderr
    assert (tmp_path / "dist" / f"phytograph-{VERSION}-py3-none-any.whl").is_file()
