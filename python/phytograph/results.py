"""Result types returned by the analysis tools.

Each keeps the backend's full response in ``raw`` (nothing is thrown away) and
exposes the parts a script usually wants as NumPy arrays or plain dicts.
Coordinates are TRUE WORLD coordinates, as everywhere in this API.
"""
from __future__ import annotations

import base64
import csv
import math
import struct
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, Iterable, List, Optional, Sequence, Union

import numpy as np

if TYPE_CHECKING:  # pragma: no cover
    from .backend import Backend

PathLike = Union[str, Path]

# Class codes written by the segmentation tools (backend-api/main.py, denoise.py).
GROUND = 1          # ground_class: ground
NON_GROUND = 2      # ground_class: everything else (plants, structures)
WOOD = 1            # wood_class
LEAF = 2            # wood_class
NOISE_CLEAN = 1     # noise_class
NOISE = 2           # noise_class


def _flatten(d: Dict[str, Any], prefix: str = "") -> Dict[str, Any]:
    """One CSV row from a nested dict: scalars kept, short numeric lists split
    into _0/_1/... (or _x/_y/_z for length 3), nested dicts prefixed."""
    out: Dict[str, Any] = {}
    for k, v in d.items():
        key = f"{prefix}{k}"
        if isinstance(v, dict):
            out.update(_flatten(v, key + "_"))
        elif isinstance(v, (list, tuple)):
            if len(v) == 3 and all(isinstance(x, (int, float)) or x is None for x in v):
                for axis, x in zip("xyz", v):
                    out[f"{key}_{axis}"] = x
            elif len(v) <= 4 and all(isinstance(x, (int, float)) or x is None for x in v):
                for i, x in enumerate(v):
                    out[f"{key}_{i}"] = x
            # longer lists (polygons, per-point data) don't belong in a table row
        else:
            out[key] = v
    return out


def _write_rows(path: PathLike, rows: Iterable[Dict[str, Any]]) -> Path:
    rows = [_flatten(r) for r in rows]
    cols: List[str] = []
    for r in rows:
        cols += [c for c in r if c not in cols]
    p = Path(path).expanduser()
    with open(p, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)
    return p


# --------------------------------------------------------------------------
@dataclass
class Mesh:
    """A triangle mesh: ``vertices`` (N,3), ``faces`` (M,3) vertex indices,
    optional per-vertex ``normals`` (N,3)."""
    vertices: np.ndarray
    faces: np.ndarray
    normals: Optional[np.ndarray] = None
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def _from_frame(cls, meta: Dict[str, Any], bufs: Dict[str, np.ndarray],
                    shift: Optional[np.ndarray] = None) -> "Mesh":
        v = bufs["vertices"].reshape(-1, 3).astype(np.float64)
        if shift is not None:
            v = v + shift
        n = bufs.get("normals")
        return cls(vertices=v, faces=bufs["indices"].reshape(-1, 3).astype(np.int64),
                   normals=None if n is None or n.size != v.size else n.reshape(-1, 3),
                   raw=meta)

    @property
    def area(self) -> float:
        a, b, c = (self.vertices[self.faces[:, i]] for i in range(3))
        return float(0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1).sum())

    def to_obj(self, path: PathLike) -> Path:
        p = Path(path).expanduser()
        with open(p, "w") as f:
            f.write("# Phytograph mesh\n")
            np.savetxt(f, self.vertices, fmt="v %.6f %.6f %.6f")
            if self.normals is not None:
                np.savetxt(f, self.normals, fmt="vn %.6f %.6f %.6f")
                # v//vn with the same index: [a, a, b, b, c, c]
                np.savetxt(f, np.repeat(self.faces + 1, 2, axis=1), fmt="f %d//%d %d//%d %d//%d")
            else:
                np.savetxt(f, self.faces + 1, fmt="f %d %d %d")
        return p

    def to_ply(self, path: PathLike) -> Path:
        """Binary little-endian PLY (float64 vertices keep world precision)."""
        p = Path(path).expanduser()
        header = ("ply\nformat binary_little_endian 1.0\ncomment Phytograph mesh\n"
                  f"element vertex {len(self.vertices)}\n"
                  "property double x\nproperty double y\nproperty double z\n"
                  f"element face {len(self.faces)}\n"
                  "property list uchar int vertex_indices\nend_header\n")
        faces = np.empty(len(self.faces), dtype=[("n", "u1"), ("i", "<i4", (3,))])
        faces["n"] = 3
        faces["i"] = self.faces
        with open(p, "wb") as f:
            f.write(header.encode("ascii"))
            f.write(np.ascontiguousarray(self.vertices, dtype="<f8").tobytes())
            f.write(faces.tobytes())
        return p


# --------------------------------------------------------------------------
@dataclass
class DEM:
    """A gridded surface. ``z`` is (ny, nx) with row 0 at the minimum y and NaN
    for void cells; ``origin`` is the world [x, y] of the grid's lower-left
    corner; ``mesh`` is the triangulated surface."""
    z: np.ndarray
    origin: np.ndarray
    cell_size: float
    mesh: Optional[Mesh]
    layers: Dict[str, np.ndarray]
    crs_epsg: Optional[int]
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)
    _backend: Optional["Backend"] = field(default=None, repr=False)

    @property
    def shape(self):
        return self.z.shape

    def xy(self) -> np.ndarray:
        """(ny, nx, 2) world x/y of each cell CENTER."""
        ny, nx = self.z.shape
        xs = self.origin[0] + (np.arange(nx) + 0.5) * self.cell_size
        ys = self.origin[1] + (np.arange(ny) + 0.5) * self.cell_size
        return np.stack(np.meshgrid(xs, ys), axis=-1)

    def to_raster(self, path: PathLike, *, crs_epsg: Optional[int] = None) -> Path:
        """Write GeoTIFF (``.tif``) or ESRI ASCII (``.asc``) — the same writer
        the app's DEM export uses."""
        if self._backend is None:
            raise RuntimeError("this DEM is not attached to a backend")
        p = Path(path).expanduser()
        fmt = {"tif": "tif", "tiff": "tif", "asc": "asc"}.get(p.suffix.lower().lstrip("."))
        if fmt is None:
            raise ValueError("raster path must end in .tif or .asc")
        nodata = -9999.0
        grid = np.where(np.isfinite(self.z), self.z, nodata)
        res = self._backend.transport.post_json("/api/dem/export-raster", {
            "format": fmt, "grid_z": grid.ravel().tolist(), "nx": int(self.z.shape[1]),
            "ny": int(self.z.shape[0]), "cell_size": float(self.cell_size),
            "origin": [float(self.origin[0]), float(self.origin[1])], "nodata": nodata,
            "crs_epsg": crs_epsg if crs_epsg is not None else self.crs_epsg})
        p.write_bytes(base64.b64decode(res["data_base64"]))
        return p


# --------------------------------------------------------------------------
@dataclass
class Inventory:
    """Per-tree measurements (``trees``: one dict per tree with ``tree_id``,
    ``dbh_m``, ``height_m``, stem base, lean, crown …), the stem curves, and
    stand-level metrics."""
    trees: List[Dict[str, Any]]
    stem_curve: List[Dict[str, Any]]
    stand: Dict[str, Any]
    warnings: List[str]
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)

    def __len__(self) -> int:
        return len(self.trees)

    def to_csv(self, path: PathLike) -> Path:
        """One row per tree; nested values are flattened into columns."""
        return _write_rows(path, self.trees)

    def stem_curve_to_csv(self, path: PathLike) -> Path:
        return _write_rows(path, self.stem_curve)


# --------------------------------------------------------------------------
# TreeQSM-layout CSV. Mirrors qsmToCylinderCsv in src/renderer/lib/qsmExport.ts;
# src/shared/qsmTreeqsmCsv.contract.json holds one QSM and its exact text, and
# both writers are tested against it.
TREEQSM_CSV_HEADER = (
    "ID,parentID,branchID,branchOrder,segmentID,parentSegmentID,"
    "startX,startY,startZ,endX,endY,endZ,"
    "axisX,axisY,axisZ,radius,length,surfaceCoverage,meanAbsDeviation")


def _js_number(x: Any) -> str:
    """``String(x)`` for a JS number: the shortest round-trip digits, laid out
    by ECMAScript's Number::toString rules (``1`` not ``1.0``, ``1e-7`` not
    ``1e-07``, ``0.00001`` not ``1e-05``). Non-finite values are empty, as the
    app writes them."""
    from decimal import Decimal

    v = float(x)
    if not np.isfinite(v):
        return ""
    if v == 0:
        return "0"
    sign, digits, exp = Decimal(repr(abs(v))).as_tuple()
    ds = "".join(map(str, digits)).rstrip("0")
    exp += len(digits) - len(ds)
    k, n = len(ds), len(ds) + exp        # value = 0.<ds> x 10^n
    if k <= n <= 21:
        out = ds + "0" * (n - k)
    elif 0 < n <= 21:
        out = ds[:n] + "." + ds[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * (-n) + ds
    else:
        e = n - 1
        mant = ds if k == 1 else ds[0] + "." + ds[1:]
        out = f"{mant}e{'+' if e >= 0 else '-'}{abs(e)}"
    return ("-" if v < 0 else "") + out


def treeqsm_csv(cylinders: Sequence[Dict[str, Any]], shoots: Sequence[Dict[str, Any]]) -> str:
    parent_of_shoot = {s["shoot_id"]: s["parent_shoot_id"] for s in shoots}
    lines = [TREEQSM_CSV_HEADER]
    for c in cylinders:
        start, end = c["start"], c["end"]
        d = [end[0] - start[0], end[1] - start[1], end[2] - start[2]]
        n = math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2])   # as Math.sqrt
        axis = [0.0, 0.0, 0.0] if n == 0 else [d[0] / n, d[1] / n, d[2] / n]
        cov, mad = c.get("surf_cov"), c.get("mad")
        lines.append(",".join([
            str(c["cyl_id"]), str(c["parent_id"]),
            str(c["shoot_id"]), str(c["rank"]),
            str(c["shoot_id"]), str(parent_of_shoot.get(c["shoot_id"], -1)),
            *(_js_number(v) for v in (*start, *end, *axis, c["radius"], n)),
            "" if cov is None else _js_number(cov),
            "" if mad is None else _js_number(mad),
        ]))
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------
@dataclass
class QSM:
    """A quantitative structure model: ``cylinders`` (one dict each), ``shoots``
    and summary ``metrics`` (height, trunk diameter, woody volume, …)."""
    cylinders: List[Dict[str, Any]]
    shoots: List[Dict[str, Any]]
    metrics: Dict[str, Any]
    tree_id: Optional[int] = None
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)

    def __len__(self) -> int:
        return len(self.cylinders)

    def to_csv(self, path: PathLike) -> Path:
        """One row per cylinder: every field of the cylinder dicts, flattened
        (``start_x`` …). For TreeQSM/SimpleForest/rTwig tools use
        :meth:`to_treeqsm_csv`."""
        return _write_rows(path, self.cylinders)

    def to_treeqsm_csv(self, path: PathLike) -> Path:
        """The cylinder table in the layout the app's File → Export QSM writes
        (TreeQSM/SimpleForest columns, readable by rTwig), byte for byte.

        One row per cylinder, base to tip within each branch, in metres:

        ``ID``, ``parentID``
            Cylinder id and its parent cylinder's id (-1 for the base).
        ``branchID``, ``segmentID``
            Both the cylinder's shoot (Phytograph has one branch notion, the
            continuous shoot, so the two columns are equal).
        ``branchOrder``
            The shoot's rank: trunk 0, +1 per branching.
        ``parentSegmentID``
            The parent shoot (-1 for the trunk).
        ``startX..Z``, ``endX..Z``
            Cylinder axis end points, world coordinates.
        ``axisX..Z``
            Unit axis direction (0, 0, 0 for a zero-length cylinder).
        ``radius``, ``length``
            Metres.
        ``surfaceCoverage``, ``meanAbsDeviation``
            Fit quality: fraction of the surface the points cover, and mean
            absolute distance of points from the surface (m). Empty when the
            radius was not fitted from points.

        ``growthLength`` and ``reverseBranchOrder`` are not written (rTwig
        derives them)."""
        p = Path(path)
        p.write_text(treeqsm_csv(self.cylinders, self.shoots), newline="")
        return p


# --------------------------------------------------------------------------
@dataclass
class Skeleton:
    """A curve skeleton: ``points`` (N,3), ``edges`` (M,2) point indices, and
    per-point ``branch_orders`` / ``diameters`` when computed."""
    points: np.ndarray
    edges: np.ndarray
    branch_orders: Optional[np.ndarray]
    diameters: Optional[np.ndarray]
    total_length: float
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)


# --------------------------------------------------------------------------
@dataclass
class Registration:
    """A rigid alignment: ``matrix`` (4x4, world frame) maps the moving cloud
    onto the target. ``fitness``/``rmse`` as reported by the backend."""
    matrix: np.ndarray
    fitness: Optional[float]
    rmse: Optional[float]
    warning: Optional[str]
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)


# --------------------------------------------------------------------------
@dataclass
class Scan:
    """One scanner position for :meth:`Backend.lad`: a cloud plus the scan
    geometry its beams were fired with (the app reads these from a Helios scan
    XML or the scanner's metadata).

    ``n_theta``/``n_phi`` are the zenith/azimuth sample counts over
    ``theta=(min, max)`` and ``phi=(min, max)`` degrees."""
    cloud: Any
    origin: Sequence[float]
    n_theta: Optional[int] = None
    n_phi: Optional[int] = None
    theta: Sequence[float] = (0.0, 180.0)
    phi: Sequence[float] = (0.0, 360.0)
    return_type: str = "single"
    beam_exit_diameter: Optional[float] = None
    beam_divergence: Optional[float] = None

    def _entry(self) -> Dict[str, Any]:
        e: Dict[str, Any] = {"session_id": self.cloud.session_id,
                             "origin": [float(v) for v in self.origin],
                             "theta_min": float(self.theta[0]), "theta_max": float(self.theta[1]),
                             "phi_min": float(self.phi[0]), "phi_max": float(self.phi[1]),
                             "return_type": self.return_type}
        for k in ("n_theta", "n_phi", "beam_exit_diameter", "beam_divergence"):
            v = getattr(self, k)
            if v is not None:
                e[k] = v
        return e


@dataclass
class Grid:
    """The LAD voxel grid: world ``center`` and full ``size`` [x, y, z], and the
    number of voxels along each axis. ``rotation`` is degrees about Z."""
    center: Sequence[float]
    size: Sequence[float]
    n: Sequence[int] = (1, 1, 1)
    rotation: float = 0.0

    def _body(self) -> Dict[str, Any]:
        return {"center": [float(v) for v in self.center], "size": [float(v) for v in self.size],
                "nx": int(self.n[0]), "ny": int(self.n[1]), "nz": int(self.n[2]),
                "rotation": float(self.rotation)}


@dataclass
class LADResult:
    """Leaf area density per voxel. ``lad`` is (nx, ny, nz) in m²/m³ (NaN where
    a voxel was not solved); ``cells`` keeps every per-voxel record (G(θ), beam
    and hit counts, confidence intervals, …)."""
    lad: np.ndarray
    total_leaf_area: Optional[float]
    cells: List[Dict[str, Any]]
    warnings: List[str]
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def _from(cls, res: Dict[str, Any]) -> "LADResult":
        nx, ny, nz = int(res["nx"]), int(res["ny"]), int(res["nz"])
        lad = np.full((nx, ny, nz), np.nan)
        # Place each voxel by its CENTER rather than by assuming Helios's index
        # order: undo the grid's rotation about Z, then bin into the lattice.
        center = np.asarray(res["grid_center"], dtype=float)
        size = np.asarray(res["grid_size"], dtype=float)
        theta = -np.radians(float(res.get("grid_rotation") or 0.0))
        rot = np.array([[np.cos(theta), -np.sin(theta)], [np.sin(theta), np.cos(theta)]])
        step = size / np.array([nx, ny, nz])
        for cell in res.get("cells", []):
            if not cell.get("lad_solved", True) or cell.get("lad") is None:
                continue
            d = np.asarray(cell["center"], dtype=float) - center
            d[:2] = rot @ d[:2]
            ijk = np.floor((d + size / 2) / step).astype(int)
            ijk = np.clip(ijk, 0, [nx - 1, ny - 1, nz - 1])
            lad[tuple(ijk)] = float(cell["lad"])
        return cls(lad=lad, total_leaf_area=res.get("total_leaf_area"),
                   cells=list(res.get("cells", [])), warnings=list(res.get("warnings") or []),
                   raw=res)

    def to_csv(self, path: PathLike) -> Path:
        """One row per voxel."""
        return _write_rows(path, self.cells)
