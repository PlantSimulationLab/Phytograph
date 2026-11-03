"""Pack the headless backend archive for this machine's platform.

    python python/pack_backend.py --out backend-dist

Writes ``backend-dist/<asset>`` and ``backend-dist/<asset>.sha256``, where
``<asset>`` is ``phytograph._download.asset_name(...)`` — the same name the
client downloads by. Run by the release workflow on each platform AFTER the
sidecars are signed, so the archive holds the signed binaries, and uploaded to
the release beside the installers. See ``phytograph/_download.py`` for the
layout and why it mirrors the app's.

Refuses a bundle whose version stamp is not this package's version: an archive
named for 0.98.0 holding a 0.97.0 backend would download fine and then fail
every script at the version check.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import sys
import tarfile
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
sys.path.insert(0, str(HERE))
import _stdlib_import  # noqa: E402  (no httpx/numpy on the release runner's Python)

_download = _stdlib_import.load("_download")
EXPECTED_BACKEND_VERSION = _stdlib_import.load("_version").EXPECTED_BACKEND_VERSION

# (source dir relative to the repo, path inside the archive). Mirrors the app's
# extraResources (package.json): resources/{phytograph_backend,potree_converter,
# ml_models} and docker/riegl one level up.
CONTENTS = [
    ("resources/phytograph_backend", "resources/phytograph_backend"),
    ("resources/potree_converter", "resources/potree_converter"),
    ("resources/ml_models", "resources/ml_models"),
    ("docker/riegl", "docker/riegl"),
]
REQUIRED = {"resources/phytograph_backend", "resources/potree_converter"}
# Nothing is filtered: the archive holds exactly what electron-builder ships
# (`phytograph_backend/**/*`). A "skip build/ dirs" filter, meant for
# PyInstaller's workpath (resources/build, which is not packed at all), once
# dropped _internal/pyhelios/assets/build and the backend died at startup.
SKIP_DIRS: set = set()


def _walk(src_root: Path, arc_root: str):
    """(path on disk, name in archive) for every file, dir and symlink."""
    for dirpath, dirnames, filenames in os.walk(src_root, followlinks=False):
        d = Path(dirpath)
        rel = d.relative_to(src_root)
        dirnames[:] = sorted(n for n in dirnames if n not in SKIP_DIRS)
        yield d, f"{arc_root}/{rel.as_posix()}".rstrip("/.") if rel.parts else arc_root
        for n in sorted(filenames) + [n for n in dirnames if (d / n).is_symlink()]:
            p = d / n
            yield p, f"{arc_root}/{(rel / n).as_posix()}"


def pack(out_dir: Path, *, repo: Path = REPO) -> Path:
    os_name, arch = _download.platform_key()
    version = EXPECTED_BACKEND_VERSION
    exe = repo / "resources" / "phytograph_backend" / _download.exe_relpath(os_name).name
    stamp = repo / "resources" / "phytograph_backend" / "phytograph_backend_version.txt"
    if not exe.is_file():
        raise SystemExit(f"pack_backend: no backend at {exe}; run `npm run build:backend` first.")
    built = stamp.read_text().strip() if stamp.is_file() else None
    if built != version:
        raise SystemExit(f"pack_backend: the bundle is {built or 'unstamped'}, this package is "
                         f"{version}. Rebuild the backend (npm run build:backend).")
    for src, _ in CONTENTS:
        if src in REQUIRED and not (repo / src).is_dir():
            raise SystemExit(f"pack_backend: missing {src}")

    name = _download.asset_name(version, os_name, arch)
    out_dir.mkdir(parents=True, exist_ok=True)
    dest = out_dir / name
    manifest = json.dumps({"version": version, "os": os_name, "arch": arch}, indent=1).encode()
    entries = [(p, a) for src, arc in CONTENTS if (repo / src).is_dir()
               for p, a in _walk(repo / src, arc)]

    if os_name == "windows":
        with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            z.writestr(_download.MANIFEST_NAME, manifest)
            for p, a in entries:
                if p.is_symlink():
                    raise SystemExit(f"pack_backend: symlink in a Windows bundle: {p}")
                if p.is_dir():
                    continue
                z.write(p, a)
    else:
        with tarfile.open(dest, "w:gz", compresslevel=6) as t:
            info = tarfile.TarInfo(_download.MANIFEST_NAME)
            info.size, info.mode = len(manifest), 0o644
            t.addfile(info, io.BytesIO(manifest))
            for p, a in entries:
                if p.is_symlink():
                    target = os.readlink(p)
                    resolved = (p.parent / target).resolve()
                    if os.path.isabs(target) or repo.resolve() not in resolved.parents:
                        raise SystemExit(f"pack_backend: symlink {p} points outside the bundle")
                t.add(p, arcname=a, recursive=False)

    digest = hashlib.sha256(dest.read_bytes()).hexdigest()
    (out_dir / f"{name}.sha256").write_text(f"{digest}  {name}\n")
    return dest


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args(argv)
    dest = pack(args.out)
    print(f"{dest} ({dest.stat().st_size / 1e6:.0f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
