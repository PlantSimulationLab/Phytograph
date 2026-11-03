"""``python -m phytograph`` — manage the backend a script will use.

    python -m phytograph download              # fetch + verify now (e.g. before going offline)
    python -m phytograph download --archive F  # install from an archive copied over by hand
    python -m phytograph where                 # which backend `Backend()` would launch
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import _download
from ._version import EXPECTED_BACKEND_VERSION
from .errors import PhytographError


def _progress(frac, msg):
    pct = f"{frac * 100:5.1f}% " if frac is not None else ""
    print(f"\r  {pct}{msg}".ljust(78), end="", file=sys.stderr, flush=True)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m phytograph", description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("download", help="download and verify the backend for this version")
    d.add_argument("--archive", type=Path,
                   help="install from this already-downloaded archive instead (still verified)")
    sub.add_parser("where", help="show which backend Backend() would use")
    args = ap.parse_args(argv)
    try:
        if args.cmd == "download":
            os_name, arch = _download.platform_key()
            name = _download.asset_name(EXPECTED_BACKEND_VERSION, os_name, arch)
            print(f"phytograph {EXPECTED_BACKEND_VERSION}: backend {name}", file=sys.stderr)
            exe = _download.install(archive=args.archive, progress=_progress)
            print(file=sys.stderr)
            print(exe)
        else:
            from .backend import _resolve_command
            cached = _download.cached_executable()
            print(f"phytograph {EXPECTED_BACKEND_VERSION}")
            print(f"download cache: {_download.cache_root()}"
                  + (f" (installed: {cached})" if cached else " (nothing downloaded yet)"))
            # `auto`'s order, without ever starting a download: the explicit
            # executable and dev checkout ("dev"), an app of this version
            # ("app"), then the download cache.
            desc = None
            for src in ("dev", "app"):
                try:
                    desc = _resolve_command(src, None)[3]
                    break
                except PhytographError:
                    continue
            if desc is None and cached is not None:
                desc = f"downloaded backend {cached}"
            print(f"Backend() would use: {desc}" if desc else
                  "Backend() would download the backend on first use "
                  "(or run: python -m phytograph download)")
    except PhytographError as e:
        print(f"\nerror: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
