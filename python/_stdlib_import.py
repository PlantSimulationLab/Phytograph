"""Load ``phytograph._download`` (and ``_version``) without running the package's
``__init__``, which imports the client and therefore httpx and numpy.

The release tools (``build_wheel.py``, ``pack_backend.py``) run on a CI runner's
bare Python, with neither installed. They need only the archive naming in
``_download``, which is standard-library only, so they import it through a bare
package stub. Pinned by ``python/tests/test_release_tools_stdlib.py``, which runs
both tools under ``python -S`` (no site-packages at all).
"""
from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

PKG_DIR = Path(__file__).resolve().parent / "phytograph"


def load(name: str):
    """``phytograph.<name>`` without importing ``phytograph/__init__.py``.
    If the real package is already imported (e.g. in the test suite), it is used."""
    if "phytograph" not in sys.modules:
        stub = types.ModuleType("phytograph")
        stub.__path__ = [str(PKG_DIR)]
        sys.modules["phytograph"] = stub
    return importlib.import_module(f"phytograph.{name}")
