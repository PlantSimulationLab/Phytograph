"""Process memory budget, measurement, and byte-weighted admission control.

Until this module existed the backend had no idea how much memory it was using
or how much the machine had: the only throttles were a worker-thread count and
an 8-session cap, both proxies for memory chosen by guesswork. A 100 M-point
cloud session is ~6-9 GB resident (see `estimate_session_bytes`), so two of
them running a bake concurrently on a 16 GB laptop is an OOM kill with nothing
in any log to say why.

Three things live here:

1. MEASUREMENT - `physical_ram_bytes`, `available_bytes`, `rss_bytes`. psutil
   when it is installed (it is a declared dependency and bundled by
   build-backend.mjs); a best-effort `os.sysconf` / `resource` fallback so a
   bare venv without it still runs and every value degrades to "unknown" (0)
   rather than raising.

2. THE BUDGET - `budget_bytes()`. `PHYTOGRAPH_MEMORY_BUDGET_BYTES` pins it;
   otherwise `PHYTOGRAPH_MEMORY_BUDGET_FRACTION` (default 0.5) of physical RAM.
   A FRACTION rather than a constant so the same build scales from a 16 GB
   laptop (~8 GB budget) to a 64 GB workstation (~32 GB) without a setting,
   while the user can still pin it. Every large-cloud threshold in the backend
   derives from this number; nothing else should hard-code a byte count.

3. ADMISSION - `Admission.admit(estimate, label)`. A heavy operation declares
   the working set it is about to allocate and waits until that fits under the
   budget alongside everything already admitted. This is deliberately NOT a
   refusal: a single job larger than the whole budget is admitted as soon as it
   is alone (the OS may page; that is recoverable, a refused export is not) and
   logged. Refusing / prompting is the cost-advisory's job (see
   `_cost_advisory` in main.py), which runs BEFORE the work is committed to.

Everything here is process-local and lock-protected; nothing holds a lock while
sleeping except the admission Condition, which is the point.
"""
from __future__ import annotations

import os
import threading
import time
from typing import Callable, Dict, List, Optional

try:  # pragma: no cover - exercised by whichever branch the host takes
    import psutil as _psutil
except Exception:  # ImportError, or a broken wheel
    _psutil = None

DEFAULT_BUDGET_FRACTION = 0.5
_BUDGET_BYTES_ENV = "PHYTOGRAPH_MEMORY_BUDGET_BYTES"
_BUDGET_FRACTION_ENV = "PHYTOGRAPH_MEMORY_BUDGET_FRACTION"

GiB = 1024 ** 3


# ---- measurement -------------------------------------------------------------

def physical_ram_bytes() -> int:
    """Total physical RAM, or 0 when it cannot be determined."""
    if _psutil is not None:
        try:
            return int(_psutil.virtual_memory().total)
        except Exception:
            pass
    try:
        pages = os.sysconf("SC_PHYS_PAGES")
        page = os.sysconf("SC_PAGE_SIZE")
        if pages > 0 and page > 0:
            return int(pages) * int(page)
    except (ValueError, OSError, AttributeError):
        pass
    return 0


def available_bytes() -> int:
    """Memory the OS reports as available without swapping, or 0 if unknown."""
    if _psutil is not None:
        try:
            return int(_psutil.virtual_memory().available)
        except Exception:
            pass
    try:
        pages = os.sysconf("SC_AVPHYS_PAGES")
        page = os.sysconf("SC_PAGE_SIZE")
        if pages > 0 and page > 0:
            return int(pages) * int(page)
    except (ValueError, OSError, AttributeError):
        pass
    return 0


def rss_bytes(include_children: bool = False) -> int:
    """Resident set size of this process (plus live children when asked).

    Children matter here because the killable segmentation workers and
    PotreeConverter hold the operation's real working set outside this
    process; a parent-only number would say a 100 M-point ground run costs
    nothing.
    """
    if _psutil is not None:
        try:
            proc = _psutil.Process()
            total = int(proc.memory_info().rss)
            if include_children:
                for child in proc.children(recursive=True):
                    try:
                        total += int(child.memory_info().rss)
                    except Exception:
                        continue
            return total
        except Exception:
            pass
    try:
        import resource

        usage = resource.getrusage(resource.RUSAGE_SELF)
        # ru_maxrss is KiB on Linux, bytes on macOS. It is the PEAK, not the
        # current value, which is the best the fallback can do.
        scale = 1 if os.uname().sysname == "Darwin" else 1024
        return int(usage.ru_maxrss) * scale
    except Exception:
        return 0


# ---- budget -----------------------------------------------------------------

def budget_fraction() -> float:
    raw = os.environ.get(_BUDGET_FRACTION_ENV)
    if raw:
        try:
            frac = float(raw)
            if 0.05 <= frac <= 1.0:
                return frac
        except ValueError:
            pass
    return DEFAULT_BUDGET_FRACTION


def budget_bytes() -> int:
    """The memory this backend should plan to use at once.

    Pinned by PHYTOGRAPH_MEMORY_BUDGET_BYTES; otherwise a fraction of physical
    RAM. When even physical RAM is unknown, fall back to 4 GiB - small enough
    to be safe on any machine that can run the app, large enough that nothing
    the E2E suite does hits it.
    """
    raw = os.environ.get(_BUDGET_BYTES_ENV)
    if raw:
        try:
            pinned = int(raw)
            if pinned > 0:
                return pinned
        except ValueError:
            pass
    phys = physical_ram_bytes()
    if phys <= 0:
        return 4 * GiB
    return int(phys * budget_fraction())


def budget_source() -> str:
    if os.environ.get(_BUDGET_BYTES_ENV):
        return "env"
    return "fraction"


def snapshot(include_children: bool = False) -> Dict[str, object]:
    """One dict with everything a health probe or a log line wants."""
    return {
        "physical_bytes": physical_ram_bytes(),
        "available_bytes": available_bytes(),
        "rss_bytes": rss_bytes(include_children=include_children),
        "budget_bytes": budget_bytes(),
        "budget_fraction": budget_fraction(),
        "budget_source": budget_source(),
        "psutil": _psutil is not None,
    }


# ---- per-point cost model ----------------------------------------------------

# Resident bytes per point of a CloudSession, by column. Positions are float64
# (precision argument on CloudSession.positions); every extra scalar column is
# float32; the delete mask is one byte. These are the numbers the whole plan is
# budgeted against - keep them in step with CloudSession's dtypes.
POSITION_BYTES = 24
COLOR_BYTES = 6
INTENSITY_BYTES = 2
EXTRA_BYTES = 4
DELETED_BYTES = 1
TIMESTAMP_BYTES = 8
ORIGIN_BYTES = 24


def bytes_per_point(
    *,
    n_extras: int = 0,
    colors: bool = False,
    intensity: bool = False,
    timestamps: bool = False,
    origins: bool = False,
) -> int:
    total = POSITION_BYTES + DELETED_BYTES + EXTRA_BYTES * max(0, int(n_extras))
    if colors:
        total += COLOR_BYTES
    if intensity:
        total += INTENSITY_BYTES
    if timestamps:
        total += TIMESTAMP_BYTES
    if origins:
        total += ORIGIN_BYTES
    return total


def estimate_session_bytes(sess) -> int:
    """Resident bytes of a CloudSession-like object (duck-typed on its arrays).

    Counts the arrays it actually holds, including the undo snapshots, so the
    result is what the process pays now - not what a fresh import would cost.
    """
    total = 0
    for name in ("positions", "colors", "intensity", "deleted", "timestamps",
                 "beam_origins"):
        arr = getattr(sess, name, None)
        total += _nbytes(arr)
    for arr in (getattr(sess, "extras", None) or {}).values():
        total += _nbytes(arr)
    for arr in getattr(sess, "deleted_history", None) or []:
        total += _nbytes(arr)
    misses = getattr(sess, "backfilled_misses", None) or {}
    for arr in misses.values():
        total += _nbytes(arr)
    return int(total)


def _nbytes(arr) -> int:
    try:
        return int(arr.nbytes)
    except AttributeError:
        return 0


# ---- admission --------------------------------------------------------------

class Admission:
    """Byte-weighted admission control for heavy operations.

    `with admission.admit(estimate, "bake 12.4 M pts"):` blocks until the
    estimate fits under `budget_fn()` next to everything currently admitted.
    A job that can never fit (estimate > budget) is admitted as soon as nothing
    else is running, and a warning is logged - the budget is advisory for a
    lone job and a hard cap only on CONCURRENCY. Waiting jobs are logged once
    they have waited `log_after_s`, so a queue is visible in the backend log.
    """

    def __init__(self, budget_fn: Callable[[], int], log: Optional[Callable[[str], None]] = None,
                 log_after_s: float = 2.0):
        self._budget_fn = budget_fn
        self._log = log or (lambda msg: print(msg, flush=True))
        self._log_after_s = log_after_s
        self._cond = threading.Condition()
        self._admitted: Dict[int, tuple] = {}   # token -> (estimate, label, since)
        self._next_token = 1

    def admitted_bytes(self) -> int:
        with self._cond:
            return sum(e for e, _l, _s in self._admitted.values())

    def in_flight(self) -> List[Dict[str, object]]:
        with self._cond:
            return [
                {"label": label, "bytes": est, "seconds": round(time.time() - since, 1)}
                for est, label, since in self._admitted.values()
            ]

    def admit(self, estimate: int, label: str) -> "_Admitted":
        return _Admitted(self, max(0, int(estimate)), str(label))

    def _acquire(self, estimate: int, label: str) -> int:
        started = time.time()
        logged = False
        with self._cond:
            while True:
                budget = max(0, int(self._budget_fn()))
                used = sum(e for e, _l, _s in self._admitted.values())
                if not self._admitted or used + estimate <= budget:
                    if estimate > budget and budget > 0:
                        self._log(
                            f"[memory] {label}: estimated {estimate / GiB:.1f} GiB exceeds the "
                            f"{budget / GiB:.1f} GiB budget; running it alone"
                        )
                    token = self._next_token
                    self._next_token += 1
                    self._admitted[token] = (estimate, label, time.time())
                    return token
                if not logged and time.time() - started >= self._log_after_s:
                    logged = True
                    self._log(
                        f"[memory] {label}: waiting for {estimate / GiB:.1f} GiB; "
                        f"{used / GiB:.1f} of {budget / GiB:.1f} GiB already admitted "
                        f"({len(self._admitted)} operation(s))"
                    )
                self._cond.wait(timeout=self._log_after_s)

    def _release(self, token: int) -> None:
        with self._cond:
            self._admitted.pop(token, None)
            self._cond.notify_all()


class _Admitted:
    def __init__(self, admission: Admission, estimate: int, label: str):
        self._admission = admission
        self._estimate = estimate
        self._label = label
        self._token: Optional[int] = None

    def __enter__(self):
        self._token = self._admission._acquire(self._estimate, self._label)
        return self

    def __exit__(self, *exc):
        if self._token is not None:
            self._admission._release(self._token)
            self._token = None
        return False


def fmt_bytes(n: float) -> str:
    """Human-readable size for log lines and user-facing advisories."""
    n = float(n)
    if n >= GiB:
        return f"{n / GiB:.1f} GB"
    if n >= 1024 ** 2:
        return f"{n / 1024 ** 2:.0f} MB"
    return f"{n / 1024:.0f} KB"
