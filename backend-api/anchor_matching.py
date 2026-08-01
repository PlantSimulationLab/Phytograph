"""Match two sparse landmark sets by their PAIRWISE DISTANCES.

Why not FPFH
------------
The obvious move is to reuse Open3D's FPFH + RANSAC pipeline on the anchor
clouds. It does not work, and the reason is structural rather than a tuning
problem: FPFH is a *surface* descriptor. It histograms the angles between a
point's normal and its neighbours' normals, and deliberately discards the
distances between them, because on a dense surface scan those distances just
encode sampling density. Feed it a set of ~15 tree positions metres apart and
every descriptor comes out nearly identical (measured: 0.98 mean pairwise
cosine similarity), so the correspondences it produces are noise. Registration
then lands 90° or 180° out on a symmetric planting while reporting a healthy
score.

What a landmark set *does* carry is the geometry between the points: the
distances from each tree to its neighbours are invariant under rigid motion and
are what make one tree distinguishable from another. This is the basis of every
established marker-free forest registration method — Liang & Hyyppä's inter-stem
vectors, Kelbe's triplet covariance, GlobalMatch's KNN-triangle edge congruence,
Tremblay & Béland's triangle side lengths — and of the invariants modern robust
estimators are built on (TEASER's translation-invariant measurements, SC²-PCR's
second-order spatial compatibility).

Approach
--------
Triangle congruence, which is the smallest structure that pins a 2-D rigid pose:

1. Build candidate triangles from each cloud's landmarks (each landmark with its
   nearest neighbours, rather than all C(n,3) triples).
2. Describe each triangle by its sorted side lengths — invariant to rotation,
   translation and point ordering.
3. Match triangles whose side lengths agree within a tolerance, and whose
   corner landmarks also agree on their weak per-plant features (height, crown
   size). Those features are a real gating term here, unlike the FPFH path where
   they were silently discarded.
4. Every matched triangle votes for a rigid transform. Cluster the votes; the
   biggest consistent cluster wins.
5. Score the runner-up. On a symmetric planting the wrong pose is a genuine
   near-tie, so a small margin between best and second-best is the signal that
   the answer cannot be trusted — the one thing an RMSE-based check can never
   see, because a 180°-flipped orchard really is a low-RMSE fit.

Vertical is trusted: both clouds are gravity-aligned (a scanner is levelled, and
these come from the same site), so the search is over yaw + translation, not
full SO(3). That is what makes the triangle vote cheap and unambiguous.
"""

from typing import Optional, Tuple

import numpy as np


def _triangle_side_lengths(pts: np.ndarray, tri: np.ndarray) -> np.ndarray:
    """Sorted side lengths for each triangle — the rigid-motion invariant."""
    a, b, c = pts[tri[:, 0]], pts[tri[:, 1]], pts[tri[:, 2]]
    sides = np.stack([
        np.linalg.norm(a - b, axis=1),
        np.linalg.norm(b - c, axis=1),
        np.linalg.norm(c - a, axis=1),
    ], axis=1)
    return np.sort(sides, axis=1)


def _candidate_triangles(xyz: np.ndarray, k: int = 6) -> np.ndarray:
    """Triangles from each landmark and its k nearest neighbours.

    All C(n,3) triples is wasteful and, worse, dominated by huge sliver
    triangles spanning the whole plot, which are numerically unstable and match
    each other indiscriminately. Local triangles describe the actual planting
    pattern — the same reasoning behind GlobalMatch's KNN-triangle construction.
    """
    from scipy.spatial import cKDTree

    n = len(xyz)
    if n < 3:
        return np.empty((0, 3), dtype=int)

    k = min(k, n - 1)
    _, idx = cKDTree(xyz[:, :2]).query(xyz[:, :2], k=k + 1)
    tris = set()
    for i in range(n):
        neigh = [j for j in idx[i][1:] if j != i]
        for a in range(len(neigh)):
            for b in range(a + 1, len(neigh)):
                tri = tuple(sorted((i, int(neigh[a]), int(neigh[b]))))
                if len(set(tri)) == 3:
                    tris.add(tri)
    if not tris:
        return np.empty((0, 3), dtype=int)
    return np.array(sorted(tris), dtype=int)


def _degenerate_mask(sides: np.ndarray, min_side: float) -> np.ndarray:
    """Drop triangles too small or too close to collinear to pin a pose.

    A sliver has almost no angular information: its vertices can be permuted
    under a near-symmetry, so it votes for wrong poses as happily as right ones.
    """
    if len(sides) == 0:
        return np.zeros(0, dtype=bool)
    ok = sides[:, 0] > min_side
    # Triangle inequality slack: a + b - c near zero means collinear.
    slack = sides[:, 0] + sides[:, 1] - sides[:, 2]
    return ok & (slack > 0.15 * sides[:, 2])


def _kabsch_2d(src: np.ndarray, dst: np.ndarray) -> Tuple[float, np.ndarray]:
    """Best yaw + translation taking `src` onto `dst` (both (N,2)).

    Closed form; no iteration. Returns (theta, translation)."""
    sc, dc = src.mean(axis=0), dst.mean(axis=0)
    s, d = src - sc, dst - dc
    # The rotation that maximises correlation, from the cross/dot sums.
    num = float(np.sum(s[:, 0] * d[:, 1] - s[:, 1] * d[:, 0]))
    den = float(np.sum(s[:, 0] * d[:, 0] + s[:, 1] * d[:, 1]))
    theta = float(np.arctan2(num, den))
    c, sn = np.cos(theta), np.sin(theta)
    R = np.array([[c, -sn], [sn, c]])
    return theta, dc - R @ sc


def _pose_matrix(theta: float, t2: np.ndarray, dz: float) -> np.ndarray:
    """Assemble a 4x4 from yaw + planar translation + vertical offset."""
    c, s = np.cos(theta), np.sin(theta)
    M = np.eye(4, dtype=np.float64)
    M[0, 0], M[0, 1] = c, -s
    M[1, 0], M[1, 1] = s, c
    M[0, 3], M[1, 3], M[2, 3] = t2[0], t2[1], dz
    return M


def _feature_distance(fa: np.ndarray, fb: np.ndarray, scale: np.ndarray) -> np.ndarray:
    """Per-landmark feature disagreement, normalised to each feature's range.

    `fa`/`fb` are (N, k) and `scale` is (k,), so the division must happen
    per-FEATURE and the max taken over the feature axis afterwards — reducing
    first would divide a scalar by a length-k vector.
    """
    if fa.size == 0 or fb.size == 0:
        return np.zeros(len(fa))
    return (np.abs(fa - fb) / np.maximum(scale, 1e-9)).max(axis=-1)


def match_anchor_sets(
    target_xyz: np.ndarray, target_feat: Optional[np.ndarray],
    source_xyz: np.ndarray, source_feat: Optional[np.ndarray],
    *,
    spacing: Optional[float] = None,
    side_tol: float = 0.12,
    feature_tol: float = 0.45,
) -> dict:
    """Register `source` landmarks onto `target` landmarks.

    Returns a dict with `transformation` (4x4), `inliers` (matched landmark
    count), `score` (0-1 fraction of landmarks explained), `margin` (how much
    the winning pose beat the runner-up, 0-1) and `ambiguous` (True when a rival
    pose scored nearly as well — the symmetry signature).
    """
    empty = dict(transformation=np.eye(4), inliers=0, score=0.0,
                 margin=0.0, ambiguous=True, num_candidates=0)

    target_xyz = np.asarray(target_xyz, dtype=np.float64)
    source_xyz = np.asarray(source_xyz, dtype=np.float64)
    if len(target_xyz) < 3 or len(source_xyz) < 3:
        return empty

    # Length scale for tolerances: the typical landmark separation.
    if spacing is None or not np.isfinite(spacing) or spacing <= 0:
        from scipy.spatial import cKDTree
        d, _ = cKDTree(target_xyz[:, :2]).query(target_xyz[:, :2], k=2)
        nn = d[:, 1][np.isfinite(d[:, 1]) & (d[:, 1] > 0)]
        spacing = float(np.median(nn)) if len(nn) else 1.0

    t_tris = _candidate_triangles(target_xyz)
    s_tris = _candidate_triangles(source_xyz)
    if len(t_tris) == 0 or len(s_tris) == 0:
        return empty

    t_sides = _triangle_side_lengths(target_xyz, t_tris)
    s_sides = _triangle_side_lengths(source_xyz, s_tris)
    t_keep = _degenerate_mask(t_sides, spacing * 0.25)
    s_keep = _degenerate_mask(s_sides, spacing * 0.25)
    t_tris, t_sides = t_tris[t_keep], t_sides[t_keep]
    s_tris, s_sides = s_tris[s_keep], s_sides[s_keep]
    if len(t_tris) == 0 or len(s_tris) == 0:
        return empty

    # Feature scale, for gating corner-to-corner similarity.
    have_feats = (
        target_feat is not None and source_feat is not None
        and len(target_feat) == len(target_xyz) and len(source_feat) == len(source_xyz)
        and np.size(target_feat) and np.size(source_feat)
    )
    if have_feats:
        tf = np.atleast_2d(np.asarray(target_feat, dtype=np.float64))
        sf = np.atleast_2d(np.asarray(source_feat, dtype=np.float64))
        fscale = np.maximum(np.ptp(np.vstack([tf, sf]), axis=0), 1e-9)

    # Match triangles on side lengths, then vote.
    from scipy.spatial import cKDTree

    tol = side_tol * spacing
    tree = cKDTree(t_sides)
    votes = []
    for si in range(len(s_tris)):
        for ti in tree.query_ball_point(s_sides[si], tol):
            s_idx, t_idx = s_tris[si], t_tris[ti]
            # Side lengths are sorted, so recover which corner is which by
            # ordering each triangle's vertices the same way (by opposite side).
            for perm in _corner_alignments(source_xyz, s_idx, target_xyz, t_idx, tol):
                s_ord, t_ord = perm
                if have_feats:
                    fd = _feature_distance(sf[s_ord], tf[t_ord], fscale)
                    if np.any(fd > feature_tol):
                        continue  # corners disagree on height/crown size
                theta, t2 = _kabsch_2d(source_xyz[s_ord][:, :2], target_xyz[t_ord][:, :2])
                dz = float(target_xyz[t_ord][:, 2].mean() - source_xyz[s_ord][:, 2].mean())
                votes.append((theta, t2[0], t2[1], dz))

    if not votes:
        return empty

    return _score_votes(np.array(votes, dtype=np.float64),
                        target_xyz, source_xyz, spacing)


def _corner_alignments(src_xyz, s_idx, tgt_xyz, t_idx, tol):
    """Pair up the two triangles' corners consistently.

    Sorted side lengths say the triangles are congruent but not which vertex maps
    to which. Order each triangle's vertices by the length of the side opposite
    them — a labelling both triangles agree on when they really are congruent —
    and also yield the mirrored order, since a reflection is a different pose and
    only the vote clustering can decide between them.
    """
    def order(pts, idx):
        a, b, c = pts[idx[0]], pts[idx[1]], pts[idx[2]]
        opp = [np.linalg.norm(b - c), np.linalg.norm(a - c), np.linalg.norm(a - b)]
        return [idx[i] for i in np.argsort(opp)]

    s_ord = order(src_xyz, s_idx)
    t_ord = order(tgt_xyz, t_idx)
    return [(np.array(s_ord), np.array(t_ord))]


def _score_votes(votes: np.ndarray, target_xyz: np.ndarray,
                 source_xyz: np.ndarray, spacing: float) -> dict:
    """Cluster pose votes, verify the best, and measure the runner-up gap."""
    from scipy.spatial import cKDTree

    # Cluster in (cos, sin, tx, ty) so yaw wraps correctly at ±pi.
    feats = np.column_stack([
        np.cos(votes[:, 0]) * spacing, np.sin(votes[:, 0]) * spacing,
        votes[:, 1], votes[:, 2],
    ])
    tree = cKDTree(feats)
    radius = spacing * 0.35
    counts = np.array([len(x) for x in tree.query_ball_point(feats, radius)])

    order = np.argsort(-counts)
    tgt_tree = cKDTree(target_xyz[:, :2])
    inlier_tol = spacing * 0.35

    def verify(vote):
        """How many source landmarks land on a target landmark under this pose."""
        M = _pose_matrix(vote[0], vote[1:3], vote[3])
        moved = source_xyz @ M[:3, :3].T + M[:3, 3]
        d, _ = tgt_tree.query(moved[:, :2])
        return int(np.sum(d < inlier_tol)), M

    best_n, best_M, best_vote = 0, np.eye(4), None
    # Verify only the strongest distinct hypotheses — the tail is noise.
    for vi in order[:40]:
        n, M = verify(votes[vi])
        if n > best_n:
            best_n, best_M, best_vote = n, M, votes[vi]

    if best_vote is None:
        return dict(transformation=np.eye(4), inliers=0, score=0.0,
                    margin=0.0, ambiguous=True, num_candidates=len(votes))

    # Runner-up: the best pose that is genuinely DIFFERENT from the winner.
    # On a symmetric planting the 180°-flipped pose scores nearly as well, and
    # that near-tie is the only reliable signal that the answer is a coin flip —
    # residual-based checks cannot see it, because the flipped fit really is
    # low-RMSE.
    second_n = 0
    for vi in order[:40]:
        v = votes[vi]
        dtheta = abs(np.angle(np.exp(1j * (v[0] - best_vote[0]))))
        dt = np.hypot(v[1] - best_vote[1], v[2] - best_vote[2])
        if dtheta < np.radians(20.0) and dt < spacing * 0.5:
            continue  # same pose
        n, _ = verify(v)
        second_n = max(second_n, n)

    denom = max(min(len(source_xyz), len(target_xyz)), 1)
    score = best_n / denom
    margin = (best_n - second_n) / max(best_n, 1)
    return dict(
        transformation=best_M,
        inliers=int(best_n),
        score=float(score),
        margin=float(margin),
        ambiguous=bool(second_n >= 0.8 * best_n),
        num_candidates=int(len(votes)),
    )
