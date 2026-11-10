"""``python -m phytograph`` — manage the backend a script will use.

    python -m phytograph download              # fetch + verify now (e.g. before going offline)
    python -m phytograph download --archive F  # install from an archive copied over by hand
    python -m phytograph where                 # which backend `Backend()` would launch
    python -m phytograph agent-files [DIR]     # AGENTS.md + CLAUDE.md for coding agents
    python -m phytograph skills install        # copy the agent skill into .claude/skills
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import _agent_files, _download
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
    a = sub.add_parser(
        "agent-files", help="write AGENTS.md and CLAUDE.md for AI coding agents into a project",
        description="Write AGENTS.md (this version's agent guidance) and CLAUDE.md (@AGENTS.md) "
                    "into DIR. A file is rewritten only while its first line is the "
                    "phytograph-managed marker; delete that line to keep your own edits. "
                    f"Set {_agent_files.ENV_OPT_OUT}=0 to disable. Codex, Cursor and Claude Code "
                    "read these files; point Gemini CLI at AGENTS.md with its context.fileName "
                    "setting.")
    a.add_argument("dir", nargs="?", type=Path, default=Path("."), help="project folder (default: .)")
    a.add_argument("--dry-run", action="store_true", help="report what would change, write nothing")
    a.add_argument("--stdout", action="store_true", help="print the AGENTS.md text instead")
    sk = sub.add_parser("skills", help="the agent skills shipped with this version")
    sks = sk.add_subparsers(dest="skills_cmd", required=True)
    sks.add_parser("path", help="print the folder holding the shipped skills")
    si = sks.add_parser(
        "install", help="copy the shipped skills into an agent's skills folder",
        description="Copy each shipped skill folder into DEST. Claude Code: .claude/skills "
                    "(default) or ~/.claude/skills; other harnesses: their skills folder, "
                    "e.g. .agents/skills. Re-run after upgrading phytograph.")
    si.add_argument("--to", type=Path, default=Path(".claude") / "skills", dest="dest",
                    help="skills folder (default: .claude/skills)")
    si.add_argument("--force", action="store_true",
                    help="replace a same-named skill folder phytograph did not install")
    args = ap.parse_args(argv)
    try:
        if args.cmd == "agent-files":
            return _cmd_agent_files(args)
        if args.cmd == "skills":
            if args.skills_cmd == "path":
                print(_agent_files._skills_dir())
                return 0
            for name, what in _agent_files.install_skills(args.dest, force=args.force).items():
                print(f"{what} {args.dest / name}")
            return 0
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
    except (PhytographError, OSError) as e:
        print(f"\nerror: {e}", file=sys.stderr)
        return 1
    return 0


def _cmd_agent_files(args) -> int:
    if args.stdout:
        print(_agent_files.agents_md(), end="")
        return 0
    if _agent_files.disabled_by_env():
        print(f"agent-files: disabled by {_agent_files.ENV_OPT_OUT}; nothing written",
              file=sys.stderr)
        return 0
    status, notes = _agent_files.write_agent_files(args.dir, dry_run=args.dry_run)
    verb = "would be " if args.dry_run else ""
    for name, st in status.items():
        print(f"{args.dir / name}: {verb + st if st == 'written' else st}")
    for n in notes:
        print(f"note: {n}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
