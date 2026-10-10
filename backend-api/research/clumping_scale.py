"""Research harness: estimating the clumping (heterogeneity) scale of vegetation from a
LiDAR scan, to inform LAD voxel size and/or correct the Beer's-law inversion.

Not shipped. See README.md in this directory.

Beer's law assumes the attenuating medium is homogeneous inside a voxel. When it is not,
mean transmission exceeds the transmission of the mean (Jensen), so the inversion
UNDER-estimates leaf area. This harness builds leaf scenes whose clump scale and exact
per-voxel leaf area are known, scans them with the Helios synthetic scanner, and scores
label-free estimators of the heterogeneity against that truth.

Everything an estimator may read is a per-cell sufficient statistic that the Helios
inversion's own voxel traversal already visits (or could accumulate for free):

    N  beams that entered the cell          H  beams that terminated inside it
    Z  summed FREE path (to the hit, or     D  summed POTENTIAL path (full chord)
       the full chord if transmitted)

so nothing here needs a second pass over the point cloud.
"""

from __future__ import annotations

import math
import os
import sys
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import numpy as np
import numba as nb

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND_DIR = os.path.dirname(_HERE)
_REPO = os.path.dirname(_BACKEND_DIR)
for _p in (os.path.join(_REPO, "pyhelios"), _BACKEND_DIR):
    if _p not in sys.path:
        sys.path.insert(0, _p)


# ----------------------------------------------------------------------------------
# Scenes with known clump scale and exact leaf area
# ----------------------------------------------------------------------------------

@dataclass
class Scene:
    """Square leaves of side ``leaf_w`` in an axis-aligned box. ``centers``/``normals``
    are (M,3); ``tangent_u``/``tangent_v`` are the in-plane half-edge vectors."""
    box_min: np.ndarray
    box_size: np.ndarray
    centers: np.ndarray
    u: np.ndarray
    v: np.ndarray
    leaf_w: float
    label: str = ""
    meta: dict = field(default_factory=dict)

    @property
    def leaf_area(self) -> float:
        return float(len(self.centers) * self.leaf_w ** 2)

    @property
    def mean_lad(self) -> float:
        return self.leaf_area / float(np.prod(self.box_size))


def _random_leaf_frames(rng, m: int, leaf_w: float):
    """Uniformly random leaf normals (spherical leaf-angle distribution => G = 0.5 for
    every beam direction, so a clumping bias cannot hide behind a G(theta) error)."""
    n = rng.normal(size=(m, 3))
    n /= np.linalg.norm(n, axis=1, keepdims=True)
    a = rng.normal(size=(m, 3))
    u = np.cross(n, a)
    u /= np.linalg.norm(u, axis=1, keepdims=True)
    v = np.cross(n, u)
    return u * (leaf_w / 2), v * (leaf_w / 2)


def make_scene(kind: str, lad: float, leaf_w: float = 0.05, clump_sigma: float = 0.15,
               leaves_per_clump: float = 60.0, box: float = 4.0, z0: float = 0.5,
               seed: int = 0, crown_radius: float = 0.9, n_crowns: int = 4) -> Scene:
    """``kind``:
      'uniform'  Poisson leaves (the null: no clumping beyond the leaf itself).
      'clumped'  Neyman-Scott: Poisson clump centers, leaves Gaussian (sigma) about them.
                 The leaf-density field then has covariance ~ exp(-h^2 / 4 sigma^2), so
                 the ground-truth heterogeneity scale is sigma (FWHM of a clump 2.35 sigma).
      'crowns'   two scales: spherical crowns with gaps between them, shoots clumped inside.
    Positions wrap periodically in the box, so the mean LAD is exact and the field is
    stationary right up to the box faces.
    """
    rng = np.random.default_rng(seed)
    box_min = np.array([-box / 2, -box / 2, z0])
    box_size = np.array([box, box, box])
    m = int(round(lad * box ** 3 / leaf_w ** 2))
    if kind == "uniform":
        c = rng.uniform(0, 1, size=(m, 3)) * box_size
    elif kind == "clumped":
        nc = max(1, int(round(m / leaves_per_clump)))
        cc = rng.uniform(0, 1, size=(nc, 3)) * box_size
        c = cc[rng.integers(0, nc, size=m)] + rng.normal(scale=clump_sigma, size=(m, 3))
        c = np.mod(c, box_size)
    elif kind == "crowns":
        # crown centers on a jittered lattice so crowns don't pile up
        g = int(math.ceil(n_crowns ** (1 / 2)))
        xy = np.array([[(i + 0.5) / g, (j + 0.5) / g] for i in range(g) for j in range(g)])[:n_crowns]
        xy = (xy + rng.uniform(-0.08, 0.08, xy.shape)) * box
        crown_c = np.column_stack([xy, np.full(len(xy), box / 2)])
        nc = max(1, int(round(m / leaves_per_clump)))
        # shoot centers uniform inside crown spheres
        d = rng.normal(size=(nc, 3))
        d /= np.linalg.norm(d, axis=1, keepdims=True)
        r = crown_radius * rng.uniform(0, 1, nc) ** (1 / 3)
        cc = crown_c[rng.integers(0, len(crown_c), nc)] + d * r[:, None]
        c = cc[rng.integers(0, nc, size=m)] + rng.normal(scale=clump_sigma, size=(m, 3))
        c = np.clip(c, 0.01, box - 0.01)
    else:
        raise ValueError(kind)
    u, v = _random_leaf_frames(rng, m, leaf_w)
    return Scene(box_min, box_size, c + box_min, u, v, leaf_w, label=kind,
                 meta=dict(kind=kind, lad=lad, leaf_w=leaf_w, clump_sigma=clump_sigma,
                           leaves_per_clump=leaves_per_clump, seed=seed))


def true_leaf_area_grid(scene: Scene, n: int) -> np.ndarray:
    """Exact-ish leaf area per cell of an n^3 grid over the box: each leaf is split into
    a 4x4 lattice of sub-areas so a leaf straddling a face is apportioned, not assigned."""
    k = 4
    s = (np.arange(k) + 0.5) / k * 2 - 1
    a = np.zeros((n, n, n))
    da = scene.leaf_w ** 2 / (k * k)
    for su in s:
        for sv in s:
            p = scene.centers + su * scene.u + sv * scene.v
            ijk = np.floor((p - scene.box_min) / scene.box_size * n).astype(np.int64)
            ok = np.all((ijk >= 0) & (ijk < n), axis=1)
            np.add.at(a, (ijk[ok, 0], ijk[ok, 1], ijk[ok, 2]), da)
    return a


# ----------------------------------------------------------------------------------
# Helios synthetic scan -> beams
# ----------------------------------------------------------------------------------

@dataclass
class Beams:
    origin: np.ndarray   # (B,3) float64
    direction: np.ndarray  # (B,3) unit
    t_hit: np.ndarray    # (B,) range to the return; +inf for a miss
    scan: np.ndarray     # (B,) int
    weight: Optional[np.ndarray] = None  # (B,) share of its pulse; None = 1 (single return)


def default_scanners(scene: Scene, n_scans: int = 4, standoff: float = 5.0, height: float = 1.5):
    cx, cy = scene.box_min[:2] + scene.box_size[:2] / 2
    az = [math.pi / 4 + i * (2 * math.pi / max(n_scans, 1)) for i in range(n_scans)]
    if n_scans == 2:
        az = [math.pi / 4, math.pi / 4 + math.pi / 2]
    r = standoff * math.sqrt(2)
    return [(cx + r * math.sin(a), cy + r * math.cos(a), height) for a in az]


def scan_scene(scene: Scene, scanners, ang_res_deg: float = 0.1, range_noise: float = 0.0,
               **multi) -> Beams:
    """Scan a leaf scene with the Helios synthetic scanner (misses recorded)."""
    c, u, v = scene.centers, scene.u, scene.v
    quads = np.stack([c - u - v, c + u - v, c + u + v, c - u + v], axis=1)
    tris = np.concatenate([quads[:, [0, 1, 2]], quads[:, [0, 2, 3]]])
    return scan_triangles(tris, scene.box_min, scene.box_size, scanners, ang_res_deg, range_noise, **multi)


def scan_triangles(tris: np.ndarray, box_min, box_size, scanners, ang_res_deg: float = 0.1,
                   range_noise: float = 0.0, rays_per_pulse: Optional[int] = None,
                   exit_diameter: float = 0.0, beam_divergence: float = 0.0,
                   pulse_distance_threshold: float = 0.05) -> Beams:
    """Scan a (T,3,3) triangle soup; one beam per recorded point (hit or miss). The scan
    window is clipped to the box's angular bounding rectangle.

    With ``rays_per_pulse`` the pulse is a finite-footprint bundle that can produce several
    returns. Each recorded return then becomes its own beam carrying an EQUAL share
    1/(returns of that pulse) -- the convention of Helios' accumulateBeamCell, which
    counts a pulse's returns and does not weight them by energy."""
    from pyhelios import Context, LiDARCloud

    t = len(tris)
    verts = tris.reshape(-1, 3).astype(np.float32)
    faces = np.arange(3 * t, dtype=np.int32).reshape(t, 3)
    corners = np.array([[box_min[0] + i * box_size[0], box_min[1] + j * box_size[1],
                         box_min[2] + k * box_size[2]]
                        for i in (0, 1) for j in (0, 1) for k in (0, 1)])
    res = math.radians(ang_res_deg)
    with Context() as ctx:
        ctx.addTrianglesFromArrays(verts, faces)
        with LiDARCloud() as lidar:
            lidar.disableMessages()
            for sc in scanners:
                d = corners - np.asarray(sc)
                zen = np.arccos(d[:, 2] / np.linalg.norm(d, axis=1))
                azi = np.mod(np.arctan2(d[:, 0], d[:, 1]), 2 * math.pi)
                if azi.max() - azi.min() > math.pi:  # straddles 0
                    raise ValueError("scanner azimuth window straddles 0; move the scanner")
                pad = 2 * res
                th = (max(zen.min() - pad, 0.0), min(zen.max() + pad, math.pi))
                ph = (azi.min() - pad, azi.max() + pad)
                lidar.addScan(origin=list(sc),
                              Ntheta=int(round((th[1] - th[0]) / res)), theta_range=th,
                              Nphi=int(round((ph[1] - ph[0]) / res)), phi_range=ph,
                              exit_diameter=exit_diameter, beam_divergence=beam_divergence,
                              range_noise_stddev=range_noise)
            weight = None
            if rays_per_pulse:
                ctx.seedRandomGenerator(12345)
                lidar.syntheticScan(ctx, rays_per_pulse=int(rays_per_pulse),
                                    pulse_distance_threshold=pulse_distance_threshold,
                                    record_misses=True)
            else:
                lidar.syntheticScan(ctx, record_misses=True)
            xyz, _ = lidar.getHitsXYZRGBArrays()
            miss = np.asarray(lidar.getHitMissArray()).astype(bool)
            sid = np.asarray(lidar.getHitScanIDArray()).astype(np.int64)
            if rays_per_pulse:
                ts = np.asarray(lidar.getHitDataColumnArray("timestamp"))
                _, inv, cnt = np.unique(np.column_stack([sid.astype(np.float64), ts]), axis=0,
                                        return_inverse=True, return_counts=True)
                weight = 1.0 / cnt[inv.ravel()]
    xyz = xyz.astype(np.float64)
    o = np.asarray(scanners, dtype=np.float64)[sid]
    d = xyz - o
    r = np.linalg.norm(d, axis=1)
    d /= r[:, None]
    return Beams(o, d, np.where(miss, np.inf, r), sid, weight)


# ----------------------------------------------------------------------------------
# Voxel traversal -> per-cell sufficient statistics
# ----------------------------------------------------------------------------------

N_DBINS = 12  # potential-path-length histogram bins on [0, sqrt(3)*cell]


@nb.njit(parallel=True, cache=True, fastmath=True)
def _traverse(origin, direction, t_hit, wgt, g0, cell, n, nthreads):
    nc = n * n * n
    N = np.zeros((nthreads, nc), np.float32)
    H = np.zeros((nthreads, nc), np.float32)
    Z = np.zeros((nthreads, nc), np.float64)
    D = np.zeros((nthreads, nc), np.float64)
    DH = np.zeros((nthreads, nc, N_DBINS), np.float32)   # count per path bin
    DS = np.zeros((nthreads, nc, N_DBINS), np.float32)   # summed path per bin
    dmax = cell * math.sqrt(3.0) * 1.0001
    B = origin.shape[0]
    gmax = g0 + cell * n
    for b in nb.prange(B):
        tid = nb.get_thread_id()
        o = origin[b]
        u = direction[b]
        t0 = 0.0
        t1 = 1e30
        ok = True
        for a in range(3):
            if abs(u[a]) < 1e-12:
                if o[a] < g0[a] or o[a] > gmax[a]:
                    ok = False
            else:
                ta = (g0[a] - o[a]) / u[a]
                tb = (gmax[a] - o[a]) / u[a]
                if ta > tb:
                    ta, tb = tb, ta
                if ta > t0:
                    t0 = ta
                if tb < t1:
                    t1 = tb
        if (not ok) or t0 >= t1:
            continue
        th = t_hit[b]
        w = wgt[b]
        if th <= t0:
            continue  # terminated before the grid
        ijk = np.empty(3, np.int64)
        step = np.empty(3, np.int64)
        tmax = np.empty(3, np.float64)
        tdel = np.empty(3, np.float64)
        tstart = t0 + 1e-9
        for a in range(3):
            p = o[a] + tstart * u[a]
            i = int(math.floor((p - g0[a]) / cell))
            if i < 0:
                i = 0
            if i >= n:
                i = n - 1
            ijk[a] = i
            if u[a] > 1e-12:
                step[a] = 1
                tmax[a] = (g0[a] + (i + 1) * cell - o[a]) / u[a]
                tdel[a] = cell / u[a]
            elif u[a] < -1e-12:
                step[a] = -1
                tmax[a] = (g0[a] + i * cell - o[a]) / u[a]
                tdel[a] = -cell / u[a]
            else:
                step[a] = 0
                tmax[a] = 1e30
                tdel[a] = 1e30
        t = t0
        while True:
            a = 0
            if tmax[1] < tmax[a]:
                a = 1
            if tmax[2] < tmax[a]:
                a = 2
            tn = tmax[a]
            if tn > t1:
                tn = t1
            d = tn - t
            if d > 1e-9:
                c = (ijk[0] * n + ijk[1]) * n + ijk[2]
                N[tid, c] += w
                D[tid, c] += w * d
                kb = int(d / dmax * N_DBINS)
                if kb >= N_DBINS:
                    kb = N_DBINS - 1
                DH[tid, c, kb] += w
                DS[tid, c, kb] += w * d
                if th <= tn:
                    H[tid, c] += w
                    Z[tid, c] += w * (th - t)
                    break
                Z[tid, c] += w * d
            if tmax[a] >= t1 or step[a] == 0:
                break
            t = tmax[a]
            ijk[a] += step[a]
            if ijk[a] < 0 or ijk[a] >= n:
                break
            tmax[a] += tdel[a]
    return N.sum(0), H.sum(0), Z.sum(0), D.sum(0), DH.sum(0), DS.sum(0)


@dataclass
class CellStats:
    n: int
    cell: float
    N: np.ndarray
    H: np.ndarray
    Z: np.ndarray
    D: np.ndarray
    DH: np.ndarray
    DS: np.ndarray

    def grid(self, a):
        return a.reshape(self.n, self.n, self.n)


def traverse(beams: Beams, scene: Scene, n: int) -> CellStats:
    cell = float(scene.box_size[0] / n)
    wgt = np.ones(len(beams.t_hit)) if beams.weight is None else beams.weight.astype(np.float64)
    N, H, Z, D, DH, DS = _traverse(beams.origin, beams.direction, beams.t_hit, wgt,
                                   scene.box_min.astype(np.float64), cell, n,
                                   nb.get_num_threads())
    return CellStats(n, cell, N.astype(np.float64), H.astype(np.float64), Z, D,
                     DH.astype(np.float64), DS.astype(np.float64))


# ----------------------------------------------------------------------------------
# Baseline estimators of the attenuation coefficient lambda = G * LAD
# ----------------------------------------------------------------------------------

def lam_beer(st: CellStats, min_beams: int = 5) -> np.ndarray:
    """Helios' estimator: solve mean_i exp(-lam * d_i) = P over the entering beams, with
    the potential path lengths taken from a histogram. NaN where N < min_beams; a fully
    intercepted cell is capped with the Pimont bounded RDI (I <= 1 - 1/(2N+2))."""
    N, H = st.N, st.H
    ok = N >= min_beams
    P = np.where(ok, 1 - H / np.maximum(N, 1), np.nan)
    P = np.maximum(P, 1.0 / (2 * np.maximum(N, 1) + 2))
    w = st.DH / np.maximum(N, 1)[:, None]
    dbar = st.DS / np.maximum(st.DH, 1e-9)
    lam = np.where(ok, -np.log(P) / np.maximum(st.D / np.maximum(N, 1), 1e-9), np.nan)
    for _ in range(30):  # Newton on f(lam) = sum w exp(-lam d) - P  (convex, monotone)
        e = w * np.exp(-lam[:, None] * dbar)
        f = e.sum(1) - P
        fp = -(e * dbar).sum(1)
        lam = np.where(ok, np.maximum(lam - f / np.minimum(fp, -1e-12), 0.0), np.nan)
    return lam


def lam_mle(st: CellStats, min_beams: int = 5) -> np.ndarray:
    """Contact-frequency / maximum-likelihood estimator, hits per unit free path. Its
    sufficient statistics are ADDITIVE across cells, which is what makes it the natural
    currency for multi-scale work."""
    return np.where(st.N >= min_beams, st.H / np.maximum(st.Z, 1e-12), np.nan)


def coarsen(a: np.ndarray, f: int, how: str = "sum") -> np.ndarray:
    n = a.shape[0] // f
    r = a.reshape(n, f, n, f, n, f)
    if how == "sum":
        return r.sum((1, 3, 5))
    if how == "nanmean":
        return np.nanmean(r, (1, 3, 5))
    return r.mean((1, 3, 5))


# ----------------------------------------------------------------------------------
# Heterogeneity estimators
# ----------------------------------------------------------------------------------

def covariance_profile(lam: np.ndarray, valid: np.ndarray, cell: float, max_lag: float,
                       weights: Optional[np.ndarray] = None):
    """Radially averaged autocovariance of a masked 3-D field at lattice lags > 0.

    Only CROSS-cell products are used, so measurement noise that is independent between
    cells (beam shot noise, and leaf-level Poisson noise once cell > leaf) drops out
    without having to model it -- the reason to prefer this to a variance at lag 0.
    Returns (h, C, npairs) sorted by lag, lag 0 excluded.
    """
    n = lam.shape[0]
    w = valid.astype(np.float64) if weights is None else np.where(valid, weights, 0.0)
    mu = float((np.where(valid, lam, 0.0) * w).sum() / max(w.sum(), 1e-12))
    x = np.where(valid, lam - mu, 0.0) * w
    s = (2 * n,) * 3
    fx = np.fft.rfftn(x, s=s, axes=(0, 1, 2))
    fm = np.fft.rfftn(w, s=s, axes=(0, 1, 2))
    num = np.fft.irfftn(fx * np.conj(fx), s=s, axes=(0, 1, 2))
    den = np.fft.irfftn(fm * np.conj(fm), s=s, axes=(0, 1, 2))
    L = int(min(n - 1, math.ceil(max_lag / cell)))
    idx = np.arange(-L, L + 1)
    ii, jj, kk = np.meshgrid(idx, idx, idx, indexing="ij")
    r2 = (ii * ii + jj * jj + kk * kk).ravel()
    numv = num[ii % (2 * n), jj % (2 * n), kk % (2 * n)].ravel()
    denv = den[ii % (2 * n), jj % (2 * n), kk % (2 * n)].ravel()
    keep = (r2 > 0) & (r2 <= L * L)
    r2, numv, denv = r2[keep], numv[keep], denv[keep]
    uniq, inv = np.unique(r2, return_inverse=True)
    ns = np.bincount(inv, numv)
    ds = np.bincount(inv, denv)
    return np.sqrt(uniq) * cell, ns / np.maximum(ds, 1e-9), ds, mu


_CHORDS = None


def cube_chords(nsamp: int = 4000, seed: int = 7) -> np.ndarray:
    """Chord lengths of isotropic uniform random lines through a UNIT cube (mean 2/3)."""
    global _CHORDS
    if _CHORDS is not None and len(_CHORDS) == nsamp:
        return _CHORDS
    rng = np.random.default_rng(seed)
    out = []
    while sum(len(o) for o in out) < nsamp:
        m = nsamp * 4
        u = rng.normal(size=(m, 3))
        u /= np.linalg.norm(u, axis=1, keepdims=True)
        # mu-random lines: uniform point on a plane perpendicular to u, through a ball
        a = rng.normal(size=(m, 3))
        e1 = np.cross(u, a); e1 /= np.linalg.norm(e1, axis=1, keepdims=True)
        e2 = np.cross(u, e1)
        rr = math.sqrt(3) / 2 * np.sqrt(rng.uniform(size=m)); ph = rng.uniform(0, 2 * math.pi, m)
        p = 0.5 + e1 * (rr * np.cos(ph))[:, None] + e2 * (rr * np.sin(ph))[:, None]
        with np.errstate(divide="ignore", invalid="ignore"):
            ta = (0 - p) / u; tb = (1 - p) / u
        t0 = np.minimum(ta, tb).max(1); t1 = np.maximum(ta, tb).min(1)
        d = t1 - t0
        out.append(d[d > 1e-6])
    _CHORDS = np.concatenate(out)[:nsamp]
    return _CHORDS


def tau_variance(d: np.ndarray, cov_fn) -> np.ndarray:
    """Var of the optical depth along a chord of length d through a stationary field with
    line covariance cov_fn(h):  V(d) = 2 * int_0^d (d - h) C(h) dh."""
    q = (np.arange(64) + 0.5) / 64
    h = d[:, None] * q[None, :]
    return 2 * (d[:, None] * (d[:, None] - h) * cov_fn(h)).mean(1)


def _solve_beer(P: float, d: np.ndarray) -> float:
    lo, hi = 0.0, 1e4
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        if np.exp(-mid * d).mean() > P:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


_PAIRS = None


def cube_pair_distances(nsamp: int = 4000, seed: int = 11) -> np.ndarray:
    """Distances between pairs of uniform random points in a UNIT cube."""
    global _PAIRS
    if _PAIRS is None or len(_PAIRS) != nsamp:
        rng = np.random.default_rng(seed)
        _PAIRS = np.linalg.norm(rng.uniform(size=(nsamp, 3)) - rng.uniform(size=(nsamp, 3)), axis=1)
    return _PAIRS


def predict_omega(mu: float, cov_fn, voxel: float, model: str = "gamma") -> float:
    """Predicted ratio (Beer's-law lambda at this voxel size) / (true mean lambda), for a
    medium whose attenuation field has mean mu and covariance cov_fn(h).

    Only heterogeneity INSIDE a voxel biases its inversion; a voxel that is uniformly
    denser than its neighbor is inverted correctly. So the variance that matters is the
    chord optical depth's variance WITHIN a voxel:

        V_w(d) = 2 int_0^d (d-h) C(h) dh  -  d^2 * blockvar(voxel)

    the total minus the variance of the voxel's own mean. Forgetting the second term
    predicts a bias that never goes away as the voxel shrinks.

    'gamma': chord optical depth Gamma distributed => negative-binomial transmission
    (1 + mu d / k)^-k with k = (mu d)^2 / V_w (Nilson 1971).
    'second': second-order expansion exp(-mu d) (1 + V_w/2).
    """
    d = cube_chords() * voxel
    blockvar = float(np.mean(cov_fn(cube_pair_distances() * voxel)))
    V = np.maximum(tau_variance(d, cov_fn) - d * d * blockvar, 0.0)
    t = mu * d
    if model == "gamma":
        k = np.where(V > 1e-12, t * t / np.maximum(V, 1e-12), 1e12)
        Pd = np.exp(-k * np.log1p(t / k))
    else:
        Pd = np.exp(-t) * (1 + V / 2)
    return _solve_beer(float(Pd.mean()), d) / mu


def fit_covariance(h, C, npairs, fit_max: float):
    """Fit C(h) = s * exp(-(h/ell)^p) to the empirical profile (p in [1,2]: exponential
    ... Gaussian). Returns dict(s, ell, p, integral_scale, fn)."""
    from scipy.optimize import least_squares
    from scipy.special import gamma as gfn
    m = h <= fit_max
    hh, cc, ww = h[m], C[m], np.sqrt(npairs[m] / npairs[m].max())
    s0 = max(cc[0], 1e-9)

    def res(pv):
        s, ell, p = pv
        return ww * (s * np.exp(-(hh / ell) ** p) - cc)
    best = None
    for ell0 in (1.01 * hh[0], 3 * hh[0], fit_max / 2):
        for p0 in (1.0, 2.0):
            r = least_squares(res, [s0 * 2, ell0, p0],
                              bounds=([0, hh[0], 1.0], [np.inf, fit_max * 20, 2.0]))
            if best is None or r.cost < best.cost:
                best = r
    s, ell, p = best.x
    return dict(s=float(s), ell=float(ell), p=float(p),
                integral_scale=float(ell * gfn(1 + 1 / p)),
                fn=lambda x: s * np.exp(-(np.abs(x) / ell) ** p))


# ----------------------------------------------------------------------------------
# Scale ladder: one fine pass, every coarser level by ADDING sufficient statistics
# ----------------------------------------------------------------------------------

def ladder(st: CellStats, min_beams: int = 10, min_path_cells: float = 3.0):
    """Mean attenuation coefficient as a function of voxel size, from ONE fine traversal.

    H (hits) and Z (free path) are additive, so the contact-frequency estimate of any
    coarser voxel is sum(H)/sum(Z) over its children -- no re-traversal. A cell too
    poorly probed to estimate inherits its parent's value (top-down fill), so every level
    is a mean over the same volume.

    Returns list of (voxel_size, mean_lambda, unsampled_fraction, filled_field, raw_field,
    sampled_mask), fine -> coarse.
    """
    n = st.n
    H = st.grid(st.H); Z = st.grid(st.Z); N = st.grid(st.N)
    levels = []
    f = 1
    while n // f >= 1:
        Hc, Zc = coarsen(H, f), coarsen(Z, f)
        # a parent is trusted on total free path (N is not additive across children)
        okc = (Zc >= min_path_cells * st.cell * f * min_beams / 3.0) if f > 1 else (N >= min_beams)
        levels.append((f, Hc / np.maximum(Zc, 1e-12), okc))
        if n // f == 1:
            break
        f *= 2
    # top-down fill
    filled = [None] * len(levels)
    f, lam, ok = levels[-1]
    filled[-1] = np.where(ok, lam, 0.0)
    for i in range(len(levels) - 2, -1, -1):
        f, lam, ok = levels[i]
        parent = np.repeat(np.repeat(np.repeat(filled[i + 1], 2, 0), 2, 1), 2, 2)
        filled[i] = np.where(ok, lam, parent)
    out = []
    for (f, lam, ok), fl in zip(levels, filled):
        out.append((st.cell * f, float(fl.mean()), float(1 - ok.mean()), fl, lam, ok))
    return out


# Residual overestimate of the decoupled reference when a leaf spans several cells, measured
# on uniform canopies: ~ coef * (leaf_width / reference cell)^2. Only applied when a width is given.
LEAF_SPAN_COEF = 0.15


def pair_up(st: CellStats) -> CellStats:
    """Merge 2x2x2 fine cells into one, by SUMMING the children's statistics.

    The summed potential path D is deliberately not the parent's own potential path: a
    beam stopped in the first child contributes nothing for the children behind it. So it
    counts potential path only up to the sub-cell where the beam ended, which resolves
    most of the within-cell shading geometrically and leaves the g() factor in
    decoupled_field() little to do. Measured on clumped scenes this is what takes the
    reference from ~0.95 of truth (parent's own D) to ~1.00-1.03.
    """
    n = st.n // 2
    c = lambda a: coarsen(st.grid(a), 2).ravel()
    D = c(st.D)
    N = D / (st.cell * 2 * 2.0 / 3.0)   # beams are not additive; path / mean chord of a cube
    empty = np.zeros((n ** 3, N_DBINS))
    return CellStats(n, st.cell * 2, N, c(st.H), c(st.Z), D, empty, empty)

_NEIGHBOR_LAGS = np.array([math.sqrt(i * i + j * j + k * k) for i in (-1, 0, 1)
                           for j in (-1, 0, 1) for k in (-1, 0, 1) if (i, j, k) != (0, 0, 0)])


def decoupled_field(st: CellStats, min_beams: int = 10):
    """Per-cell attenuation estimate that needs no leaf width. Returns (field, sampled).

    Hits over FREE path (and Beer's law, which is the same thing) is biased upward in a
    cell that holds only a leaf or two: each hit also shortens that cell's own free path,
    so numerator and denominator share their noise, and a leaf blocks many neighboring
    beams at once so the noise does not average down with beam count. That is the
    "leaf-size bias" (~ +0.2 (leaf / voxel)^2 for Beer's law on a uniform canopy).

    Decoupling removes it at the source instead of correcting for it:

        lambda_c = H_c / D_c * g(f_nb),   g(f) = -ln(1 - f) / f

    H over POTENTIAL path D is linear in the cell's own hits (D does not depend on them),
    and the within-cell shading factor g is evaluated at the hit fraction of the 26
    NEIGHBORS, whose noise is independent of this cell's.
    """
    from scipy.ndimage import uniform_filter
    H, N, D = st.grid(st.H), st.grid(st.N), st.grid(st.D)
    sH = uniform_filter(H, 3, mode="constant") * 27 - H
    sN = uniform_filter(N, 3, mode="constant") * 27 - N
    f = np.clip(sH / np.maximum(sN, 1e-9), 0, 1 - 1 / (2 * np.maximum(sN, 1) + 2))
    g = np.where(f > 1e-6, -np.log1p(-f) / np.maximum(f, 1e-6), 1.0)
    return H / np.maximum(D, 1e-12) * g, N >= min_beams


def analyze(st: CellStats, leaf_w: Optional[float] = None, min_beams: int = 10,
            fit_max: float = 1.0) -> dict:
    """Label-free heterogeneity analysis from one fine traversal's cell statistics.

    Returns the clump scale (integral scale of the attenuation field), its strength
    (CV^2), a bias-free reference mean attenuation, and the predicted Beer's-law bias
    factor omega(voxel) for every dyadic voxel size.

    ``st`` is the FINE traversal; the reference is built one level up (2 x its cell) from
    paired-up statistics, see pair_up().

    ``leaf_w`` is OPTIONAL: the reference comes from decoupled_field(), which has no
    leaf-size term. A width only trims the residual left when leaves span several
    reference cells (a few percent at cell ~ 2 leaf widths).
    """
    lv = ladder(st, min_beams)
    rs = pair_up(st)
    lam, ok = decoupled_field(rs, min_beams)
    parent = np.repeat(np.repeat(np.repeat(lv[2][3], 2, 0), 2, 1), 2, 2)
    fine = np.where(ok, lam, parent)          # unsampled cells inherit their parent
    base = float(fine.mean())
    h, C, npair, mu = covariance_profile(np.where(ok, lam, 0.0), ok, rs.cell, fit_max * 1.5)
    fit = fit_covariance(h, C, npair, fit_max)
    # The neighbors' hit fraction is smoother than the cell's own, so g is a little low in
    # the dense cells. The shortfall is (mean chord / 2) * [C(0) - C(neighbor lags)] of the
    # REAL field, which the fitted covariance supplies without the noise.
    restore = 0.5 * (rs.cell * 2.0 / 3.0) * (fit["s"] - float(np.mean(fit["fn"](_NEIGHBOR_LAGS * rs.cell))))
    span = 1.0 + (LEAF_SPAN_COEF * (leaf_w / rs.cell) ** 2 if leaf_w else 0.0)
    debiased = (base + restore) / span
    sub = predict_omega(max(debiased, 1e-9), fit["fn"], rs.cell, "gamma")
    ref = debiased / sub
    return dict(
        cell=st.cell, ref_cell=rs.cell, mu=mu, fit=fit, scale=fit["integral_scale"],
        cv2=fit["s"] / max(mu * mu, 1e-12), fine_mean=base, restore=restore,
        span_factor=span, subgrid_omega=sub, ref=ref, filled=lv[0][2],
        unsampled=[l[2] for l in lv], sizes=[l[0] for l in lv], means=[l[1] for l in lv],
        omega_ladder=[l[1] / ref for l in lv],
        omega_model=[predict_omega(ref, fit["fn"], l[0], "gamma") for l in lv],
        fine_field=fine * (ref / max(base, 1e-12)),
    )


def recommend_voxel(an: dict, tol: float = 0.05, max_unsampled: float = 0.05) -> dict:
    """Largest voxel whose predicted total bias (clumping low + leaf-size high) is within
    ``tol``, among sizes that are adequately sampled. If none qualifies, the least-biased
    adequately sampled size, flagged so the caller applies the correction instead."""
    cand = [(c, o) for c, o, u in zip(an["sizes"], an["omega_ladder"], an["unsampled"])
            if u <= max_unsampled and c >= an["ref_cell"]]
    if not cand:
        cand = list(zip(an["sizes"], an["omega_ladder"]))[1:2]
    ok = [c for c, o in cand if abs(o - 1) <= tol]
    if ok:
        return dict(voxel=max(ok), needs_correction=False)
    c, o = min(cand, key=lambda t: abs(t[1] - 1))
    return dict(voxel=c, needs_correction=True, omega=o)


def plant_leaf_triangles(model: str, age: float, seed: int = 1) -> np.ndarray:
    """Leaf primitives of a PlantArchitecture plant as an untextured (T,3,3) triangle
    soup (quads split). Wood is dropped so the projected-area truth is unambiguous."""
    from pyhelios import Context, PlantArchitecture
    from pyhelios.types import vec3
    with Context() as ctx:
        ctx.seedRandomGenerator(int(seed))
        pa = PlantArchitecture(ctx)
        pa.loadPlantModelFromLibrary(model)
        pa.buildPlantInstanceFromLibrary(vec3(0.0, 0.0, 0.0), float(age))
        out = []
        for u in pa.getAllLeafUUIDs():
            v = np.array([(p.x, p.y, p.z) for p in ctx.getPrimitiveVertices(int(u))])
            out.append(v[[0, 1, 2]])
            if len(v) == 4:
                out.append(v[[0, 2, 3]])
    return np.array(out)


def projected_area_total(tris: np.ndarray, scanner) -> float:
    """Sum of triangle area * |n . beam| seen from one scanner: the exact volume integral
    of the attenuation coefficient for that scan, with no G(theta) assumption."""
    n = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])  # |n| = 2 * area
    d = tris.mean(1) - np.asarray(scanner)
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    return float(0.5 * np.abs((n * d).sum(1)).sum())


# ----------------------------------------------------------------------------------
# Sweeps
# ----------------------------------------------------------------------------------

G_SPHERICAL = 0.5


def _true_omega(beams: Beams, box, truth_lambda_total: float, sizes) -> Dict[float, float]:
    """Ground truth: (Beer's-law total at each voxel size) / (true total)."""
    out = {}
    for c in sizes:
        n = int(round(box.box_size[0] / c))
        st = traverse(beams, box, n)
        out[c] = float(np.nansum(lam_beer(st)) * st.cell ** 3 / truth_lambda_total)
    return out


def _report(tag: str, an: dict, tru: Dict[float, float], true_mean_lambda: float, true_scale=None,
            ref_with_width=None):
    lad = dict(zip(an["sizes"], an["omega_ladder"]))
    rec = recommend_voxel(an)
    ks = sorted(tru, reverse=True)
    ts = f"{true_scale:.2f}" if true_scale else "  - "
    ww = f" ({ref_with_width:.2f} with width)" if ref_with_width else ""
    print(f"{tag:44s} scale {an['scale']:.2f}/{ts}  ref/true {an['ref'] / true_mean_lambda:.2f}{ww}  "
          f"omega true|ladder: " + "  ".join(f"{tru[k]:.2f}|{lad[k]:.2f}" for k in ks) +
          f"  -> voxel {rec['voxel']:.2f}" + (" +correction" if rec["needs_correction"] else ""))


def sweep_scenes(nf: int = 64):
    cases = [dict(kind="uniform", lad=1.0), dict(kind="uniform", lad=3.0),
             dict(kind="uniform", lad=1.0, n_scans=1), dict(kind="uniform", lad=1.0, res=0.3)]
    for sig, lpc in ((0.05, 60), (0.1, 60), (0.1, 200), (0.2, 60), (0.2, 400), (0.4, 1500)):
        cases.append(dict(kind="clumped", lad=1.0, clump_sigma=sig, leaves_per_clump=lpc))
    cases += [dict(kind="clumped", lad=l, clump_sigma=0.2, leaves_per_clump=400) for l in (0.3, 3.0)]
    cases += [dict(kind="clumped", lad=1.0, clump_sigma=0.2, leaves_per_clump=400, **k)
              for k in (dict(res=0.3), dict(n_scans=1), dict(noise=0.01))]
    for div in (0.00035, 0.003):              # finite footprint -> several returns per pulse
        mr = dict(rays_per_pulse=20, exit_diameter=0.007, beam_divergence=div)
        cases += [dict(kind="uniform", lad=1.0, res=0.2, multi=mr),
                  dict(kind="clumped", lad=1.0, clump_sigma=0.2, leaves_per_clump=400, res=0.2, multi=mr)]
    cases += [dict(kind="crowns", lad=0.5, clump_sigma=0.1, leaves_per_clump=60),
              dict(kind="crowns", lad=1.0, clump_sigma=0.15, leaves_per_clump=200)]
    print("omega columns: voxel 1.0, 0.5, 0.25 m; reference cell 0.125 m; scale = integral scale (est/true); ref = NO leaf width")
    for c in cases:
        c = dict(c)
        res, ns, noise = c.pop("res", 0.1), c.pop("n_scans", 4), c.pop("noise", 0.0)
        multi = c.pop("multi", {})
        sc = make_scene(seed=1, **c)
        bm = scan_scene(sc, default_scanners(sc, ns), res, noise, **multi)
        st = traverse(bm, sc, nf)
        an = analyze(st)                      # no leaf width supplied
        with_w = analyze(st, sc.leaf_w)["ref"]
        lam_true = G_SPHERICAL * sc.mean_lad
        tru = _true_omega(bm, sc, lam_true * float(np.prod(sc.box_size)), [1.0, 0.5, 0.25])
        tag = f"{c['kind'][:5]} LAD={c['lad']} s={c.get('clump_sigma', 0)} m={c.get('leaves_per_clump', 0)} res={res} scans={ns}" + (f" div={multi['beam_divergence'] * 1e3:g}mrad" if multi else "")
        _report(tag, an, tru, lam_true,
                c["clump_sigma"] * math.sqrt(math.pi) if c["kind"] == "clumped" else None,
                with_w / lam_true)


def sweep_plants(nf: int = 64, res: float = 0.05):
    """Realistic architecture: PlantArchitecture trees, one scan position at a time, scored
    against the exact projected leaf area seen from that position (no G assumption)."""
    class Box:  # traverse()/_true_omega() only need the box
        pass
    for model, age, w in (("almond", 1300, 0.05), ("walnut", 1300, 0.10)):
        tris = plant_leaf_triangles(model, age)
        lo, hi = tris.reshape(-1, 3).min(0), tris.reshape(-1, 3).max(0)
        side = float((hi - lo).max()) * 1.02
        box = Box()
        box.box_min, box.box_size = (lo + hi) / 2 - side / 2, np.array([side] * 3)
        r = (side / 2 + 1.5) * math.sqrt(2)
        ctr = (lo + hi) / 2
        for az in (math.pi / 4, 3 * math.pi / 4):
            scn = (ctr[0] + r * math.sin(az), ctr[1] + r * math.cos(az), 1.2)
            bm = scan_triangles(tris, box.box_min, box.box_size, [scn], res)
            truth = projected_area_total(tris, scn)
            st = traverse(bm, box, nf)
            an = analyze(st)
            sizes = an["sizes"][2:5][::-1]
            _report(f"{model} age={age} az={math.degrees(az):.0f}", an,
                    _true_omega(bm, box, truth, sizes), truth / side ** 3,
                    ref_with_width=analyze(st, w)["ref"] / (truth / side ** 3))


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--plants", action="store_true", help="also run the PlantArchitecture trees")
    args = ap.parse_args()
    sweep_scenes()
    if args.plants:
        sweep_plants()
