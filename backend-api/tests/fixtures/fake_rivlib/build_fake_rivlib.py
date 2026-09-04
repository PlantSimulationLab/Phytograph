"""Compile the fake RiVLib stand-ins, wherever the tests happen to run.

Two tiny C files with no dependencies beyond libm, so every platform's default
toolchain can build them: MSVC on Windows (already present on GitHub's
windows runners, and located the same way the real shim build locates it),
cc/gcc/clang everywhere else.

The result is laid out as a REAL RiVLib download would be — `<root>/lib/` with
the platform's expected scanifc filename — because the backend validates a
RiVLib folder by looking for exactly that file. A flat pile of .so files would
test the reader but not `_riegl_rivlib_valid`, `_riegl_scanifc_path`, or the
status endpoint that depends on them.

Returns None when there is no compiler, so the tests skip rather than fail on a
machine that cannot build them.
"""

from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent

# The name the backend expects to find inside a RiVLib download, per platform.
# Keep in sync with main.py's _riegl_scanifc_names().
SCANIFC_NAME = "scanifc-mt-s.dll" if sys.platform == "win32" else "libscanifc.so"
SHIM_NAME = "fake_rxpshim.dll" if sys.platform == "win32" else "libfake_rxpshim.so"


class FakeRivlib:
    """Where the built stand-ins live, in the shape the backend expects."""

    def __init__(self, root: Path, shim: Path):
        self.root = root  # pass as rivlib_path / RIVLIB_ROOT
        self.scanifc = root / "lib" / SCANIFC_NAME  # pass as RIVLIB_SO
        self.shim = shim  # pass as PHYTOGRAPH_RXP_SHIM


def _cache_dir() -> Path:
    """One build per source revision, reused across test sessions.

    Keyed by a hash of the sources so an edit rebuilds and a stale artifact can
    never be picked up — the same reason the real shim's cache is keyed by
    content rather than by mtime.
    """
    h = hashlib.sha256()
    for name in ("fake_scanifc.c", "fake_rxpshim.c", "build_fake_rivlib.py"):
        h.update((HERE / name).read_bytes())
    return Path(tempfile.gettempdir()) / f"phytograph-fake-rivlib-{h.hexdigest()[:12]}"


def _posix_compiler() -> "str | None":
    for candidate in (os.environ.get("CC"), "cc", "gcc", "clang"):
        if not candidate:
            continue
        try:
            subprocess.run([candidate, "--version"], capture_output=True, timeout=30)
            return candidate
        except (OSError, subprocess.SubprocessError):
            continue
    return None


def _build_posix(cc: str, src: Path, out: Path) -> None:
    subprocess.run(
        [cc, "-shared", "-fPIC", "-O1", str(src), "-o", str(out), "-lm"],
        check=True, capture_output=True, text=True,
    )


def _build_msvc(vcvars: str, src: Path, out: Path) -> None:
    """Same .bat indirection as the real shim build, for the same reason.

    cl needs the environment vcvars64.bat exports, so the two must run in one
    shell — and Python's Windows argument quoting mangles the inner quotes of a
    `cmd /c "call ... && cl ..."` string when any path contains a space, which
    "C:\\Program Files\\..." always does.
    """
    work = out.parent
    script = work / f"build_{out.stem}.bat"
    script.write_text(
        "@echo off\r\n"
        f'call "{vcvars}" >nul\r\n'
        f'cl /nologo /LD /O1 "{src}" /Fe:"{out}"\r\n',
        encoding="utf-8",
    )
    proc = subprocess.run(
        ["cmd", "/c", str(script)], capture_output=True, text=True, cwd=work
    )
    if proc.returncode != 0 or not out.exists():
        raise RuntimeError(
            "fake RiVLib build failed:\n"
            + (proc.stdout or proc.stderr or "no compiler output")[-1500:]
        )


def build() -> "FakeRivlib | None":
    """Build (or reuse) the stand-ins. None when no compiler is available."""
    cache = _cache_dir()
    lib_dir = cache / "lib"
    scanifc = lib_dir / SCANIFC_NAME
    shim = cache / SHIM_NAME
    if scanifc.exists() and shim.exists():
        return FakeRivlib(cache, shim)

    lib_dir.mkdir(parents=True, exist_ok=True)
    # A real download has these beside lib/; some checks look at the shape.
    (cache / "include").mkdir(exist_ok=True)
    (cache / "bin").mkdir(exist_ok=True)

    if sys.platform == "win32":
        # Reuse the reader's own probe so "can CI build this" and "can the app
        # build the real shim" cannot answer differently.
        sys.path.insert(0, str(HERE.parents[3] / "docker" / "riegl"))
        import rxp_reader

        vcvars = rxp_reader.find_msvc_vcvars()
        if vcvars is None:
            return None
        _build_msvc(vcvars, HERE / "fake_scanifc.c", scanifc)
        _build_msvc(vcvars, HERE / "fake_rxpshim.c", shim)
    else:
        cc = _posix_compiler()
        if cc is None:
            return None
        _build_posix(cc, HERE / "fake_scanifc.c", scanifc)
        _build_posix(cc, HERE / "fake_rxpshim.c", shim)

    return FakeRivlib(cache, shim)


if __name__ == "__main__":
    built = build()
    if built is None:
        print("no compiler available", file=sys.stderr)
        raise SystemExit(1)
    print("root   :", built.root)
    print("scanifc:", built.scanifc)
    print("shim   :", built.shim)
