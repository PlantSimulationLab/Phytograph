"""Plant organs for the app: soil / stem / leaf per point, plus one id per leaflet.

The ``plant_organ`` models (``ml.tasks``) have two outputs: a class per point,
and a per-point vote for the centroid of the leaflet it belongs to, which
``ml.instances.cluster`` turns into leaflets. :func:`label_plant` runs both and
returns the two columns the app writes:

- ``plant_organ``: 1 soil, 2 stem (petioles, rachises and petiolules
  included), 3 leaf. Mapped from the model's classes by NAME, as
  ``segment_wood`` maps its model's, so any ``plant_organ`` package writes the
  same codes the renderer's scheme colors.
- ``leaflet_id``: 0 for every point that is not in a leaflet, 1..N otherwise,
  numbered by centroid height, lowest first. PlantCloudFit reads increasing
  leaflet labels as increasing age; on a single scan there is no age, and
  height is the proxy that holds for an upright plant (a drooping old leaf can
  still sit below a younger one).

Models work in meters, but herbaceous plants are often scanned and exported
in millimeters, and nothing in an XYZ file says which. :func:`resolve_units`
reads it from the cloud's size (``units="auto"``) unless the caller says, and
warns when the size it implies is not a plant's, or could be read either way.

This module imports torch only inside :func:`label_plant`, so the server can
import :func:`resolve_units` without paying for torch.
"""

from __future__ import annotations

import numpy as np

SOIL, STEM, LEAF = 1, 2, 3
CLASS_BY_NAME = {"soil": SOIL, "stem": STEM, "leaf": LEAF}
UNIT_SCALE = {"m": 1.0, "cm": 0.01, "mm": 0.001}
UNIT_NAMES = {"m": "meters", "cm": "centimeters", "mm": "millimeters"}

# Above this robust diagonal (in the cloud's own units) "auto" reads the cloud
# as millimeters. The model is for single plants, pots and short rows, which
# are 2 cm to a few meters across: a cloud more than 30 units across is a
# 3 cm+ plant in millimeters far more often than a 30 m+ plot in meters (which
# the model is not for anyway). Centimeters are never guessed.
AUTO_MM_DIAGONAL = 30.0
# The sizes, in meters, the model is for (a seedling to a short row). Outside
# this the user is told the units are probably wrong. It is kept narrow on
# purpose: a wrong unit is off by 10x-1000x, and only a narrow window turns that
# into a warning rather than a size that still looks plausible.
PLANT_SIZE_M = (0.02, 5.0)
# "auto" read as millimeters with the diagonal below this: a 3-30 cm plant in
# mm, or a 30-300 cm plant in cm. Both are plants, so the size cannot decide;
# the user is told which reading was taken.
AMBIGUOUS_CM_DIAGONAL = 300.0


def robust_diagonal(points: np.ndarray) -> float:
    """Diagonal of the 1st-99th percentile box: one stray point does not set it."""
    if len(points) < 2:
        return 0.0
    lo, hi = np.percentile(points, [1, 99], axis=0)
    return float(np.linalg.norm(hi - lo))


def resolve_units(points: np.ndarray, units: str = "auto") -> tuple[str, list[str]]:
    """``(units, warnings)``: the unit to read the cloud in ("m", "cm" or "mm")
    and anything the user should hear about it."""
    diag = robust_diagonal(points)
    auto = units == "auto"
    if auto:
        units = "mm" if diag > AUTO_MM_DIAGONAL else "m"
    if units not in UNIT_SCALE:
        raise ValueError(f"units must be 'auto', 'm', 'cm' or 'mm', not {units!r}")
    warnings = []
    meters = diag * UNIT_SCALE[units]
    lo, hi = PLANT_SIZE_M
    if meters > 0 and not (lo <= meters <= hi):
        warnings.append(
            f"Read in {UNIT_NAMES[units]}, this cloud is {meters:.3g} m across, which is not the size of a "
            f"plant or pot. If that is wrong, pick its real units and run again.")
    elif auto and units == "mm" and diag <= AMBIGUOUS_CM_DIAGONAL:
        warnings.append(
            f"Read as millimeters: a plant {meters * 100:.3g} cm across. If the cloud is in centimeters "
            f"({diag / 100:.3g} m across), pick Centimeters and run again.")
    return units, warnings


def label_plant(points: np.ndarray, model_id: str | None = None, units: str = "auto",
                device: str | None = None, cluster_kw: dict | None = None) -> tuple[np.ndarray, np.ndarray, dict]:
    """``(plant_organ, leaflet_id, meta)`` for ``points`` (N, 3), in the cloud's
    own units. ``meta`` holds the model id, the units used, counts and
    warnings."""
    from . import registry
    from .device import best_device
    from .infer import predict
    from .instances import cluster
    from .package import load_model

    points = np.asarray(points, np.float64)
    units, warnings = resolve_units(points, units)
    pkg = registry.find(model_id, task="plant_organ")
    device = best_device(device)
    model = load_model(pkg, device)
    xyz = points * UNIT_SCALE[units]
    values, offsets, radii = predict(model, pkg, xyz, device=device, return_offsets=True)

    # Classes by NAME, never by position: an imported package may order them
    # differently, and a name we do not know is a package this code cannot map.
    by_value = {}
    for c in pkg.classes:
        code = CLASS_BY_NAME.get(c["name"].lower())
        if code is None:
            raise ValueError(f"model {pkg.id!r} has a class {c['name']!r}; plant-organ models have Soil, Stem, Leaf")
        by_value[c["value"]] = code
    leaf_values = [v for v, code in by_value.items() if code == LEAF]
    if not leaf_values:
        raise ValueError(f"model {pkg.id!r} has no Leaf class")
    organ = np.zeros(len(points), np.int32)
    for v, code in by_value.items():
        organ[values == v] = code
    inst = cluster(xyz, offsets, radii, np.isin(values, leaf_values), **(cluster_kw or {}))

    leaflet = np.zeros(len(points), np.int32)
    has = inst >= 0
    ids, dense = np.unique(inst[has], return_inverse=True)
    if len(ids):
        # Mean height per leaflet in one pass, then rank lowest first.
        z = np.bincount(dense, weights=xyz[has, 2]) / np.bincount(dense)
        rank = np.empty(len(ids), np.int64)
        rank[np.argsort(z, kind="stable")] = np.arange(1, len(ids) + 1)
        leaflet[has] = rank[dense]

    meta = {
        "model_id": pkg.id, "units": units, "device": device, "warnings": warnings,
        "num_soil": int((organ == SOIL).sum()), "num_stem": int((organ == STEM).sum()),
        "num_leaf": int((organ == LEAF).sum()), "num_leaflets": int(len(ids)),
    }
    return organ, leaflet, meta
