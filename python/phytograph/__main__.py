"""``python -m phytograph`` — manage the backend a script will use.

    python -m phytograph download              # fetch + verify now (e.g. before going offline)
    python -m phytograph download --archive F  # install from an archive copied over by hand
    python -m phytograph download --dest DIR   # install under DIR (use with PHYTOGRAPH_BACKEND_CACHE=DIR)
    python -m phytograph where                 # which backend `Backend()` would launch
    python -m phytograph identity [--json]     # that backend's exact build, without starting it
    python -m phytograph run RECIPE --in F --out D --work W [--param k=v ...]
                                               # one recipe, in-process: no server, no network
    python -m phytograph agent-files [DIR]     # AGENTS.md + CLAUDE.md for coding agents
    python -m phytograph skills install        # copy the agent skill into .claude/skills
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from . import _agent_files, _download
from ._version import EXPECTED_BACKEND_VERSION
from .errors import PhytographError


def _progress(frac, msg):
    pct = f"{frac * 100:5.1f}% " if frac is not None else ""
    print(f"\r  {pct}{msg}".ljust(78), end="", file=sys.stderr, flush=True)


EXIT_ENGINE_MISSING = 4


def _cmd_run(argv) -> int:
    """Exec the installed engine in one-shot mode (backend-api/oneshot.py).

    Never downloads. On POSIX the engine REPLACES this process, so the process
    the caller started is the engine itself: its exit status is the run's, and
    killing it kills the run. ``--engine PATH`` / ``--source`` choose the engine
    as ``Backend()`` would; every other argument is the engine's (``run --help``)."""
    from .backend import _resolve_command
    from .errors import BackendNotFound

    engine, source, rest = None, "auto", []
    it = iter(argv)
    for a in it:
        if a in ("--engine", "--source"):
            val = next(it, None)
            if val is None:
                print(f"phytograph run: error: {a} needs a value", file=sys.stderr)
                return 2
            if a == "--engine":
                engine = val
            else:
                source = val
        elif a.startswith("--engine="):
            engine = a.split("=", 1)[1]
        elif a.startswith("--source="):
            source = a.split("=", 1)[1]
        else:
            rest.append(a)
    try:
        cmd, _cwd, resources, _desc = _resolve_command(source, engine, None, offline=True)
    except (BackendNotFound, ValueError) as e:
        print(f"phytograph run: engine not available: {e}", file=sys.stderr)
        return EXIT_ENGINE_MISSING
    if resources.is_dir():
        os.environ.setdefault("PHYTOGRAPH_RESOURCES", str(resources))
    full = [*cmd, "--run-recipe", *rest]
    sys.stdout.flush()
    sys.stderr.flush()
    if sys.platform == "win32":
        import subprocess
        return subprocess.call(full)
    os.execv(full[0], full)
    return 1  # pragma: no cover - execv does not return


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == ["run"]:
        return _cmd_run(argv[1:])
    ap = argparse.ArgumentParser(prog="python -m phytograph", description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("download", help="download and verify the backend for this version")
    d.add_argument("--archive", type=Path,
                   help="install from this already-downloaded archive instead (still verified)")
    d.add_argument("--dest", type=Path,
                   help="install under this folder instead of the per-user cache; a later "
                        "process finds it through PHYTOGRAPH_BACKEND_CACHE=DEST")
    sub.add_parser("where", help="show which backend Backend() would use")
    sub.add_parser("run", help="run one recipe in the installed engine, in-process "
                               "(no server, no network); `run --help` for its options")
    idp = sub.add_parser(
        "identity", help="print the exact build of the backend Backend() would use",
        description="Read the engine's identity stamp without starting it or using the network: "
                    "versions, libhelios and sources digests, PyHelios/helios-core commits, "
                    "package versions, the verified archive digest, and `key`, which changes "
                    "whenever the native code does.")
    idp.add_argument("--json", action="store_true", help="one JSON document on stdout")
    idp.add_argument("--source", default="auto", choices=("auto", "app", "dev", "download"))
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
        if args.cmd == "identity":
            from ._identity import engine_identity
            ident = engine_identity(source=args.source)
            if args.json:
                print(json.dumps(ident, indent=2, sort_keys=True))
            else:
                for k in sorted(ident):
                    print(f"{k}: {json.dumps(ident[k]) if isinstance(ident[k], (dict, list)) else ident[k]}")
            return 0
        if args.cmd == "download":
            if args.dest is not None:
                os.environ["PHYTOGRAPH_BACKEND_CACHE"] = str(args.dest.expanduser().resolve())
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
