"""Extent-seeded tool defaults: the Python half of a cross-process contract.

The app's panels seed ground (CSF), DEM and tree-segmentation parameters from
the cloud's hits-only extent (`src/renderer/lib/groundSegmentDefaults.ts`,
`demDefaults.ts`, `treeSegmentDefaults.ts`). The Python scripting client needs
the same numbers, and a second hand-maintained copy is exactly the
"computed twice, agreeing by accident" shape CLAUDE.md warns about. So both
implementations are pinned to `src/shared/parameterDefaults.contract.json`,
asserted by `src/renderer/lib/parameterDefaults.contract.test.ts` (Vitest) and
`backend-api/tests/test_param_defaults.py` (pytest). Change one side without the
JSON and its own test fails; change the JSON and both do.

Read the TypeScript modules for WHY each constant has its value; this file only
reproduces the arithmetic. Pure: no numpy, no `main` import.
"""
from __future__ import annotations

import math
from typing import Dict, Optional, Union

Number = Union[int, float]

# --- ground (CSF) ----------------------------------------------------------
_CLOTH_MIN, _CLOTH_MAX = 0.05, 2.0
_THRESH_MIN, _THRESH_MAX = 0.02, 1.0
_FLAT_EXTENT_FRACTION = 1 / 100
_SLOPE_CLOTH_FRACTION = 1 / 200
_SLOPE_CLOTH_MAX = 1.0
_SLOPE_THRESHOLD = 0.5
_SLOPE_RELIEF_RATIO = 0.2
_VEGETATION_RELIEF_RATIO = 0.7
_SLOPE_MIN_EXTENT_M = 50.0
_ALS_SPACING_M = 0.1
_ALS_MIN_EXTENT_M = 50.0
_ALS_CLOTH = 0.75
_ALS_CLASS_THRESHOLD = 0.5

# --- DEM -------------------------------------------------------------------
_CELL_MIN, _CELL_MAX = 0.02, 2.0
_DEM_EXTENT_FRACTION = 1 / 100

# --- tree segmentation (TreeIso) --------------------------------------------
_DEC1_MIN, _DEC1_MAX = 0.05, 1.0
_DEC1_FRACTION = 1 / 372
_MAX_GAP_FRACTION = 2 / 186
_MAX_GAP_MIN, _MAX_GAP_MAX = 2.0, 6.0
_OUTLIER_GAP_DEFAULT = 0.65

# The fallback extent for a non-finite / non-positive input (plant scale).
_FALLBACK_EXTENT = 1.5


def _finite_pos(v: Optional[Number]) -> bool:
    return v is not None and math.isfinite(v) and v > 0


def _clamp_round(value: float, lo: float, hi: float) -> float:
    """JS `Math.round(clamp(v) * 1000) / 1000`. Python's round() is banker's
    rounding, which differs at exact halves; Math.round rounds half up."""
    clamped = max(lo, min(hi, value))
    return math.floor(clamped * 1000 + 0.5) / 1000


def ground_defaults(horizontal_extent_m: Number, vertical_relief_m: Number = 0,
                    point_spacing_m: Optional[Number] = None) -> Dict[str, object]:
    """`groundSegmentDefaultsForExtent`, keyed by the backend's request field
    names (`SessionGroundSegmentRequest`)."""
    if (point_spacing_m is not None and math.isfinite(point_spacing_m)
            and point_spacing_m >= _ALS_SPACING_M
            and math.isfinite(horizontal_extent_m) and horizontal_extent_m >= _ALS_MIN_EXTENT_M):
        return {"cloth_resolution": _ALS_CLOTH, "class_threshold": _ALS_CLASS_THRESHOLD,
                "rigidness": 2, "slope_smooth": True}
    ext = horizontal_extent_m if _finite_pos(horizontal_extent_m) else _FALLBACK_EXTENT
    relief = vertical_relief_m if _finite_pos(vertical_relief_m) else 0.0
    ratio = relief / ext
    if ext >= _SLOPE_MIN_EXTENT_M and _SLOPE_RELIEF_RATIO <= ratio < _VEGETATION_RELIEF_RATIO:
        cloth = min(ext * _SLOPE_CLOTH_FRACTION, _SLOPE_CLOTH_MAX)
        return {"cloth_resolution": _clamp_round(cloth, _CLOTH_MIN, _CLOTH_MAX),
                "class_threshold": _clamp_round(_SLOPE_THRESHOLD, _THRESH_MIN, _THRESH_MAX),
                "rigidness": 1, "slope_smooth": True}
    scaled = ext * _FLAT_EXTENT_FRACTION
    return {"cloth_resolution": _clamp_round(scaled, _CLOTH_MIN, _CLOTH_MAX),
            "class_threshold": _clamp_round(scaled, _THRESH_MIN, _THRESH_MAX),
            "rigidness": 3, "slope_smooth": False}


def dem_defaults(horizontal_extent_m: Number) -> Dict[str, float]:
    """`demDefaultsForExtent`."""
    ext = horizontal_extent_m if _finite_pos(horizontal_extent_m) else _FALLBACK_EXTENT
    return {"cell_size": _clamp_round(ext * _DEM_EXTENT_FRACTION, _CELL_MIN, _CELL_MAX)}


def tree_defaults(horizontal_extent_m: Number) -> Dict[str, float]:
    """`treeSegmentDefaultsForExtent`, keyed by TreeIso's request field names."""
    ext = horizontal_extent_m if _finite_pos(horizontal_extent_m) else _FALLBACK_EXTENT
    dec1 = _clamp_round(ext * _DEC1_FRACTION, _DEC1_MIN, _DEC1_MAX)
    dec2 = _clamp_round(2 * dec1, _DEC1_MIN, 2 * _DEC1_MAX)
    max_gap = _clamp_round(ext * _MAX_GAP_FRACTION, _MAX_GAP_MIN, _MAX_GAP_MAX)
    outlier = _clamp_round(_OUTLIER_GAP_DEFAULT, 0.0, max_gap)
    return {"decimate_res1": dec1, "decimate_res2": dec2, "max_gap": max_gap,
            "max_outlier_gap": outlier}
