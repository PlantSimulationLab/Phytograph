"""Periodic all-thread stack dumps that cannot crash the process they watch.

CI and the platform gate set PHYTOGRAPH_STACK_DUMP_SECS so a hung or crashed
backend on a runner nobody can log into leaves its thread stacks in the
uploaded logs. That used to be `faulthandler.dump_traceback_later(repeat=True)`,
whose watchdog walks every thread's frames WITHOUT the GIL while those threads
keep running. A thread that returns mid-walk frees the frame being read, and
the watchdog dereferences it: on the Windows platform gate (release run
44640932438) the backend died with an access violation while dumping a worker
that was inside psutil, which failed a Helios XML import and the release gate
with it. The shipped app never sets the variable; the instrument was crashing
the thing it watched.

This dumper takes the GIL (`sys._current_frames()` plus `traceback`), so every
frame it reads is alive for the whole read. The trade: a thread that holds the
GIL forever in C would stall the dump instead of appearing in it. The fatal
handler (`faulthandler.enable`, installed by the caller) still writes the
crashing traceback on a native fault, which is the one moment the unsafe walk
is worth it, since the process is going down anyway.
"""

from __future__ import annotations

import sys
import threading
import time
import traceback
from typing import IO, Optional


def format_all_stacks() -> str:
    """Every live thread's stack, most recent call last, with its name."""
    names = {t.ident: t.name for t in threading.enumerate()}
    out = [f"--- stacks at {time.strftime('%Y-%m-%d %H:%M:%S')} ---\n"]
    for ident, frame in sorted(sys._current_frames().items()):
        out.append(f"Thread 0x{ident:016x} ({names.get(ident, '?')}):\n")
        out.extend(traceback.format_stack(frame))
        out.append("\n")
    return "".join(out)


def start_periodic_stack_dump(file: IO[str], interval_s: float,
                              stop: Optional[threading.Event] = None) -> threading.Event:
    """Append `format_all_stacks()` to `file` every `interval_s` seconds from a
    daemon thread. Returns the Event that stops it (tests; the backend never
    stops it). A failed write ends the thread rather than raising into nothing."""
    if interval_s <= 0:
        raise ValueError(f"interval must be positive, got {interval_s!r}")
    stop = stop or threading.Event()

    def _run() -> None:
        while not stop.wait(interval_s):
            try:
                file.write(format_all_stacks())
                file.flush()
            except (OSError, ValueError):
                return

    threading.Thread(target=_run, name="stack-dumper", daemon=True).start()
    return stop
