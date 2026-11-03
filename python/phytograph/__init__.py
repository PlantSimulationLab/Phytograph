"""Phytograph scripting API.

Run Phytograph's point-cloud processing headless, from a script::

    import phytograph as pg

    with pg.Backend() as be:                 # launches a private headless backend
        cloud = be.open("plot.laz")
        cloud.crop([0, 0, -5], [20, 20, 40])
        cloud.export("plot-cropped.laz")
        xyz = cloud.positions                # (N, 3) float64, world coordinates

The package is pure Python (httpx + numpy). The compute runs in the same backend
the desktop app ships, located automatically (see :class:`Backend`).
"""
from ._version import EXPECTED_BACKEND_VERSION, __version__
from .backend import Backend
from .cloud import Cloud
from .errors import (BackendNotFound, BackendStartError, Canceled, CostWarning,
                     PhytographError, VersionMismatch)
from .results import (DEM, GROUND, LEAF, NOISE, NOISE_CLEAN, NON_GROUND, QSM, WOOD, Grid,
                      Inventory, LADResult, Mesh, Registration, Scan, Skeleton)

__all__ = ["Backend", "Cloud", "PhytographError", "BackendNotFound", "BackendStartError",
           "VersionMismatch", "Canceled", "CostWarning", "EXPECTED_BACKEND_VERSION", "__version__",
           "DEM", "Mesh", "QSM", "Skeleton", "Inventory", "Registration", "LADResult", "Scan", "Grid",
           "GROUND", "NON_GROUND", "WOOD", "LEAF", "NOISE", "NOISE_CLEAN"]
