"""Stand-level geometry for a tree inventory: the plot boundary, crown overlap,
distance-dependent competition and canopy cover. Pure numpy, no session access.

The method specification, with the published source of each definition, is
`docs/docs/concepts/stand-metrics.md`. The per-hectare arithmetic (stems/ha,
basal area/ha, QMD, Lorey's height) and biomass live in the renderer
(`src/renderer/lib/standSummary.ts`) so they follow the user's own edits
(status, minimum DBH, plot area) without a round trip; this module holds only
what needs the crown polygons.

Crown projections are CONVEX hulls (tree_inventory's `crown_hull_xy`), so every
polygon operation here is a convex one: intersection is Sutherland-Hodgman
clipping, exact for convex operands. The one non-convex quantity - the UNION of
many crowns, for canopy cover - is measured on a raster, whose cell size is a
parameter and whose error is at most one cell width along the crowns' outline.
"""
from __future__ import annotations

import math
from typing import Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np


# ==================== polygons ====================

def convex_hull(xy: np.ndarray) -> Optional[np.ndarray]:
    """Counter-clockwise convex hull of 2-D points (Qhull via scipy), or None
    for fewer than 3 non-collinear points."""
    p = np.asarray(xy, dtype=np.float64)
    if len(p) < 3:
        return None
    try:
        from scipy.spatial import ConvexHull
        off = p.mean(axis=0)
        h = ConvexHull(p - off)
    except Exception:  # QhullError: collinear / coincident input
        return None
    return p[h.vertices]  # 2-D hull vertices come counter-clockwise


def polygon_area(poly: Optional[np.ndarray]) -> float:
    if poly is None or len(poly) < 3:
        return 0.0
    p = np.asarray(poly, dtype=np.float64)
    p = p - p.mean(axis=0)
    x, y = p[:, 0], p[:, 1]
    return float(abs(0.5 * np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y)))


def _ccw(poly: np.ndarray) -> np.ndarray:
    p = np.asarray(poly, dtype=np.float64)
    x, y = p[:, 0], p[:, 1]
    signed = 0.5 * np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y)
    return p if signed >= 0 else p[::-1]


def clip_convex(subject: np.ndarray, clip: np.ndarray) -> Optional[np.ndarray]:
    """Intersection of two convex polygons (Sutherland-Hodgman), or None."""
    out = [tuple(v) for v in _ccw(subject)]
    c = _ccw(clip)
    for i in range(len(c)):
        a, b = c[i], c[(i + 1) % len(c)]
        if not out:
            return None
        inp, out = out, []

        def inside(pt):
            return (b[0] - a[0]) * (pt[1] - a[1]) - (b[1] - a[1]) * (pt[0] - a[0]) >= -1e-12

        def meet(p1, p2):
            x1, y1 = p1; x2, y2 = p2
            dx, dy = x2 - x1, y2 - y1
            ex, ey = b[0] - a[0], b[1] - a[1]
            den = dx * ey - dy * ex
            if abs(den) < 1e-18:
                return p2
            t = ((a[0] - x1) * ey - (a[1] - y1) * ex) / den
            return (x1 + t * dx, y1 + t * dy)

        for j in range(len(inp)):
            cur, prev = inp[j], inp[j - 1]
            if inside(cur):
                if not inside(prev):
                    out.append(meet(prev, cur))
                out.append(cur)
            elif inside(prev):
                out.append(meet(prev, cur))
    if len(out) < 3:
        return None
    return np.array(out)


def points_in_convex(xy: np.ndarray, poly: np.ndarray) -> np.ndarray:
    """Boolean mask of `xy` inside (or on) a convex polygon."""
    p = _ccw(poly)
    inside = np.ones(len(xy), dtype=bool)
    for i in range(len(p)):
        a, b = p[i], p[(i + 1) % len(p)]
        inside &= (b[0] - a[0]) * (xy[:, 1] - a[1]) - (b[1] - a[1]) * (xy[:, 0] - a[0]) >= -1e-9
    return inside


def distance_to_boundary(pt, poly: np.ndarray) -> float:
    """Distance from a point to a polygon's boundary (its nearest edge)."""
    p = np.asarray(poly, dtype=np.float64)
    a = p
    b = np.roll(p, -1, axis=0)
    ab = b - a
    t = np.clip(((pt[0] - a[:, 0]) * ab[:, 0] + (pt[1] - a[:, 1]) * ab[:, 1])
                / np.maximum((ab ** 2).sum(axis=1), 1e-18), 0, 1)
    proj = a + ab * t[:, None]
    return float(np.min(np.hypot(proj[:, 0] - pt[0], proj[:, 1] - pt[1])))


class HullAccumulator:
    """Convex hull of a point stream, fed chunk by chunk: the hull of
    (current hull + chunk) is the hull of everything seen, so the whole stream
    is never held."""

    def __init__(self):
        self.hull: Optional[np.ndarray] = None

    def add(self, xy: np.ndarray) -> None:
        if len(xy) == 0:
            return
        pts = xy if self.hull is None else np.vstack([self.hull, xy])
        h = convex_hull(pts)
        if h is not None:
            self.hull = h


# ==================== competition, overlap, cover ====================

# Upper bound on the canopy-cover raster (cells). At the default 0.1 m a
# 1 km x 1 km mosaic would be 1e8 cells; past this the cell grows instead
# (reported as `cover_cell_m`), which keeps memory bounded at a known cost in
# precision rather than failing after the trees were measured.
MAX_COVER_CELLS = 20_000_000


def competition(trees: Sequence[dict], *, radius_m: float,
                plot_polygon: Optional[np.ndarray] = None,
                sample_step_m: float = 0.1,
                check: Optional[Callable[[], None]] = None) -> Dict[int, dict]:
    """Per-tree distance-dependent competition and crown overlap.

    `trees` are tree-list rows (tree_id, stem_base, dbh_m, crown_hull_xy).
    Returns {tree_id: {...}} with:

      hegyi_index         sum over competitors j within `radius_m` of the
                          stem base of (D_j / D_i) / dist_ij (Hegyi 1974).
                          None for a tree without DBH.
      n_competitors       trees with a DBH inside the radius.
      crown_overlap_m2    sum of the pairwise intersection areas of this
                          crown's projection with every other crown's.
      crown_overlap_fraction
                          share of this crown's projection covered by at
                          least one other crown (sampled on a
                          `sample_step_m` grid).
      edge                True when the search circle reaches past the plot
                          boundary, so competitors outside the plot are
                          missing and the index is an underestimate.

    Neighbours come from a KD-tree over the stem bases, so the cost is
    O(N * k) in the trees near each one, not O(N^2). Two crowns can only
    overlap when their stem bases are within the sum of their reaches (the
    farthest hull vertex from each stem base). `check()`, when given, is
    called once per tree and may raise to cancel.
    """
    from scipy.spatial import cKDTree

    rows = [t for t in trees if t.get("stem_base") is not None]
    out: Dict[int, dict] = {}
    if not rows:
        return out
    base = np.array([t["stem_base"][:2] for t in rows], dtype=np.float64)
    dbh = np.array([t.get("dbh_m") if t.get("dbh_m") is not None else np.nan for t in rows])
    hulls = [np.asarray(t["crown_hull_xy"], dtype=np.float64) if t.get("crown_hull_xy") else None
             for t in rows]
    areas = [polygon_area(h) for h in hulls]
    reach = np.array([float(np.max(np.hypot(*(h - base[i]).T))) if h is not None else 0.0
                      for i, h in enumerate(hulls)])
    kd = cKDTree(base)
    max_reach = float(reach.max()) if len(reach) else 0.0
    for i, t in enumerate(rows):
        if check is not None:
            check()
        nbrs = np.array(kd.query_ball_point(base[i], radius_m), dtype=np.int64)
        nbrs = nbrs[nbrs != i]
        d = np.hypot(base[nbrs, 0] - base[i, 0], base[nbrs, 1] - base[i, 1])
        ok = np.isfinite(dbh[nbrs])
        nbrs, d = nbrs[ok], d[ok]
        hegyi = None
        if np.isfinite(dbh[i]) and dbh[i] > 0:
            hegyi = float(np.sum((dbh[nbrs] / dbh[i]) / np.maximum(d, 0.1)))
        overlap = 0.0
        frac = None
        if hulls[i] is not None and areas[i] > 0:
            others = []
            cand = kd.query_ball_point(base[i], reach[i] + max_reach)
            for j in cand:
                if j == i or hulls[j] is None:
                    continue
                if np.hypot(*(base[j] - base[i])) > reach[i] + reach[j]:
                    continue
                a = polygon_area(clip_convex(hulls[i], hulls[j]))
                if a > 0:
                    overlap += a
                    others.append(hulls[j])
            if others:
                lo, hi = hulls[i].min(axis=0), hulls[i].max(axis=0)
                gx, gy = np.meshgrid(np.arange(lo[0], hi[0] + sample_step_m, sample_step_m),
                                     np.arange(lo[1], hi[1] + sample_step_m, sample_step_m))
                g = np.column_stack([gx.ravel(), gy.ravel()])
                g = g[points_in_convex(g, hulls[i])]
                covered = np.zeros(len(g), dtype=bool)
                for hj in others:
                    covered |= points_in_convex(g, hj)
                frac = float(covered.mean()) if len(g) else 0.0
            else:
                frac = 0.0
        edge = False
        if plot_polygon is not None and len(plot_polygon) >= 3:
            edge = bool(distance_to_boundary(base[i], plot_polygon) < radius_m
                        or not points_in_convex(base[i:i + 1], plot_polygon)[0])
        out[int(t["tree_id"])] = {
            "hegyi_index": hegyi, "n_competitors": int(len(nbrs)),
            "crown_overlap_m2": float(overlap), "crown_overlap_fraction": frac,
            "edge": edge,
        }
    return out


def crown_union_area(hulls: Sequence[Optional[np.ndarray]], *, cell_m: float = 0.1,
                     within: Optional[np.ndarray] = None,
                     check: Optional[Callable[[], None]] = None) -> Tuple[float, float]:
    """(area covered by at least one crown projection in m², cell size used),
    measured on a raster; restricted to `within` (the convex plot polygon)
    when given. Each crown is first CLIPPED to the plot (both are convex, so
    clip_convex is exact) and rasterised only over its own bounding box - no
    full-extent coordinate grid is ever built. The cell grows past `cell_m`
    when the extent would exceed MAX_COVER_CELLS."""
    hs = []
    for h in hulls:
        if h is None or len(h) < 3:
            continue
        h = np.asarray(h, dtype=np.float64)
        if within is not None:
            h = clip_convex(h, np.asarray(within, dtype=np.float64))
            if h is None:
                continue
        hs.append(h)
    if not hs:
        return 0.0, cell_m
    allp = np.vstack(hs)
    lo, hi = allp.min(axis=0), allp.max(axis=0)
    span = np.maximum(hi - lo, cell_m)
    cell = max(cell_m, math.sqrt(float(span[0] * span[1]) / MAX_COVER_CELLS))
    nx = int(math.ceil(span[0] / cell)) + 1
    ny = int(math.ceil(span[1] / cell)) + 1
    covered = np.zeros((ny, nx), dtype=bool)
    for h in hs:
        if check is not None:
            check()
        hlo, hhi = h.min(axis=0), h.max(axis=0)
        i0 = max(0, int((hlo[0] - lo[0]) / cell)); i1 = min(nx, int((hhi[0] - lo[0]) / cell) + 2)
        j0 = max(0, int((hlo[1] - lo[1]) / cell)); j1 = min(ny, int((hhi[1] - lo[1]) / cell) + 2)
        gx, gy = np.meshgrid(lo[0] + (np.arange(i0, i1) + 0.5) * cell,
                             lo[1] + (np.arange(j0, j1) + 0.5) * cell)
        m = points_in_convex(np.column_stack([gx.ravel(), gy.ravel()]), h).reshape(gx.shape)
        covered[j0:j1, i0:i1] |= m
    return float(covered.sum() * cell * cell), float(cell)


def stand_geometry(trees: Sequence[dict], *, plot_polygon: Optional[np.ndarray],
                   competition_radius_m: float, cover_cell_m: float = 0.1,
                   check: Optional[Callable[[], None]] = None) -> dict:
    """Everything stand-level that needs polygons: the plot boundary and its
    area, the crown union (for canopy cover), the summed crown area, and the
    per-tree competition block. `check()` is called periodically and may raise
    to cancel."""
    hulls = [np.asarray(t["crown_hull_xy"]) if t.get("crown_hull_xy") else None for t in trees]
    plot_area = polygon_area(plot_polygon) if plot_polygon is not None else None
    union, cell = crown_union_area(hulls, cell_m=cover_cell_m, within=plot_polygon, check=check)
    return {
        "plot_polygon": None if plot_polygon is None else np.asarray(plot_polygon).tolist(),
        "plot_area_m2": plot_area,
        "crown_union_area_m2": union,
        "cover_cell_m": cell,
        "crown_area_sum_m2": float(sum(polygon_area(h) for h in hulls)),
        "competition_radius_m": competition_radius_m,
        "competition": {str(k): v for k, v in competition(
            trees, radius_m=competition_radius_m, plot_polygon=plot_polygon, check=check).items()},
    }
