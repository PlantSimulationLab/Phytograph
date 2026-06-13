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


def _configure_logging():
    """Send INFO+ to BOTH stderr (so the Electron supervisor's stdout/stderr tee
    in src/main/backend.ts captures it) AND a rotating file on disk.

    The file lives in PHYTOGRAPH_LOG_DIR when the supervisor passes one (it points
    at electron-log's directory so everything ends up together), falling back to
    the OS temp dir for standalone `python backend_wrapper.py` runs. This is the
    durable, full-fidelity backend log that gets concatenated into a bug report's
    attachment even if a streamed line was missed by the tee.
    """
    log_dir = os.environ.get("PHYTOGRAPH_LOG_DIR") or os.path.join(
        tempfile.gettempdir(), "phytograph-logs"
    )
    try:
        os.makedirs(log_dir, exist_ok=True)
    except OSError:
        log_dir = tempfile.gettempdir()

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
            os.path.join(log_dir, "phytograph-backend.log"),
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
    # Port is chosen by whoever spawned us (the Electron supervisor in
    # src/main/backend.ts, or scripts/dev.mjs) and passed via
    # PHYTOGRAPH_BACKEND_PORT so multiple app instances / dev sessions never
    # collide on a fixed port. Falls back to 8008 when launched standalone.
    port = int(os.environ.get("PHYTOGRAPH_BACKEND_PORT", "8008"))
    logger.info(f"Starting server on http://127.0.0.1:{port} (logs → {_LOG_DIR})")
    # log_config=None tells uvicorn NOT to install its own stdout-only logging
    # config, so its access/error loggers inherit the root handlers configured
    # above — i.e. uvicorn request logs also land in the rotating file.
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=port,
        reload=False,
        log_level="info",
        log_config=None,
    )