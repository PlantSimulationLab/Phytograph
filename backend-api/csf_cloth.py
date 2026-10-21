"""CSF's cloth, ported from the Apache-2.0 `cloth-simulation-filter` 1.1.7
source (Zhang et al. 2016), with one change: how particles with no point get
a height.

This is `CSF::do_cloth` operation for operation, in CSF's own frame (y up =
minus the elevation), serial like the macOS wheel (built without OpenMP; the
Linux/Windows wheels run the constraint pass in parallel, which is a data
race, so their cloth is not deterministic). With `fill_mode=0` it reproduces
the wheel's cloth bit for bit (`tests/test_csf_cloth.py`), with one caveat:
a particle's position is `origin + i * step` rounded twice, as written and as
the x86 wheels compute it. The macOS arm64 wheel's compiler fuses it into one
FMA, so where two points are EXACTLY tied in distance from a particle (common
on mm-quantized TLS data, e.g. stem points stacked in one column) it can keep
the other one. One convention on every platform was chosen over matching
arm64; on tree_1/tree_4 the two agree on accuracy to within 0.00006.

Why it exists. At a fine cloth, CSF's time is not the simulation but the
height fill in `RasterTerrian`: a particle whose row and column hold no point
floods a BFS of its own until it reaches one, which costs O(empty area) per
such particle - quadratic in the particle count. A terrestrial scan's
bounding box is mostly empty corners, so on a 45.7 M-point scan at a 0.2 m
cloth (1,446 x 982 particles) the fill took 274 s and the 342 iterations of
simulation 38 s. `fill_mode=1` (the default) does the same hop-nearest search
as one multi-source BFS: 1.2 s. It can only pick a different, equally near
particle (a tie in hop count, or one CSF's never-cleared visited flags hid),
which changed 0, 14 and 3 of the 45.7 M labels at 0.2, 0.3 and 0.5 m. Every
one sat 129-171 m out at the bounding box's edge, where a few sparse points
border the filled corners and the cloth moved by up to 0.29 m. The close-range
benchmarks (tree_1, tree_4, the bean fixture) and the 15 ISPRS samples
changed no label.

Tried and rejected, measured on the same data: settling a coarse cloth first
and starting the fine one from it (slower, since pinning is over by ~50
iterations and the rest is cloth sagging between pinned particles, and 5-12 %
of labels flipped, ISPRS accuracy -4 points); a looser stop than 5 mm (5-35 %
of the simulation saved, thousands of labels flipped at 2 cm).

Only the y coordinate of a particle ever changes (gravity and every
correction are vertical), so a particle is its height, its previous height
and a movable flag.

The per-step order is CSF's, and it matters:
  1. Verlet step for every movable particle;
  2. for each particle in index order, each of its neighbor links in the
     order `Cloth::makeConstraint` appended them (Gauss-Seidel, both ends of
     every link visit it);
  3. maxDiff = max |old - new| over MOVABLE particles;
  4. terrain collision pins a particle that has passed its height;
  5. stop when 0 < maxDiff < 0.005.
"""
from __future__ import annotations

import numpy as np
from numba import njit

DAMPING = 0.01
GRAVITY = 0.2
CLOTH_Y_HEIGHT = 0.05
SMOOTH_THRESHOLD = 0.3          # Cloth(..., 0.3, 9999, ...) in CSF::do_cloth
HEIGHT_THRESHOLD = 9999.0
MAX_PARTICLE_FOR_POSTPROCESSING = 50
MIN_INF = -9999999999.0
MAX_INF = 9999999999.0
STOP_TOL = 0.005


def _jit(fn):
    """`njit(cache=True)`, or plain `njit` when numba finds nowhere to cache:
    its locators raise at decoration time (a packaged app whose user cache
    dir is not writable), which would make this module unimportable and
    ground segmentation unavailable over a ~2 s compile."""
    try:
        return njit(cache=True)(fn)
    except RuntimeError:
        return njit(fn)


_SINGLE_MOVE = np.array([0, 0.3, 0.51, 0.657, 0.7599, 0.83193, 0.88235, 0.91765,
                         0.94235, 0.95965, 0.97175, 0.98023, 0.98616, 0.99031, 0.99322])
_DOUBLE_MOVE = np.array([0, 0.3, 0.42, 0.468, 0.4872, 0.4949, 0.498, 0.4992,
                         0.4997, 0.4999, 0.4999, 0.5, 0.5, 0.5, 0.5])


@_jit
def _neighbors(w, h):
    """CSR neighbor lists in `makeConstraint` append order."""
    n = w * h
    count = np.zeros(n + 1, dtype=np.int64)
    links = np.empty((8 * n, 2), dtype=np.int64)    # <= 4 links per particle per distance
    m = 0
    for d in (1, 2):
        for x in range(w):
            for y in range(h):
                if x < w - d:
                    links[m, 0] = y * w + x
                    links[m, 1] = y * w + x + d
                    m += 1
                if y < h - d:
                    links[m, 0] = y * w + x
                    links[m, 1] = (y + d) * w + x
                    m += 1
                if x < w - d and y < h - d:
                    links[m, 0] = y * w + x
                    links[m, 1] = (y + d) * w + x + d
                    m += 1
                    links[m, 0] = y * w + x + d
                    links[m, 1] = (y + d) * w + x
                    m += 1
    for k in range(m):
        count[links[k, 0] + 1] += 1
        count[links[k, 1] + 1] += 1
    for i in range(n):
        count[i + 1] += count[i]
    cur = count[:-1].copy()
    nbr = np.empty(count[n], dtype=np.int64)
    for k in range(m):
        a = links[k, 0]
        b = links[k, 1]
        nbr[cur[a]] = b
        cur[a] += 1
        nbr[cur[b]] = a
        cur[b] += 1
    return count, nbr


@_jit
def _neighbor_height(p, nearest, start, nbr, visited, q, back):
    """Rasterization::findHeightValByNeighbor, quirks included: p is marked
    visited and never unmarked, and p's own neighbors are queued unmarked.
    `q` and `back` are scratch reused across calls; len(particles) + 32 is
    enough, since a particle is queued at most once through `visited` plus
    p's own (at most 16) unmarked neighbors."""
    qh = 0
    qt = 0
    nb = 0
    for k in range(start[p], start[p + 1]):
        visited[p] = True
        q[qt] = nbr[k]
        qt += 1
    while qh < qt:
        c = q[qh]
        qh += 1
        back[nb] = c
        nb += 1
        if nearest[c] > MIN_INF:
            for i in range(nb):
                visited[back[i]] = False
            while qh < qt:
                visited[q[qh]] = False
                qh += 1
            return nearest[c]
        for k in range(start[c], start[c + 1]):
            t = nbr[k]
            if not visited[t]:
                visited[t] = True
                q[qt] = t
                qt += 1
    return MIN_INF


@_jit
def _multi_source_fill(hv, need, nearest, start, nbr):
    """Give every particle in `need` the height of the point-holding particle
    a single BFS from all of them reaches it from first: the hop-nearest one,
    as CSF's per-particle BFS finds, in O(particles) instead of a flood per
    particle. Only a tie in hop distance can pick a different particle."""
    n = len(nearest)
    src = np.full(n, -1, dtype=np.int64)
    q = np.empty(n, dtype=np.int64)
    qt = 0
    for i in range(n):
        if nearest[i] > MIN_INF:
            src[i] = i
            q[qt] = i
            qt += 1
    qh = 0
    while qh < qt:
        c = q[qh]
        qh += 1
        for k in range(start[c], start[c + 1]):
            t = nbr[k]
            if src[t] < 0:
                src[t] = src[c]
                q[qt] = t
                qt += 1
    for i in range(n):
        if need[i]:
            hv[i] = nearest[src[i]] if src[i] >= 0 else MIN_INF


@_jit
def rasterize(xs, ys_csf, zs, origin_x, origin_z, step, w, h, start, nbr, fill_mode=0):
    """Rasterization::RasterTerrian over points given in CSF's frame (x, y =
    minus elevation, z = our y). Returns (heightvals, visited).

    fill_mode 0 is CSF's: a particle with no point takes the first point
    height along its row (right, then left), then its column (down, then
    up), then a BFS flood of its own - which costs O(empty area) per such
    particle, so it grows with the SQUARE of the particle count. Mode 1
    replaces only that last BFS with one multi-source BFS. It also leaves no
    stale `visited` flags behind, which CSF's flood does (it never clears its
    own start particle), and which `movable_filter` reads to skip a particle
    as a component seed."""
    n = w * h
    nearest = np.full(n, MIN_INF)
    tmp = np.full(n, MAX_INF)
    for i in range(len(xs)):
        col = int((xs[i] - origin_x) / step + 0.5)
        row = int((zs[i] - origin_z) / step + 0.5)
        if col >= 0 and row >= 0:
            idx = row * w + col
            px = origin_x + col * step
            pz = origin_z + row * step
            d = (xs[i] - px) * (xs[i] - px) + (zs[i] - pz) * (zs[i] - pz)
            if d < tmp[idx]:
                tmp[idx] = d
                nearest[idx] = ys_csf[i]
    hv = np.empty(n)
    visited = np.zeros(n, dtype=np.bool_)
    q = np.empty(n + 32, dtype=np.int64)
    back = np.empty(n + 32, dtype=np.int64)
    need = np.zeros(n, dtype=np.bool_)
    any_need = False
    for i in range(n):
        if nearest[i] > MIN_INF:
            hv[i] = nearest[i]
            continue
        x = i % w
        y = i // w
        v = MIN_INF
        found = False
        for c in range(x + 1, w):
            if nearest[y * w + c] > MIN_INF:
                v = nearest[y * w + c]
                found = True
                break
        if not found:
            for c in range(x - 1, -1, -1):
                if nearest[y * w + c] > MIN_INF:
                    v = nearest[y * w + c]
                    found = True
                    break
        if not found:
            for r in range(y - 1, -1, -1):
                if nearest[r * w + x] > MIN_INF:
                    v = nearest[r * w + x]
                    found = True
                    break
        if not found:
            for r in range(y + 1, h):
                if nearest[r * w + x] > MIN_INF:
                    v = nearest[r * w + x]
                    found = True
                    break
        if not found:
            if fill_mode == 1:
                need[i] = True
                any_need = True
            else:
                v = _neighbor_height(i, nearest, start, nbr, visited, q, back)
        hv[i] = v
    if any_need:
        _multi_source_fill(hv, need, nearest, start, nbr)
    return hv, visited


@_jit
def simulate(pos, old, movable, hv, start, nbr, rigidness, time_step, iterations):
    """Cloth::timeStep + terrCollision loop of CSF::do_cloth, in place.
    Returns the number of iterations run."""
    n = len(pos)
    ts2 = time_step * time_step
    acc = (-GRAVITY * ts2) / 1.0
    disp = acc * ts2
    damp = 1.0 - DAMPING
    if rigidness > 14:
        dm = 0.5
        sm = 1.0
    else:
        dm = _DOUBLE_MOVE[rigidness]
        sm = _SINGLE_MOVE[rigidness]
    it = 0
    while it < iterations:
        for i in range(n):
            if movable[i]:
                t = pos[i]
                pos[i] = pos[i] + (pos[i] - old[i]) * damp + disp
                old[i] = t
        for j in range(n):
            mj = movable[j]
            for k in range(start[j], start[j + 1]):
                p2 = nbr[k]
                corr = pos[p2] - pos[j]
                m2 = movable[p2]
                if mj and m2:
                    v = corr * dm
                    pos[j] = pos[j] + v
                    pos[p2] = pos[p2] + (-v)
                elif mj:
                    pos[j] = pos[j] + corr * sm
                elif m2:
                    pos[p2] = pos[p2] + (-(corr * sm))
        md = 0.0
        for i in range(n):
            if movable[i]:
                d = abs(old[i] - pos[i])
                if d > md:
                    md = d
        for i in range(n):
            if pos[i] < hv[i]:
                if movable[i]:
                    pos[i] = pos[i] + (hv[i] - pos[i])
                movable[i] = False
        it += 1
        if md != 0.0 and md < STOP_TOL:
            break
    return it


@_jit
def movable_filter(pos, movable, hv, visited, w, h):
    """Cloth::movableFilter (slope smoothing), in place."""
    n = w * h
    cpos = np.zeros(n, dtype=np.int64)
    q = np.empty(n, dtype=np.int64)
    conn = np.empty(n, dtype=np.int64)          # particle index per component slot
    nb = np.empty((n, 4), dtype=np.int64)
    nbc = np.zeros(n, dtype=np.int64)
    for x in range(w):
        for y in range(h):
            p = y * w + x
            if not movable[p] or visited[p]:
                continue
            total = 1
            nconn = 0
            conn[nconn] = p
            nconn += 1
            visited[p] = True
            qh = 0
            qt = 0
            q[qt] = p
            qt += 1
            slot = 0
            while qh < qt:
                c = q[qh]
                qh += 1
                cx = c % w
                cy = c // w
                nbc[slot] = 0
                for dirn in range(4):
                    if dirn == 0:
                        if cx <= 0:
                            continue
                        t = c - 1
                    elif dirn == 1:
                        if cx >= w - 1:
                            continue
                        t = c + 1
                    elif dirn == 2:
                        if cy <= 0:
                            continue
                        t = c - w
                    else:
                        if cy >= h - 1:
                            continue
                        t = c + w
                    if movable[t]:
                        if not visited[t]:
                            total += 1
                            visited[t] = True
                            conn[nconn] = t
                            nconn += 1
                            q[qt] = t
                            qt += 1
                            nb[slot, nbc[slot]] = total - 1
                            nbc[slot] += 1
                            cpos[t] = total - 1
                        else:
                            nb[slot, nbc[slot]] = cpos[t]
                            nbc[slot] += 1
                slot += 1
            if total > MAX_PARTICLE_FOR_POSTPROCESSING:
                # findUnmovablePoint
                edge = np.empty(nconn, dtype=np.int64)
                ne = 0
                for i in range(nconn):
                    idx = conn[i]
                    cx = idx % w
                    cy = idx // w
                    for dirn in range(4):
                        if dirn == 0:
                            if cx <= 0:
                                continue
                            r = idx - 1
                        elif dirn == 1:
                            if cx >= w - 1:
                                continue
                            r = idx + 1
                        elif dirn == 2:
                            if cy <= 0:
                                continue
                            r = idx - w
                        else:
                            if cy >= h - 1:
                                continue
                            r = idx + w
                        if not movable[r]:
                            if (abs(hv[idx] - hv[r]) < SMOOTH_THRESHOLD
                                    and pos[idx] - hv[idx] < HEIGHT_THRESHOLD):
                                if movable[idx]:
                                    pos[idx] = pos[idx] + (hv[idx] - pos[idx])
                                movable[idx] = False
                                edge[ne] = i
                                ne += 1
                                break
                # handle_slop_connected
                seen = np.zeros(nconn, dtype=np.bool_)
                qh = 0
                qt = 0
                for i in range(ne):
                    q[qt] = edge[i]
                    qt += 1
                    seen[edge[i]] = True
                while qh < qt:
                    s = q[qh]
                    qh += 1
                    ic = conn[s]
                    for k in range(nbc[s]):
                        t = nb[s, k]
                        inb = conn[t]
                        if (abs(hv[ic] - hv[inb]) < SMOOTH_THRESHOLD
                                and abs(pos[inb] - hv[inb]) < HEIGHT_THRESHOLD):
                            if movable[inb]:
                                pos[inb] = pos[inb] + (hv[inb] - pos[inb])
                            movable[inb] = False
                            if not seen[t]:
                                q[qt] = t
                                qt += 1
                                seen[t] = True


def settle(sub: np.ndarray, *, cloth_resolution: float, rigidness: int, time_step: float,
           iterations: int, slope_smooth: bool, fill_mode: int = 1):
    """CSF::do_cloth on `sub` (N, 3, our x/y/z, in the order CSF would see
    them). Returns (pos, info): pos is the (height, width) cloth in CSF's
    frame (minus the elevation), the array `do_cloth_export` gives.

    `fill_mode=0` is CSF exactly (tests/test_csf_cloth.py pins it to the
    wheel bit for bit); the default, 1, fills particles with no point in
    their row or column by one multi-source BFS (see `rasterize`)."""
    sub = np.asarray(sub, dtype=np.float64)
    if not np.isfinite(sub).all():
        # The bounding box would go NaN and take the whole cloth with it;
        # callers drop such points first (main.segment_ground).
        raise ValueError("csf_cloth.settle: non-finite coordinates")
    res = float(cloth_resolution)
    lo = sub.min(axis=0)
    hi = sub.max(axis=0)
    origin_x = lo[0] - 2 * res
    origin_z = lo[1] - 2 * res
    w = int(np.floor((hi[0] - lo[0]) / res)) + 4
    h = int(np.floor((hi[1] - lo[1]) / res)) + 4
    start, nbr = _neighbors(w, h)
    xs = np.ascontiguousarray(sub[:, 0])
    ys = np.ascontiguousarray(-sub[:, 2])
    zs = np.ascontiguousarray(sub[:, 1])
    hv, visited = rasterize(xs, ys, zs, origin_x, origin_z, res, w, h, start, nbr, int(fill_mode))
    pos = np.full(w * h, (-lo[2]) + CLOTH_Y_HEIGHT)
    old = pos.copy()
    movable = np.ones(w * h, dtype=np.bool_)
    its = simulate(pos, old, movable, hv, start, nbr, int(rigidness), float(time_step),
                   int(iterations))
    if slope_smooth:
        movable_filter(pos, movable, hv, visited, w, h)
    return pos.reshape(h, w), dict(iterations=int(its), width=w, height=h)
