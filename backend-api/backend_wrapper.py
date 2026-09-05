#!/usr/bin/env python3
"""
Wrapper script to ensure backend starts properly
Handles matplotlib font cache building before starting uvicorn
"""

import sys
import os
import logging
import tempfile
from logging.handlers import RotatingFileHandler

# ==================== Killable segmentation worker re-entry ====================
# When spawned with PHYTOGRAPH_SEG_WORKER set, this same binary/interpreter runs
# ONE segmentation compute (in seg_worker) and exits — NOT the uvicorn server.
# This is how the frozen PyInstaller binary (which has no script arg) re-enters
# as a killable subprocess so the parent backend can SIGKILL it on Cancel. Done
# at the very top, before the heavy matplotlib/uvicorn imports, so the worker
# pays only for what it needs.
_SEG_WORKER_DIR = os.environ.get("PHYTOGRAPH_SEG_WORKER")
if _SEG_WORKER_DIR:
    import seg_worker
    sys.exit(seg_worker.run(_SEG_WORKER_DIR))


# ==================== RIEGL reader re-entry ====================
# Same trick, same reason. On a NATIVE runtime (Windows) there is no container
# to be the reader's entrypoint, so the backend runs rxp_reader as a child
# process — and in a packaged build `sys.executable` is this binary, which has
# no script argument to give it. PHYTOGRAPH_RXP_READER is how the child knows
# to be the reader instead of the server.
#
# Also at the very top: the reader needs numpy and ctypes, not uvicorn or
# matplotlib, and an import it does not use is pure startup cost on a path that
# runs once per scan position.
if os.environ.get("PHYTOGRAPH_RXP_READER"):
    import rxp_reader
    sys.exit(rxp_reader.main(sys.argv[1:]))


# When spawned with PHYTOGRAPH_IMPORT_SELFTEST set, import the third-party modules
# that only some code paths reach, report what failed, and exit — do NOT start the
# server. scripts/build-backend.mjs runs this against the freshly built bundle.
#
# Why: PyInstaller bundles what its static analysis can SEE, and a lazy
# function-local import inside a rarely-exercised endpoint is exactly what it
# misses. That shipped twice here — `sklearn.mixture` was absent (the bundle had
# an sklearn/ directory, so a file-existence check looked fine), and once that was
# collected, sklearn's own deps joblib/threadpoolctl were still missing. Both
# failed ONLY in the packaged app; dev and pytest run against the venv, where
# every module is present. A real import in the real binary is the only check
# that distinguishes the two.
if os.environ.get("PHYTOGRAPH_IMPORT_SELFTEST"):
    import importlib
    _REQUIRED = [
        "sklearn.mixture",   # _wood_geometric_labels (wood/leaf segmentation)
        "skimage", "cut_pursuit_py", "numpy_indexed", "maxflow",  # TreeIso
        "CSF",               # ground segmentation
        "pye57", "plyfile", "laspy", "pyproj", "tifffile",  # IO
        "open3d", "scipy", "pytexit",
        # pyhelios is deliberately NOT here: loading it pulls in the native
        # libhelios, whose resolution depends on cwd/env rather than on what
        # PyInstaller bundled, so it reports failures this check can't act on.
        # The backend's own _assert_pyhelios_native() covers it at startup.
    ]
    _failed = []
    for _m in _REQUIRED:
        try:
            importlib.import_module(_m)
        except Exception as _e:
            _failed.append(f"{_m}: {type(_e).__name__}: {_e}")
    for _f in _failed:
        print(f"[selftest] FAIL {_f}")
    print(f"[selftest] {len(_REQUIRED) - len(_failed)}/{len(_REQUIRED)} imports OK")
    sys.exit(1 if _failed else 0)


# ==================== Command line ====================
# Parsed HERE — after the seg-worker re-entry above (which is spawned with an
# empty argv and must never reach this parser), but BEFORE the matplotlib/uvicorn
# imports below, which cost ~20 s in the frozen binary. So `--help` and a bad
# argument answer instantly instead of after a long silent startup.
#
# Why this exists: the port normally arrives via PHYTOGRAPH_BACKEND_PORT (the
# Electron supervisor in src/main/backend.ts spawns the bundled binary with an
# empty argv and sets that env var; scripts/dev.mjs passes --port to uvicorn
# directly, not to this wrapper). Nothing in the product passes --port here. But
# running the packaged binary BY HAND to debug it is a real workflow, and before
# this an unrecognized `--port 9000` was silently discarded — you got a server on
# 8008 with no indication why. argparse also rejects unknown arguments outright,
# which is the actual fix for that trap.
def _parse_args(argv):
    import argparse

    parser = argparse.ArgumentParser(
        prog="phytograph_backend",
        description="Phytograph compute backend (FastAPI + uvicorn).",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=None,
        help="TCP port to bind on 127.0.0.1. Overrides PHYTOGRAPH_BACKEND_PORT; "
             "defaults to that env var, then 8008.",
    )
    parser.add_argument(
        "--host",
        default=None,
        help="Interface to bind. Defaults to 127.0.0.1; the backend is not "
             "authenticated, so only change this on a trusted network.",
    )
    # parse_args (not parse_known_args) so an unrecognized argument exits 2 with
    # a usage message rather than being ignored.
    return parser.parse_args(argv)


_ARGS = _parse_args(sys.argv[1:])


def _resolve_port(args) -> int:
    """CLI flag > PHYTOGRAPH_BACKEND_PORT > 8008.

    The env var stays the default so every existing launch path (supervisor, dev
    script, E2E) is untouched; the flag is a manual-launch convenience layered on
    top. A non-numeric env var would otherwise raise a bare ValueError from int(),
    so it's reported as the configuration error it is.
    """
    if args.port is not None:
        port = args.port
        source = "--port"
    else:
        raw = os.environ.get("PHYTOGRAPH_BACKEND_PORT", "8008")
        source = "PHYTOGRAPH_BACKEND_PORT"
        try:
            port = int(raw)
        except ValueError:
            raise SystemExit(
                f"Invalid {source}={raw!r}: expected an integer port."
            )
    # 0 is legitimate (bind any free port), so the floor is 0, not 1.
    if not (0 <= port <= 65535):
        raise SystemExit(f"Invalid port {port} from {source}: must be 0-65535.")
    return port


def _configure_logging():
    """Send INFO+ to BOTH stderr (so the Electron supervisor's stdout/stderr tee
    in src/main/backend.ts captures it) AND a rotating file on disk.

    The file lives in PHYTOGRAPH_LOG_DIR when the supervisor passes one (it points
    at electron-log's directory so everything ends up together), falling back to
    the OS temp dir for standalone `python backend_wrapper.py` runs. This is the
    durable, full-fidelity backend log that gets concatenated into a bug report's
    attachment even if a streamed line was missed by the tee.

    When the supervisor passes PHYTOGRAPH_LOG_SESSION, the file is named
    phytograph-backend-<session>.log so it pairs with this launch's
    main-<session>.log (one main + one backend file per session). Without it
    (standalone launch), the legacy phytograph-backend.log name is used.
    """
    log_dir = os.environ.get("PHYTOGRAPH_LOG_DIR") or os.path.join(
        tempfile.gettempdir(), "phytograph-logs"
    )
    try:
        os.makedirs(log_dir, exist_ok=True)
    except OSError:
        log_dir = tempfile.gettempdir()

    session = os.environ.get("PHYTOGRAPH_LOG_SESSION")
    log_name = f"phytograph-backend-{session}.log" if session else "phytograph-backend.log"

    fmt = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s", "%Y-%m-%d %H:%M:%S"
    )

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    # Clear any handlers a prior basicConfig/uvicorn import installed so we don't
    # double-log.
    for h in list(root.handlers):
        root.removeHandler(h)

    stream = logging.StreamHandler()  # stderr by default
    stream.setFormatter(fmt)
    root.addHandler(stream)

    try:
        file_handler = RotatingFileHandler(
            os.path.join(log_dir, log_name),
            maxBytes=5 * 1024 * 1024,
            backupCount=2,
            encoding="utf-8",
        )
        file_handler.setFormatter(fmt)
        root.addHandler(file_handler)
    except OSError as exc:
        root.warning("Could not open backend log file in %s: %s", log_dir, exc)

    # Last-resort capture: uncaught exceptions that escape the FastAPI handlers
    # (e.g. during startup, before uvicorn is serving) still reach the log.
    def _excepthook(exc_type, exc_value, exc_tb):
        root.error("Uncaught exception", exc_info=(exc_type, exc_value, exc_tb))

    sys.excepthook = _excepthook
    return log_dir


_LOG_DIR = _configure_logging()
logger = logging.getLogger(__name__)

# CRITICAL: Disable matplotlib font manager to avoid 30+ second startup delay
# Use platform-agnostic temp directory (works on Windows, macOS, Linux)
mpl_config_dir = os.path.join(tempfile.gettempdir(), 'matplotlib')
os.makedirs(mpl_config_dir, exist_ok=True)
os.environ['MPLCONFIGDIR'] = mpl_config_dir
os.environ['MPLBACKEND'] = 'Agg'

# Set matplotlib to use minimal configuration
import matplotlib
matplotlib.use('Agg')  # Use non-interactive backend
matplotlib.rcParams['font.family'] = 'DejaVu Sans'  # Use a single font
matplotlib.rcParams['font.sans-serif'] = ['DejaVu Sans']

# Disable font manager completely
import matplotlib.font_manager as fm
fm._rebuild = lambda: None  # Disable font cache rebuilding

logger.info("Matplotlib initialized with minimal config")

# Now import and run the main app
logger.info("Starting Phytograph backend server...")
from main import app
import uvicorn

if __name__ == "__main__":
    # Port is normally chosen by whoever spawned us (the Electron supervisor in
    # src/main/backend.ts, or scripts/dev.mjs) and passed via
    # PHYTOGRAPH_BACKEND_PORT so multiple app instances / dev sessions never
    # collide on a fixed port. An explicit --port overrides it (manual launches);
    # falls back to 8008 when neither is given.
    port = _resolve_port(_ARGS)
    host = _ARGS.host or "127.0.0.1"
    logger.info(f"Starting server on http://{host}:{port} (logs → {_LOG_DIR})")
    # log_config=None tells uvicorn NOT to install its own stdout-only logging
    # config, so its access/error loggers inherit the root handlers configured
    # above — i.e. uvicorn request logs also land in the rotating file.
    uvicorn.run(
        app,
        host=host,
        port=port,
        reload=False,
        log_level="info",
        log_config=None,
    )