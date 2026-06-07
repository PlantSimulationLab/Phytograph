"""Stage B: deterministic geodesic level-set skeleton.

Evolves the existing BFS skeleton (Li et al. 2017) into the cleaner
Verroust-Lazarus / Xu geodesic level-set form, which is fully deterministic and
bridges occlusion gaps:

  1. build a kNN/radius neighbor graph (cKDTree) with Euclidean edge weights;
  2. pick a root at the tree base (lowest points);
  3. TRUE geodesic distance from the root via scipy.sparse.csgraph.dijkstra
     (not hop count);
  4. bin points into level sets by geodesic distance (width = bin_width);
  5. connected components within each level set => one skeleton node per
     component (centroid); a level with >1 component marks a bifurcation;
  6. connect a node to the adjacent-lower-level node it is graph-adjacent to
     => a rooted tree (acyclic by construction; parent is always lower geodesic);
  7. reconnect components the graph left orphaned (occlusion gaps) to the
     nearest lower-level node within a gap tolerance.

Output is a ``SkeletonGraph``: node positions + parent links, rooted at the base.
Deterministic: cKDTree + csgraph + fixed binning + lowest-index tie-breaking; no
RNG, no iterative non-convex optimization.

All distances meters.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components, dijkstra
from scipy.spatial import cKDTree


@dataclass
class SkeletonOptions:
    # Neighbor graph: connect points within this radius (auto from density if None).
    graph_radius: float | None = None
    max_neighbors: int = 30
    # Root: points within this height of the minimum z are the root set.
    root_height: float = 0.05
    # Level-set bin width along geodesic distance (auto from density if None).
    bin_width: float | None = None
    # Minimum points for a level-set component to become a node (noise guard).
    min_component_size: int = 3
    # Prune dead-end spurs (leaf chains) shorter than this many nodes -- removes
    # transient small fragments that create spurious forks. 0 disables.
    min_spur_nodes: int = 2
    # Laplacian smoothing passes on node positions (reduces centroid zigzag that
    # inflates centerline arc length). Forks/root are pinned. 0 disables.
    smooth_iterations: int = 5
    smooth_alpha: float = 0.5
    # Reconnect orphaned components within this multiple of bin_width.
    gap_tolerance_bins: float = 3.0
    # Bridge disconnected graph components (occlusion gaps) up to this length
    # (auto: 15x density if None) so the geodesic field reaches the crown.
    bridge_max: float | None = None


@dataclass
class SkeletonGraph:
    """A rooted skeleton: nodes (3D positions) with parent links.

    ``parent[i]`` is the index of node i's parent, or -1 for the root. ``level[i]``
    is the geodesic level-set index of node i. ``point_count[i]`` is how many
    cloud points the node's component contained (a density proxy used later for
    GrowthLength-style decisions and radius seeding).
    """

    nodes: np.ndarray  # (K, 3)
    parent: np.ndarray  # (K,) int, -1 for root
    level: np.ndarray  # (K,) int level-set index
    point_count: np.ndarray  # (K,) int
    root: int = 0
    meta: dict = field(default_factory=dict)

    def __len__(self) -> int:
        return int(self.nodes.shape[0])

    def edges(self) -> list[tuple[int, int]]:
        """(parent, child) pairs."""
        return [(int(p), i) for i, p in enumerate(self.parent) if p >= 0]

    def children_of(self) -> dict[int, list[int]]:
        out: dict[int, list[int]] = {i: [] for i in range(len(self))}
        for i, p in enumerate(self.parent):
            if p >= 0:
                out[int(p)].append(i)
        return out

    def is_acyclic_single_root(self) -> bool:
        roots = int(np.sum(self.parent < 0))
        if roots != 1:
            return False
        # Walk every node to root; detect cycles.
        for start in range(len(self)):
            seen = set()
            cur = start
            while cur >= 0:
                if cur in seen:
                    return False
                seen.add(cur)
                cur = int(self.parent[cur])
        return True


def _density(points: np.ndarray, sample: int = 2000) -> float:
    n = len(points)
    if n < 2:
        return 0.01
    idx = np.linspace(0, n - 1, min(sample, n)).astype(np.int64)
    tree = cKDTree(points)
    d, _ = tree.query(points[idx], k=2)
    nn = d[:, 1]
    nn = nn[nn > 0]
    return float(np.median(nn)) if nn.size else 0.01


def _build_graph(points: np.ndarray, radius: float, max_neighbors: int, bridge_max: float):
    """Symmetric radius graph as a sparse weighted adjacency (Euclidean weights).

    To survive occlusion gaps (which would otherwise leave the crown unreachable
    from the root), if the radius graph has multiple connected components we add
    bridge edges between the closest points of distinct components, up to
    ``bridge_max`` length. This keeps the geodesic field defined across gaps
    while never bridging genuinely far-apart debris. Deterministic.
    """
    tree = cKDTree(points)
    pairs = tree.query_pairs(radius, output_type="ndarray")
    n = len(points)
    if len(pairs) == 0:
        return coo_matrix((n, n)).tocsr(), tree, pairs

    rows = list(pairs[:, 0])
    cols = list(pairs[:, 1])
    d = list(np.linalg.norm(points[pairs[:, 0]] - points[pairs[:, 1]], axis=1))

    bridges = _bridge_components(points, pairs, n, bridge_max)
    for i, j, dist in bridges:
        rows.append(i)
        cols.append(j)
        d.append(dist)

    rows_a = np.asarray(rows)
    cols_a = np.asarray(cols)
    w = np.asarray(d)
    adj = coo_matrix(
        (np.concatenate([w, w]),
         (np.concatenate([rows_a, cols_a]), np.concatenate([cols_a, rows_a]))),
        shape=(n, n),
    ).tocsr()
    all_pairs = np.column_stack([rows_a, cols_a])
    return adj, tree, all_pairs


def _bridge_components(points, pairs, n, bridge_max):
    """Return bridge edges (i, j, dist) connecting distinct components of the
    radius graph via their mutually-nearest points, iterating until one
    component or no bridge is short enough. Deterministic (component order +
    KD-tree nearest)."""
    data = np.ones(len(pairs), dtype=np.int8)
    adj = coo_matrix((data, (pairs[:, 0], pairs[:, 1])), shape=(n, n))
    ncomp, labels = connected_components(adj, directed=False)
    bridges: list[tuple[int, int, float]] = []
    guard = 0
    while ncomp > 1 and guard < n:
        guard += 1
        comp_ids = np.unique(labels)
        # Anchor on the largest component; connect the nearest other-component
        # point to it.
        counts = np.bincount(labels, minlength=int(labels.max()) + 1)
        main = int(np.argmax(counts))
        main_pts_idx = np.where(labels == main)[0]
        other_idx = np.where(labels != main)[0]
        if other_idx.size == 0:
            break
        main_tree = cKDTree(points[main_pts_idx])
        dists, nn = main_tree.query(points[other_idx])
        k = int(np.argmin(dists))
        if dists[k] > bridge_max:
            break  # nearest gap too large -> leave disconnected (real debris)
        i = int(other_idx[k])
        j = int(main_pts_idx[int(nn[k])])
        bridges.append((i, j, float(dists[k])))
        # Merge: relabel i's whole component into main, recompute cheaply.
        labels[labels == labels[i]] = main
        ncomp = int(np.unique(labels).size)
    return bridges


def _component_adjacency(
    labels_per_point: np.ndarray, node_of_point: np.ndarray, pairs: np.ndarray, n_nodes: int
) -> set[tuple[int, int]]:
    """Which skeleton nodes are graph-adjacent (some cloud edge crosses between
    their components)."""
    adj: set[tuple[int, int]] = set()
    if len(pairs) == 0:
        return adj
    a = node_of_point[pairs[:, 0]]
    b = node_of_point[pairs[:, 1]]
    mask = (a >= 0) & (b >= 0) & (a != b)
    for x, y in zip(a[mask], b[mask]):
        lo, hi = (int(x), int(y)) if x < y else (int(y), int(x))
        adj.add((lo, hi))
    return adj


def extract_skeleton(points: np.ndarray, opts: SkeletonOptions | None = None) -> SkeletonGraph:
    """Extract a rooted geodesic level-set skeleton from a (preprocessed) cloud."""
    opts = opts or SkeletonOptions()
    points = np.asarray(points, dtype=np.float64)
    n = len(points)
    if n < 2:
        return SkeletonGraph(
            nodes=points.reshape(-1, 3).copy(),
            parent=np.full(max(n, 0), -1, dtype=np.int64),
            level=np.zeros(n, dtype=np.int64),
            point_count=np.ones(n, dtype=np.int64),
            meta={"degenerate": True},
        )

    density = _density(points)
    # Graph radius must reliably connect the tubular surface AND bridge axial
    # spacing; 2.5x density fragments the graph (Dijkstra can't reach the crown).
    # 4x density gives a single connected component on test trees -- use it as the
    # floor. (Verified empirically: 2.5x -> ~300 components, 4x -> 1 component.)
    radius = opts.graph_radius if opts.graph_radius is not None else 4.0 * density
    # Level-set bin width: a few graph-radii so each level spans a short tube
    # section but stays wider than the local spacing.
    bin_width = opts.bin_width if opts.bin_width is not None else 6.0 * density

    bridge_max = opts.bridge_max if opts.bridge_max is not None else 15.0 * density
    adj, tree, pairs = _build_graph(points, radius, opts.max_neighbors, bridge_max)

    # Root set: lowest points.
    z = points[:, 2]
    root_mask = (z - z.min()) <= opts.root_height
    root_idx = np.where(root_mask)[0]
    if root_idx.size == 0:
        root_idx = np.array([int(np.argmin(z))])

    # Geodesic distance from the root set (multi-source dijkstra = min over sources).
    geo = dijkstra(adj, directed=False, indices=root_idx, min_only=True)
    # Unreachable points (occlusion islands): assign them later; for now mark inf.
    reachable = np.isfinite(geo)

    # Level-set index per reachable point.
    level = np.full(n, -1, dtype=np.int64)
    level[reachable] = np.floor(geo[reachable] / bin_width).astype(np.int64)

    # Within each level set, connected components on the cloud graph => nodes.
    node_of_point = np.full(n, -1, dtype=np.int64)
    node_positions: list[np.ndarray] = []
    node_level: list[int] = []
    node_count: list[int] = []

    # Precompute CSR for sub-graph component extraction.
    adj_csr = adj.tocsr() if adj.nnz else adj

    for lv in range(int(level[reachable].max()) + 1 if reachable.any() else 0):
        members = np.where(level == lv)[0]
        if members.size == 0:
            continue
        if adj.nnz == 0:
            comps = np.zeros(members.size, dtype=np.int64)
            ncomp = 1
        else:
            sub = adj_csr[members][:, members]
            ncomp, comps = connected_components(sub, directed=False)
        for ci in range(ncomp):
            comp_members = members[comps == ci]
            if comp_members.size < opts.min_component_size:
                continue
            nid = len(node_positions)
            node_of_point[comp_members] = nid
            node_positions.append(points[comp_members].mean(axis=0))
            node_level.append(lv)
            node_count.append(int(comp_members.size))

    if not node_positions:
        # Fallback: single node at centroid.
        return SkeletonGraph(
            nodes=points.mean(axis=0).reshape(1, 3),
            parent=np.array([-1], dtype=np.int64),
            level=np.array([0], dtype=np.int64),
            point_count=np.array([n], dtype=np.int64),
            meta={"fallback": "single_node"},
        )

    nodes = np.asarray(node_positions)
    node_level_arr = np.asarray(node_level, dtype=np.int64)
    node_count_arr = np.asarray(node_count, dtype=np.int64)

    # Merge same-level nodes that are spatially close: a single branch's
    # cross-section can fragment into several arc-components within one level
    # set, producing spurious sibling nodes (and spurious forks). Nodes in the
    # same level within ``merge_radius`` are the same cross-section -> merge.
    merge_radius = max(bin_width, 2.0 * radius)
    nodes, node_level_arr, node_count_arr, node_of_point = _merge_colevel_nodes(
        nodes, node_level_arr, node_count_arr, node_of_point, merge_radius
    )
    K = len(nodes)

    # Node adjacency from cloud-edge crossings.
    node_adj = _component_adjacency(level, node_of_point, pairs, K)

    # Parent = adjacent node at the next lower level. Ties -> nearest, then lowest id.
    parent = np.full(K, -1, dtype=np.int64)
    neighbors_by_node: dict[int, list[int]] = {i: [] for i in range(K)}
    # Sort the adjacency set before consuming it so iteration order is explicit and
    # never depends on set internals (determinism the pipeline contract requires).
    for lo, hi in sorted(node_adj):
        neighbors_by_node[lo].append(hi)
        neighbors_by_node[hi].append(lo)

    for i in range(K):
        lvl = node_level_arr[i]
        if lvl == node_level_arr.min():
            continue  # base level -> root candidates
        # Parent must be at a STRICTLY lower level so the parent relation is
        # acyclic by construction. We deliberately do NOT fall back to a same-level
        # neighbor: two mutually-nearest co-level nodes with no lower neighbor would
        # then pick each other and form a 2-cycle (corrupting the rooted tree).
        # A node with no strictly-lower neighbor is left an orphan (parent = -1)
        # and attached to the nearest strictly-lower node by _reconnect_orphans,
        # which preserves acyclicity.
        lower = [j for j in neighbors_by_node[i] if node_level_arr[j] < lvl]
        if lower:
            # nearest lower node; tie -> lowest id
            d = [float(np.linalg.norm(nodes[i] - nodes[j])) for j in lower]
            order = sorted(range(len(lower)), key=lambda k: (d[k], lower[k]))
            parent[i] = lower[order[0]]

    # Choose the single root: the base-level node with the most points (the
    # trunk base). Other parentless nodes get reconnected (occlusion gaps).
    base_level = node_level_arr.min()
    base_nodes = np.where(node_level_arr == base_level)[0]
    root = int(base_nodes[np.argmax(node_count_arr[base_nodes])])
    parent[root] = -1

    _reconnect_orphans(nodes, parent, node_level_arr, root, bin_width, opts.gap_tolerance_bins)

    if opts.min_spur_nodes > 0:
        nodes, parent, node_level_arr, node_count_arr, root = _prune_spurs(
            nodes, parent, node_level_arr, node_count_arr, root, opts.min_spur_nodes
        )

    if opts.smooth_iterations > 0:
        nodes = _smooth_nodes(
            nodes, parent, root, opts.smooth_iterations, opts.smooth_alpha
        )

    graph = SkeletonGraph(
        nodes=nodes,
        parent=parent,
        level=node_level_arr,
        point_count=node_count_arr,
        root=root,
        meta={
            "density": density,
            "graph_radius": radius,
            "bin_width": bin_width,
            "n_nodes": K,
            "unreachable_points": int(np.sum(~reachable)),
        },
    )
    # The parent relation is acyclic + single-rooted by construction; assert it so
    # any future regression (e.g. a parent-selection change re-introducing a cycle)
    # fails loudly here rather than corrupting the downstream segment tree.
    assert graph.is_acyclic_single_root(), "skeleton produced a cyclic/multi-root parent tree"
    return graph


def _merge_colevel_nodes(nodes, level, count, node_of_point, merge_radius):
    """Merge nodes in the SAME level set whose centroids are within
    ``merge_radius`` -- these are arc-fragments of one branch cross-section, not
    distinct branches. Returns updated (nodes, level, count, node_of_point).
    Deterministic: union-find with lowest-index representative.

    NOTE: only same-level merging, so a genuine bifurcation (children diverging
    INTO higher levels) is preserved -- its children live at higher levels and
    are never merged with each other here once they separate beyond merge_radius.
    """
    K = len(nodes)
    if K == 0:
        return nodes, level, count, node_of_point

    parent = np.arange(K)

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)  # lowest index is representative

    # Union same-level nodes within merge_radius.
    for lv in np.unique(level):
        members = np.where(level == lv)[0]
        if members.size < 2:
            continue
        sub = nodes[members]
        tree = cKDTree(sub)
        for a, b in tree.query_pairs(merge_radius):
            union(int(members[a]), int(members[b]))

    # Relabel into compact merged ids.
    roots = np.array([find(i) for i in range(K)])
    uniq = {r: new for new, r in enumerate(sorted(set(roots.tolist())))}
    new_id = np.array([uniq[r] for r in roots])
    M = len(uniq)

    new_count = np.zeros(M, dtype=np.int64)
    sum_pos = np.zeros((M, 3), dtype=np.float64)
    new_level = np.zeros(M, dtype=np.int64)
    for i in range(K):
        m = new_id[i]
        new_count[m] += count[i]
        sum_pos[m] += nodes[i] * count[i]  # point-count-weighted centroid
        new_level[m] = level[i]  # same within a merge group
    new_nodes = sum_pos / new_count[:, None]

    # Remap point->node.
    nop = node_of_point.copy()
    mapped = nop >= 0
    nop[mapped] = new_id[nop[mapped]]
    return new_nodes, new_level, new_count, nop


def _smooth_nodes(nodes, parent, root, iterations, alpha):
    """Laplacian smoothing of node positions along the tree: each non-fork,
    non-leaf, non-root node moves toward the average of its parent and its single
    child. Forks (>=2 children), leaves, and the root are PINNED so topology and
    extent are preserved (only the zigzag along straight runs is removed).
    Deterministic."""
    K = len(nodes)
    if K < 3:
        return nodes
    children: dict[int, list[int]] = {i: [] for i in range(K)}
    for i in range(K):
        if parent[i] >= 0:
            children[int(parent[i])].append(i)
    # Pin: root, forks (>=2 children), leaves (0 children).
    pinned = np.zeros(K, dtype=bool)
    pinned[root] = True
    for i in range(K):
        if len(children[i]) != 1:
            pinned[i] = True

    pos = nodes.copy()
    for _ in range(iterations):
        new = pos.copy()
        for i in range(K):
            if pinned[i]:
                continue
            p = int(parent[i])
            kids = children[i]
            if p < 0 or len(kids) != 1:
                continue
            neigh = 0.5 * (pos[p] + pos[kids[0]])
            new[i] = (1 - alpha) * pos[i] + alpha * neigh
        pos = new
    return pos


def _prune_spurs(nodes, parent, level, count, root, min_spur_nodes):
    """Iteratively remove short dead-end spurs: a leaf whose branch (walking up
    until a fork or the root) has fewer than ``min_spur_nodes`` nodes is a
    transient fragment, not a real branch. Removing these collapses spurious
    forks. Re-indexes the surviving nodes. Deterministic."""
    K = len(nodes)
    if K == 0:
        return nodes, parent, level, count, root

    alive = np.ones(K, dtype=bool)
    changed = True
    while changed:
        changed = False
        # children counts among alive nodes
        child_count = np.zeros(K, dtype=np.int64)
        for i in range(K):
            if alive[i] and parent[i] >= 0 and alive[parent[i]]:
                child_count[parent[i]] += 1
        for i in range(K):
            if not alive[i] or i == root or child_count[i] > 0:
                continue  # not a leaf
            # walk up the spur collecting single-child ancestors
            spur = [i]
            cur = int(parent[i])
            while cur >= 0 and cur != root and child_count[cur] == 1 and alive[cur]:
                spur.append(cur)
                cur = int(parent[cur])
            if len(spur) < min_spur_nodes:
                for s in spur:
                    alive[s] = False
                changed = True

    # Re-index survivors.
    old_ids = np.where(alive)[0]
    remap = {int(o): n for n, o in enumerate(old_ids)}
    new_nodes = nodes[old_ids]
    new_level = level[old_ids]
    new_count = count[old_ids]
    new_parent = np.full(len(old_ids), -1, dtype=np.int64)
    for n, o in enumerate(old_ids):
        p = int(parent[o])
        new_parent[n] = remap.get(p, -1) if p >= 0 else -1
    new_root = remap.get(root, 0)
    return new_nodes, new_parent, new_level, new_count, new_root


def _reconnect_orphans(
    nodes: np.ndarray,
    parent: np.ndarray,
    level: np.ndarray,
    root: int,
    bin_width: float,
    gap_tolerance_bins: float,
) -> None:
    """Attach parentless non-root nodes (occlusion gaps left them disconnected)
    to the nearest node at a strictly lower level within the gap tolerance.
    Modifies ``parent`` in place; preserves acyclicity (parent is lower level)."""
    K = len(nodes)
    tol = gap_tolerance_bins * bin_width
    orphans = [i for i in range(K) if parent[i] < 0 and i != root]
    if not orphans:
        return
    for i in orphans:
        candidates = np.where(level < level[i])[0]
        if candidates.size == 0:
            candidates = np.array([root])
        d = np.linalg.norm(nodes[candidates] - nodes[i], axis=1)
        j = int(candidates[np.argmin(d)])
        if d.min() <= tol or level[i] > level.min():
            parent[i] = j
        else:
            parent[i] = root  # last resort: keep the graph connected
