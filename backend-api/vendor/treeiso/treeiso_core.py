"""Individual-tree isolation via the TreeIso cut-pursuit graph method.

Adapted from TreeIso (`PythonCpp/treeiso.py`, commit dcf4a743) by
Zhouxin Xi & Loïc Landrieu — see UPSTREAM_LICENSE.txt (MIT) and PROVENANCE.md.

Changes from upstream:
  - The module-level ``PR_*`` constants are replaced by a :class:`TreeIsoParams`
    dataclass threaded through every stage, so parameters can be set per request.
  - File/laspy I/O (``process_las_file``, ``process_csv_file``, ``read_csv_file``,
    ``main``) is dropped. Phytograph passes numpy arrays and reads numpy labels.
  - A single entry point :func:`segment_trees` runs the three-stage pipeline on an
    (N, 3) array and returns the per-point integer tree label at full resolution
    (1..K; 0 is reserved for "unassigned" by the caller — this function returns
    contiguous 1-based ids for the points it is given).

The algorithm is unchanged: 3D cut-pursuit (init) -> 2D cut-pursuit
(intermediate) -> similarity-based segment merging (final). No neural network,
no GPU; the C++ ``cut_pursuit_py`` accelerates the graph cut, with a pure-Python
fallback.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import numpy_indexed as npi
from scipy.spatial import cKDTree, ConvexHull
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import connected_components
from skimage import draw

# Try the optimized C++ cut-pursuit first, fall back to the pure-Python L0 port.
try:  # pragma: no cover - exercised by whichever backend is installed
    from cut_pursuit_py import perform_cut_pursuit

    USE_CPP = True
except ImportError:  # pragma: no cover
    from cut_pursuit_L0 import perform_cut_pursuit

    USE_CPP = False


@dataclass
class TreeIsoParams:
    """Tunable TreeIso parameters (defaults match upstream Xi & Hopkinson 2022)."""

    # Stage 1 — initial 3D cut-pursuit over the decimated cloud.
    reg_strength1: float = 1.0   # lambda1
    min_nn1: int = 5             # K1 (key)
    decimate_res1: float = 0.05  # voxel size for stage-1 decimation (m)

    # Stage 2 — intermediate 2D cut-pursuit over stage-1 segment centroids.
    reg_strength2: float = 15.0  # lambda2 (key)
    min_nn2: int = 20            # K2 (key)
    decimate_res2: float = 0.1   # voxel size for stage-2 decimation (m)
    max_gap: float = 2.0         # max intra-tree point gap from occlusion (m)

    # Stage 3 — similarity-based merging into final trees.
    rel_height_length_ratio: float = 0.5      # rho
    vertical_weight: float = 0.5              # w
    min_nn3: int = 20
    score_candidate_thresh: float = 0.7
    init_stem_rel_length_thresh: float = 1.5

    # Post-processing: split an instance wherever its own points are separated by
    # a 3D gap wider than this (see `_split_across_gaps`). Note this is SMALLER
    # than `max_gap`, and intentionally so — `max_gap` is how far stage 2 may
    # reach to CONNECT an occlusion-separated limb, whereas this is the distance
    # beyond which a body is a DIFFERENT tree.
    #
    # 0.65 m is the midpoint of the range that is correct on BOTH calibration
    # datasets: 0.55-0.90 on TreeIso's 9-ground-truth-tree demo cloud (0.5 splits
    # it into 10; 0.4 into 22) and 0.50-0.75 on the Nickels almond scan (1.0
    # reabsorbs the neighbouring tree). See treeSegmentDefaults.ts for the full
    # sweep. Upstream's 3.0 is NOT a comparable default — it is commented
    # "trivial: post-processing to remove isolated points", i.e. noise cleanup
    # behind an opt-in flag, and at that distance nothing splits on close-range
    # TLS (measured inter-tree merges at 0.92 m / 1.72 m).
    max_outlier_gap: float = 0.65


# --------------------------------------------------------------------------- #
# Geometry helpers (verbatim from upstream, parameter-free)
# --------------------------------------------------------------------------- #
def overlapping(conv_hull1, conv_hull2):
    """2D horizontal overlap ratio between two convex hulls (max over either)."""
    conv_hull1 = np.array(conv_hull1)
    conv_hull2 = np.array(conv_hull2)

    scale = 10
    conv_hull_combo = np.vstack((conv_hull1, conv_hull2))
    conv_hull_combo_min = np.min(conv_hull_combo, axis=0)

    digitize_size = np.ceil(
        np.max(conv_hull_combo[:, :2] - conv_hull_combo_min, axis=0) * scale
    ) + 10
    digitize_size = digitize_size.astype(int)
    digitize_size = [digitize_size[1], digitize_size[0]]

    hull1_scaled = (conv_hull1 - conv_hull_combo_min) * scale
    hull2_scaled = (conv_hull2 - conv_hull_combo_min) * scale

    conv_mask1 = np.zeros(digitize_size, dtype=np.uint8)
    conv_mask2 = np.zeros(digitize_size, dtype=np.uint8)

    r1, c1 = hull1_scaled[:, 1], hull1_scaled[:, 0]
    r2, c2 = hull2_scaled[:, 1], hull2_scaled[:, 0]

    rr1, cc1 = draw.polygon(r1, c1)
    rr2, cc2 = draw.polygon(r2, c2)

    conv_mask1[rr1, cc1] = 1
    conv_mask2[rr2, cc2] = 1

    conv_intersect_mask = conv_mask1 & conv_mask2

    intersection_area = np.sum(conv_intersect_mask)
    mask1_area = np.sum(conv_mask1)
    mask2_area = np.sum(conv_mask2)

    overlap_ratio = max(
        intersection_area / mask1_area,
        intersection_area / mask2_area,
    )
    if np.isnan(overlap_ratio):
        overlap_ratio = 0
    return overlap_ratio


def trimmean(x, percent):
    """Robust mean trimming ``percent`` of data from each end."""
    x = np.asarray(x)
    if x.ndim > 2:
        raise ValueError("Input must be 1-D or 2-D array")
    if not 0 <= percent <= 100:
        raise ValueError("Percent must be between 0 and 100")
    if x.ndim == 1:
        n = len(x)
        k = int(round(n * percent / 100 / 2))
        return np.mean(np.sort(x)[k:n - k])
    return np.array([trimmean(col, percent) for col in x.T])


# --------------------------------------------------------------------------- #
# Pipeline stages (parameterized by TreeIsoParams)
# --------------------------------------------------------------------------- #
def init_segs(pcd, p: TreeIsoParams):
    """Stage 1: initial 3D cut-pursuit segmentation."""
    pcd = pcd[:, :3] - np.mean(pcd[:, :3], axis=0)
    point_count = len(pcd)
    if point_count == 0:
        return False

    kdtree = cKDTree(pcd[:, :3])
    _, nn_idx = kdtree.query(pcd, k=p.min_nn1 + 1)
    indices = nn_idx[:, 1:]

    n_nodes = len(pcd)
    eu = np.repeat(np.arange(n_nodes), p.min_nn1)
    ev = indices.ravel()
    edge_weight = np.ones_like(eu, dtype=np.float32)

    return perform_cut_pursuit(
        reg_strength=p.reg_strength1,
        D=3,
        pc_vec=pcd.astype(np.float32),
        edge_weights=edge_weight,
        Eu=eu.astype(np.uint32),
        Ev=ev.astype(np.uint32),
        verbose=False,
    )


def create_node_edges(points, p: TreeIsoParams, k=10, max_distance=0.4):
    """Build inter-segment edges weighted by min point-to-point distance."""
    _, centroids_idx, inverse_idx = np.unique(
        points[:, -1], return_index=True, return_inverse=True
    )
    _, v_group = npi.group_by(points[:, -1].astype(np.int32), np.arange(len(points[:, -1])))

    centroids = np.array([np.mean(points[idx, :3], 0) for idx in v_group])
    kdtree = cKDTree(centroids[:, :3])
    _, indices = kdtree.query(centroids[:, :3], k=min(k + 1, len(centroids)))
    # cKDTree.query returns a 1-D array when k==1 (a single centroid); keep it
    # 2-D so the per-row indexing below holds regardless of segment count.
    if indices.ndim == 1:
        indices = indices[:, np.newaxis]
    distance_matrix = np.zeros([len(centroids), len(centroids)]) - 1
    for i, v in enumerate(v_group):
        nn_idx = indices[i, 1:]
        tree = cKDTree(points[v, :3])
        distance_matrix[i, i] = 0
        for j, nv in enumerate(nn_idx):
            if distance_matrix[i, j] > 0:
                continue
            nn_dist = tree.query(points[v_group[nv], :3], k=1)
            distance_matrix[i, nv] = np.min(nn_dist)

    kdtree = cKDTree(points[:, :3])
    _, nn_idx = kdtree.query(points[:, :3], k=min(k + 1, len(points)))
    if nn_idx.ndim == 1:
        nn_idx = nn_idx[:, np.newaxis]
    indices = nn_idx[:, 1:]
    # When fewer than k+1 neighbours exist, each point contributes one edge per
    # available neighbour, not exactly k — size the source array to match so the
    # repeat/ravel stay aligned.
    k_eff = indices.shape[1]

    eu = np.repeat(np.arange(len(points)), k_eff)
    ev = indices.ravel()

    eu_node = inverse_idx[eu]
    ev_node = inverse_idx[ev]

    distance_pairs = np.transpose([eu, ev, distance_matrix[eu_node, ev_node]])
    distance_pairs = distance_pairs[distance_pairs[:, -1] < max_distance]
    distance_pairs = distance_pairs[distance_pairs[:, -1] > -1]
    return centroids, distance_pairs, centroids_idx, inverse_idx


def intermediate_segs(pcd, p: TreeIsoParams):
    """Stage 2: intermediate 2D cut-pursuit over stage-1 segments."""
    pcd[:, :3] = pcd[:, :3] - np.mean(pcd[:, :3], axis=0)
    _, distance_pairs, _, _ = create_node_edges(
        pcd[:, :4], p, k=p.min_nn2, max_distance=p.max_gap
    )
    if len(pcd) == 0:
        return False

    eu = distance_pairs[:, 0].astype(np.uint32)
    ev = distance_pairs[:, 1].astype(np.uint32)

    if USE_CPP:
        edge_weight = 10 / ((distance_pairs[:, 2] + 0.01) / 0.01) * (p.reg_strength2)
    else:
        edge_weight = 10 / ((distance_pairs[:, 2] + 0.01) / 0.01)

    return perform_cut_pursuit(
        reg_strength=p.reg_strength2,
        D=2,
        pc_vec=pcd[:, :2].astype(np.float32),
        edge_weights=edge_weight.astype(np.float32),
        Eu=eu,
        Ev=ev,
        verbose=False,
    )


def final_segs(pcd, p: TreeIsoParams):
    """Stage 3: merge segments into final trees by similarity.

    Args:
        pcd: array with columns [x, y, z, init_segs, intermediate_segs]
    """
    pcd = np.concatenate([pcd, pcd[:, -1][:, np.newaxis]], axis=-1)

    clusterIdx = pcd[:, -3]
    _, clusterUIdx, clusterUIdxInverse = np.unique(
        clusterIdx, return_index=True, return_inverse=True
    )
    _, clusterVGroup = npi.group_by(clusterIdx.astype(np.int32), np.arange(len(clusterIdx)))
    centroids = np.vstack([np.mean(pcd[g, :3], 0) for g in clusterVGroup])

    clusterGroupMap = np.concatenate([centroids, pcd[clusterUIdx, -3:-1]], axis=-1)
    clusterMapU, clusterMapVGroup = npi.group_by(
        clusterGroupMap[:, -1].astype(np.int32), np.arange(len(clusterGroupMap[:, -1]))
    )

    clusterGroupIds = pcd[clusterUIdx, -1][clusterUIdxInverse]

    iter = 1
    toMergeIds = np.array([0, 0])
    prevToMergeIds = np.array([0])
    mergedRemainIds = []
    groupU = []
    groupVGroup = []
    groupFeatures = []

    while len(toMergeIds) != len(prevToMergeIds) and len(toMergeIds) > 0:
        prevToMergeIds = toMergeIds.copy()

        groupU, _ = np.unique(clusterGroupIds.astype(np.int32), return_inverse=True)
        _, groupVGroup = npi.group_by(
            clusterGroupIds.astype(np.int32), np.arange(len(clusterGroupIds))
        )

        nGroups = len(groupVGroup)
        if nGroups == 1:
            return np.zeros(len(pcd))

        groupFeatures = np.zeros([nGroups, 5])
        groupHulls = [None] * nGroups
        for i in range(nGroups):
            groupPts = pcd[groupVGroup[i], :]
            groupFeatures[i, :3] = trimmean(groupPts[:, :3], 0.2)
            groupFeatures[i, 3] = np.min(groupPts[:, 2])
            groupFeatures[i, 4] = np.max(groupPts[:, 2]) - min(groupPts[:, 2])
            try:
                hull = ConvexHull(groupPts[:, :2])
                groupHulls[i] = groupPts[hull.vertices, :2]
            except Exception:
                mins = np.min(groupPts[:, :2], axis=0)
                maxs = np.max(groupPts[:, :2], axis=0)
                groupHulls[i] = np.array([
                    [mins[0], mins[1]],
                    [maxs[0], mins[1]],
                    [maxs[0], maxs[1]],
                    [mins[0], maxs[1]],
                ])

        kdtree = cKDTree(groupFeatures[:, :2])
        groupNNCDs, groupNNIdxC = kdtree.query(
            groupFeatures[:, :2], k=min(len(groupFeatures), p.min_nn3)
        )
        groupNNCDs = (
            np.transpose(groupNNCDs)[:, np.newaxis] if groupNNCDs.ndim == 1 else groupNNCDs
        )
        sigmaD = np.mean(groupNNCDs[:, 1])

        toMergeIds = np.zeros(nGroups, dtype=np.int32)
        for i in range(nGroups):
            currentGroupFt = groupFeatures[i, 3:5]
            nnGroupId = groupNNIdxC[i, :]
            nnGroupFt = groupFeatures[nnGroupId, 3:5]
            currentGroupRelHt = (currentGroupFt[0] - np.min(nnGroupFt[:, 0])) / currentGroupFt[1]
            if np.abs(currentGroupRelHt) > p.rel_height_length_ratio:
                if (currentGroupFt[1] / np.median(nnGroupFt[:, 1])) > p.init_stem_rel_length_thresh:
                    toMergeIds[i] = i
                else:
                    toMergeIds[i] = -i
        toMergeLogi = toMergeIds != 0
        remainIds = np.where(~toMergeLogi)[0]
        toMergeIds = toMergeIds[toMergeLogi]
        if (iter == 1) and np.sum(toMergeIds >= 0) > 0:
            toMergeIds = toMergeIds[toMergeIds > 0]
        else:
            toMergeIds = np.abs(toMergeIds)

        kdtree = cKDTree(groupFeatures[remainIds, :2])
        _, groupNNIdx = kdtree.query(
            groupFeatures[toMergeIds, :2], k=min(p.min_nn3, len(remainIds))
        )
        groupNNIdx = (
            np.transpose(groupNNIdx)[:, np.newaxis] if groupNNIdx.ndim == 1 else groupNNIdx
        )
        nNNs = groupNNIdx.shape[1]

        for i, toMergeId in enumerate(toMergeIds):
            currentClusterCentroids = clusterGroupMap[np.concatenate([clusterMapVGroup[toMergeId]]), :]
            filterMetrics = np.zeros([nNNs, 5])
            for j in range(nNNs):
                remainId = remainIds[groupNNIdx[i, j]]
                line1Ends = [groupFeatures[toMergeId, 3], groupFeatures[toMergeId, 3] + groupFeatures[toMergeId, 4]]
                line2Ends = [groupFeatures[remainId, 3], groupFeatures[remainId, 3] + groupFeatures[remainId, 4]]
                lineSegs = [(line2Ends[1] - line1Ends[0]), (line1Ends[1] - line2Ends[0])]
                verticalOverlapRatio = np.min(lineSegs) / np.max(lineSegs)
                if groupHulls[toMergeId] is not None and groupHulls[remainId] is not None:
                    horizontalOverlapRatio = overlapping(groupHulls[toMergeId], groupHulls[remainId])
                else:
                    horizontalOverlapRatio = 0.0

                nnClusterCentroids = clusterGroupMap[np.concatenate([clusterMapVGroup[remainId]]), :]
                kdtree = cKDTree(nnClusterCentroids[:, :3])
                nnDs, _ = kdtree.query(currentClusterCentroids[:, :3], k=1)
                min3DSpacing = np.min(nnDs)
                min2DSpacing = np.linalg.norm(
                    np.mean(nnClusterCentroids[:, :2], 0) - np.mean(currentClusterCentroids[:, :2], 0)
                )
                filterMetrics[j, :] = np.array(
                    [horizontalOverlapRatio, verticalOverlapRatio, min3DSpacing, min2DSpacing, remainId]
                )
            filterMetrics[filterMetrics[:, 1] <= 0, 1] = 0
            score = np.exp(
                -np.power(1 - filterMetrics[:, 0], 2)
                - p.vertical_weight * np.power(1 - filterMetrics[:, 1], 2)
                - np.power(np.min(filterMetrics[:, 2:4], 1) / sigmaD, 2)
            )

            scoreSortI = score.argsort()[::-1]
            scoreSort = score[scoreSortI]
            if scoreSort[0] == 0:
                continue
            scoreSortRatio = scoreSort / scoreSort[0]
            scoreSortCandidateIdx = np.where(scoreSortRatio > p.score_candidate_thresh)[0]
            nScoreSortCandidateIdx = len(scoreSortCandidateIdx)
            if nScoreSortCandidateIdx == 1:
                mergeNNId = groupU[int(filterMetrics[scoreSortI[scoreSortCandidateIdx[0]], -1])]
            elif nScoreSortCandidateIdx > 1:
                filterMinSpacingIdx = np.argmin(filterMetrics[scoreSortI[scoreSortCandidateIdx], 2])
                mergeNNId = groupU[int(filterMetrics[scoreSortI[filterMinSpacingIdx], -1])]
            else:
                continue
            clusterGroupIds[groupVGroup[toMergeIds[i]]] = mergeNNId

        mergedRemainIds.extend(groupU[remainIds])
        clusterGroupMap[:, -1] = clusterGroupIds[clusterUIdx]
        clusterMapU, clusterMapVGroup = npi.group_by(
            clusterGroupMap[:, -1].astype(np.int32), np.arange(len(clusterGroupMap[:, -1]))
        )
        iter = iter + 1

    # Merge any remaining non-stem segments to the nearest by minimal 3D gap.
    unmergeIds = np.setdiff1d(groupU, mergedRemainIds)
    if len(unmergeIds) > 0:
        mergedRemainIds = np.unique(mergedRemainIds)

        unmergeIds = np.where(np.isin(clusterMapU, unmergeIds))[0]
        mergedRemainIds = np.where(np.isin(clusterMapU, mergedRemainIds))[0]

        kdtree = cKDTree(groupFeatures[mergedRemainIds, :2])
        _, groupNNIdx = kdtree.query(
            groupFeatures[unmergeIds, :2], k=min(p.min_nn3, len(mergedRemainIds))
        )
        groupNNIdx = (
            np.transpose(groupNNIdx)[:, np.newaxis] if groupNNIdx.ndim == 1 else groupNNIdx
        )
        nNNs = groupNNIdx.shape[1]

        for i, unmergeId in enumerate(unmergeIds):
            currentClusterCentroids = clusterGroupMap[np.concatenate([clusterMapVGroup[unmergeId]]), :]
            filterMetrics = np.zeros([nNNs, 2])
            for j in range(nNNs):
                mergedRemainId = mergedRemainIds[groupNNIdx[i, j]]
                nnClusterCentroids = clusterGroupMap[np.concatenate([clusterMapVGroup[mergedRemainId]]), :]
                kdtree = cKDTree(currentClusterCentroids[:, :3])
                nnDs, _ = kdtree.query(nnClusterCentroids[:, :3])
                min3DSpacing = min(nnDs)
                filterMetrics[j, :] = np.array([min3DSpacing, mergedRemainId])

            filterMinSpacingIdx = np.argmin(filterMetrics[:, 0])
            mergeNNId = groupU[int(filterMetrics[filterMinSpacingIdx, -1])]
            clusterGroupIds[groupVGroup[unmergeIds[i]]] = mergeNNId

    _, clusterGroupIds = np.unique(clusterGroupIds, return_inverse=True)
    return clusterGroupIds


def decimate_pcd(columns, min_res):
    """Voxel-decimate to ``min_res``; return (unique-index, inverse-index)."""
    _, block_idx_uidx, block_inverse_idx = np.unique(
        np.floor(columns[:, :3] / min_res).astype(np.int32),
        axis=0,
        return_index=True,
        return_inverse=True,
    )
    return block_idx_uidx, block_inverse_idx


def isolate_gaps(pcd, max_gap, search_K=20):
    """Label connected components, splitting across gaps larger than ``max_gap``.

    Runs on the DECIMATED cloud (see :func:`_split_across_gaps`): the adjacency
    matrix is (n, n) sparse over the node count, so feeding it a multi-million
    point cloud at full resolution is not viable.
    """
    pcd = pcd[:, :3] - np.mean(pcd[:, :3], axis=0)
    point_count = len(pcd)
    if point_count == 0:
        return False

    K = min(search_K, len(pcd))
    kdtree = cKDTree(pcd[:, :3])
    nn_D, nn_idx = kdtree.query(pcd[:, :3], k=K)

    indices = nn_idx[:, 1:]
    nn_D = nn_D[:, 1:]

    eu = np.repeat(np.arange(len(pcd)), K - 1)
    ev = indices.ravel()
    nn_D = nn_D.ravel()
    inlier_ind = nn_D < max_gap
    eu = eu[inlier_ind]
    ev = ev[inlier_ind]

    adjacency_matrix = csr_matrix(
        (np.ones(len(eu), dtype=int), (eu, ev)), shape=(point_count, point_count)
    )
    _, labels = connected_components(
        csgraph=adjacency_matrix, directed=False, connection="weak", return_labels=True
    )
    return labels


# --------------------------------------------------------------------------- #
# Public entry point
# --------------------------------------------------------------------------- #
def _process_point_cloud(pcd, p: TreeIsoParams):
    """Run the three stages on an (N, 3) array; return labels + decimation maps."""
    pcd = pcd - np.mean(pcd, axis=0)

    dec_idx_uidx, dec_inverse_idx = decimate_pcd(pcd, p.decimate_res1)
    pcd_dec = pcd[dec_idx_uidx]
    init_labels = init_segs(pcd_dec, p)

    dec_idx_uidx2, dec_inverse_idx2 = decimate_pcd(pcd, p.decimate_res2)
    pcd_dec2 = pcd[dec_idx_uidx2]
    intermediate_labels = intermediate_segs(
        np.concatenate(
            [pcd_dec2, init_labels[dec_inverse_idx][dec_idx_uidx2][:, np.newaxis]], axis=-1
        ),
        p,
    )

    final_labels = final_segs(
        np.concatenate(
            [
                pcd_dec,
                init_labels[:, np.newaxis],
                intermediate_labels[dec_inverse_idx2][dec_idx_uidx][:, np.newaxis],
            ],
            axis=-1,
        ),
        p,
    )
    return init_labels, intermediate_labels, final_labels, dec_inverse_idx, dec_inverse_idx2


# Components smaller than this share of their parent tree are treated as debris
# rather than a mis-merged neighbour, and are left attached. Splitting on every
# component would shard a tree into confetti: occlusion leaves plenty of small
# genuinely-detached twigs, and each one becoming its own "tree" is a worse
# answer than the over-merge we are fixing. A mis-merged neighbouring tree is a
# substantial body — the measured case is 3.5% of its parent — while occlusion
# debris is orders of magnitude below that.
_MIN_SPLIT_FRACTION = 0.005

# ...and an ABSOLUTE floor in decimated nodes, because the fraction alone is not
# enough. `_split_across_gaps` works on the DECIMATED cloud, where a whole small
# tree can be ~126 nodes: 0.5% of that is 0.63, so the fraction rounds away to
# nothing and every speck of noise becomes its own "tree" (measured: 56-point and
# 1-point instances). A component must clear BOTH bars to be split off.
_MIN_SPLIT_NODES = 20

# Voxel size (m) the connectivity test runs at, as a fraction of the gap being
# tested. Connectivity only needs enough resolution to tell "touching" from
# "separated by more than `gap`", so testing at gap/8 is ample — and it is what
# keeps the cost bounded.
#
# The obvious alternatives both fail. A radius query at the FULL stage-1
# resolution is quadratic in the neighbourhood: `query_pairs` returns every pair
# within the radius, and inside a dense crown that measured 1.6 s at a 0.5 m gap
# rising to 369 s at 3.0 m on the Nickels tree_8 scan — the most permissive
# setting being the slowest, exactly backwards for a knob a user raises to be
# less aggressive. Capping the graph with a k-NN budget instead (isolate_gaps'
# own `search_K=20` formulation) is fast but WRONG at these densities: at 0.05 m
# decimation a node's 20th-nearest neighbour is a median 0.108 m away, so with a
# 0.6 m gap the entire budget is spent on neighbours a few cm away and no edge
# ever reaches across a gap — trees shattered into 21-27 fragments instead of 7.
# Coarsening the cloud fixes both at once: it shrinks the neighbourhood a radius
# query has to enumerate, while keeping the radius semantics that decide the
# split.
_SPLIT_RES_FRACTION = 1.0 / 8.0


def _split_across_gaps(xyz_dec, labels_dec, max_outlier_gap):
    """Split each tree label wherever its own points are separated by a 3D gap
    wider than ``max_outlier_gap``.

    Stage 3 merges a rootless segment into whichever neighbour scores best, and
    its score has no distance ceiling: ``min3DSpacing`` only enters the exponent,
    so a segment metres away still merges if nothing closer competes. That is the
    intended behaviour for an occluded branch whose own trunk is present, but it
    also captures a NEIGHBOURING tree whose trunk was cropped out of the scene —
    the common case at the edge of a single-tree crop, where every surrounding
    tree is a trunkless crown fragment.

    This is upstream's ``if_isolate_outlier`` post-process (``process_las_file``,
    guarded by ``PR_MAX_OUTLIER_GAP``), which Phytograph's adaptation dropped
    along with the laspy I/O that hosted it. Upstream intersects the tree labels
    with the connectivity components; we do the same, but only for components
    that are a meaningful share of their parent (see ``_MIN_SPLIT_FRACTION``),
    and per-tree rather than globally so an unrelated tree's geometry can never
    influence another's split.

    Args:
        xyz_dec: (M, 3) decimated points.
        labels_dec: (M,) tree label per decimated point.
        max_outlier_gap: gap (m) above which one tree's points are separate trees.

    Returns:
        (M,) relabelled array, aligned to ``labels_dec``.
    """
    gap = float(max_outlier_gap)
    if not np.isfinite(gap) or gap <= 0:
        return labels_dec

    # Floor the gap at the cloud's own point spacing. Below roughly 2x the median
    # nearest-neighbour distance, "is this point connected to that one?" stops
    # being a question about tree structure and becomes one about sampling: the
    # test disconnects a tree from ITSELF, and the result is not merely more
    # aggressive but meaningless. It is also non-monotonic, which is the part
    # that misleads — on the sparse e2e fixture (0.21 m spacing) tightening the
    # gap from 0.65 to 0.2 m gave FEWER instances (11 -> 7), not more, because
    # whole crowns crumbled into sub-threshold debris that the size guards then
    # reabsorbed. A user on sparse data who reaches for a smaller number to split
    # more would otherwise get quieter, wronger output with no indication.
    if len(xyz_dec) >= 2:
        nn = cKDTree(xyz_dec).query(xyz_dec, k=2, workers=-1)[0][:, 1]
        nn = nn[np.isfinite(nn) & (nn > 0)]
        if nn.size:
            floor = 2.0 * float(np.median(nn))
            if gap < floor:
                gap = floor

    out = np.array(labels_dec, dtype=np.int64, copy=True)
    next_label = int(out.max()) + 1 if len(out) else 1

    for tree_id in np.unique(labels_dec):
        member = np.where(labels_dec == tree_id)[0]
        if len(member) < 2:
            continue

        # Coarsen to a fraction of the gap for the connectivity test, then push
        # each component's label back to every point of its voxel. Splitting is a
        # decision about whole limbs, so it does not need cm resolution.
        coarse_uidx, coarse_inv = decimate_pcd(
            xyz_dec[member], gap * _SPLIT_RES_FRACTION
        )
        pts = xyz_dec[member][coarse_uidx]
        if len(pts) < 2:
            continue

        # Connect every pair closer than the gap, then take connected components.
        # The coarsening above is what makes this radius query affordable.
        pairs = cKDTree(pts).query_pairs(gap, output_type="ndarray")
        adjacency = csr_matrix(
            (np.ones(len(pairs), dtype=np.int8), (pairs[:, 0], pairs[:, 1])),
            shape=(len(pts), len(pts)),
        )
        n_comp, comp = connected_components(
            csgraph=adjacency, directed=False, connection="weak", return_labels=True
        )
        if n_comp <= 1:
            continue

        comp = comp[coarse_inv]
        sizes = np.bincount(comp, minlength=n_comp)
        # Keep the largest component under the original id; only components that
        # are substantial in their own right become new trees. Everything else
        # stays with the parent, so debris never inflates the tree count.
        keep = int(np.argmax(sizes))
        threshold = max(_MIN_SPLIT_FRACTION * len(member), _MIN_SPLIT_NODES)
        for ci in range(n_comp):
            if ci == keep or sizes[ci] < threshold:
                continue
            out[member[comp == ci]] = next_label
            next_label += 1

    return out


def segment_trees(xyz: np.ndarray, params: TreeIsoParams | None = None) -> np.ndarray:
    """Segment a multi-tree point cloud into per-point tree instance ids.

    Args:
        xyz: (N, 3) float array of x, y, z coordinates. Ground points should be
            removed beforehand (TreeIso isolates above-ground tree structure).
        params: tuning parameters; defaults to :class:`TreeIsoParams` (upstream
            defaults).

    Returns:
        (N,) int array of tree ids, contiguous 1..K, aligned to the input order.
        Returns all-ones when the cloud collapses to a single tree, and an empty
        array for empty input.
    """
    if params is None:
        params = TreeIsoParams()
    xyz = np.asarray(xyz, dtype=np.float64)[:, :3]
    n = len(xyz)
    if n == 0:
        return np.zeros(0, dtype=np.int64)

    _, _, final_labels, dec_inverse_idx, _ = _process_point_cloud(xyz, params)
    final_labels = np.asarray(final_labels)

    # Post-process: split any tree that stage 3 assembled across a gap wider than
    # `max_outlier_gap`. Runs on the DECIMATED cloud, which is both what the
    # labels are indexed against and the only tractable size for a neighbour
    # graph — the full cloud here is routinely millions of points.
    #
    # `_process_point_cloud` mean-centres before decimating, so rebuild the same
    # decimated coordinates rather than re-deriving them from `xyz`: the split
    # must see the geometry the labels were computed on.
    centred = xyz - np.mean(xyz, axis=0)
    dec_uidx, _ = decimate_pcd(centred, params.decimate_res1)
    if len(dec_uidx) == len(final_labels):
        final_labels = _split_across_gaps(
            centred[dec_uidx], final_labels, params.max_outlier_gap
        )

    # final_labels is per decimated point; map back to full resolution.
    per_point = final_labels[dec_inverse_idx].astype(np.int64)
    # Re-base to contiguous 1..K (0 is reserved for the caller's "unassigned").
    _, per_point = np.unique(per_point, return_inverse=True)
    return per_point.astype(np.int64) + 1
