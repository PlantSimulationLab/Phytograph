"""Recipes: the operation sequences an expert runs the same way every time.

Each tool on :class:`~phytograph.Cloud` does one thing. Getting a sane answer
out of a scan usually takes several of them in a fixed order, with settings the
app's panels choose for you and checks the app shows as a toast. A recipe is
that sequence written down once, so a script - or an agent - does not have to
rediscover it:

* the ORDER (ground before DEM before stem seeds before tree segmentation …);
* the settings where the API's default differs from the app's (ground
  tolerance measured from the scan, wood by the ML model);
* the CHECK the app would show, raised as :class:`RecipeError` when the result
  is not usable and recorded as an advisory when it is usable but suspect.

Every recipe returns a :class:`RecipeRecord` naming what it ran, with which
parameters, on which package and backend version, and what each step reported.
Keep it beside the outputs: it is the provenance of the numbers.

The knowledge behind these choices is in ``skills/phytograph/SKILL.md`` (shipped
in the wheel, see :func:`phytograph.skills_dir`) and in the user guide's
workflow pages.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Tuple

import numpy as np

from ._version import __version__
from .errors import PhytographError
from .results import GROUND, NOISE_CLEAN, NON_GROUND, WOOD

if TYPE_CHECKING:  # pragma: no cover
    from .cloud import Cloud
    from .results import DEM, QSM, Inventory, Registration

__all__ = ["RecipeError", "RecipeRecord", "Step", "clean", "ground_and_heights", "plot_trees",
           "plot_inventory", "tree_qsm", "register_pair", "herbaceous_organs"]

# Real scanner noise is 0.1-3% of points (docs: clean-point-cloud). The app asks
# before deleting more than 20%; a script has nobody to ask, so it refuses.
NOISE_ADVISORY_FRACTION = 0.03
NOISE_REFUSE_FRACTION = 0.20
# The app thins a tree to 60 000 points before a QSM; /api/qsm/build does not.
QSM_POINTS = 60_000
# A QSM radius whose surface coverage is below this leans on the taper model.
QSM_INFERRED_RADIUS_COVERAGE = 0.7
# ICP is good when its RMSE is well under 1% of the cloud's size (docs: register-compare).
REGISTRATION_RMSE_FRACTION = 0.01
# segment_organs' plausible plant size, in meters (docs: segment-organs).
ORGAN_PLANT_SIZE_M = (0.02, 5.0)


class RecipeError(PhytographError):
    """A recipe's result failed the check an expert would apply; ``detail``
    holds the record so far."""


@dataclass
class Step:
    """One tool call: its name, the parameters it was given, and what it reported."""
    op: str
    params: Dict[str, Any]
    summary: Dict[str, Any] = field(default_factory=dict)


@dataclass
class RecipeRecord:
    """What a recipe ran. ``advisories`` are results that passed the checks
    but deserve a look (the app would show them as a warning toast)."""
    recipe: str
    params: Dict[str, Any]
    phytograph_version: str
    backend_version: Optional[str]
    input: Dict[str, Any]
    steps: List[Step] = field(default_factory=list)
    advisories: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return _jsonable(asdict(self))

    def _step(self, op: str, params: Dict[str, Any], res: Any = None) -> Any:
        self.steps.append(Step(op, dict(params), _summary(res)))
        self.advisories.extend(_advisories(res, op))
        return res

    def _fail(self, message: str) -> "RecipeError":
        return RecipeError(f"{self.recipe}: {message}", detail=self.to_dict())


def _start(recipe: str, cloud: "Cloud", params: Dict[str, Any]) -> RecipeRecord:
    info = cloud.import_info
    return RecipeRecord(
        recipe=recipe, params=dict(params), phytograph_version=__version__,
        backend_version=getattr(cloud._be, "version", None),
        input={"name": cloud.name, "session_id": cloud.session_id, "points": len(cloud),
               "source_path": info.get("source_path") or info.get("file_path")})


# --------------------------------------------------------------------------
# Recipes
# --------------------------------------------------------------------------
def clean(cloud: "Cloud", *, method: str = "ror", max_flagged: float = NOISE_REFUSE_FRACTION,
          **params: Any) -> RecipeRecord:
    """Flag outliers and delete them, in place. Run it PER SCAN, before
    registering or merging: density differs between scan positions.

    ``ror`` (isolated points) is the safe default; ``sor`` grows more
    aggressive with every pass, so never run it twice. Refuses (cloud
    unchanged) when more than ``max_flagged`` of the points would go: that is
    a wrong radius, not noise."""
    rec = _start("clean", cloud, {"method": method, "max_flagged": max_flagged, **params})
    n = len(cloud)
    rec._step("denoise", {"method": method, **params}, cloud.denoise(method=method, **params))
    flagged = n - int(np.count_nonzero(cloud.column("noise_class") == NOISE_CLEAN))
    frac = flagged / max(n, 1)
    rec.steps[-1].summary["flagged_fraction"] = frac
    if frac > max_flagged:
        raise rec._fail(f"{frac:.1%} of points flagged as noise (limit {max_flagged:.0%}); real "
                        "scanner noise is 0.1-3%. The radius or neighbor count is wrong for this "
                        "cloud's spacing; leave them unset to have them measured.")
    if frac > NOISE_ADVISORY_FRACTION:
        rec.advisories.append(f"clean: {frac:.1%} flagged, above the usual 0.1-3%")
    if flagged:
        cloud.filter(where={"noise_class": [NOISE_CLEAN]})
        rec._step("filter", {"where": {"noise_class": [NOISE_CLEAN]}}, {"points": len(cloud)})
    return rec


def ground_and_heights(cloud: "Cloud", *, cell_size: Optional[float] = None,
                       fill_voids: bool = False,
                       **ground_params: Any) -> Tuple["DEM", RecipeRecord]:
    """``ground_class`` and ``height_above_ground`` on the cloud, and the DTM.

    The ground tolerance is measured from the scan (``auto_class_threshold``),
    as the app does by default and the bare API does not: a tolerance seeded
    from the plot's WIDTH leaves flat ground labeled non-ground in patches
    when the ground band is tens of centimeters thick. ``fill_voids=True`` for
    closed canopy where little ground is seen."""
    params = {"auto_class_threshold": True, **ground_params}
    rec = _start("ground_and_heights", cloud, {"cell_size": cell_size, "fill_voids": fill_voids,
                                               **params})
    rec._step("segment_ground", params, cloud.segment_ground(**params))
    g = cloud.column("ground_class")
    n_ground = int(np.count_nonzero(g == GROUND))
    rec.steps[-1].summary["ground_fraction"] = n_ground / max(len(g), 1)
    if n_ground == 0:
        raise rec._fail("no point was labeled ground. Crop people, tripods and buildings out "
                        "first; on a single potted plant, crop the pot instead of using this.")
    if not np.any(g == NON_GROUND):
        raise rec._fail("every point was labeled ground: the cloth reached the canopy top. "
                        "Try rigidness=3, slope_smooth=False, or a coarser cloth_resolution.")
    dem = cloud.dem(cell_size=cell_size, surface="dtm", fill_voids=fill_voids,
                    add_height_column=True)
    finite = float(np.isfinite(dem.z).mean())
    rec._step("dem", {"cell_size": dem.cell_size, "surface": "dtm", "fill_voids": fill_voids,
                      "add_height_column": True},
              {"grid": list(dem.z.shape), "finite_fraction": finite})
    if finite < 0.5:
        rec.advisories.append(f"ground_and_heights: only {finite:.0%} of DEM cells have ground; "
                              "consider fill_voids=True")
    return dem, rec


def plot_trees(cloud: "Cloud", *, seeds: Optional[np.ndarray] = None, use_stem_seeds: bool = True,
               method: str = "treeiso", **tree_params: Any) -> Tuple[int, RecipeRecord]:
    """Individual trees in a plot → ``tree_instance``. Ground and heights
    first, then stem seeds from the breast-height layer (``use_stem_seeds``;
    treat them as a draft - posts get seeded, hidden stems are missed), then
    segmentation. Returns the number of trees found.

    ``method="chm"`` for airborne or closed canopy where trunks are not seen.
    A "more than one trunk" advisory means trees merged and the count is a
    MINIMUM: lower ``max_outlier_gap`` first, then ``max_gap``."""
    rec = _start("plot_trees", cloud, {"use_stem_seeds": use_stem_seeds, "method": method,
                                       **tree_params})
    if "height_above_ground" not in cloud.columns or "ground_class" not in cloud.columns:
        _, sub = ground_and_heights(cloud)
        _merge(rec, sub)
    if seeds is None and use_stem_seeds and method == "treeiso":
        seeds = cloud.detect_stems()
        rec._step("detect_stems", {}, {"seeds": len(seeds)})
    body = dict(tree_params)
    rec._step("segment_trees", {"method": method, "seeds": None if seeds is None else len(seeds),
                                **body},
              cloud.segment_trees(method=method, seeds=seeds, **body))
    ids = np.unique(cloud.column("tree_instance"))
    n = int(np.count_nonzero(ids > 0))
    rec.steps[-1].summary["trees"] = n
    if n == 0:
        raise rec._fail("no tree was segmented. Check ground_class is right and the scan "
                        "reaches the trunks; for airborne data use method='chm'.")
    return n, rec


def plot_inventory(cloud: "Cloud", *, breast_height_m: float = 1.3,
                   **inventory_params: Any) -> Tuple["Inventory", RecipeRecord]:
    """DBH, height and crown per tree. Segments the trees first unless
    ``tree_instance`` already exists (re-segmenting renumbers them). Counts
    each tree flag (``partial_arc`` is normal for one scan; ``no_stem`` means
    merged or occluded) into the record."""
    rec = _start("plot_inventory", cloud, {"breast_height_m": breast_height_m,
                                           **inventory_params})
    if "tree_instance" not in cloud.columns:
        _, sub = plot_trees(cloud)
        _merge(rec, sub)
    elif "height_above_ground" not in cloud.columns:
        _, sub = ground_and_heights(cloud)
        _merge(rec, sub)
    inv = cloud.tree_inventory(breast_height_m=breast_height_m, **inventory_params)
    flags: Dict[str, int] = {}
    for t in inv.trees:
        for f in t.get("flags") or []:
            flags[f] = flags.get(f, 0) + 1
    rec._step("tree_inventory", {"breast_height_m": breast_height_m, **inventory_params},
              {"trees": len(inv), "flags": flags})
    rec.advisories.extend(f"tree_inventory: {w}" for w in inv.warnings)
    if len(inv) == 0:
        raise rec._fail("the inventory measured no tree")
    if flags.get("no_stem"):
        rec.advisories.append(f"plot_inventory: {flags['no_stem']} tree(s) with no stem fitted "
                              "(merged or occluded)")
    return inv, rec


def tree_qsm(cloud: "Cloud", *, remove_ground: bool = True, wood_method: Optional[str] = "ml",
             max_points: int = QSM_POINTS, seed: int = 0,
             **qsm_params: Any) -> Tuple["QSM", RecipeRecord]:
    """A QSM of ONE tree. Leaf-off trees are what QSMs are for: leaves are
    fitted as spurious branches, which is why the wood is kept first.

    ``cloud`` is not modified: ground and leaf are removed on extracted
    copies. Wood is separated with the ML model (wood IoU ~0.80, the app's
    default) rather than the API's ``sota`` default (~0.61); ``wood_method=None``
    skips it for a cloud that is already wood. The tree is thinned to
    ``max_points`` as the app does, deterministically from ``seed``.

    ``fork_symmetry`` (default 0.75): 0.6-0.7 for open-center trees,
    0.85-0.95 for a central leader. ``twig_radius_mm`` (4.23) anchors the
    radius taper. The returned QSM's ``metrics['trunk_diameter_mm']`` is in mm
    while cylinder ``radius`` is in m."""
    rec = _start("tree_qsm", cloud, {"remove_ground": remove_ground, "wood_method": wood_method,
                                     "max_points": max_points, "seed": seed, **qsm_params})
    owned: List["Cloud"] = []
    try:
        work = cloud
        if remove_ground:
            gp = {"auto_class_threshold": True}
            rec._step("segment_ground", gp, work.segment_ground(**gp))
            work = _extract(rec, work, {"ground_class": [NON_GROUND]}, "non-ground", owned)
        if wood_method is not None:
            rec._step("segment_wood", {"method": wood_method},
                      work.segment_wood(method=wood_method))
            work = _extract(rec, work, {"wood_class": [WOOD]}, "wood", owned)
        if len(work) > max_points:
            work = _thin(rec, work, max_points, seed, owned)
        q = work.qsm(**qsm_params)
        cov = np.array([c.get("surf_cov", np.nan) for c in q.cylinders], dtype=float)
        inferred = float(np.mean(cov < QSM_INFERRED_RADIUS_COVERAGE)) if len(cov) else 0.0
        rec._step("qsm", qsm_params, {"cylinders": len(q), "inferred_radius_fraction": inferred,
                                      "tree_height_m": q.metrics.get("tree_height_m"),
                                      "trunk_diameter_mm": q.metrics.get("trunk_diameter_mm")})
        if len(q) == 0:
            raise rec._fail("no cylinder was fitted: the crown is disconnected from the base "
                            "(over-cropped trunk, over-thinned, or a single view).")
        if inferred > 0.5:
            rec.advisories.append(f"tree_qsm: {inferred:.0%} of cylinder radii have surface "
                                  f"coverage under {QSM_INFERRED_RADIUS_COVERAGE} and come from "
                                  "the taper model, not the points")
        return q, rec
    finally:
        for c in owned:
            c.close()


def register_pair(moving: "Cloud", target: "Cloud", *, global_first: bool = True,
                  max_rmse_fraction: float = REGISTRATION_RMSE_FRACTION,
                  scene_type: str = "agriculture",
                  **icp_params: Any) -> Tuple["Registration", RecipeRecord]:
    """Move ``moving`` onto ``target``: a global search (no initial pose
    needed), then ICP. Judged by RMSE against the target's size - never by
    ``fitness``, which reads ~100% on a wrong alignment - and refused, with
    ``moving`` put back, when RMSE exceeds ``max_rmse_fraction`` of it.

    A "fits almost as well" advisory on a planted scene means a row-shifted
    pose may have won; the fix is a third overlapping scan, not a parameter."""
    rec = _start("register_pair", moving, {"global_first": global_first,
                                           "max_rmse_fraction": max_rmse_fraction,
                                           "scene_type": scene_type, **icp_params})
    total = np.eye(4)
    if global_first:
        g = moving.register_to(target, method="global", scene_type=scene_type)
        rec._step("register_global", {"scene_type": scene_type},
                  {"fitness": g.fitness, "rmse": g.rmse, "warning": g.warning})
        total = g.matrix @ total
    reg = moving.register_to(target, method="icp", **icp_params)
    rec._step("register_icp", icp_params, {"fitness": reg.fitness, "rmse": reg.rmse,
                                           "warning": reg.warning})
    total = reg.matrix @ total
    size = _diagonal(target)
    frac = (reg.rmse or 0.0) / size if size > 0 else float("inf")
    rec.steps[-1].summary["rmse_fraction"] = frac
    if reg.rmse is None or frac > max_rmse_fraction:
        moving.transform(np.linalg.inv(total))
        raise rec._fail(f"ICP RMSE {reg.rmse} is {frac:.2%} of the target's size (limit "
                        f"{max_rmse_fraction:.0%}); the clouds were not aligned and 'moving' was "
                        "put back. Crop to the overlap, or give an initial pose.")
    if reg.rmse == 0:
        rec.advisories.append("register_pair: zero RMSE can mean no overlap at all")
    # The matrix that took `moving` from where it started to where it is now.
    return _with_matrix(reg, total), rec


def herbaceous_organs(cloud: "Cloud", *, model_id: Optional[str] = None) -> RecipeRecord:
    """``plant_organ`` (1 soil, 2 stem, 3 leaf) and ``leaflet_id`` on ONE
    herbaceous dicot plant scanned at about 3 mm spacing or finer, soil or pot
    left in. Not for trees, grasses or cereals.

    Passes ``units="m"`` because an imported cloud is already in meters; the
    backend's ``auto`` reads anything over 30 units across as millimeters and
    cannot tell mm from cm between 30 and 300. Refuses a plant outside
    2 cm-5 m: that is a unit error at import (``source_units=``)."""
    rec = _start("herbaceous_organs", cloud, {"model_id": model_id})
    size = _diagonal(cloud)
    lo, hi = ORGAN_PLANT_SIZE_M
    if not lo <= size <= hi:
        raise rec._fail(f"the cloud is {size:.3g} m across, outside {lo}-{hi} m for one plant; "
                        "re-import with source_units='mm' or 'cm' if the file is not in meters.")
    params = {"units": "m", **({"model_id": model_id} if model_id else {})}
    rec._step("segment_organs", params, cloud.segment_organs(**params))
    organ = cloud.column("plant_organ")
    counts = {int(k): int(v) for k, v in zip(*np.unique(organ, return_counts=True))}
    leaflets = int(np.count_nonzero(np.unique(cloud.column("leaflet_id")) > 0))
    rec.steps[-1].summary.update({"organ_counts": counts, "leaflets": leaflets})
    if not counts.get(3):
        raise rec._fail("no leaf point was found; check the plant is a dicot and the spacing "
                        "is about 3 mm or finer")
    return rec


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
def _extract(rec: RecipeRecord, cloud: "Cloud", where: Dict[str, Any], what: str,
             owned: List["Cloud"]) -> "Cloud":
    child = cloud.extract(where=where, name=f"{cloud.name}-{what}")
    if child is None or len(child) == 0:
        raise rec._fail(f"no {what} points remain after {where}")
    owned.append(child)
    rec._step("extract", {"where": where}, {"points": len(child)})
    return child


def _thin(rec: RecipeRecord, cloud: "Cloud", n: int, seed: int, owned: List["Cloud"]) -> "Cloud":
    """A seeded uniform subsample, as a new cloud. Uniform rather than voxel:
    the QSM's own skeleton handles density, and this is reproducible exactly."""
    pts = cloud.positions
    keep = np.sort(np.random.default_rng(seed).choice(len(pts), size=n, replace=False))
    child = cloud._be.from_numpy(pts[keep], name=f"{cloud.name}-thin")
    owned.append(child)
    rec._step("thin", {"to": n, "seed": seed, "from": len(pts)}, {"points": len(child)})
    return child


def _diagonal(cloud: "Cloud") -> float:
    p = cloud.positions
    return float(np.linalg.norm(p.max(0) - p.min(0))) if len(p) else 0.0


def _with_matrix(reg: "Registration", m: np.ndarray) -> "Registration":
    from dataclasses import replace
    return replace(reg, matrix=m)


def _merge(rec: RecipeRecord, sub: RecipeRecord) -> None:
    rec.steps.extend(Step(f"{sub.recipe}.{s.op}", s.params, s.summary) for s in sub.steps)
    rec.advisories.extend(sub.advisories)


_ADVISORY_KEYS = ("warning", "warnings", "quality_warning", "advisories")


def _advisories(res: Any, op: str) -> List[str]:
    if not isinstance(res, dict):
        return []
    out: List[str] = []
    for k in _ADVISORY_KEYS:
        v = res.get(k)
        if isinstance(v, str) and v:
            out.append(f"{op}: {v}")
        elif isinstance(v, (list, tuple)):
            out.extend(f"{op}: {w}" for w in v if w)
    return out


def _summary(res: Any) -> Dict[str, Any]:
    """The scalar fields of a response (counts, flags, timings): a per-point
    payload is a list or array and never enters the record."""
    if not isinstance(res, dict):
        return {}
    return {k: v for k, v in res.items()
            if k not in _ADVISORY_KEYS
            and isinstance(v, (int, float, str, bool, type(None)))}


def _jsonable(x: Any) -> Any:
    if isinstance(x, dict):
        return {str(k): _jsonable(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_jsonable(v) for v in x]
    if isinstance(x, np.generic):
        return x.item()
    if isinstance(x, np.ndarray):
        return x.tolist()
    return x
