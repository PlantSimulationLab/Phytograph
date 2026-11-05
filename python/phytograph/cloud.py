"""`Cloud`: a handle on one backend cloud session."""
from __future__ import annotations

import io
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple, Union

import numpy as np

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
        ``add_height_column=True`` also writes ``height_above_ground``."""
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

    def segment_trees(self, *, method: str = "treeiso", seeds: Optional[np.ndarray] = None,
                      **params: Any) -> Dict[str, Any]:
        """Individual trees → column ``tree_instance`` (0 = ground/unassigned).
        Run :meth:`segment_ground` first. ``method="chm"`` for canopy-height
        segmentation of tall stands. TreeIso decimation and gap parameters are
        seeded from the extent; any TreeIso/CHM field may be passed."""
        body: Dict[str, Any] = {"method": method}
        if method == "treeiso":
            body.update(self.defaults()["trees"])
        body.update(params)
        if seeds is not None:
            # World in, stored frame out: TreeIso matches seeds against the
            # session's stored positions.
            body["seed_points"] = (np.asarray(seeds, dtype=float).reshape(-1, 3)
                                   - self.world_shift).tolist()
        return self._post_tool("segment_trees", body)

    def segment_wood(self, *, method: str = "sota", **params: Any) -> Dict[str, Any]:
        """Wood/leaf separation → column ``wood_class`` (:data:`WOOD` = 1,
        :data:`LEAF` = 2). ``method``: ``sota``, ``geometric``, ``connectivity``,
        or ``ml`` with ``model_id=``."""
        return self._post_tool("segment_wood", {"method": method, **params, "defer_octree": True})

    def segment_organs(self, *, units: str = "auto", model_id: Optional[str] = None) -> Dict[str, Any]:
        """Plant organ segmentation (ML) → columns ``plant_organ``, ``leaflet_id``."""
        return self._post_tool("segment_organs", self._given(units=units, model_id=model_id))

    def denoise(self, *, method: str = "ror", **params: Any) -> Dict[str, Any]:
        """Flag outliers → column ``noise_class`` (:data:`NOISE` = 2). Points are
        not deleted; follow with ``filter(where={"noise_class": [1]})`` to drop
        them. ``method``: ``"ror"`` (radius) or ``"sor"`` (statistical)."""
        return self._post_tool("denoise", {"method": method, **params})

    def tree_inventory(self, **params: Any) -> "Inventory":
        """DBH, height, stem curve, crown and stand metrics for every tree in
        ``tree_instance`` (run :meth:`segment_trees` first)."""
        from .results import Inventory
        res = self._post_tool("tree_inventory", params, stream=True)
        return Inventory(trees=list(res.get("trees") or []), stem_curve=list(res.get("stem_curve") or []),
                         stand=dict(res.get("stand") or {}), warnings=list(res.get("warnings") or []),
                         raw=res)

    def tree_qsms(self, *, tree_ids: Optional[Iterable[int]] = None, **params: Any) -> Dict[int, "QSM"]:
        """One QSM per segmented tree, ``{tree_id: QSM}``. Uses wood points only
        when ``wood_class`` exists. A tree whose QSM fails is left out of the
        result and named in a Python warning (with the backend's reason)."""
        from .results import QSM
        body: Dict[str, Any] = dict(params)
        if tree_ids is not None:
            body["tree_ids"] = [int(t) for t in tree_ids]
        res = self._post_tool("tree_qsm", body, stream=True)
        out: Dict[int, QSM] = {}
        for r in res.get("results") or []:
            if not r.get("success"):
                import warnings
                warnings.warn(f"QSM failed for tree {r.get('tree_id')}: {r.get('error')}",
                              stacklevel=2)
                continue
            if r.get("success"):
                out[int(r["tree_id"])] = QSM(cylinders=list(r.get("cylinders") or []),
                                             shoots=list(r.get("shoots") or []),
                                             metrics=dict(r.get("metrics") or {}),
                                             tree_id=int(r["tree_id"]), raw=r)
        return out

    def _source(self) -> Dict[str, Any]:
        return {"session_id": self.session_id}

    def qsm(self, **params: Any) -> "QSM":
        """A QSM of this whole cloud as ONE tree (cylinders + metrics)."""
        from .results import QSM
        res = self._t.post_stream("/api/qsm/build", {"source": self._source(), **params})
        if not res.get("success"):
            raise PhytographError(f"qsm failed: {res.get('error')}", detail=res)
        return QSM(cylinders=list(res.get("cylinders") or []), shoots=list(res.get("shoots") or []),
                   metrics=dict(res.get("metrics") or {}), raw=res)

    def skeleton(self, **params: Any) -> "Skeleton":
        """A curve skeleton of this cloud (one tree/plant)."""
        from .results import Skeleton
        res = self._t.post_json("/api/skeleton/extract", {"source": self._source(), **params})
        if not res.get("success"):
            raise PhytographError(f"skeleton failed: {res.get('error')}", detail=res)
        pts = np.asarray(res.get("skeleton_points") or [], dtype=np.float64).reshape(-1, 3)
        edges = np.asarray(res.get("skeleton_edges") or [], dtype=np.int64).reshape(-1, 2)
        bo, dia = res.get("branch_orders"), res.get("diameters")
        return Skeleton(points=pts, edges=edges,
                        branch_orders=None if bo is None else np.asarray(bo),
                        diameters=None if dia is None else np.asarray(dia, dtype=float),
                        total_length=float(res.get("total_length") or 0.0), raw=res)

    def triangulate(self, *, method: str = "ball_pivoting", **params: Any) -> "Mesh":
        """A surface mesh: ``ball_pivoting``, ``poisson``, ``alpha_shape`` or
        ``delaunay`` (2.5-D)."""
        from .results import Mesh
        meta, bufs = self._t.post_stream("/api/triangulate",
                                         {"source": self._source(), "method": method, **params})
        if not meta.get("success", True):
            raise PhytographError(f"triangulate failed: {meta.get('error')}", detail=meta)
        return Mesh._from_frame(meta, bufs)

    def fit_crown(self, shape: str = "ellipsoid", **params: Any) -> Dict[str, Any]:
        """Fit a crown envelope (``ellipsoid``, ``prism``, ``cone``, ``alpha``)
        per tree (``tree_instance_ids=[...]``) or to the whole cloud; returns
        the backend's crowns with their volume/area metrics."""
        res = self._t.post_stream("/api/fit/crown", {"source": self._source(), "shape": shape, **params})
        if isinstance(res, dict) and res.get("success") is False:
            raise PhytographError(f"crown fit failed: {res.get('error')}", detail=res)
        return res

    def register_to(self, target: "Cloud", *, method: str = "icp", apply: bool = True,
                    **params: Any) -> "Registration":
        """Align this cloud onto ``target``. ``method="icp"`` refines a nearby
        pose; ``"global"`` searches without one (then refines with ICP). With
        ``apply=True`` (default) this cloud is moved; the matrix is returned
        either way."""
        from .results import Registration
        path = {"icp": "/api/c2c/icp-register", "global": "/api/c2c/global-register"}.get(method)
        if path is None:
            raise ValueError("method must be 'icp' or 'global'")
        res = self._t.post_stream(path, {"target_source": target._source(),
                                         "source_source": self._source(), **params})
        if not res.get("success"):
            raise PhytographError(f"registration failed: {res.get('error') or res}", detail=res)
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
