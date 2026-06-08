"""Stage D: robust per-cylinder least-squares fitting + quality metrics.

Phase C hands us a QSM whose topology, shoot membership, and rank are final, but
whose radii are a provisional point-count proxy and whose axes are the (smoothed)
skeleton edges. Stage D replaces those provisional radii with REAL radii fit from
the point cloud, and tags every cylinder with two quality numbers used downstream
(Phase E radius correction, model selection, reporting):

  - ``surf_cov`` -- lateral surface coverage in [0, 1]. Fraction of an nl x ns
    grid wrapped around the fitted cylinder that contains >=1 point. Low SurfCov
    (<~0.3-0.5) means the cylinder was seen one-sided (occlusion), which is the
    dominant radius-OVER-estimation failure mode (a one-sided arc looks locally
    planar, so least-squares prefers a larger radius). Phase E leans on this.
  - ``mad`` -- mean absolute point-to-surface distance (meters). Fit tightness.

The fit itself is the VERIFIED TreeQSM least-squares cylinder (findings.md Phase
6), done as a deterministic Huber IRLS / M-estimator rather than RANSAC:

  par = [x0, y0, alpha, beta, r]   (axis point x,y in a rotated frame;
                                     alpha,beta rotate the +z axis; r = radius)
  Data is pre-rotated so the seed axis is +z; residual dist = sqrt(xt^2+yt^2) - r;
  Gauss-Newton step p = -(J'WJ)^-1 (J'W d), Huber weights W recomputed each
  iteration. PCA on the assigned points seeds the axis; the median radial offset
  seeds r. No randomness anywhere -- same points in => same fit out.

Determinism: point->cylinder assignment is a pure nearest-axis test; PCA seed is
sign-canonicalized; IRLS is a fixed-iteration deterministic loop. No RNG.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.spatial import cKDTree

from .model import QSM, Cylinder


@dataclass
class CylinderFitOptions:
    # --- point -> cylinder assignment (true nearest-cylinder) ---
    # Each cloud point is assigned to the cylinder whose axis is NEAREST (global
    # hard assignment), via a KD-tree of axis samples spaced this finely. Finer =
    # more accurate nearest-axis (esp. for long cylinders) at more samples; ~the
    # SurfCov grid resolution is a good match.
    assign_sample_spacing: float = 0.03  # meters between axis samples
    # A point whose nearest axis sample is farther than this is dropped (other
    # trees, ground, gross outliers). Generous enough to reach a thick trunk's bark
    # (real trunks here ~0.2 m radius) but not so large it absorbs a neighbouring
    # tree. Points genuinely on the tree sit within this of SOME cylinder axis.
    max_assign_dist: float = 0.5  # meters
    # Legacy radial-band knobs, kept for the re-fit helper / tests that call
    # _assign_points directly. Not used by the main nearest-cylinder path.
    assign_band_scale: float = 3.0
    assign_band_abs: float = 0.02
    min_points: int = 6  # below this, keep the provisional radius (cannot fit)

    # --- Gauss-Newton / IRLS ---
    max_iter: int = 50
    tol: float = 1e-4  # |SS0 - SS1| convergence (TreeQSM uses 1e-4)
    huber_k: float = 1.345  # Huber tuning (in units of robust residual scale)
    # Reliability gate (TreeQSM rcond(-A) < 10000*eps). If the normal matrix is
    # near-singular the fit is unreliable; we keep the provisional radius.
    rcond_floor: float = 1e4 * np.finfo(np.float64).eps

    # --- SurfCov grid (TreeQSM: res=0.03, 0.8r axial gate) ---
    surfcov_res: float = 0.03  # meters per grid cell (axial + arc)
    surfcov_min_layers: int = 3
    surfcov_min_sectors: int = 8
    surfcov_max_sectors: int = 36
    # Radial band (as fractions of r) a point's axis-distance must fall in to
    # count toward coverage. TreeQSM keeps points straddling the fitted surface
    # (0.8r..1.2r), excluding interior noise and far outliers. A point exactly on
    # the surface has radial == r, well inside this band.
    surfcov_band_lo: float = 0.8
    surfcov_band_hi: float = 1.2

    # --- sanity clamps on the fitted radius (meters) ---
    radius_min: float = 0.001
    radius_max: float = 0.50
    # A fit whose radius jumps beyond this factor of the provisional estimate AND
    # has low SurfCov AND is a LOOSE fit (mad > runaway_mad_frac * radius) is
    # rejected (keep provisional). The mad condition distinguishes a true one-sided-
    # arc balloon (points scattered off the inflated circle -> large mad) from a
    # legitimately thick-but-short cylinder slice (low SurfCov from few axial layers
    # but points tight on the real shell -> small mad). Without it, the guard wrongly
    # rejected correct thick-trunk fits.
    runaway_factor: float = 4.0
    runaway_surfcov: float = 0.3
    runaway_mad_frac: float = 0.25  # mad above this fraction of radius == loose fit


# ---------------------------------------------------------------------------
# Rotation helpers (build R(alpha, beta) and its derivatives), matching the
# TreeQSM convention: rotate about x by alpha, then about y by beta.
# ---------------------------------------------------------------------------


def _rot(alpha: float, beta: float) -> np.ndarray:
    ca, sa = np.cos(alpha), np.sin(alpha)
    cb, sb = np.cos(beta), np.sin(beta)
    Rx = np.array([[1, 0, 0], [0, ca, -sa], [0, sa, ca]], dtype=np.float64)
    Ry = np.array([[cb, 0, sb], [0, 1, 0], [-sb, 0, cb]], dtype=np.float64)
    return Ry @ Rx


def _drot_dalpha(alpha: float, beta: float) -> np.ndarray:
    ca, sa = np.cos(alpha), np.sin(alpha)
    cb, sb = np.cos(beta), np.sin(beta)
    dRx = np.array([[0, 0, 0], [0, -sa, -ca], [0, ca, -sa]], dtype=np.float64)
    Ry = np.array([[cb, 0, sb], [0, 1, 0], [-sb, 0, cb]], dtype=np.float64)
    return Ry @ dRx


def _drot_dbeta(alpha: float, beta: float) -> np.ndarray:
    ca, sa = np.cos(alpha), np.sin(alpha)
    cb, sb = np.cos(beta), np.sin(beta)
    Rx = np.array([[1, 0, 0], [0, ca, -sa], [0, sa, ca]], dtype=np.float64)
    dRy = np.array([[-sb, 0, cb], [0, 0, 0], [-cb, 0, -sb]], dtype=np.float64)
    return dRy @ Rx


def _rotate_to_z(axis: np.ndarray) -> np.ndarray:
    """Rotation matrix Rot0 such that Rot0 @ axis = +z. Deterministic."""
    a = axis / (np.linalg.norm(axis) or 1.0)
    z = np.array([0.0, 0.0, 1.0])
    v = np.cross(a, z)
    s = float(np.linalg.norm(v))
    c = float(np.dot(a, z))
    if s < 1e-12:
        # Already parallel to +/- z.
        return np.eye(3) if c > 0 else np.diag([1.0, -1.0, -1.0])
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * ((1 - c) / (s * s))


@dataclass
class _FitResult:
    start: np.ndarray
    end: np.ndarray
    radius: float
    surf_cov: float
    mad: float
    reliable: bool
    n_points: int


# ---------------------------------------------------------------------------
# Core single-cylinder fit
# ---------------------------------------------------------------------------


def fit_cylinder(
    points: np.ndarray,
    seed_start: np.ndarray,
    seed_end: np.ndarray,
    seed_radius: float,
    opts: CylinderFitOptions | None = None,
) -> _FitResult | None:
    """Fit one cylinder to ``points`` using the verified TreeQSM 5-parameter
    least-squares model with deterministic Huber IRLS. ``seed_*`` come from the
    provisional (skeleton) cylinder. Returns None if there are too few points;
    otherwise a ``_FitResult`` (which may be flagged ``reliable=False``).

    The fitted axis is re-projected onto the seed segment's axial extent so the
    cylinder keeps its place along the shoot (we re-fit radius + local axis tilt,
    not the segment's length / endpoints).
    """
    opts = opts or CylinderFitOptions()
    P = np.asarray(points, dtype=np.float64)
    if P.shape[0] < opts.min_points:
        return None

    seed_start = np.asarray(seed_start, dtype=np.float64)
    seed_end = np.asarray(seed_end, dtype=np.float64)
    seed_axis = seed_end - seed_start
    seg_len = float(np.linalg.norm(seed_axis))
    if seg_len <= 0:
        return None

    # --- PCA seed for the axis (more stable than the raw skeleton edge) ---
    centroid = P.mean(axis=0)
    cov = np.cov((P - centroid).T)
    evals, evecs = np.linalg.eigh(cov)
    pca_axis = evecs[:, -1]  # largest eigenvalue = elongation = axis
    # Canonicalize sign to agree with the seed axis (determinism + correct frame).
    if float(np.dot(pca_axis, seed_axis)) < 0:
        pca_axis = -pca_axis
    # Blend toward the seed axis when the point cloud is too short/round to give a
    # trustworthy PCA direction (occluded thin cyls). Use elongation ratio.
    elong = float(evals[-1] / (evals[-2] + 1e-12))
    seed_axis_u = seed_axis / seg_len
    axis0 = pca_axis if elong > 3.0 else seed_axis_u
    axis0 = axis0 / (np.linalg.norm(axis0) or 1.0)

    # Pre-rotate points so the seed axis is +z, origin at seed_start.
    Rot0 = _rotate_to_z(axis0)
    Pt0 = (P - seed_start) @ Rot0.T  # (N,3); axis ~ +z

    # Seed radius from the median radial offset in the rotated frame (robust to
    # the provisional radius being wrong).
    r_med = float(np.median(np.sqrt(Pt0[:, 0] ** 2 + Pt0[:, 1] ** 2)))
    r0 = r_med if r_med > opts.radius_min else max(seed_radius, opts.radius_min)

    # par = [x0, y0, alpha, beta, r] in the rotated frame.
    par = np.array([0.0, 0.0, 0.0, 0.0, r0], dtype=np.float64)

    def residual_and_jac(par):
        x0, y0, alpha, beta, r = par
        R = _rot(alpha, beta)
        Q = (Pt0 - np.array([x0, y0, 0.0])) @ R.T
        xt, yt = Q[:, 0], Q[:, 1]
        rt = np.sqrt(xt * xt + yt * yt)
        rt_safe = np.where(rt > 1e-12, rt, 1e-12)
        dist = rt - r
        # Normalized radial direction in the rotated frame.
        N = np.stack([xt / rt_safe, yt / rt_safe], axis=1)  # (m,2)
        base = Pt0 - np.array([x0, y0, 0.0])
        A1 = (R @ np.array([-1.0, 0.0, 0.0]))[:2]
        A2 = (R @ np.array([0.0, -1.0, 0.0]))[:2]
        A3 = (base @ _drot_dalpha(alpha, beta).T)[:, :2]
        A4 = (base @ _drot_dbeta(alpha, beta).T)[:, :2]
        J = np.empty((Pt0.shape[0], 5), dtype=np.float64)
        J[:, 0] = N @ A1
        J[:, 1] = N @ A2
        J[:, 2] = np.sum(N * A3, axis=1)
        J[:, 3] = np.sum(N * A4, axis=1)
        J[:, 4] = -1.0
        return dist, J

    ss_prev = np.inf
    reliable = True
    for _ in range(opts.max_iter):
        dist, J = residual_and_jac(par)
        # Huber weights from a robust scale (MAD of residuals).
        scale = 1.4826 * np.median(np.abs(dist - np.median(dist)))
        scale = scale if scale > 1e-9 else (np.std(dist) + 1e-9)
        u = np.abs(dist) / (opts.huber_k * scale)
        w = np.where(u <= 1.0, 1.0, 1.0 / np.maximum(u, 1e-12))
        WJ = J * w[:, None]
        A = J.T @ WJ
        b = J.T @ (w * dist)
        # Reliability gate (near-singular normal matrix).
        if 1.0 / np.linalg.cond(A) < opts.rcond_floor:
            reliable = False
            break
        try:
            step = -np.linalg.solve(A, b)
        except np.linalg.LinAlgError:
            reliable = False
            break
        par = par + step
        par[4] = abs(par[4])  # radius stays positive
        ss = float(np.sqrt(np.sum((w * dist) ** 2)))
        if abs(ss_prev - ss) < opts.tol:
            break
        ss_prev = ss

    x0, y0, alpha, beta, r = par
    r = float(np.clip(abs(r), opts.radius_min, opts.radius_max))

    # Map the fitted axis (a line in the rotated frame: dir = R^-1 z through
    # [x0,y0,0]) back to world coordinates, then project the seed endpoints onto
    # it so the cylinder keeps its axial extent.
    R = _rot(alpha, beta)
    axis_rot = R.T @ np.array([0.0, 0.0, 1.0])  # axis dir in Pt0 frame
    pt_rot = np.array([x0, y0, 0.0])
    axis_world = Rot0.T @ axis_rot
    axis_world /= np.linalg.norm(axis_world) or 1.0
    pt_world = seed_start + Rot0.T @ pt_rot

    def project(p):
        return pt_world + axis_world * float(np.dot(p - pt_world, axis_world))

    fit_start = project(seed_start)
    fit_end = project(seed_end)

    # Quality metrics on the final fit (use the rotated-frame residuals).
    dist, _ = residual_and_jac(par)
    mad = float(np.mean(np.abs(dist)))
    surf_cov = _surface_coverage(P, fit_start, fit_end, r, opts)

    return _FitResult(
        start=fit_start, end=fit_end, radius=r,
        surf_cov=surf_cov, mad=mad, reliable=reliable, n_points=P.shape[0],
    )


def _surface_coverage(
    points: np.ndarray,
    start: np.ndarray,
    end: np.ndarray,
    radius: float,
    opts: CylinderFitOptions,
) -> float:
    """TreeQSM SurfCov: fraction of an nl x ns lateral grid that holds a point.

    nl = max(min_layers, ceil(length/res)) axial layers; ns angular sectors =
    ceil(2*pi*r/res) clamped to [min_sectors, max_sectors]. Only points within
    ``radial_gate * r`` of the axis are counted (excludes outliers / other cyls).
    """
    axis = end - start
    L = float(np.linalg.norm(axis))
    if L <= 0 or radius <= 0:
        return 0.0
    axis_u = axis / L
    ap = points - start[None, :]
    t = ap @ axis_u  # axial coordinate
    radial_vec = ap - t[:, None] * axis_u[None, :]
    radial = np.linalg.norm(radial_vec, axis=1)

    inside = (
        (t >= 0)
        & (t <= L)
        & (radial >= opts.surfcov_band_lo * radius)
        & (radial <= opts.surfcov_band_hi * radius)
    )
    if not np.any(inside):
        return 0.0
    t_in = t[inside]
    rv = radial_vec[inside]

    # Build an orthonormal frame (u, v) perpendicular to the axis for the angle.
    seed_v = np.array([1.0, 0.0, 0.0]) if abs(axis_u[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
    u = seed_v - axis_u * float(np.dot(seed_v, axis_u))
    u /= np.linalg.norm(u) or 1.0
    v = np.cross(axis_u, u)
    ang = np.arctan2(rv @ v, rv @ u)  # [-pi, pi]

    nl = max(opts.surfcov_min_layers, int(np.ceil(L / opts.surfcov_res)))
    ns = int(np.ceil(2.0 * np.pi * radius / opts.surfcov_res))
    ns = min(opts.surfcov_max_sectors, max(opts.surfcov_min_sectors, ns))

    li = np.clip((t_in / L * nl).astype(int), 0, nl - 1)
    si = np.clip(((ang + np.pi) / (2.0 * np.pi) * ns).astype(int), 0, ns - 1)
    occupied = len(set(zip(li.tolist(), si.tolist())))
    return float(occupied) / float(nl * ns)


# ---------------------------------------------------------------------------
# Full-QSM fitting
# ---------------------------------------------------------------------------


def fit_qsm_cylinders(
    qsm: QSM,
    cloud: np.ndarray,
    opts: CylinderFitOptions | None = None,
) -> QSM:
    """Replace provisional cylinder radii in ``qsm`` with point-cloud fits, and
    populate ``surf_cov`` / ``mad`` per cylinder. Topology, shoot membership, and
    rank are preserved exactly -- only ``radius``, ``start``, ``end`` (axial
    re-fit), ``surf_cov`` and ``mad`` change.

    Cylinders that can't be reliably fit (too few points, near-singular normal
    matrix, or a low-coverage radius runaway) KEEP their provisional radius and
    are flagged with the SurfCov/mad we did measure, so Phase E can correct them.
    Returns a NEW QSM (does not mutate the input).
    """
    opts = opts or CylinderFitOptions()
    cloud = np.asarray(cloud, dtype=np.float64)

    new_cyls: list[Cylinder] = []
    if cloud.shape[0] == 0:
        # No cloud: pass through unchanged (radii stay provisional).
        for c in qsm.cylinders:
            new_cyls.append(_clone(c))
        return _rebuild(qsm, new_cyls, fitted=0, reason="empty_cloud")

    # TRUE NEAREST-CYLINDER ASSIGNMENT. Each cloud point is assigned to the single
    # cylinder whose AXIS it is nearest to (a global competition), not to every
    # cylinder within a radial band. This de-conflates the crowded crown: a point
    # on a rank-1 branch's bark goes to that branch, not to the nearby trunk or a
    # sibling, so each cylinder's fit sees its OWN surface. The radius emerges from
    # the points genuinely closest to this axis -- no band prior to guess. Done in
    # ONE batched query against a KD-tree of densely-sampled axis points (each
    # tagged with its cyl_id), so it is fast (O(N log M)) rather than O(N*cyls).
    assigned = _assign_nearest_cylinder(qsm, cloud, opts)

    n_fit = 0
    for c in qsm.cylinders:
        pts = assigned.get(c.cyl_id, _EMPTY)
        fit = (
            fit_cylinder(pts, c.start, c.end, c.radius, opts)
            if pts.shape[0] >= opts.min_points
            else None
        )

        nc = _clone(c)
        if fit is None:
            nc.surf_cov = (
                _surface_coverage(pts, c.start, c.end, c.radius, opts)
                if pts.shape[0] > 0 else 0.0
            )
            nc.mad = None
            new_cyls.append(nc)
            continue

        # Runaway = a fit that ballooned far past the provisional radius on a
        # one-sided arc. The tell-tale of a TRUE balloon is that the points DON'T
        # lie on the inflated circle (large mad relative to radius) AND coverage is
        # low. A short-but-fat trunk slice also has low SurfCov (few axial layers)
        # but its points sit TIGHTLY on the real shell (small mad), so we must NOT
        # reject it. Hence: big-radius + low-coverage + LOOSE fit (or no mad).
        loose = fit.mad is None or fit.mad > opts.runaway_mad_frac * fit.radius
        runaway = (
            fit.radius > opts.runaway_factor * max(c.radius, opts.radius_min)
            and fit.surf_cov < opts.runaway_surfcov
            and loose
        )
        if fit.reliable and not runaway:
            nc.start = fit.start
            nc.end = fit.end
            nc.radius = fit.radius
            nc.surf_cov = fit.surf_cov
            nc.mad = fit.mad
            n_fit += 1
        else:
            nc.surf_cov = fit.surf_cov
            nc.mad = fit.mad
        new_cyls.append(nc)

    return _rebuild(qsm, new_cyls, fitted=n_fit, reason="ok")


_EMPTY = np.zeros((0, 3), dtype=np.float64)


def _assign_nearest_cylinder(
    qsm: QSM, cloud: np.ndarray, opts: CylinderFitOptions
) -> dict[int, np.ndarray]:
    """Assign each cloud point to the cylinder whose AXIS is nearest, returning
    {cyl_id: points (K,3)}.

    Implementation: sample every cylinder's axis at ~``assign_sample_spacing`` and
    build ONE KD-tree over those samples (each remembers its cyl_id). A single
    batched nearest-neighbour query maps every cloud point to its nearest axis
    sample -> nearest cylinder. Points whose nearest axis sample is farther than
    ``max_assign_dist`` (other trees, ground, gross outliers) are dropped. This is
    a per-point hard assignment, so neighbouring cylinders in a dense crown no
    longer share each other's bark. O(N log M); one tree build + one query."""
    samples: list[np.ndarray] = []
    sample_cyl: list[np.ndarray] = []
    spacing = opts.assign_sample_spacing
    for c in qsm.cylinders:
        L = c.length
        n = max(2, int(np.ceil(L / spacing)) + 1) if L > 0 else 1
        ts = np.linspace(0.0, 1.0, n)
        pts = c.start[None, :] + ts[:, None] * (c.end - c.start)[None, :]
        samples.append(pts)
        sample_cyl.append(np.full(n, c.cyl_id, dtype=np.int64))
    if not samples:
        return {}
    axis_pts = np.concatenate(samples, axis=0)
    axis_cyl = np.concatenate(sample_cyl, axis=0)

    axis_tree = cKDTree(axis_pts)
    dist, idx = axis_tree.query(cloud, k=1)
    nearest_cyl = axis_cyl[idx]
    keep = dist <= opts.max_assign_dist

    out: dict[int, np.ndarray] = {}
    cl = cloud[keep]
    nc = nearest_cyl[keep]
    order = np.argsort(nc, kind="stable")
    nc_sorted = nc[order]
    cl_sorted = cl[order]
    # Split the sorted points into per-cylinder contiguous blocks.
    uniq, starts = np.unique(nc_sorted, return_index=True)
    ends = np.append(starts[1:], len(nc_sorted))
    for cid, s, e in zip(uniq.tolist(), starts.tolist(), ends.tolist()):
        out[cid] = cl_sorted[s:e]
    return out


def _assign_points_within(
    c: Cylinder, cloud: np.ndarray, tree: cKDTree, band: float
) -> np.ndarray:
    """Points whose distance to this cylinder's AXIS segment is within ``band``.
    KD-tree pre-filters by a ball around the midpoint; exact segment distance
    prunes. (A point may fall in two cylinders' bands near a fork -- fine, both
    fits see the shared ring.)"""
    reach = 0.5 * c.length + band
    cand_idx = tree.query_ball_point(c.midpoint, reach)
    if not cand_idx:
        return np.zeros((0, 3))
    cand = cloud[cand_idx]
    d = _dist_to_segment(cand, c.start, c.end)
    return cand[d <= band]


def _assign_points(
    c: Cylinder, cloud: np.ndarray, tree: cKDTree, opts: CylinderFitOptions
) -> np.ndarray:
    """Assignment using a band tied to the cylinder's CURRENT radius (used for the
    conditional re-fit, where the radius is already a real fitted value)."""
    band = opts.assign_band_scale * c.radius + opts.assign_band_abs
    return _assign_points_within(c, cloud, tree, band)


def _dist_to_segment(points: np.ndarray, a: np.ndarray, b: np.ndarray) -> np.ndarray:
    ab = b - a
    L2 = float(ab @ ab)
    if L2 == 0:
        return np.linalg.norm(points - a, axis=1)
    t = np.clip((points - a) @ ab / L2, 0.0, 1.0)
    proj = a[None, :] + t[:, None] * ab[None, :]
    return np.linalg.norm(points - proj, axis=1)


def _clone(c: Cylinder) -> Cylinder:
    return Cylinder(
        cyl_id=c.cyl_id, start=c.start.copy(), end=c.end.copy(), radius=c.radius,
        parent_id=c.parent_id, shoot_id=c.shoot_id, rank=c.rank,
        surf_cov=c.surf_cov, mad=c.mad,
    )


def _rebuild(qsm: QSM, cyls: list[Cylinder], fitted: int, reason: str) -> QSM:
    meta = dict(qsm.meta)
    meta.update(
        stage="cylinders",
        provisional_radius=False,
        n_fitted=fitted,
        n_cylinders=len(cyls),
        fit_reason=reason,
    )
    return QSM(cylinders=cyls, shoots=qsm.shoots, units=qsm.units, meta=meta)
