"""Which engine build this is, without starting it.

A harness that records results per engine build, and caches on it, needs an
identity that changes whenever the native code does, even when the version
number does not. The packaged engine carries one: ``phytograph_backend_identity.json``,
written by ``scripts/build-backend.mjs`` (schema in ``scripts/backend-identity.mjs``).
For a downloaded engine the verified archive digest is added from the install's
``.complete`` marker. A dev checkout has no stamp, so its identity is computed
live from git and the compiled libhelios.

``key`` is a sha256 over the fields that define the build (not where it is
installed, and not the archive digest, so the same bundle has the same key
whether it came from the app or a download). Use it as the cache key.

The same functions run in the client and inside the engine (one-shot mode),
so a ``RecipeRecord`` and ``python -m phytograph identity`` agree.
"""
from __future__ import annotations

import hashlib
import json
import platform
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, Optional

from ._version import __version__

IDENTITY_FILE = "phytograph_backend_identity.json"
VERSION_STAMP = "phytograph_backend_version.txt"
SOURCES_STAMP = "phytograph_backend_sources.sha256"
LIBHELIOS_STAMP = "phytograph_backend_libhelios.sha256"

# Packages whose native code decides the numbers; the same list as
# scripts/backend-identity.mjs (tests/test_identity.py keeps them equal).
PACKAGES = ("numpy", "scipy", "open3d", "scikit-learn", "scikit-image", "torch",
            "numba", "llvmlite", "cut-pursuit-py", "fastapi", "starlette", "httpx")

_PACKAGES_PROBE = """
import json, platform, sys, importlib.metadata as m
out = {}
for n in sys.argv[1:]:
    try:
        out[n] = m.version(n)
    except m.PackageNotFoundError:
        out[n] = None
print(json.dumps({"python": platform.python_version(), "packages": out}))
"""

# Fields that define the build; everything else is provenance.
KEY_FIELDS = ("source", "engine_version", "sources_sha256", "libhelios_sha256",
              "pyhelios", "helios_core", "python", "packages", "os", "arch", "dev_tree")


def _read(path: Path) -> Optional[str]:
    try:
        return path.read_text().strip() or None
    except OSError:
        return None


def _key(ident: Dict[str, Any]) -> str:
    material = {k: ident.get(k) for k in KEY_FIELDS}
    blob = json.dumps(material, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(blob).hexdigest()


def _finish(ident: Dict[str, Any]) -> Dict[str, Any]:
    ident["phytograph_version"] = __version__
    ident["key"] = _key(ident)
    return ident


def bundle_identity(exe_dir: Path) -> Dict[str, Any]:
    """Identity of a packaged engine whose executable lives in ``exe_dir``."""
    exe_dir = Path(exe_dir)
    stamp = exe_dir / IDENTITY_FILE
    if stamp.is_file():
        ident = json.loads(stamp.read_text())
    else:
        # A bundle built before the identity stamp: the three plain stamps.
        ident = {"schema": 0,
                 "engine_version": _read(exe_dir / VERSION_STAMP),
                 "sources_sha256": _read(exe_dir / SOURCES_STAMP),
                 "libhelios_sha256": _read(exe_dir / LIBHELIOS_STAMP)}
    ident["source"] = "bundle"
    ident["location"] = str(exe_dir)
    # <install>/resources/phytograph_backend/<exe>: a download keeps its
    # verified archive digest in <install>/.complete.
    ident["archive_sha256"] = _read(exe_dir.parents[1] / ".complete") if len(exe_dir.parents) > 1 else None
    return _finish(ident)


def _git(root: Path, *args: str) -> Optional[str]:
    try:
        out = subprocess.run(["git", "-C", str(root), *args], capture_output=True,
                             text=True, timeout=30, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip() if out.returncode == 0 else None


def _libhelios(root: Path) -> Optional[str]:
    name = {"win32": "libhelios.dll", "darwin": "libhelios.dylib"}.get(sys.platform, "libhelios.so")
    lib = root / "pyhelios" / "pyhelios_build" / "build" / "lib" / name
    if not lib.is_file():
        return None
    h = hashlib.sha256()
    with open(lib, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _python_packages(python: Optional[str]) -> Dict[str, Any]:
    if not python:
        return {"python": None, "packages": None}
    try:
        out = subprocess.run([python, "-c", _PACKAGES_PROBE, *PACKAGES], capture_output=True,
                             text=True, timeout=60, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return {"python": None, "packages": None}
    if out.returncode != 0:
        return {"python": None, "packages": None}
    return json.loads(out.stdout.strip().splitlines()[-1])


def dev_identity(root: Path, python: Optional[str] = None) -> Dict[str, Any]:
    """Identity of a dev checkout's engine (``backend-api`` run from source),
    whose interpreter is ``python`` (default: the one running this code).

    ``dev_tree`` hashes HEAD plus the uncommitted diff of everything the
    engine runs, so an edit changes the key even before it is committed."""
    import re

    root = Path(root)
    main_py = root / "backend-api" / "main.py"
    m = re.search(r'^BACKEND_VERSION\s*=\s*["\']([^"\']+)["\']', _read(main_py) or "", re.M)
    diff = _git(root, "diff", "HEAD", "--", "backend-api", "python/phytograph") or ""
    untracked = _git(root, "ls-files", "--others", "--exclude-standard", "--",
                     "backend-api", "python/phytograph") or ""
    tree = hashlib.sha256("\n".join([_git(root, "rev-parse", "HEAD") or "", diff, untracked])
                          .encode()).hexdigest()
    ident = {
        "schema": 1,
        "source": "dev",
        "location": str(root),
        "engine_version": m.group(1) if m else None,
        "sources_sha256": None,
        "libhelios_sha256": _libhelios(root),
        "phytograph_commit": _git(root, "describe", "--tags", "--always", "--dirty"),
        "pyhelios": {"describe": _git(root / "pyhelios", "describe", "--tags", "--always", "--dirty"),
                     "commit": _git(root / "pyhelios", "rev-parse", "HEAD")},
        "helios_core": {"describe": _git(root / "pyhelios" / "helios-core", "describe", "--tags",
                                         "--always", "--dirty"),
                        "commit": _git(root / "pyhelios" / "helios-core", "rev-parse", "HEAD")},
        **_python_packages(python or sys.executable),
        "os": sys.platform,
        "arch": platform.machine(),
        "dev_tree": tree,
        "dirty": bool(diff or untracked),
        "archive_sha256": None,
    }
    return _finish(ident)


def identity_for_command(argv, cwd: Path) -> Dict[str, Any]:
    """Identity of the engine ``backend._resolve_command`` chose."""
    if len(argv) >= 2 and str(argv[1]).endswith("backend_wrapper.py"):
        return dev_identity(Path(argv[1]).resolve().parents[1], python=str(argv[0]))
    return bundle_identity(Path(argv[0]).resolve().parent)


def engine_identity(source: str = "auto", executable=None) -> Dict[str, Any]:
    """Identity of the engine ``Backend(source=..., executable=...)`` would run.

    Never starts the engine and never downloads: an engine that is not
    installed raises :class:`~phytograph.errors.BackendNotFound`."""
    from .backend import _resolve_command

    argv, cwd, _resources, _desc = _resolve_command(source, executable, None, offline=True)
    return identity_for_command(argv, cwd)


def running_identity() -> Dict[str, Any]:
    """Identity of the engine this code is running inside (one-shot mode)."""
    if getattr(sys, "frozen", False):
        return bundle_identity(Path(sys.executable).resolve().parent)
    wrapper = Path(sys.modules["__main__"].__file__).resolve() if hasattr(
        sys.modules.get("__main__"), "__file__") else None
    if wrapper is not None and wrapper.name == "backend_wrapper.py":
        return dev_identity(wrapper.parents[1])
    raise RuntimeError("running_identity() is only meaningful inside the engine")
