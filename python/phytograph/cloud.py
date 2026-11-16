"""`Cloud`: a handle on one backend cloud session."""
from __future__ import annotations

import io
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple, Union

import numpy as np

from ._tools import body_for, checked_tool
from .errors import PhytographError

if TYPE_CHECKING:  # pragma: no cover
    from .backend import Backend
    from .results import DEM, QSM, Inventory, Mesh, Registration, Skeleton

PathLike = Union[str, Path]
# A scalar filter: (lo, hi) inclusive range, or a list/set of class ids.
FieldFilter = Union[Tuple[float, float], Sequence[int], set]

_EXPORT_FORMATS = {".las": "las", ".laz": "laz", ".xyz": "xyz", ".txt": "txt",
                   ".csv": "csv", ".ply": "ply"}


class Cloud:
    """A point cloud living in the backend as an in-RAM session.

    Coordinates are TRUE WORLD coordinates everywhere in this API — what you
    pass to :meth:`crop` and :meth:`transform`, and what :meth:`to_numpy` and
    :meth:`export` give back. (The backend stores positions with an import-time
    ``world_shift`` subtracted for float precision; this class converts.)

    Sky/miss points (rays that hit nothing) are excluded from every read and
    compute by default, as in the app. :meth:`to_numpy` includes them with
    ``include_misses=True``; :meth:`export` always writes them, so a round trip
    keeps everything that was imported.

    ``intensity`` is 0-1 everywhere in this API (reads and filters alike).
    """

    def __init__(self, backend: "Backend", session_id: str, *, info: Optional[Dict[str, Any]] = None,
                 name: Optional[str] = None):
        self._be = backend
        self.session_id = session_id
        self.name = name or session_id[:8]
        self._import_info = info or {}
        self._info: Optional[Dict[str, Any]] = None

    # -- introspection -----------------------------------------------------
    def info(self, refresh: bool = True) -> Dict[str, Any]:
        """Counts, columns and frame. See ``GET /api/cloud/session/{id}/info``."""
        if refresh or self._info is None:
            self._info = self._t.get_json(f"/api/cloud/session/{self.session_id}/info")
        return self._info

    @property
    def import_info(self) -> Dict[str, Any]:
        """What the backend reported at import (robust extent, point spacing,
        detected misses, warnings …). Empty for a handle made from an id."""
        return dict(self._import_info)

    @property
    def world_shift(self) -> np.ndarray:
        shift = self.info(refresh=False).get("world_shift")
        return np.zeros(3) if shift is None else np.asarray(shift, dtype=np.float64)

    @property
    def columns(self) -> List[str]:
        """Per-point scalar columns readable with :meth:`column` and usable in
        ``where=`` filters (``intensity``, ``timestamp``, ``ground_class``, …)."""
        return list(self.info().get("columns", []))

    def __len__(self) -> int:
        """Points every compute tool sees: live (not deleted) hits."""
        return int(self.info()["hit_count"])

    def __repr__(self) -> str:
        try:
            n = len(self)
        except Exception:  # noqa: BLE001
            n = "?"
        return f"<phytograph.Cloud {self.name!r} {n} points session={self.session_id[:8]}>"

    # -- reading -----------------------------------------------------------
    def to_numpy(self, *, include_misses: bool = False, fields: Optional[Iterable[str]] = None,
                 colors: bool = True) -> Dict[str, np.ndarray]:
        """The live points as arrays: ``positions`` (N,3) float64 world
        coordinates, plus ``colors`` (N,3, 0-1) and ``intensity`` (0-1) when
        present, and each scalar column under its name — all row-aligned.

        A scalar column comes back in the type its source file declared (a PLY
        ``int`` is int32, a LAS ``double`` float64), else int32 for whole
        numbers, so the same column has the same dtype from every file.

        ``fields`` limits the scalar columns returned (``[]`` for none)."""
        params: Dict[str, Any] = {"include_misses": include_misses, "colors": colors}
        if fields is not None:
            names = list(fields)
            if names:
                params["fields"] = ",".join(names)
            else:
                params["extras"] = False
        resp = self._t.get_bytes(f"/api/cloud/session/{self.session_id}/arrays", **params)
        with np.load(io.BytesIO(resp.content), allow_pickle=False) as z:
            return {k: z[k] for k in z.files}

    @property
    def positions(self) -> np.ndarray:
        """(N,3) float64 world coordinates of the live hits."""
        return self.to_numpy(fields=[], colors=False)["positions"]

    def column(self, name: str, *, include_misses: bool = False) -> np.ndarray:
        """One scalar column, row-aligned with :attr:`positions`."""
        return self.to_numpy(fields=[name], colors=False, include_misses=include_misses)[name]

    # -- editing (in place; returns self for chaining) -----------------------
    def _session_region(self, lo: Sequence[float], hi: Sequence[float]) -> Dict[str, List[float]]:
        s = self.world_shift
        lo_a, hi_a = np.asarray(lo, float) - s, np.asarray(hi, float) - s
        if lo_a.shape != (3,) or hi_a.shape != (3,):
            raise ValueError("box corners must be [x, y, z]")
        return {"min": np.minimum(lo_a, hi_a).tolist(), "max": np.maximum(lo_a, hi_a).tolist()}

    # The backend filters intensity on its stored LAS uint16 scale; reads hand it
    # back as 0-1. Filters take 0-1 too, so one number means one thing.
    _INTENSITY_SCALE = 65535.0

    @classmethod
    def _scalar_filters(cls, where: Optional[Mapping[str, FieldFilter]]) -> List[Dict[str, Any]]:
        out = []
        for slug, cond in (where or {}).items():
            scale = cls._INTENSITY_SCALE if slug == "intensity" else 1.0
            if isinstance(cond, tuple) and len(cond) == 2:
                lo, hi = cond
                f: Dict[str, Any] = {"slug": slug}
                if lo is not None:
                    f["min"] = float(lo) * scale
                if hi is not None:
                    f["max"] = float(hi) * scale
                out.append(f)
            elif slug == "intensity":
                raise ValueError("filter intensity with a (lo, hi) range in 0-1, not class values")
            else:
                out.append({"slug": slug, "values": [int(v) for v in cond]})
        return out

    def _predicate(self, box: Optional[Tuple[Sequence[float], Sequence[float]]], invert: bool,
                   where: Optional[Mapping[str, FieldFilter]]) -> Dict[str, Any]:
        body: Dict[str, Any] = {}
        if box is not None:
            body["region"] = {"kind": "box", **self._session_region(*box), "invert": bool(invert)}
        elif invert:
            raise ValueError("invert applies to a box")
        filters = self._scalar_filters(where)
        if filters:
            body["scalar_filters"] = filters
        if not body:
            raise ValueError("give a box and/or `where` filters")
        return body

    def crop(self, min: Sequence[float], max: Sequence[float], *, invert: bool = False) -> "Cloud":
        """Keep the points inside the world-coordinate box (outside, if
        ``invert``); delete the rest."""
        return self.filter(box=(min, max), invert=invert)

    def filter(self, *, box: Optional[Tuple[Sequence[float], Sequence[float]]] = None,
               invert: bool = False, where: Optional[Mapping[str, FieldFilter]] = None) -> "Cloud":
        """Keep points passing the box AND every ``where`` filter; delete the rest.

        ``where={"intensity": (0.2, None), "ground_class": [1]}`` keeps intensity
        ≥ 0.2 among class-1 points (a tuple is an inclusive range, ``None`` an
        open end; a list is a set of class ids)."""
        body = self._predicate(box, invert, where)
        # A script has no octree to look at: skip the PotreeConverter rebuild.
        body["rebuild"] = False
        res = self._t.post_stream(f"/api/cloud/session/{self.session_id}/filter", body)
        self._info = None
        if isinstance(res, dict) and res.get("point_count") == 0 and not res.get("rebuilt", True):
            raise PhytographError("filter would remove every point; the cloud is unchanged",
                                  detail=res)
        return self

    def extract(self, *, box: Optional[Tuple[Sequence[float], Sequence[float]]] = None,
                invert: bool = False, where: Optional[Mapping[str, FieldFilter]] = None,
                name: Optional[str] = None) -> Optional["Cloud"]:
        """A NEW cloud of the selected points; this one is unchanged. ``None``
        when nothing is selected."""
        body = self._predicate(box, invert, where)
        res = self._t.post_json(f"/api/cloud/session/{self.session_id}/extract", body)
        child = (res or {}).get("extracted")
        if not child:
            return None
        return Cloud(self._be, child["session_id"], info=child, name=name or f"{self.name}-extract")

    def split(self, column: str, *, exclude: Optional[Iterable[int]] = (0,),
              include_misses: bool = False) -> Dict[int, "Cloud"]:
        """One new cloud per distinct value of an integer ``column`` (e.g.
        ``tree_instance`` → one cloud per tree). Values in ``exclude`` are
        skipped (default 0 = unassigned/ground/miss). This cloud is unchanged."""
        body: Dict[str, Any] = {"slug": column, "include_misses": include_misses}
        if exclude is not None:
            body["exclude_values"] = [int(v) for v in exclude]
        res = self._t.post_stream(f"/api/cloud/session/{self.session_id}/extract_by_column", body)
        if isinstance(res, dict) and res.get("error"):
            raise PhytographError(f"split by {column!r} failed: {res['error']}", detail=res)
        out: Dict[int, Cloud] = {}
        for child in (res or {}).get("children", []):
            v = int(child["value"])
            out[v] = Cloud(self._be, child["session_id"], info=child, name=f"{self.name}-{column}-{v}")
        return out

    def transform(self, matrix: Union[np.ndarray, Sequence[float]]) -> "Cloud":
        """Apply a 4x4 affine (rigid or rigid+scale, positive determinant) in
        world coordinates, in place."""
        m = np.asarray(matrix, dtype=np.float64)
        if m.shape == (16,):
            m = m.reshape(4, 4)
        if m.shape != (4, 4):
            raise ValueError("matrix must be 4x4 (or 16 row-major floats)")
        # "none": move the geometry and build nothing — a script never looks at
        # the octree, and "pose" falls back to a full reconvert once a filter
        # has left the octree stale.
        self._t.post_json(f"/api/cloud/session/{self.session_id}/transform",
                          {"matrix": m.ravel().tolist(), "octree_mode": "none"})
        self._info = None
        return self

    def translate(self, dx: float, dy: float, dz: float) -> "Cloud":
        m = np.eye(4)
        m[:3, 3] = (dx, dy, dz)
        return self.transform(m)

    # -- analysis tools ------------------------------------------------------
    #
    # Each writes its per-point result as a COLUMN on this cloud (as in the app)
    # and returns a summary. Parameters you leave out take the app's defaults:
    # for ground, DEM and tree segmentation those are seeded from this cloud's
    # extent exactly as the app's panels seed them (see `defaults()`).
    # Sky/miss points are never fed to any tool here except LAD.

    def defaults(self) -> Dict[str, Any]:
        """Extent-seeded parameters for ``ground``, ``dem`` and ``trees``, as
        the app would pre-fill its panels for this cloud, plus the measured
        ``robust_extent`` and ``point_spacing``."""
        return self._t.get_json(f"/api/cloud/session/{self.session_id}/defaults")

    def _post_tool(self, tool: str, body: Dict[str, Any], *, stream: bool = False) -> Any:
        path = f"/api/cloud/session/{self.session_id}/{tool}"
        res = self._t.post_stream(path, body) if stream else self._t.post_json(path, body)
        self._info = None
        if isinstance(res, dict) and res.get("success") is False:
            raise PhytographError(f"{tool} failed: {res.get('error')}", detail=res)
        return res

    @staticmethod
    def _given(**kw: Any) -> Dict[str, Any]:
        return {k: v for k, v in kw.items() if v is not None}

    def compute_normals(self, *, k: Optional[int] = None, radius: Optional[float] = None,
                        orientation: Optional[str] = None,
                        viewpoint: Optional[Sequence[float]] = None) -> Dict[str, Any]:
        """Per-point normals → columns ``nx, ny, nz, curvature, verticality``.
        ``orientation``: ``"origin"`` (toward the scanner/viewpoint, default),
        ``"up"``, … as in the app."""
        body = self._given(k=k, radius=radius, orientation=orientation,
                           viewpoint=None if viewpoint is None else [float(v) for v in viewpoint])
        return self._post_tool("compute_normals", {**body, "defer_octree": True})

    def segment_ground(self, *, cloth_resolution: Optional[float] = None,
                       class_threshold: Optional[float] = None, rigidness: Optional[int] = None,
                       slope_smooth: Optional[bool] = None, iterations: Optional[int] = None,
                       auto_class_threshold: bool = False) -> Dict[str, Any]:
        """Cloth-simulation ground filter → column ``ground_class``
        (:data:`phytograph.GROUND` = 1, :data:`phytograph.NON_GROUND` = 2).
        ``auto_class_threshold=True`` measures the tolerance from the data."""
        seeded = self.defaults()["ground"]
        body = {**seeded, **self._given(cloth_resolution=cloth_resolution,
                                        class_threshold=class_threshold, rigidness=rigidness,
                                        slope_smooth=slope_smooth, iterations=iterations)}
        body["auto_class_threshold"] = bool(auto_class_threshold)
        return self._post_tool("segment_ground", {**body, "defer_octree": True})

    def dem(self, *, cell_size: Optional[float] = None, surface: str = "dtm",
            method: str = "tin", fill_voids: bool = False, add_height_column: bool = False,
            ground_percentile: Optional[float] = None,
            bbox: Optional[Sequence[float]] = None) -> "DEM":
        """A terrain (``surface="dtm"``) or surface (``"dsm"``) model, using
        ``ground_class`` when present (ground is segmented first otherwise).
        ``add_height_column=True`` also writes ``height_above_ground``.
        ``bbox`` ([minx, miny, maxx, maxy], world coordinates) sets the grid;
        points outside it are ignored."""
        from .results import DEM, Mesh
        body: Dict[str, Any] = {
            "cell_size": cell_size if cell_size is not None else self.defaults()["dem"]["cell_size"],
            "surface_type": surface, "method": method, "fill_voids": fill_voids,
            "add_height_column": add_height_column}
        if ground_percentile is not None:
            body["ground_percentile"] = float(ground_percentile)
        if bbox is not None:
            s = self.world_shift
            b = [float(v) for v in bbox]
            body["bbox"] = [b[0] - s[0], b[1] - s[1], b[2] - s[0], b[3] - s[1]]
        meta, bufs = self._post_tool("dem", body, stream=True)
        if not meta.get("success", True):
            raise PhytographError(f"dem failed: {meta.get('error')}", detail=meta)
        shift = np.asarray(meta.get("world_shift") or [0.0, 0.0, 0.0], dtype=np.float64)
        nx, ny = int(meta["grid_nx"]), int(meta["grid_ny"])
        z = bufs["grid_z"].astype(np.float64).reshape(ny, nx) + shift[2]
        layers = {k[len("layer_grid_"):]: v.astype(np.float64).reshape(ny, nx)
                  for k, v in bufs.items() if k.startswith("layer_grid_")}
        mesh = Mesh._from_frame(meta, bufs, shift) if "vertices" in bufs else None
        return DEM(z=z, origin=np.asarray(meta["grid_origin"], dtype=np.float64) + shift[:2],
                   cell_size=float(meta["grid_cell"]), mesh=mesh, layers=layers,
                   crs_epsg=self.info(refresh=False).get("crs_epsg"), raw=meta, _backend=self._be)

    def detect_stems(self, *, band_min_m: Optional[float] = None, band_max_m: Optional[float] = None,
                     max_diameter_m: Optional[float] = None) -> np.ndarray:
        """Trunk positions found in the breast-height layer, as (N,3) world
        points — usable as ``seeds`` for :meth:`segment_trees`. Needs the
        ``height_above_ground`` column: run ``dem(add_height_column=True)``
        first."""
        res = self._t.post_json(f"/api/cloud/session/{self.session_id}/detect_stems",
                                self._given(band_min_m=band_min_m, band_max_m=band_max_m,
                                            max_diameter_m=max_diameter_m))
        seeds = res.get("seeds") or []
        pts = [[s["x"], s["y"], s["z"]] if isinstance(s, dict) else s for s in seeds]
        # The backend reports seeds in the session's stored frame (world_shift
        # subtracted), where the app's viewer uses them; this API is world.
        return np.asarray(pts, dtype=np.float64).reshape(-1, 3) + self.world_shift

    # The keywords each method uses on its own; keywords in no entry apply to
    # every method. Checked by `checked_tool` and pinned against the backend's
    # request models by backend-api/tests/test_scripting_client_signatures.py.
    _TREES_BY_METHOD = {
        "treeiso": ("reg_strength1", "min_nn1", "decimate_res1", "reg_strength2", "min_nn2",
                    "decimate_res2", "max_gap", "rel_height_length_ratio", "vertical_weight",
                    "min_nn3", "score_candidate_thresh", "init_stem_rel_length_thresh",
                    "max_outlier_gap"),
        "chm": ("chm_cell", "chm_min_height", "chm_crown_scale"),
    }

    @checked_tool(method_arg="method", by_method=_TREES_BY_METHOD)
    def segment_trees(self, *, method: str = "treeiso", seeds: Optional[np.ndarray] = None,
                      reg_strength1: float = 1.0, min_nn1: int = 5,
                      decimate_res1: Optional[float] = None,
                      reg_strength2: float = 15.0, min_nn2: int = 20,
                      decimate_res2: Optional[float] = None, max_gap: Optional[float] = None,
                      rel_height_length_ratio: float = 0.5, vertical_weight: float = 0.5,
                      min_nn3: int = 20, score_candidate_thresh: float = 0.7,
                      init_stem_rel_length_thresh: float = 1.5,
                      max_outlier_gap: Optional[float] = None,
                      tiling: str = "auto", tile_buffer_m: float = 10.0,
                      chm_cell: Optional[float] = None, chm_min_height: float = 2.0,
                      chm_crown_scale: float = 2.5) -> Dict[str, Any]:
        """Individual trees → column ``tree_instance`` (0 = ground or unassigned).

        Run :meth:`segment_ground` first; ground points are left out. Re-running
        renumbers the trees.

        Parameters
        ----------
        method : {"treeiso", "chm"}
            ``treeiso`` for terrestrial or mobile scans with visible trunks;
            ``chm`` (canopy-height watershed) for airborne scans or closed canopy.
        seeds : (N, 3) array, optional
            World points, one per tree, e.g. from :meth:`detect_stems`. Each seed
            yields one tree. Seeds can join segments but cannot split them.
        reg_strength1, min_nn1, decimate_res1 : TreeIso stage 1 (fine clustering)
            ``decimate_res1`` (m) is the stage-1 voxel; ``None`` seeds it from
            the cloud's extent as the app does (0.05 m on a small plot).
        reg_strength2, min_nn2, decimate_res2 : TreeIso stage 2 (segment merging)
            Raise ``reg_strength2`` when a tree comes back in pieces.
            ``decimate_res2`` (m): ``None`` seeds it from the extent (0.1 m).
        max_gap : float, optional
            Largest void (m) a limb may cross to rejoin its tree. ``None`` seeds
            it from the extent (2.0 m on a small plot). Lower it (after
            ``max_outlier_gap``) when trees merge.
        rel_height_length_ratio, vertical_weight, min_nn3, score_candidate_thresh,
        init_stem_rel_length_thresh : TreeIso stage 3 (stem candidates)
            Defaults are Xi & Hopkinson (2022).
        max_outlier_gap : float, optional
            Distance (m) beyond which a body is split off its instance as another
            tree. Must stay BELOW ``max_gap`` or nothing separates. ``None`` =
            0.65 m clamped to ``max_gap``. Lower it first when trees merge.
        tiling : {"auto", "on", "off"}
            Tile large plots; ``auto`` tiles above the voxel guideline.
        tile_buffer_m : float
            Tile overlap (m); must exceed any crown's reach.
        chm_cell : float, optional
            CHM cell (m); ``None`` = ``chm_crown_scale / 12``.
        chm_min_height : float
            Canopy lower than this (m) is not a tree.
        chm_crown_scale : float
            Roughly the width (m) of the SMALLER crowns, not the trunk spacing.
            Err low: too large merges neighboring crowns.
        """
        body: Dict[str, Any] = {"method": method}
        if method == "treeiso":
            body.update(self.defaults()["trees"])
        body.update(body_for(self._TREES_BY_METHOD, method, dict(
            reg_strength1=reg_strength1, min_nn1=min_nn1, decimate_res1=decimate_res1,
            reg_strength2=reg_strength2, min_nn2=min_nn2, decimate_res2=decimate_res2,
            max_gap=max_gap, rel_height_length_ratio=rel_height_length_ratio,
            vertical_weight=vertical_weight, min_nn3=min_nn3,
            score_candidate_thresh=score_candidate_thresh,
            init_stem_rel_length_thresh=init_stem_rel_length_thresh,
            max_outlier_gap=max_outlier_gap, tiling=tiling, tile_buffer_m=tile_buffer_m,
            chm_cell=chm_cell, chm_min_height=chm_min_height, chm_crown_scale=chm_crown_scale)))
        if seeds is not None:
            # World in, stored frame out: TreeIso matches seeds against the
            # session's stored positions.
            body["seed_points"] = (np.asarray(seeds, dtype=float).reshape(-1, 3)
                                   - self.world_shift).tolist()
        return self._post_tool("segment_trees", body)

    _WOOD_GEOMETRIC = ("k_min", "k_max", "k_step", "wood_bias", "reg_k", "reg_iters",
                       "min_speckle", "branch_grow_sph", "voxel_size", "scalar_slug",
                       "reflectance_weight_max")
    _WOOD_BY_METHOD = {
        "sota": _WOOD_GEOMETRIC,
        "connectivity": _WOOD_GEOMETRIC + ("backbone_support",),
        "geometric": _WOOD_GEOMETRIC,
        "ml": ("model_id",),
    }

    @checked_tool(method_arg="method", by_method=_WOOD_BY_METHOD)
    def segment_wood(self, *, method: str = "sota", model_id: Optional[str] = None,
                     wood_bias: float = 0.6, k_min: int = 10, k_max: int = 100, k_step: int = 10,
                     reg_k: int = 20, reg_iters: int = 3, min_speckle: int = 0,
                     branch_grow_sph: float = 0.02, voxel_size: float = 0.0,
                     backbone_support: float = 0.0, scalar_slug: Optional[str] = None,
                     reflectance_weight_max: float = 0.4) -> Dict[str, Any]:
        """Wood/leaf separation → column ``wood_class`` (:data:`WOOD` = 1,
        :data:`LEAF` = 2). Run it before any QSM or skeleton, and before thinning.

        Parameters
        ----------
        method : {"sota", "connectivity", "geometric", "ml"}
            ``ml`` is the app's default and the most accurate (wood IoU ~0.80 vs
            ~0.61 for ``sota``). ``sota`` and ``connectivity`` root at the lowest
            points, so remove the ground first; ``geometric`` when the ground
            cannot be removed cleanly; ``connectivity`` keeps twigs, which a QSM
            wants.
        model_id : str, optional
            ``ml`` only: which trained model; ``None`` = the bundled default.
        wood_bias : float
            Wood-vs-leaf sensitivity. LOWER calls more points wood.
        k_min, k_max, k_step : int
            Neighborhood sizes searched for each point's local shape.
        reg_k, reg_iters : int
            Label smoothing: neighbors and passes. More passes = smoother labels.
        min_speckle : int
            Wood clusters smaller than this many points become leaf (0 = keep all).
        branch_grow_sph : float
            Reach (m) for growing branches from the wood backbone.
        voxel_size : float
            > 0 classifies a voxel-thinned copy and propagates labels back (m);
            for very large clouds. 0 = every point.
        backbone_support : float
            ``connectivity`` only: support floor of the backbone; 0 = automatic.
        scalar_slug : str, optional
            Column used as the reflectance assist (default ``reflectance``, then
            ``intensity``, when present).
        reflectance_weight_max : float
            Cap on the reflectance assist's weight; 0 turns it off.
        """
        body = {"method": method, **body_for(self._WOOD_BY_METHOD, method, dict(
            model_id=model_id, wood_bias=wood_bias, k_min=k_min, k_max=k_max, k_step=k_step,
            reg_k=reg_k, reg_iters=reg_iters, min_speckle=min_speckle,
            branch_grow_sph=branch_grow_sph, voxel_size=voxel_size,
            backbone_support=backbone_support, scalar_slug=scalar_slug,
            reflectance_weight_max=reflectance_weight_max))}
        return self._post_tool("segment_wood", {**body, "defer_octree": True})

    def segment_organs(self, *, units: str = "auto", model_id: Optional[str] = None) -> Dict[str, Any]:
        """Plant organ segmentation (ML) → columns ``plant_organ``, ``leaflet_id``."""
        return self._post_tool("segment_organs", self._given(units=units, model_id=model_id))

    _DENOISE_BY_METHOD = {
        "ror": ("radius", "nb_points"),
        "voxel_count": ("voxel", "min_points"),
        "sor": ("nb_neighbors", "std_ratio"),
    }

    @checked_tool(method_arg="method", by_method=_DENOISE_BY_METHOD)
    def denoise(self, *, method: str = "ror", radius: Optional[float] = None,
                nb_points: Optional[int] = None, voxel: Optional[float] = None,
                min_points: Optional[int] = None, nb_neighbors: Optional[int] = None,
                std_ratio: Optional[float] = None) -> Dict[str, Any]:
        """Flag outliers → column ``noise_class`` (:data:`NOISE` = 2). Points are
        not deleted; follow with ``filter(where={"noise_class": [pg.NOISE_CLEAN]})``.

        Every parameter left as ``None`` is derived from the cloud's own point
        spacing. Real scanner noise is 0.1-3% of points.

        Parameters
        ----------
        method : {"ror", "voxel_count", "sor"}
            ``ror`` (radius outlier removal) per scan, before registering.
            ``sor`` (statistical) removes more on every pass, so run it once.
            ``voxel_count`` flags points in sparsely occupied voxels.
        radius : float, optional
            ``ror``: neighbor search radius (m). Larger flags less.
        nb_points : int, optional
            ``ror``: neighbors a point needs inside ``radius``. More flags more.
        voxel : float, optional
            ``voxel_count``: voxel size (m).
        min_points : int, optional
            ``voxel_count``: points a voxel needs to be kept. More flags more.
        nb_neighbors : int, optional
            ``sor``: neighbors in the mean-distance statistic.
        std_ratio : float, optional
            ``sor``: standard deviations beyond which a point is noise (4.0 when
            ``None``). Lower flags more.
        """
        return self._post_tool("denoise", {"method": method, **body_for(
            self._DENOISE_BY_METHOD, method, dict(
                radius=radius, nb_points=nb_points, voxel=voxel, min_points=min_points,
                nb_neighbors=nb_neighbors, std_ratio=std_ratio))})

    @checked_tool()
    def tree_inventory(self, *, breast_height_m: float = 1.3, fit_method: str = "ransac",
                       slice_thickness_m: Optional[float] = None,
                       inlier_distance_m: Optional[float] = None,
                       stem_curve_step_m: Optional[float] = None,
                       voxel_size_m: Optional[float] = None, crown_gap_m: Optional[float] = None,
                       tree_ids: Optional[Iterable[int]] = None, min_points: int = 50,
                       competition_radius_m: float = 6.0) -> "Inventory":
        """DBH, height, stem curve, crown and stand metrics for every tree in
        ``tree_instance`` (run :meth:`segment_trees` first, and the DEM with
        ``add_height_column=True`` so heights are above the ground).

        Read each tree's ``flags``: ``partial_arc`` is normal for one scan;
        ``few_points`` and ``high_residual`` mean a doubtful DBH; ``no_stem``
        means merged or occluded.

        Parameters
        ----------
        breast_height_m : float
            Height of the DBH slice (m). US convention is 1.37.
        fit_method : {"ransac", "hough"}
            Circle fit for the stem slices.
        slice_thickness_m : float, optional
            Thickness of each stem slice (m); ``None`` = 0.10. Thicker slices
            take more points but blur taper and lean.
        inlier_distance_m : float, optional
            Circle-fit inlier band (m); ``None`` = 0.02.
        stem_curve_step_m : float, optional
            Vertical step of the stem curve (m); ``None`` = 0.5.
        voxel_size_m : float, optional
            Voxel for crown volume (m); ``None`` = 0.10.
        crown_gap_m : float, optional
            Vertical gap (m) that separates the crown from the stem below it;
            ``None`` = 1.0.
        tree_ids : iterable of int, optional
            Measure only these ``tree_instance`` ids; ``None`` = every tree.
        min_points : int
            Trees with fewer points are skipped (and counted).
        competition_radius_m : float
            Search radius (m) of Hegyi's competition index.
        """
        from .results import Inventory
        body = Cloud._given(
            breast_height_m=breast_height_m, fit_method=fit_method,
            slice_thickness_m=slice_thickness_m, inlier_distance_m=inlier_distance_m,
            stem_curve_step_m=stem_curve_step_m, voxel_size_m=voxel_size_m,
            crown_gap_m=crown_gap_m, min_points=min_points,
            competition_radius_m=competition_radius_m,
            tree_ids=None if tree_ids is None else [int(t) for t in tree_ids])
        res = self._post_tool("tree_inventory", body, stream=True)
        return Inventory(trees=list(res.get("trees") or []), stem_curve=list(res.get("stem_curve") or []),
                         stand=dict(res.get("stand") or {}), warnings=list(res.get("warnings") or []),
                         raw=res)

    @checked_tool()
    def tree_qsms(self, *, tree_ids: Optional[Iterable[int]] = None,
                  max_points_per_tree: int = 60000, wood_only: bool = True,
                  include_models: bool = True, twig_radius_mm: float = 4.23,
                  w_growthlength: float = 1.0, w_area: float = 0.0, w_colinear: float = 0.0,
                  axis_termination: bool = True, fork_symmetry: float = 0.75) -> Dict[int, "QSM"]:
        """One QSM per segmented tree, ``{tree_id: QSM}``.

        A tree whose QSM fails is left out of the result and named in a Python
        *warning* with the backend's reason, so catch warnings when counting.

        Parameters
        ----------
        tree_ids : iterable of int, optional
            Only these ``tree_instance`` ids; ``None`` = every tree.
        max_points_per_tree : int
            A larger tree is voxel-thinned to this many points first.
        wood_only : bool
            Use only ``wood_class == WOOD`` points when the column exists.
        include_models : bool
            Return each tree's cylinders; ``False`` returns metrics only.
        twig_radius_mm, w_growthlength, w_area, w_colinear, axis_termination, fork_symmetry
            As in :meth:`qsm`.
        """
        from .results import QSM
        body = Cloud._given(
            max_points_per_tree=max_points_per_tree, wood_only=wood_only,
            include_models=include_models, twig_radius_mm=twig_radius_mm,
            w_growthlength=w_growthlength, w_area=w_area, w_colinear=w_colinear,
            axis_termination=axis_termination, fork_symmetry=fork_symmetry,
            tree_ids=None if tree_ids is None else [int(t) for t in tree_ids])
        res = self._post_tool("tree_qsm", body, stream=True)
        out: Dict[int, QSM] = {}
        for r in res.get("results") or []:
            if not r.get("success"):
                import warnings
                from .advisories import QSMFailedWarning
                warnings.warn(f"QSM failed for tree {r.get('tree_id')}: {r.get('error')}",
                              QSMFailedWarning, stacklevel=3)  # past checked_tool
                continue
            out[int(r["tree_id"])] = QSM(cylinders=list(r.get("cylinders") or []),
                                         shoots=list(r.get("shoots") or []),
                                         metrics=dict(r.get("metrics") or {}),
                                         tree_id=int(r["tree_id"]), raw=r)
        return out

    def _source(self) -> Dict[str, Any]:
        return {"session_id": self.session_id}

    @checked_tool()
    def qsm(self, *, twig_radius_mm: float = 4.23, w_growthlength: float = 1.0,
            w_area: float = 0.0, w_colinear: float = 0.0, axis_termination: bool = True,
            fork_symmetry: float = 0.75) -> "QSM":
        """A QSM of this whole cloud as ONE tree (cylinders + metrics).

        Not thinned: the backend refuses above 3 000 000 points, and the app
        thins to ~60 000 first (``recipes.tree_qsm`` does all of this). Separate
        wood first; leaves are fitted as spurious branches.
        ``metrics["trunk_diameter_mm"]`` is in mm, cylinder ``radius`` in m.

        Parameters
        ----------
        twig_radius_mm : float
            Measured twig radius (mm) the radius taper is anchored to at the
            tips. 4.23 is rTwig's published example; set the species' own.
        w_growthlength, w_area, w_colinear : float
            Weights of the rule choosing which child continues an axis (growth
            length, area, colinearity). The validated default is (1, 0, 0).
        axis_termination : bool
            Let an axis end at a codominant fork (a headed tree's trunk stops at
            the head).
        fork_symmetry : float
            Sibling-radius ratio at which a fork counts as codominant. 0.6-0.7
            for open-center trees, 0.85-0.95 for a central leader. A trunk
            running up a scaffold means lower it; a leader cut short means
            raise it.
        """
        from .results import QSM
        res = self._t.post_stream("/api/qsm/build", {
            "source": self._source(), "twig_radius_mm": twig_radius_mm,
            "w_growthlength": w_growthlength, "w_area": w_area, "w_colinear": w_colinear,
            "axis_termination": axis_termination, "fork_symmetry": fork_symmetry})
        if not res.get("success"):
            raise PhytographError(f"qsm failed: {res.get('error')}", detail=res)
        return QSM(cylinders=list(res.get("cylinders") or []), shoots=list(res.get("shoots") or []),
                   metrics=dict(res.get("metrics") or {}), raw=res)

    @checked_tool()
    def skeleton(self, *, search_radius: float = 0.05, threshold_filter: int = 30,
                 max_neighbors: int = 20, root_threshold: float = 0.02,
                 quantization_levels: int = 60, use_nonlinear_quantization: bool = True,
                 use_proportion_filter: bool = True, proportion_threshold: float = 0.1,
                 remove_outliers: bool = True, outlier_nb_neighbors: int = 20,
                 outlier_std_ratio: float = 2.0, smooth_skeleton: bool = True,
                 smoothing_iterations: int = 2) -> "Skeleton":
        """A curve skeleton of this cloud (one tree or plant). Separate wood
        first. ``branch_orders`` are Strahler orders counted from the tips, not
        QSM ranks.

        Parameters
        ----------
        search_radius : float
            Neighbor radius (m) of the graph. 0 = automatic from the point
            spacing (the app's default). Raise it when branches are missing.
        threshold_filter : int
            Minimum points per block (the app uses 5). Raise it to remove
            spurs; lower it when branches are missing.
        max_neighbors : int
            Neighbors per point in the graph.
        root_threshold : float
            Height (m) above the lowest point that counts as the root.
        quantization_levels : int
            Number of geodesic-distance bands. More = finer skeleton.
        use_nonlinear_quantization : bool
            Square-root banding, for more detail in the branches.
        use_proportion_filter, proportion_threshold
            Drop child blocks smaller than this fraction of their parent.
        remove_outliers, outlier_nb_neighbors, outlier_std_ratio
            Statistical outlier removal before building the graph.
        smooth_skeleton, smoothing_iterations
            Laplacian smoothing passes of the result.
        """
        from .results import Skeleton
        res = self._t.post_json("/api/skeleton/extract", {"source": self._source(), **dict(
            search_radius=search_radius, threshold_filter=threshold_filter,
            max_neighbors=max_neighbors, root_threshold=root_threshold,
            quantization_levels=quantization_levels,
            use_nonlinear_quantization=use_nonlinear_quantization,
            use_proportion_filter=use_proportion_filter,
            proportion_threshold=proportion_threshold, remove_outliers=remove_outliers,
            outlier_nb_neighbors=outlier_nb_neighbors, outlier_std_ratio=outlier_std_ratio,
            smooth_skeleton=smooth_skeleton, smoothing_iterations=smoothing_iterations)})
        if not res.get("success"):
            raise PhytographError(f"skeleton failed: {res.get('error')}", detail=res)
        pts = np.asarray(res.get("skeleton_points") or [], dtype=np.float64).reshape(-1, 3)
        edges = np.asarray(res.get("skeleton_edges") or [], dtype=np.int64).reshape(-1, 2)
        bo, dia = res.get("branch_orders"), res.get("diameters")
        return Skeleton(points=pts, edges=edges,
                        branch_orders=None if bo is None else np.asarray(bo),
                        diameters=None if dia is None else np.asarray(dia, dtype=float),
                        total_length=float(res.get("total_length") or 0.0), raw=res)

    _NORMALS = ("estimate_normals", "normal_radius", "normal_max_nn")
    _MESH_BY_METHOD = {
        "ball_pivoting": ("radii",) + _NORMALS,
        "poisson": ("depth",) + _NORMALS,
        "alpha_shape": ("alpha",),
        "delaunay": (),
    }

    @checked_tool(method_arg="method", by_method=_MESH_BY_METHOD)
    def triangulate(self, *, method: str = "ball_pivoting",
                    radii: Optional[Sequence[float]] = None, depth: int = 8,
                    alpha: Optional[float] = None, estimate_normals: bool = True,
                    normal_radius: float = 0.1, normal_max_nn: int = 30) -> "Mesh":
        """A surface mesh of this cloud.

        Parameters
        ----------
        method : {"ball_pivoting", "poisson", "alpha_shape", "delaunay"}
            ``delaunay`` is 2.5-D (a height field, for terrain).
        radii : sequence of float, optional
            ``ball_pivoting``: ball radii (m); ``None`` = from the point spacing.
            Larger closes bigger holes but bridges gaps that should stay open.
        depth : int
            ``poisson``: octree depth. Higher = more detail and memory.
        alpha : float, optional
            ``alpha_shape``: radius (m); ``None`` = automatic. Smaller follows
            concavities more tightly and can fragment.
        estimate_normals, normal_radius, normal_max_nn
            ``ball_pivoting``/``poisson``: normal estimation radius (m) and
            neighbor cap.
        """
        from .results import Mesh
        body = {"source": self._source(), "method": method, **body_for(
            self._MESH_BY_METHOD, method, dict(
                radii=None if radii is None else [float(r) for r in radii], depth=depth,
                alpha=alpha, estimate_normals=estimate_normals, normal_radius=normal_radius,
                normal_max_nn=normal_max_nn))}
        meta, bufs = self._t.post_stream("/api/triangulate", body)
        if not meta.get("success", True):
            raise PhytographError(f"triangulate failed: {meta.get('error')}", detail=meta)
        # Vertices arrive as float32 relative to `vertex_origin`; adding it back in
        # float64 keeps a georeferenced mesh's world coordinates sub-millimetre.
        origin = meta.get("vertex_origin")
        return Mesh._from_frame(
            meta, bufs, None if origin is None else np.asarray(origin, dtype=np.float64))

    _CROWN_BY_SHAPE = {"ellipsoid": (), "prism": (), "cone": (), "alpha": ("alpha",)}

    @checked_tool(method_arg="shape", by_method=_CROWN_BY_SHAPE)
    def fit_crown(self, shape: str = "ellipsoid", *, strictness: float = 0.5,
                  use_leaf_only: bool = False, tree_instance_ids: Optional[Iterable[int]] = None,
                  ground_baseline: str = "min_z", alpha: Optional[float] = None) -> Dict[str, Any]:
        """Fit a crown envelope per tree, or to the whole cloud; returns the
        backend's crowns with their volume and area metrics.

        Parameters
        ----------
        shape : {"ellipsoid", "prism", "cone", "alpha"}
            Envelope shape.
        strictness : float
            0-1 fuzzy trim of outlying crown points. Higher trims more.
        use_leaf_only : bool
            Fit only ``wood_class == LEAF`` points.
        tree_instance_ids : iterable of int, optional
            Fit these ``tree_instance`` ids; ``None`` = the whole cloud as one tree.
        ground_baseline : {"min_z", "ground_class"}
            Where the crown's height is measured from.
        alpha : float, optional
            ``alpha`` shape only: radius (m); ``None`` = automatic.
        """
        body = {"source": self._source(), "shape": shape, **body_for(
            self._CROWN_BY_SHAPE, shape, dict(
                strictness=strictness, use_leaf_only=use_leaf_only,
                ground_baseline=ground_baseline, alpha=alpha,
                tree_instance_ids=None if tree_instance_ids is None
                else [int(t) for t in tree_instance_ids]))}
        res = self._t.post_stream("/api/fit/crown", body)
        if isinstance(res, dict) and res.get("success") is False:
            raise PhytographError(f"crown fit failed: {res.get('error')}", detail=res)
        return res

    _REGISTER_BY_METHOD = {
        "icp": ("max_correspondence_distance", "max_iterations", "rmse_threshold",
                "init_transform"),
        "global": ("scene_type", "scene_type_confirmed", "anchor_method", "estimator",
                   "yaw_prior_deg", "yaw_search_deg", "prefer_refine_with_prior", "voxel_size",
                   "refine_icp", "confidence_threshold"),
    }

    @checked_tool(method_arg="method", by_method=_REGISTER_BY_METHOD)
    def register_to(self, target: "Cloud", *, method: str = "icp", apply: bool = True,
                    max_correspondence_distance: Optional[float] = None,
                    max_iterations: Optional[int] = None, rmse_threshold: Optional[float] = None,
                    init_transform: Optional[Union[np.ndarray, Sequence[float]]] = None,
                    scene_type: str = "agriculture", scene_type_confirmed: bool = False,
                    anchor_method: str = "crown", estimator: str = "correlation",
                    yaw_prior_deg: Optional[float] = None, yaw_search_deg: float = 30.0,
                    prefer_refine_with_prior: bool = False, voxel_size: Optional[float] = None,
                    refine_icp: bool = True, confidence_threshold: float = 0.3) -> "Registration":
        """Align this cloud onto ``target``; with ``apply=True`` (default) this
        cloud is moved. The 4x4 matrix is returned either way.

        Never trust ``fitness``; judge by RMSE against the cloud's size (well
        under 1%). A zero error can mean no overlap.

        Parameters
        ----------
        method : {"icp", "global"}
            ``global`` searches with no initial pose, then polishes with ICP;
            ``icp`` refines a pose already within ~10 cm and a few degrees.
        apply : bool
            Move this cloud by the result.
        max_correspondence_distance : float, optional
            ``icp``: how far off (m) the initial pose may be; ``None`` = from
            the cloud. A reach setting, not a precision one.
        max_iterations, rmse_threshold : optional
            ``icp``: per-level limits; ``None`` = the module's defaults.
        init_transform : (4, 4) array or 16 floats, optional
            ``icp``: starting pose, in the frame of the returned matrix.
        scene_type : {"agriculture", "natural", "urban"}
            ``global``: ``urban`` uses a different algorithm (surface features
            instead of per-plant anchors). On a built scene pass ``urban`` or
            ``scene_type_confirmed=True``.
        scene_type_confirmed : bool
            ``global``: keep ``scene_type`` even when the geometry disagrees
            (otherwise the call raises asking you to choose).
        anchor_method : {"crown", "trunk", "chm"}
            ``global``: what each plant is reduced to before matching. ``crown``
            for aerial or hidden trunks, ``trunk`` for terrestrial woody scans,
            ``chm`` when segmentation is unreliable.
        estimator : {"correlation", "ransac_fpfh", "fgr"}
            ``global``: how anchors (or, for ``urban``, surfaces) are matched.
        yaw_prior_deg : float, optional
            ``global``: the scanner's recorded heading difference (deg). Narrows
            the yaw search; ``None`` searches the full circle (trust it less).
        yaw_search_deg : float
            ``global``: half-width (deg) of the search around the prior.
        prefer_refine_with_prior : bool
            ``global``: skip the coarse search when a prior is given (worse on
            near-symmetric orchards; off by default).
        voxel_size : float, optional
            ``global``: feature scale (m); ``None`` = from the extent.
        refine_icp : bool
            ``global``: polish the coarse pose with ICP before returning.
        confidence_threshold : float
            ``global``: below this fitness the answer is flagged not confident.
        """
        from .results import Registration
        path = {"icp": "/api/c2c/icp-register", "global": "/api/c2c/global-register"}[method]
        if init_transform is not None:
            init_transform = [float(v) for v in np.asarray(init_transform, dtype=float).reshape(16)]
        res = self._t.post_stream(path, {
            "target_source": target._source(), "source_source": self._source(),
            **body_for(self._REGISTER_BY_METHOD, method, dict(
                max_correspondence_distance=max_correspondence_distance,
                max_iterations=max_iterations, rmse_threshold=rmse_threshold,
                init_transform=init_transform, scene_type=scene_type,
                scene_type_confirmed=scene_type_confirmed, anchor_method=anchor_method,
                estimator=estimator, yaw_prior_deg=yaw_prior_deg, yaw_search_deg=yaw_search_deg,
                prefer_refine_with_prior=prefer_refine_with_prior, voxel_size=voxel_size,
                refine_icp=refine_icp, confidence_threshold=confidence_threshold))})
        if not res.get("success"):
            raise PhytographError(f"registration failed: {res.get('error') or res}", detail=res)
        if res.get("needs_scene_confirmation"):
            # A success with no matrix: the geometry disagrees with scene_type
            # strongly enough to run a different algorithm, and the app stops
            # to ask. A script has to answer up front.
            raise PhytographError(
                f"registration stopped to confirm the scene type: {res.get('scene_message')} "
                f"Pass scene_type={res.get('observed_scene_type')!r}, or "
                f"scene_type_confirmed=True to keep {res.get('chosen_scene_type')!r}.", detail=res)
        m = np.asarray(res["transformation_matrix"], dtype=np.float64).reshape(4, 4)
        if apply:
            self.transform(m)
        return Registration(matrix=m, fitness=res.get("fitness"), rmse=res.get("rmse"),
                            warning=res.get("quality_warning") or res.get("warning"), raw=res)

    # -- writing -----------------------------------------------------------
    def export(self, path: PathLike, *, format: Optional[str] = None,
               columns: Optional[Sequence[str]] = None,
               classification_column: Optional[str] = None,
               text_header: bool = True,
               las_scale: Optional[float] = None) -> Dict[str, Any]:
        """Write the cloud to ``path`` (LAS/LAZ/XYZ/TXT/CSV/PLY, from the suffix
        unless ``format`` is given). Every column is written by default;
        ``columns`` picks and orders them (e.g. ``["x","y","z","ground_class"]``).

        LAS/LAZ store coordinates on a grid. By default it is the grid the
        points are already on (a cloud read from a 1 mm LAS re-exports exactly),
        else 10 µm, so nothing is lost. ``las_scale`` (meters) chooses a coarser
        grid for a smaller file, e.g. ``0.001``. Integer columns are written as
        integers, in the type the source file declared.

        Returns the backend's summary (point count, format, …)."""
        p = Path(path).expanduser().resolve()
        fmt = (format or _EXPORT_FORMATS.get(p.suffix.lower()) or "").lower()
        if not fmt:
            raise ValueError(f"can't tell the format from {p.name!r}; pass format=")
        body: Dict[str, Any] = {"source": {"session_id": self.session_id}, "format": fmt,
                                "dest_path": str(p), "filename": p.name,
                                "text_header": text_header}
        if columns is not None:
            body["columns"] = list(columns)
        if classification_column is not None:
            body["classification_column"] = classification_column
        if las_scale is not None:
            if not las_scale > 0:
                raise ValueError("las_scale must be a positive number of meters")
            body["las_scale"] = float(las_scale)
        res = self._t.post_stream("/api/pointcloud/export", body)
        if isinstance(res, dict) and res.get("success") is False:
            raise PhytographError(f"export failed: {res.get('error')}", detail=res)
        return res  # type: ignore[return-value]

    # -- lifetime ----------------------------------------------------------
    def close(self) -> None:
        """Free the session's memory in the backend."""
        self._t.delete(f"/api/cloud/session/{self.session_id}")

    def __enter__(self) -> "Cloud":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    @property
    def _t(self):
        return self._be.transport
