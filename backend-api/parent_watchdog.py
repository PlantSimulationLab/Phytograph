"""Shut the backend down when the app that launched it dies.

The Electron supervisor spawns this server detached (its own process group, so
`stopBackend()` can kill the whole PyInstaller tree), and every cleanup path it
has is JavaScript: `before-quit`, its signal handlers, `process.on('exit')`.
None of them runs when the app is SIGKILLed, force-quit, OOM-killed or crashes
natively, and the orphan then held every session array in RAM indefinitely;
the next launch chose a different port and never found it.

The supervisor therefore hands us a stdin PIPE that it never writes to and sets
`PHYTOGRAPH_EXIT_WITH_PARENT=1`. The OS closes the write end however the app
dies, so reading stdin to EOF is a death notice that needs no PID polling (no
PID-reuse blind spot, nothing platform-specific). Gated on the env var because
a terminal launch has a TTY on stdin, and the dev uvicorn is owned by
scripts/dev.mjs, not the app.
"""
from __future__ import annotations

import logging
import os
import signal
import sys
import threading
from typing import Callable, Optional

logger = logging.getLogger(__name__)

ENV_VAR = "PHYTOGRAPH_EXIT_WITH_PARENT"
# How long uvicorn's graceful shutdown gets before the process is ended outright.
GRACE_SECONDS = 15.0


def enabled() -> bool:
    return os.environ.get(ENV_VAR) == "1"


def watch_stdin_eof(on_eof: Callable[[], None], stream=None) -> Optional[threading.Thread]:
    """Call `on_eof` (on a daemon thread) once `stream` (default: stdin) closes.

    Returns the thread, or None when there is no stdin to watch.
    """
    if stream is None:
        stdin = sys.stdin
        if stdin is None:
            logger.warning("%s set but there is no stdin; not watching for the app's exit", ENV_VAR)
            return None
        stream = getattr(stdin, "buffer", stdin)

    def _run():
        try:
            # The supervisor never writes, so this blocks until the pipe closes.
            # Drain anything that does arrive rather than treating it as EOF.
            while stream.read(65536):
                pass
        except (OSError, ValueError):
            pass
        on_eof()

    t = threading.Thread(target=_run, name="parent-watchdog", daemon=True)
    t.start()
    return t


def shutdown_server(reap: Callable[[], None] = lambda: None,
                    grace_seconds: float = GRACE_SECONDS) -> None:
    """Ask the server to stop as if the supervisor had sent SIGTERM, and end the
    process outright if that has not finished within `grace_seconds`.

    `reap` (the segmentation-worker reaper) runs FIRST, not from atexit: uvicorn
    re-raises the captured SIGTERM once its shutdown completes, and that default
    action ends the process without running atexit. Workers sit in their own
    process groups, and with the app gone nobody is waiting for their results.
    """
    logger.warning("The app that launched this backend has exited; shutting down.")
    try:
        reap()
    except Exception:  # noqa: BLE001 - never let reaping block the shutdown
        logger.exception("Could not reap segmentation workers")

    def _force():
        logger.warning("Graceful shutdown did not finish in %.0f s; exiting.", grace_seconds)
        os._exit(0)

    timer = threading.Timer(grace_seconds, _force)
    timer.daemon = True
    timer.start()
    try:
        signal.raise_signal(signal.SIGTERM)
    except Exception:  # noqa: BLE001 - the timer is the fallback either way
        logger.exception("Could not signal the server to stop")
        _force()
