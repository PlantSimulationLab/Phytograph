"""One cap on every thread pool the engine uses: ``PHYTOGRAPH_THREADS``.

A harness that runs several evaluations per machine gives each one a slot of
N threads. Unset, nothing changes: native libraries pick their own counts and
the Python pools keep their usual sizes. Set to N:

* OpenMP (open3d, sklearn), BLAS (OpenBLAS, MKL, Accelerate), numexpr and numba
  are pinned through their environment variables. Those are read when the
  library loads, so :func:`apply_env` must run before numpy is imported; it is
  called at the top of ``backend_wrapper.py`` and ``main.py``, and every child
  process (seg workers, tile pools) inherits the environment.
* :func:`apply_runtime` additionally applies ``threadpoolctl`` limits to
  whatever is already loaded and caps torch, which is imported lazily in the
  seg worker (:func:`apply_torch` is called where torch is imported).
* Python executors and ``cKDTree.query(workers=...)`` size themselves through
  :func:`pool_size`, :func:`kd_workers` and :func:`cpu_count`. Nothing else in
  the engine may call ``os.cpu_count()`` or pass ``workers=-1``;
  ``tests/test_thread_cap.py`` enforces that.

The request thread limiter (``PHYTOGRAPH_MAX_WORKER_THREADS``) is not capped:
it bounds how many HTTP requests run at once, not the compute inside one.
"""
from __future__ import annotations

import os
import sys
from typing import Any, Dict, Optional

ENV = "PHYTOGRAPH_THREADS"

NATIVE_VARS = (
    "OMP_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "MKL_NUM_THREADS",
    "VECLIB_MAXIMUM_THREADS",
    "NUMEXPR_NUM_THREADS",
    "NUMBA_NUM_THREADS",
)

_limiter = None


def cap() -> Optional[int]:
    """The configured cap, or None when ``PHYTOGRAPH_THREADS`` is unset.

    A value that is not a positive integer is an error, not a silent default:
    a harness that thinks it set a cap must not get every core instead."""
    raw = os.environ.get(ENV, "").strip()
    if not raw:
        return None
    try:
        n = int(raw)
    except ValueError:
        raise ValueError(f"{ENV} must be a positive integer, got {raw!r}") from None
    if n < 1:
        raise ValueError(f"{ENV} must be a positive integer, got {raw!r}")
    return n


def cpu_count() -> int:
    """Cores this process may use: the cap if set, else the machine's count."""
    return cap() or os.cpu_count() or 1


def kd_workers() -> int:
    """The ``workers=`` argument for ``cKDTree.query``: the cap, or -1 (all)."""
    return cap() or -1


def pool_size(default: int) -> int:
    """Size for a Python executor whose uncapped size is ``default``."""
    c = cap()
    return max(1, min(int(default), c)) if c else max(1, int(default))


def apply_env() -> None:
    """Pin the native libraries' thread counts. Run before importing numpy."""
    c = cap()
    if c is None:
        return
    for var in NATIVE_VARS:
        os.environ[var] = str(c)


def apply_torch(torch: Any) -> None:
    c = cap()
    if c is None:
        return
    torch.set_num_threads(c)
    try:
        torch.set_num_interop_threads(c)
    except RuntimeError:
        # Only settable before torch's first parallel region; the intra-op
        # count above is the one that matters for inference.
        pass


def apply_runtime() -> None:
    """Apply the cap to native thread pools that are already loaded."""
    global _limiter
    c = cap()
    if c is None:
        return
    from threadpoolctl import threadpool_limits
    _limiter = threadpool_limits(limits=c)
    if "torch" in sys.modules:
        apply_torch(sys.modules["torch"])


def report() -> Dict[str, Any]:
    """What the process is actually running with, for a run record."""
    out: Dict[str, Any] = {"cap": cap(), "env": {v: os.environ.get(v) for v in NATIVE_VARS}}
    try:
        from threadpoolctl import threadpool_info
        out["native_pools"] = [
            {"user_api": p.get("user_api"), "internal_api": p.get("internal_api"),
             "num_threads": p.get("num_threads")}
            for p in threadpool_info()]
    except Exception as exc:  # pragma: no cover - threadpoolctl is bundled
        out["native_pools_error"] = str(exc)
    torch = sys.modules.get("torch")
    if torch is not None:
        out["torch_threads"] = torch.get_num_threads()
    return out
