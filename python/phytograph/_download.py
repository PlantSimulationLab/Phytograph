"""Fetching the headless backend, so ``pip install phytograph`` is enough.

Every release publishes, per platform, an archive of exactly what the desktop
app ships under ``Contents/Resources`` (macOS) / ``resources`` (Windows, Linux),
minus Electron:

    resources/phytograph_backend/   the PyInstaller backend
    resources/potree_converter/     needed by every import
    resources/ml_models/            bundled segmentation models
    docker/riegl/                   the RIEGL reader build context
    phytograph-backend.json         {version, os, arch}

The layout is the app's on purpose: ``PHYTOGRAPH_RESOURCES`` and the backend's
"one level up" lookups (see CLAUDE.md on the RIEGL context) then resolve exactly
as in a packaged app.

This module is the ONE definition of the archive's name and layout. The
release-side packer (``python/pack_backend.py``) imports it, and the client
downloads by it, so they cannot disagree.

Integrity: a wheel built by the release workflow embeds the SHA-256 of every
platform's archive (``_backend_manifest.json``), so a PyPI install pins the
exact bytes it will execute. Without that manifest (a source checkout, or the
wheel shipped inside the app) the digest is fetched from the release's
``<asset>.sha256`` over HTTPS. Either way a mismatch is refused, and nothing
unverified is ever extracted.

Retention: like the installers, archives are kept for the newest two releases
only (``scripts/prune-release-assets.mjs``), so an older pinned client finds
none and says how to proceed.
"""
from __future__ import annotations

import hashlib
import json
import os
import platform
import posixpath
import shutil
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from typing import Callable, Dict, Optional, Tuple

from ._version import EXPECTED_BACKEND_VERSION
from .errors import BackendNotFound

REPO = "PlantSimulationLab/Phytograph"
DEFAULT_URL_BASE = f"https://github.com/{REPO}/releases/download"
# The Linux bundle's floor (scripts/glibc-floor.mjs GLIBC_FLOOR): checked before
# a 400 MB download that could never run here. A test pins the two equal.
LINUX_GLIBC_FLOOR = (2, 38)
MANIFEST_NAME = "phytograph-backend.json"
_EXE = {"windows": "phytograph_backend.exe"}

ProgressFn = Callable[[Optional[float], str], None]


# --------------------------------------------------------------------------
# Naming
# --------------------------------------------------------------------------
def platform_key() -> Tuple[str, str]:
    """(os, arch) of this machine in archive terms."""
    if sys.platform == "darwin":
        os_name = "macos"
    elif sys.platform == "win32":
        os_name = "windows"
    elif sys.platform.startswith("linux"):
        os_name = "linux"
    else:
        raise BackendNotFound(f"No Phytograph backend is built for {sys.platform}.")
    machine = platform.machine().lower()
    arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64", "amd64": "x64"}.get(machine)
    if arch is None:
        raise BackendNotFound(f"No Phytograph backend is built for {machine} processors.")
    if (os_name, arch) not in SUPPORTED:
        raise BackendNotFound(f"No Phytograph backend is built for {os_name} on {arch} "
                              f"(published: {', '.join(f'{o}-{a}' for o, a in SUPPORTED)}).")
    return os_name, arch


# The release matrix (.github/workflows/release.yml `build`).
SUPPORTED = (("macos", "arm64"), ("macos", "x64"), ("windows", "x64"), ("linux", "x64"))


def asset_name(version: str, os_name: str, arch: str) -> str:
    ext = "zip" if os_name == "windows" else "tar.gz"
    return f"phytograph-backend-{version}-{os_name}-{arch}.{ext}"


def exe_relpath(os_name: str) -> PurePosixPath:
    return PurePosixPath("resources", "phytograph_backend", _EXE.get(os_name, "phytograph_backend"))


# --------------------------------------------------------------------------
# Where downloads live
# --------------------------------------------------------------------------
def cache_root() -> Path:
    """Per-user cache: the same OS cache directory the backend's octree cache
    uses (src/shared/octreeCacheRoot.contract.json), never a temp dir (reaped)."""
    override = os.environ.get("PHYTOGRAPH_BACKEND_CACHE")
    if override:
        return Path(override).expanduser()
    home = Path.home()
    if sys.platform == "darwin":
        base = home / "Library" / "Caches" / "Phytograph"
    elif sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA") or home / "AppData" / "Local") / "Phytograph" / "cache"
    else:
        base = Path(os.environ.get("XDG_CACHE_HOME") or home / ".cache") / "Phytograph"
    return base / "backend"


def install_dir(version: str, os_name: str, arch: str) -> Path:
    return cache_root() / f"{version}-{os_name}-{arch}"


def cached_executable(version: str = EXPECTED_BACKEND_VERSION) -> Optional[Path]:
    """The executable of a complete, verified install, or None."""
    try:
        os_name, arch = platform_key()
    except BackendNotFound:
        return None
    d = install_dir(version, os_name, arch)
    exe = d.joinpath(*exe_relpath(os_name).parts)
    return exe if (d / ".complete").is_file() and exe.is_file() else None


# --------------------------------------------------------------------------
# Digests
# --------------------------------------------------------------------------
def embedded_digests() -> Dict[str, str]:
    """{asset name: sha256} built into a release wheel; empty otherwise."""
    p = Path(__file__).with_name("_backend_manifest.json")
    if not p.is_file():
        return {}
    data = json.loads(p.read_text())
    return dict(data.get("sha256", {}))


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _check_glibc(os_name: str) -> None:
    if os_name != "linux":
        return
    lib, ver = platform.libc_ver()
    if lib != "glibc" or not ver:
        raise BackendNotFound(
            "The Phytograph backend for Linux needs glibc "
            f"{'.'.join(map(str, LINUX_GLIBC_FLOOR))}+, and this system's C library could not be "
            "identified (musl-based distributions such as Alpine are not supported).")
    have = tuple(int(x) for x in ver.split(".")[:2])
    if have < LINUX_GLIBC_FLOOR:
        raise BackendNotFound(
            f"This system has glibc {ver}; the Phytograph backend needs "
            f"{'.'.join(map(str, LINUX_GLIBC_FLOOR))} or newer (Ubuntu 23.10+/24.04, Debian 13, "
            "Fedora 39+). Older systems, including Ubuntu 22.04 and RHEL/Rocky 8-9, are not "
            "supported yet.")


# --------------------------------------------------------------------------
# Download + install
# --------------------------------------------------------------------------
def _http_get(url: str, dest: Optional[Path], progress: Optional[ProgressFn],
              what: str) -> Optional[bytes]:
    import httpx
    try:
        with httpx.stream("GET", url, follow_redirects=True,
                          timeout=httpx.Timeout(60.0, connect=20.0)) as r:
            if r.status_code == 404:
                return None
            r.raise_for_status()
            if dest is None:
                return r.read()
            total = int(r.headers.get("content-length") or 0)
            done = 0
            with open(dest, "wb") as f:
                for chunk in r.iter_bytes(1 << 20):
                    f.write(chunk)
                    done += len(chunk)
                    if progress is not None:
                        progress(done / total if total else None,
                                 f"Downloading {what} ({done / 1e6:.0f} of {total / 1e6:.0f} MB)"
                                 if total else f"Downloading {what} ({done / 1e6:.0f} MB)")
            return b""
    except httpx.HTTPError as e:
        raise BackendNotFound(f"Could not download {url}: {e}") from None


def _safe_extract(archive: Path, dest: Path) -> None:
    """Extract, refusing anything that would land outside `dest`: absolute
    paths, `..`, hard links and devices, and any symlink whose target leaves
    `dest`."""
    root = dest.resolve()

    def _ok(name: str) -> Path:
        p = PurePosixPath(name)
        if p.is_absolute() or ".." in p.parts or (p.parts and ":" in p.parts[0]):
            raise BackendNotFound(f"Refusing unsafe path in backend archive: {name!r}")
        target = (root / Path(*p.parts)).resolve()
        if target != root and root not in target.parents:
            raise BackendNotFound(f"Refusing unsafe path in backend archive: {name!r}")
        return target

    if archive.name.endswith(".zip"):
        with zipfile.ZipFile(archive) as z:
            for info in z.infolist():
                target = _ok(info.filename)
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with z.open(info) as src, open(target, "wb") as out:
                    shutil.copyfileobj(src, out)
                mode = (info.external_attr >> 16) & 0o777
                if mode:
                    os.chmod(target, mode)
    else:
        with tarfile.open(archive, "r:gz") as t:
            members = t.getmembers()
            for m in members:
                _ok(m.name)
                if m.issym():
                    # PyInstaller's macOS/Linux bundles carry relative dylib
                    # links (`_internal/libtorch.dylib -> torch/lib/...`). Allow
                    # those, and only those that stay inside the install.
                    if os.path.isabs(m.linkname):
                        raise BackendNotFound(f"Refusing absolute link in backend archive: {m.name!r}")
                    target = posixpath.normpath(str(PurePosixPath(m.name).parent / m.linkname))
                    if target == ".." or target.startswith("../"):
                        raise BackendNotFound(f"Refusing link out of the backend archive: {m.name!r}")
                    _ok(target)
                elif not (m.isfile() or m.isdir()):
                    raise BackendNotFound(f"Refusing link or special file in backend archive: {m.name!r}")
            if hasattr(tarfile, "data_filter"):     # 3.12+: the stdlib's own guard too
                t.extractall(root, members=members, filter="data")
            else:
                t.extractall(root, members=members)


def install(*, version: str = EXPECTED_BACKEND_VERSION, archive: Optional[Path] = None,
            progress: Optional[ProgressFn] = None) -> Path:
    """Make the backend for this client's version available locally and return
    its executable. Downloads it unless a verified copy is cached, or installs
    from ``archive`` (a file you downloaded yourself — still verified)."""
    os_name, arch = platform_key()
    _check_glibc(os_name)
    exe = cached_executable(version)
    if exe is not None and archive is None:
        return exe

    name = asset_name(version, os_name, arch)
    base = os.environ.get("PHYTOGRAPH_BACKEND_URL", DEFAULT_URL_BASE).rstrip("/")
    url = f"{base}/v{version}/{name}"
    src_archive = None
    if archive is not None:
        src_archive = Path(archive).expanduser()
        if not src_archive.is_file():
            raise BackendNotFound(f"No archive at {src_archive}.")
        if src_archive.name != name:
            raise BackendNotFound(f"{src_archive.name} is not this machine's backend archive; expected {name}.")

    expected = embedded_digests().get(name)
    if expected is None and src_archive is not None:
        # Offline install: the release's `<asset>.sha256`, copied alongside.
        side = src_archive.with_name(src_archive.name + ".sha256")
        if side.is_file():
            expected = side.read_text().split()[0].strip().lower()
    if expected is None:
        body = _http_get(url + ".sha256", None, None, "checksum")
        if body is None:
            if src_archive is not None:
                raise BackendNotFound(
                    f"Cannot verify {src_archive.name}: copy {name}.sha256 from the same release "
                    "next to it (or install phytograph from PyPI, whose wheel carries the digests).")
            raise _not_published(version, name)
        expected = body.decode().split()[0].strip().lower()

    final = install_dir(version, os_name, arch)
    final.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".incoming-", dir=final.parent) as tmp:
        tmp = Path(tmp)
        if src_archive is not None:
            src = src_archive
        else:
            src = tmp / name
            if _http_get(url, src, progress, f"Phytograph backend {version}") is None:
                raise _not_published(version, name)
        got = sha256_file(src)
        if got != expected:
            raise BackendNotFound(
                f"The downloaded backend failed its integrity check ({name}: sha256 {got}, "
                f"expected {expected}). Nothing was installed. Try again; if it persists, "
                "report it — the file may have been altered.")
        if progress is not None:
            progress(None, "Unpacking the Phytograph backend")
        staged = tmp / "staged"
        staged.mkdir()
        _safe_extract(src, staged)
        meta = json.loads((staged / MANIFEST_NAME).read_text())
        if (meta.get("version"), meta.get("os"), meta.get("arch")) != (version, os_name, arch):
            raise BackendNotFound(f"{name} contains a backend for {meta}; refusing it.")
        (staged / ".complete").write_text(expected + "\n")
        if final.exists():
            shutil.rmtree(final)      # an incomplete or replaced earlier install
        try:
            staged.rename(final)
        except OSError:
            # Another process finished the same install first; use theirs.
            if cached_executable(version) is None:
                raise
    exe = cached_executable(version)
    if exe is None:
        raise BackendNotFound(f"The backend archive {name} has no {exe_relpath(os_name)}.")
    return exe


def _not_published(version: str, name: str) -> BackendNotFound:
    return BackendNotFound(
        f"The backend for phytograph {version} ({name}) is not available for download. "
        "Backends are kept for the two newest releases only. Upgrade with "
        "`pip install -U phytograph`, or point PHYTOGRAPH_BACKEND_EXE at the backend inside a "
        f"Phytograph {version} app (…/resources/phytograph_backend/).")
