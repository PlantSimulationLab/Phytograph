"""Crown shape-fitting geometry.

Pure numpy/open3d/scipy — no FastAPI. The endpoint in main.py resolves points +
labels from a cloud session and calls `fit_crown` per tree; this module does the
math: a shared "fuzzy" outlier trim, then one of four shape fits, each producing
a triangle mesh (verts + faces + normals) and a metrics dict.

Design notes
------------
* **Fuzzy trim** rejects branches shooting outside the general crown so the shape
  doesn't bound empty space. A naive global radial trim (distance to centroid)
  decapitates a legitimately tall/conical crown, so instead we trim by LATERAL
  radius from the vertical crown axis, PER VERTICAL SLICE — preserving natural
  taper. `strictness` in [0,1] maps to how aggressively the outermost points in
  each slice are dropped (0 = keep all, 1 = drop the outermost ~25%). A hard
  floor guarantees a high strictness can never collapse the crown.
* **Orientation** is upright (world +Z). The user wants interpretable
  width x depth x height dimensions, so ellipsoid/cone/prism are Z-aligned rather
  than PCA-tilted. (PCA is still used for the ellipsoid's XY footprint.)
* **Volume** uses analytic formulas for the parametric shapes (reliable) and
  ConvexHull as the alpha-shape fallback when the mesh isn't watertight — never a
  negative/NaN volume.
"""
from __future__ import annotations

import math
import numpy as np

# Fraction of points the strictness knob can trim at maximum (strictness=1).
_MAX_TRIM = 0.25
# Number of vertical slices for the per-slice lateral trim.
_N_SLICES = 10
# Never trim a crown below this many points, nor below half the input — a high
# strictness must not collapse the crown to nothing.
_MIN_KEEP_ABS = 20


def _fuzzy_trim(points: np.ndarray, strictness: float) -> np.ndarray:
    """Drop lateral outliers per vertical slice. Returns the kept (M,3) points.

    strictness is clipped to [0,1]. keep_fraction = 1 - strictness*_MAX_TRIM, so
    strictness 0 keeps everything and 1 keeps the innermost ~75% of each slice's
    lateral-radius distribution. A hard floor (max(_MIN_KEEP_ABS, N/2)) stops an
    aggressive setting from collapsing the crown.
    """
    n = len(points)
    if n <= _MIN_KEEP_ABS:
        return points
    s = float(np.clip(strictness, 0.0, 1.0))
    keep_fraction = 1.0 - s * _MAX_TRIM
    if keep_fraction >= 1.0:
        return points

    centroid = points.mean(axis=0)
    # Lateral radius from the VERTICAL axis through the centroid (XY distance).
    dxy = points[:, :2] - centroid[:2]
    r = np.hypot(dxy[:, 0], dxy[:, 1])

    z = points[:, 2]
    z_min, z_max = float(z.min()), float(z.max())
    keep_mask = np.ones(n, dtype=bool)
    if z_max > z_min:
        # Assign each point to a vertical slice, trim within each slice by the
        # keep_fraction quantile of its lateral radius.
        edges = np.linspace(z_min, z_max, _N_SLICES + 1)
        slice_idx = np.clip(np.digitize(z, edges[1:-1]), 0, _N_SLICES - 1)
        for si in range(_N_SLICES):
            sel = slice_idx == si
            if sel.sum() < 4:
                continue  # too few to define an outlier threshold; keep all
            thresh = np.quantile(r[sel], keep_fraction)
            drop = sel & (r > thresh)
            keep_mask[drop] = False
    else:
        # Flat crown (no vertical extent): single-slice radial trim.
        thresh = np.quantile(r, keep_fraction)
        keep_mask[r > thresh] = False

    # Floor: never keep fewer than max(_MIN_KEEP_ABS, N/2). If the trim went too
    # far, restore the innermost points by lateral radius until the floor is met.
    floor = max(_MIN_KEEP_ABS, n // 2)
    if keep_mask.sum() < floor:
        order = np.argsort(r)  # innermost first
        keep_mask = np.zeros(n, dtype=bool)
        keep_mask[order[:floor]] = True
    return points[keep_mask]


def _uv_sphere(n_lat: int = 16, n_lon: int = 24):
    """Unit UV sphere as (vertices (V,3), triangles (T,3)). Poles are single
    vertices; the surface is closed (watertight)."""
    verts = [(0.0, 0.0, 1.0)]  # north pole
    for i in range(1, n_lat):
        theta = math.pi * i / n_lat
        st, ct = math.sin(theta), math.cos(theta)
        for j in range(n_lon):
            phi = 2.0 * math.pi * j / n_lon
            verts.append((st * math.cos(phi), st * math.sin(phi), ct))
    verts.append((0.0, 0.0, -1.0))  # south pole
    south = len(verts) - 1

    tris = []
    # North cap.
    for j in range(n_lon):
        a = 1 + j
        b = 1 + (j + 1) % n_lon
        tris.append((0, a, b))
    # Middle bands.
    for i in range(n_lat - 2):
        row0 = 1 + i * n_lon
        row1 = 1 + (i + 1) * n_lon
        for j in range(n_lon):
            j1 = (j + 1) % n_lon
            a, b = row0 + j, row0 + j1
            c, d = row1 + j, row1 + j1
            tris.append((a, c, b))
            tris.append((b, c, d))
    # South cap.
    base = 1 + (n_lat - 2) * n_lon
    for j in range(n_lon):
        a = base + j
        b = base + (j + 1) % n_lon
        tris.append((south, b, a))
    return np.asarray(verts, dtype=np.float64), np.asarray(tris, dtype=np.int32)


def _cone_mesh(base_center: np.ndarray, radius: float, height: float, n_seg: int = 32):
    """Upright cone: circular base at base_center, apex `height` above it. Closed
    base cap → watertight. Returns (vertices, triangles)."""
    cx, cy, cz = base_center
    apex = (cx, cy, cz + height)
    ring = []
    for j in range(n_seg):
        a = 2.0 * math.pi * j / n_seg
        ring.append((cx + radius * math.cos(a), cy + radius * math.sin(a), cz))
    apex_idx = 0
    base_center_idx = 1
    ring_start = 2
    verts = [apex, (cx, cy, cz)] + ring
    tris = []
    for j in range(n_seg):
        a = ring_start + j
        b = ring_start + (j + 1) % n_seg
        tris.append((apex_idx, a, b))          # side
        tris.append((base_center_idx, b, a))   # base cap (inward winding)
    return np.asarray(verts, dtype=np.float64), np.asarray(tris, dtype=np.int32)


def _box_mesh(center: np.ndarray, R: np.ndarray, extent: np.ndarray):
    """Oriented box mesh from center, rotation R (columns = axes), and full
    extents. 8 verts, 12 triangles, outward winding."""
    hx, hy, hz = extent / 2.0
    corners = np.array([
        [-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],
        [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz],
    ], dtype=np.float64)
    verts = (R @ corners.T).T + center
    faces = [
        (0, 2, 1), (0, 3, 2),  # bottom
        (4, 5, 6), (4, 6, 7),  # top
        (0, 1, 5), (0, 5, 4),  # -y
        (2, 3, 7), (2, 7, 6),  # +y
        (1, 2, 6), (1, 6, 5),  # +x
        (3, 0, 4), (3, 4, 7),  # -x
    ]
    return verts, np.asarray(faces, dtype=np.int32)


def _mesh_dict(verts: np.ndarray, tris: np.ndarray):
    """Build an open3d mesh from verts/tris, return (o3d_mesh, normals np array)."""
    import open3d as o3d
    m = o3d.geometry.TriangleMesh()
    m.vertices = o3d.utility.Vector3dVector(np.asarray(verts, dtype=np.float64))
    m.triangles = o3d.utility.Vector3iVector(np.asarray(tris, dtype=np.int32))
    m.compute_vertex_normals()
    normals = np.asarray(m.vertex_normals, dtype=np.float32)
    return m, normals


# How many multiples of the mean point spacing to try when auto-growing the alpha
# radius toward a single, watertight concave hull. A crown's foliage clusters need
# an alpha several times the spacing to bridge into one closed surface; too small
# (the raw ~2x auto value) yields disconnected fragments + spurious appendages.
_ALPHA_MULTIPLIERS = (3.0, 4.0, 5.0, 6.0, 8.0, 10.0, 14.0, 20.0)
# Light Taubin smoothing: cosmetic denoising that (unlike Laplacian) doesn't
# shrink the surface. Kept to few iterations so it preserves watertightness —
# heavier smoothing perturbs boundary triangles enough that open3d reports the
# mesh as non-watertight.
_ALPHA_SMOOTH_ITERS = 2


def _largest_watertight_component(mesh):
    """Clean a raw alpha mesh and keep ONLY its largest connected component,
    dropping the disconnected fragments + sliver appendages a raw alpha complex
    leaves behind. Returns the cleaned mesh (may or may not be watertight)."""
    import numpy as _np
    mesh.remove_degenerate_triangles()
    mesh.remove_duplicated_triangles()
    mesh.remove_duplicated_vertices()
    mesh.remove_non_manifold_edges()
    if len(mesh.triangles) == 0:
        return mesh
    labels, counts, _areas = mesh.cluster_connected_triangles()
    labels = _np.asarray(labels)
    counts = _np.asarray(counts)
    if len(counts) > 1:
        biggest = int(counts.argmax())
        mesh.remove_triangles_by_mask(labels != biggest)
        mesh.remove_unreferenced_vertices()
    return mesh


def _alpha_concave_hull(points: np.ndarray, alpha: "float | None"):
    """A SMOOTH, WATERTIGHT concave hull of `points` via an alpha shape.

    A raw open3d alpha shape on crown points is holey, fragmented, and non-
    watertight — it returns the boundary faces of every alpha-qualifying
    tetrahedron, so isolated leaf clusters become separate shells with sliver
    appendages. To get the concave hull the user actually wants:

      1. Dedup + sub-micron jitter to break coplanarity (Qhull robustness).
      2. Build the alpha shape, keep only the LARGEST connected component (drops
         the fragments/appendages).
      3. AUTO-GROW alpha (×mean-spacing) until that component is watertight — a
         small alpha leaves holes; a few multiples of the spacing bridges the
         foliage into one closed surface. An explicit `alpha` override skips the
         search and is used as-is (still largest-component-cleaned).
      4. Light Taubin smoothing (shrink-free) for a smooth surface.

    Returns an open3d TriangleMesh with vertex normals. Raises ValueError if no
    triangles could be built at all.
    """
    import open3d as o3d

    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(np.asarray(points, dtype=np.float64))
    pcd = pcd.remove_duplicated_points()
    jpts = np.asarray(pcd.points)
    if len(jpts) >= 4:
        extent = float(np.linalg.norm(jpts.max(axis=0) - jpts.min(axis=0)))
        if extent > 0:
            rng = np.random.default_rng(0)  # deterministic
            jpts = jpts + rng.normal(0.0, extent * 1e-6, jpts.shape)
            pcd.points = o3d.utility.Vector3dVector(jpts)
    mean_nn = float(np.mean(pcd.compute_nearest_neighbor_distance()))

    def _build(a: float):
        with o3d.utility.VerbosityContextManager(o3d.utility.VerbosityLevel.Error):
            m = o3d.geometry.TriangleMesh.create_from_point_cloud_alpha_shape(pcd, a)
        return _largest_watertight_component(m)

    chosen = None
    if alpha is not None:
        chosen = _build(float(alpha))
    else:
        # Grow alpha until the largest component closes; keep the last as fallback.
        for mult in _ALPHA_MULTIPLIERS:
            cand = _build(mean_nn * mult)
            if len(cand.triangles) == 0:
                continue
            chosen = cand
            if cand.is_watertight():
                break

    if chosen is None or len(chosen.triangles) == 0:
        raise ValueError("Alpha shape produced no triangles; try a larger alpha.")

    # Light shrink-free smoothing for a smooth surface, preserving watertightness.
    smoothed = chosen.filter_smooth_taubin(number_of_iterations=_ALPHA_SMOOTH_ITERS)
    # If smoothing somehow degraded it to empty, fall back to the pre-smooth mesh.
    if len(smoothed.triangles) == 0:
        smoothed = chosen
    smoothed.remove_degenerate_triangles()
    smoothed.remove_duplicated_triangles()
    smoothed.compute_vertex_normals()
    return smoothed


def fit_crown(
    crown_points: np.ndarray,
    shape: str,
    strictness: float,
    baseline_z: float,
    *,
    alpha: float | None = None,
):
    """Fit `shape` to `crown_points` (N,3, world frame). `baseline_z` is the
    ground level used for tree height. Returns a dict:
      { vertices (V,3 f64), triangles (T,3 i32), normals (V,3 f32),
        metrics: { tree_height_m, crown_volume_m3, crown_center [3],
                   crown_dims_m [3], crown_base_z, crown_top_z,
                   surface_area_m2, num_points_used } }
    Raises ValueError on too-few-points / a degenerate fit.
    """
    pts = np.asarray(crown_points, dtype=np.float64)
    if len(pts) < 4:
        raise ValueError("Need at least 4 crown points to fit a shape.")

    kept = _fuzzy_trim(pts, strictness)
    n_used = len(kept)
    # Point-cloud centroid — used only to POSITION the parametric shapes
    # (ellipsoid/cone are built around it). The REPORTED crown center + dimensions
    # are derived from the fitted mesh geometry at the end, not from here, so every
    # shape reports the geometry of the solid the user sees.
    centroid = kept.mean(axis=0)
    # Tree height is the real tree's height from the ground, so it's measured from
    # the crown POINTS (independent of which shape encloses them — the mesh top can
    # clip, e.g. a cone tip). The crown's base/top Z below come from the mesh so
    # they stay consistent with the reported dimensions.
    tree_height = float(kept[:, 2].max()) - float(baseline_z)

    verts = tris = normals = None
    volume = 0.0

    if shape == "ellipsoid":
        # Axis-aligned upright ellipsoid that ENCLOSES the crown points. Sizing
        # each semi-axis to the per-axis max would NOT contain the cloud — a point
        # moderate on all three axes still sits outside the ellipsoid surface
        # (the (x/a)²+(y/b)²+(z/c)²≤1 constraint is stricter than a box). So we fix
        # the ellipsoid's PROPORTIONS from the per-axis spread, then scale it up
        # until it contains the desired fraction of points: for each point compute
        # its normalized ellipsoid radius ρ = √((dx/a₀)²+(dy/b₀)²+(dz/c₀)²) and take
        # the keep-fraction quantile of ρ as the scale. At strictness 0 the quantile
        # is the max ρ, so EVERY point lies on or inside the surface.
        pct = 100.0 * (1.0 - float(np.clip(strictness, 0.0, 1.0)) * _MAX_TRIM)
        d = kept - centroid
        # Base semi-axes = per-axis extent (max abs offset); these set the shape,
        # the scale below sets the size. Guard tiny/zero axes.
        a0 = max(float(np.abs(d[:, 0]).max()), 1e-6)
        b0 = max(float(np.abs(d[:, 1]).max()), 1e-6)
        c0 = max(float(np.abs(d[:, 2]).max()), 1e-6)
        rho = np.sqrt((d[:, 0] / a0) ** 2 + (d[:, 1] / b0) ** 2 + (d[:, 2] / c0) ** 2)
        scale = float(np.percentile(rho, pct)) or 1.0
        cx, cy, cz = a0 * scale, b0 * scale, c0 * scale
        uv, tris = _uv_sphere()
        verts = uv * np.array([cx, cy, cz]) + centroid
        volume = 4.0 / 3.0 * math.pi * cx * cy * cz

    elif shape == "prism":
        # Axis-aligned bounding box of the trimmed crown points.
        mn = kept.min(axis=0)
        mx = kept.max(axis=0)
        center = (mn + mx) / 2.0
        extent = mx - mn
        verts, tris = _box_mesh(center, np.eye(3), extent)
        volume = float(extent[0] * extent[1] * extent[2])

    elif shape == "cone":
        # Upright cone that ENCLOSES the crown: apex at the crown top, circular
        # base at the crown bottom. A cone of height h and base radius R admits a
        # point at height z (measured from the base) with lateral radius r iff
        # r ≤ R·(1 - z/h) — the allowed radius shrinks linearly toward the apex.
        # So the base radius needed to contain a point is r / (1 - z/h); the base
        # radius that contains the desired fraction of points is the keep-fraction
        # quantile of that ratio. At strictness 0 → the max ratio, enclosing every
        # point (not just the lowest slice, which the naive widest-part radius
        # missed — a mid-height branch would poke through the taper).
        z_top = float(kept[:, 2].max())
        z_base = float(kept[:, 2].min())
        height = z_top - z_base
        if height <= 0:
            raise ValueError("Crown has no vertical extent; cone fit is undefined.")
        pct = 100.0 * (1.0 - float(np.clip(strictness, 0.0, 1.0)) * _MAX_TRIM)
        dxy = kept[:, :2] - centroid[:2]
        r = np.hypot(dxy[:, 0], dxy[:, 1])
        # Fraction of the height BELOW the apex (1 at base, →0 at apex).
        below = (z_top - kept[:, 2]) / height
        # A cone narrows to a POINT at the apex, so points in the top of the crown
        # (which still spread laterally) can never be enclosed without the base
        # radius exploding toward infinity. Exclude the top 15% from the sizing —
        # that tapering tip is inherently clipped by any cone — and size the cone
        # to enclose everything below it. `needed = r/below` is the base radius
        # required to contain each point on the cone's slant surface; take the
        # keep-fraction quantile over the eligible points. At strictness 0 → the
        # max, so every point below the tip lies on or inside the cone.
        eligible = below >= 0.15
        ref = (r / np.clip(below, 1e-6, None))[eligible]
        radius = (float(np.percentile(ref, pct)) if ref.size else float(r.max())) or 1e-6
        base_center = np.array([centroid[0], centroid[1], z_base])
        verts, tris = _cone_mesh(base_center, radius, height)
        volume = 1.0 / 3.0 * math.pi * radius * radius * height

    elif shape == "alpha":
        mesh = _alpha_concave_hull(kept, alpha)
        verts = np.asarray(mesh.vertices, dtype=np.float64)
        tris = np.asarray(mesh.triangles, dtype=np.int32)
        normals = np.asarray(mesh.vertex_normals, dtype=np.float32)
        # Watertight mesh volume, else convex-hull fallback (never NaN/negative).
        try:
            volume = abs(float(mesh.get_volume())) if mesh.is_watertight() else 0.0
        except Exception:
            volume = 0.0
        if volume <= 0.0:
            from scipy.spatial import ConvexHull
            volume = float(ConvexHull(kept).volume)
    else:
        raise ValueError(f"Unknown crown shape: {shape!r}")

    if normals is None:
        _, normals = _mesh_dict(verts, tris)

    verts = np.asarray(verts, dtype=np.float64)
    import open3d as o3d
    m = o3d.geometry.TriangleMesh()
    m.vertices = o3d.utility.Vector3dVector(verts)
    m.triangles = o3d.utility.Vector3iVector(np.asarray(tris, dtype=np.int32))
    surface_area = float(m.get_surface_area())

    # Center + dimensions are derived from the FITTED MESH GEOMETRY (its
    # axis-aligned bounding box), not the point cloud, so every shape reports the
    # geometry of the solid the user sees — consistent across ellipsoid / prism /
    # cone / alpha. crown_base_z / crown_top_z are the mesh's Z-extent (so the
    # height dimension = crown_top_z - crown_base_z). tree_height_m stays measured
    # from the crown POINTS above (the real tree height, which a clipped mesh top
    # like a cone tip would understate).
    mesh_min = verts.min(axis=0)
    mesh_max = verts.max(axis=0)
    mesh_center = (mesh_min + mesh_max) / 2.0
    dims = mesh_max - mesh_min

    return {
        "vertices": verts,
        "triangles": np.asarray(tris, dtype=np.int32),
        "normals": np.asarray(normals, dtype=np.float32),
        "metrics": {
            "tree_height_m": float(tree_height),
            "crown_volume_m3": float(volume),
            "crown_center": [float(mesh_center[0]), float(mesh_center[1]), float(mesh_center[2])],
            "crown_dims_m": [float(dims[0]), float(dims[1]), float(dims[2])],
            "crown_base_z": float(mesh_min[2]),
            "crown_top_z": float(mesh_max[2]),
            "surface_area_m2": surface_area,
            "num_points_used": int(n_used),
        },
    }
