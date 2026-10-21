"""How multi-return pulses should be weighted in the Beer's-law LAD inversion.

Research harness (not shipped). Companion to clumping_scale.py, whose scene/scan/traversal
helpers it reuses. Uniform leaf canopy, Helios finite-footprint scans (40 rays/pulse), pooled
attenuation sum(H)/sum(Z) over the box divided by the true G*LAD; a single-ray scan reads 0.987.

Two recording conventions:
  * Helios synthetic MULTI mode also writes a "partial miss" row for the energy that left the
    pulse unintercepted. Equal weighting over all rows (accumulateBeamCell) is then close to
    right with no detection threshold, and reads LOW as the threshold rises.
  * A real instrument never records that row. Equal weighting then treats every partial edge
    hit as a full interception and reads HIGH (leaves effectively grow by the footprint).
Energy weighting (return weight = intercepted fraction, escaped remainder as a transmitted
beam) is exact, but only with the true fraction; driven by reflectance it inherits the
calibration error of a "full-footprint" return.

    venv/bin/python -u research/multireturn_weighting.py            # synthetic tables
    venv/bin/python -u research/multireturn_weighting.py --real a.laz [b.laz ...]   # RIEGL floor
"""
import math
import sys

import numpy as np

from clumping_scale import G_SPHERICAL, Beams, default_scanners, make_scene, traverse

RAYS = 40


def raw_scan(scene, scanners, ang_res_deg, rays, divergence, threshold, exit_diameter=0.007,
             range_resolution=0.05):
    """Helios scan of a leaf scene keeping every recorded row and its per-return columns."""
    from pyhelios import Context, LiDARCloud
    c, u, v = scene.centers, scene.u, scene.v
    q = np.stack([c - u - v, c + u - v, c + u + v, c - u + v], axis=1)
    tris = np.concatenate([q[:, [0, 1, 2]], q[:, [0, 2, 3]]])
    verts = tris.reshape(-1, 3).astype(np.float32)
    faces = np.arange(len(verts), dtype=np.int32).reshape(-1, 3)
    lo, sz = scene.box_min, scene.box_size
    corners = np.array([[lo[0] + i * sz[0], lo[1] + j * sz[1], lo[2] + k * sz[2]]
                        for i in (0, 1) for j in (0, 1) for k in (0, 1)])
    res = math.radians(ang_res_deg)
    multi = rays > 1
    with Context() as ctx:
        ctx.addTrianglesFromArrays(verts, faces)
        with LiDARCloud() as lidar:
            lidar.disableMessages()
            for i, sc in enumerate(scanners):
                d = corners - np.asarray(sc)
                zen = np.arccos(d[:, 2] / np.linalg.norm(d, axis=1))
                azi = np.mod(np.arctan2(d[:, 0], d[:, 1]), 2 * math.pi)
                th = (zen.min() - 2 * res, zen.max() + 2 * res)
                ph = (azi.min() - 2 * res, azi.max() + 2 * res)
                lidar.addScan(origin=list(sc), Ntheta=int(round((th[1] - th[0]) / res)), theta_range=th,
                              Nphi=int(round((ph[1] - ph[0]) / res)), phi_range=ph,
                              exit_diameter=exit_diameter if multi else 0.0,
                              beam_divergence=divergence if multi else 0.0)
                lidar.setScanDetectionThreshold(i, threshold)
            ctx.seedRandomGenerator(12345)
            if multi:
                lidar.syntheticScan(ctx, rays_per_pulse=rays, pulse_distance_threshold=range_resolution,
                                    record_misses=True)
            else:
                lidar.syntheticScan(ctx, record_misses=True)
            xyz, _ = lidar.getHitsXYZRGBArrays()
            out = dict(xyz=xyz.astype(np.float64), miss=np.asarray(lidar.getHitMissArray()).astype(bool),
                       sid=np.asarray(lidar.getHitScanIDArray()).astype(np.int64))
            if multi:
                for k in ("timestamp", "nRaysHit", "intensity"):
                    out[k] = np.asarray(lidar.getHitDataColumnArray(k))
    out["origin"] = np.asarray(scanners, float)[out["sid"]]
    return out


def _beams(raw, weight, keep):
    o = raw["origin"][keep]
    d = raw["xyz"][keep] - o
    r = np.linalg.norm(d, axis=1)
    return Beams(o, d / r[:, None], np.where(raw["miss"][keep], np.inf, r), raw["sid"][keep], weight)


def _pulses(raw):
    _, pid, cnt = np.unique(np.column_stack([raw["sid"].astype(float), raw["timestamp"]]), axis=0,
                            return_inverse=True, return_counts=True)
    pid = pid.ravel()
    nreal = np.bincount(pid, weights=(~raw["miss"]).astype(float), minlength=len(cnt))
    return pid, cnt, nreal


def equal_weights(raw, real_format=True):
    """accumulateBeamCell's convention: each recorded row of a pulse carries 1/rows. With
    real_format the partial-miss rows a real instrument never writes are dropped first."""
    if "timestamp" not in raw:
        return _beams(raw, None, np.ones(len(raw["miss"]), bool))
    pid, cnt, nreal = _pulses(raw)
    keep = ~(raw["miss"] & (nreal[pid] > 0)) if real_format else np.ones(len(pid), bool)
    rows = np.bincount(pid[keep], minlength=len(cnt))
    return _beams(raw, 1.0 / rows[pid[keep]], keep)


def energy_weights(raw, f, tau=None):
    """Real-format record. Return k carries its intercepted fraction f_k (a pulse is capped at 1);
    the escaped remainder 1 - sum(f) becomes a transmitted beam along the pulse's last return.
    With tau, a pulse whose last return has f >= tau is taken as fully intercepted (F = 1)."""
    pid, cnt, nreal = _pulses(raw)
    real = ~raw["miss"]
    full_miss = raw["miss"] & (nreal[pid] == 0)
    f = np.where(real, np.clip(f, 0, None), 0.0)
    order = np.nonzero(real)[0]
    last = np.full(len(cnt), -1)
    last[pid[order]] = order
    s = np.bincount(pid, weights=f, minlength=len(cnt))
    F = np.minimum(s, 1.0)
    if tau is not None:
        has = nreal > 0
        F[has] = np.where(f[last[has]] >= tau, 1.0, F[has])
    w = np.where(real, F[pid] * f / np.maximum(s[pid], 1e-12), 0.0)
    p = np.nonzero((nreal > 0) & (F < 0.999))[0]
    idx = last[p]
    keep = real | full_miss
    b = _beams(raw, np.where(full_miss, 1.0, w)[keep], keep)
    d2 = raw["xyz"][idx] - raw["origin"][idx]
    d2 /= np.linalg.norm(d2, axis=1)[:, None]
    return Beams(np.r_[b.origin, raw["origin"][idx]], np.r_[b.direction, d2],
                 np.r_[b.t_hit, np.full(len(idx), np.inf)], np.r_[b.scan, raw["sid"][idx]],
                 np.r_[b.weight, 1 - F[p]])


def pooled(beams, scene, n=8):
    st = traverse(beams, scene, n)
    return st.H.sum() / st.Z.sum() / (G_SPHERICAL * scene.mean_lad)


def sweep():
    rng = np.random.default_rng(7)
    for w in (0.05, 0.10):
        sc = make_scene("uniform", 1.0, leaf_w=w, seed=1)
        scn = default_scanners(sc, 4)
        print(f"leaf {w} m: single ray {pooled(equal_weights(raw_scan(sc, scn, 0.2, 1, 0, 0)), sc):.3f}")
        for div in (0.00035, 0.001, 0.003):
            for thr in (0.0, 0.05, 0.1):
                raw = raw_scan(sc, scn, 0.2, RAYS, div, thr)
                f = np.where(raw["miss"], 0.0, raw["nRaysHit"] / RAYS)
                print(f"  div {div * 1e3:4.2f} mrad thr {thr:.2f}: equal, Helios rows "
                      f"{pooled(equal_weights(raw, False), sc):.3f}  equal, real rows "
                      f"{pooled(equal_weights(raw), sc):.3f}  energy (true f) "
                      f"{pooled(energy_weights(raw, f), sc):.3f}", flush=True)
            if div == 0.001:
                continue
            raw = raw_scan(sc, scn, 0.2, RAYS, div, 0.0)
            f = np.where(raw["miss"], 0.0, raw["nRaysHit"] / RAYS)
            noise = 10 ** (rng.normal(0, 1.5, len(f)) / 10)
            for tau in (None, 0.3):
                vals = [pooled(energy_weights(raw, f * noise * 10 ** (db / 10), tau), sc) for db in (-2, -1, 0, 1, 2)]
                print(f"    energy, 1.5 dB per-return noise, tau={tau}: full-hit calibration "
                      f"-2/-1/0/+1/+2 dB -> " + " ".join(f"{v:.3f}" for v in vals), flush=True)


def real_floor(paths):
    """RIEGL amplitude is dB above the detection threshold and reflectance is dB relative to a
    full-footprint white target, so reflectance - amplitude is the floor in reflectance units.
    Prints it against the reflectance of single-return pulses and of 2-return pulse sums."""
    import laspy
    for path in paths:
        las = laspy.read(path)
        r = np.sqrt(np.asarray(las.x) ** 2 + np.asarray(las.y) ** 2 + np.asarray(las.z) ** 2)
        R = np.asarray(las["reflectance"], float)
        A = np.asarray(las["amplitude"], float)
        n = np.asarray(las["target_count"]).astype(int)
        t = np.asarray(las.gps_time)
        hit = n > 0
        r, R, A, n, t = r[hit], R[hit], A[hit], n[hit], t[hit]
        _, pid, cnt = np.unique(t, return_inverse=True, return_counts=True)
        complete = (cnt == np.bincount(pid, weights=n) / cnt)
        s = 10 * np.log10(np.bincount(pid, weights=10 ** (R / 10)))
        rp = np.bincount(pid, weights=r) / cnt
        print(path.split("/")[-1])
        for lo, hi in ((3, 6), (6, 10), (10, 20), (20, 40), (40, 80)):
            m = (r >= lo) & (r < hi)
            sel = complete & (rp >= lo) & (rp < hi)
            one, two = sel & (cnt == 1), sel & (cnt == 2)
            if one.sum() < 500 or two.sum() < 500:
                continue
            full = np.percentile(s[one], 90)
            floor = np.median(R[m] - A[m])
            q = lambda v: "/".join(f"{x:.1f}" for x in np.percentile(v, [50, 75, 90]))
            print(f"  {lo:>2}-{hi:<2} m  points in multi-return pulses {np.mean(n[m] > 1):.2f}  "
                  f"single p50/75/90 {q(s[one])} dB  2-return sum {q(s[two])} dB  "
                  f"floor {floor:.1f} dB = {10 ** ((floor - full) / 10):.4f} of a full return")


if __name__ == "__main__":
    if "--real" in sys.argv:
        real_floor(sys.argv[sys.argv.index("--real") + 1:])
    else:
        sweep()
