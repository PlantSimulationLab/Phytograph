"""Load Open3D once, in the background, before any tool needs it.

`import open3d` is the most expensive import in the backend: measured 13.6 s on
a cold disk and 3.7 s warm on a dev Mac, against ~1 ms to actually read a 4 k-face
PLY with it. Every open3d-using tool imports it lazily, so the first one a user
runs after the backend starts paid that whole cost behind a progress bar that
said something unrelated ("Reading mesh from disk…"), and looked hung.

Two pieces fix that:

* `start_background_warmup()` — called from a FastAPI startup hook — imports
  open3d on a daemon thread while the user is still looking at an empty scene.
  A request that needs open3d while the warm-up is mid-import simply blocks on
  Python's per-module import lock until it finishes; the module is never
  imported twice.
* `get_open3d()` replaces `import open3d as o3d` at the call sites. If open3d is
  not loaded yet it tells the running tool's progress bar so ("Loading Open3D…"),
  then restores the tool's own last message once the load is done. The progress
  reporter is found through a thread-local that `_bin_frame_streaming_response`
  sets for its worker thread, so no tool signature has to change.

Ordering constraint (see the libhelios preload in main.py): on macOS libhelios
must load BEFORE open3d, or it binds open3d's libomp and dies on a missing
symbol. main.py loads libhelios at import time, long before a startup hook runs,
so the warm-up is always second. This module must never be imported-and-warmed
from anywhere earlier than that.
"""

from __future__ import annotations

import os
import sys
import threading
import time
from contextlib import contextmanager

LOADING_MESSAGE = "Loading Open3D (first use since the backend started)…"

_ready = threading.Event()
_start_lock = threading.Lock()
_started = False
_local = threading.local()


def is_ready() -> bool:
    """True once open3d has finished importing in this process."""
    return _ready.is_set()


def _load() -> None:
    t0 = time.perf_counter()
    try:
        import open3d  # noqa: F401
    except Exception as e:  # noqa: BLE001 - a tool that needs it will raise its own error
        print(f"[open3d] background warm-up failed: {e!r}", flush=True)
        return
    _ready.set()
    print(f"[open3d] loaded in the background in {time.perf_counter() - t0:.1f}s", flush=True)


def start_background_warmup() -> bool:
    """Start importing open3d on a daemon thread. Idempotent. Returns True if a
    thread was started. `PHYTOGRAPH_OPEN3D_WARMUP=0` disables it."""
    global _started
    if os.environ.get("PHYTOGRAPH_OPEN3D_WARMUP") == "0":
        return False
    with _start_lock:
        if _started or _ready.is_set():
            return False
        _started = True
    threading.Thread(target=_load, name="open3d-warmup", daemon=True).start()
    return True


@contextmanager
def reporting_to(progress):
    """Route `get_open3d()`'s "Loading Open3D…" notice on this thread to `progress`
    (a `progress(fraction, message)` callable) for the duration of the block."""
    prev = getattr(_local, "progress", None)
    _local.progress = progress
    try:
        yield
    finally:
        _local.progress = prev


def get_open3d():
    """Return the `open3d` module, announcing the wait on the current tool's
    progress bar if the module is still loading."""
    if _ready.is_set():
        return sys.modules["open3d"]
    reporter = getattr(_local, "progress", None)
    last = getattr(reporter, "last", None) if reporter is not None else None
    if reporter is not None:
        # Hold the bar where the tool left it rather than snapping it to 0.
        reporter(last[0] if last else 0.0, LOADING_MESSAGE)
    import open3d
    _ready.set()
    if reporter is not None and last is not None:
        # Put the tool's own label back; otherwise "Loading Open3D…" sits on the
        # bar until the tool's next report, which may be a long stage away.
        reporter(*last)
    return open3d
