"""Stage C: segment tree, GrowthLength, axis continuation, and SHOOT RANK.

This is the headline stage. It turns the rooted skeleton graph (nodes + parent
links) into a QSM whose cylinders are grouped into **continuous shoots**, each
classified by **shoot rank** (trunk = 0, scaffolds = 1, ...).

Algorithm (verified against TreeQSM / aRchi / SimpleForest -- findings.md Phase 6):
  1. Collapse the node tree into SEGMENTS = maximal chains of degree-2 nodes
     between forks (or between a fork and a leaf / the root).
  2. Compute GrowthLength per segment = its own length + the GrowthLength of all
     segments it supports (cumulative distal length). One post-order pass.
  3. At each fork, the CONTINUATION child = arg max of a weighted score:
        w_L * norm(GrowthLength) + w_A * norm(CSA) + w_theta * norm(cos angle)
     Defaults (1, 0, 0) reproduce aRchi/SimpleForest (largest-subtree rule).
     The continuation child inherits the parent segment's shoot + rank; every
     other child starts a NEW shoot at rank + 1.
  4. A SHOOT = a maximal chain of continuation-linked segments.
  5. rank = number of forks between the base and the shoot's first segment
     (trunk = 0). Equivalent to TreeQSM's extension-based BranchOrder.

Emits a ``QSM``. Cylinders are the skeleton edges (one cylinder per node->parent
edge); radius is a provisional estimate here (point-count proxy) and is replaced
by the real fit in Phase D. The TOPOLOGY and SHOOT/RANK assignment are final.

Deterministic: post-order traversal, arg-max with lowest-index tie-break.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .model import NO_PARENT, QSM, Cylinder, Shoot
from .skeleton import SkeletonGraph


@dataclass
class SegmentOptions:
    # Continuation-score weights: subtree GrowthLength, cross-sectional area,
    # colinearity. (1,0,0) = pure largest-subtree (aRchi/SimpleForest default).
    w_growthlength: float = 1.0
    w_area: float = 0.0
    w_colinear: float = 0.0
    # COLINEARITY GATE for axis continuation (DISABLED by default, = 0.0). When
    # > 0, a child may only CONTINUE the parent's axis (keep its rank+shoot) if it
    # is at least this colinear (cos) with the parent; if NO child clears the gate
    # the parent axis TERMINATES and all children become rank+1 laterals.
    #
    # This was added to match the PyHelios GT's short determinate TRUNK (which ends
    # in a whorl of scaffolds), and on GT geometry it separates continuation (cos
    # ~0.99) from laterals (cos <=0.89) cleanly. BUT on the RECONSTRUCTED skeleton
    # the separation collapses (true continuations dip to cos ~0.73 from level-set
    # noise, and the skeleton merges the whorl into an ordinary 2-way fork), so the
    # gate wrongly terminates real scaffolds -- rank-1 recall fell to 0.17-0.33.
    # Per user decision (2026-06-07): a trunk that continues as rank-0 into a
    # scaffold is acceptable; scaffold recall matters more. So the gate stays OFF
    # and we keep pure largest-GrowthLength continuation. The trunk-whorl rank edge
    # case is a known, accepted limitation (see Layer-2 validation notes); a
    # confidence-gated viewport prompt is the eventual fix, not a magic threshold.
    continuation_min_colinear: float = 0.0
    # Provisional radius from node point-count: r = clip(k * sqrt(count), ...).
    # Only used until Phase D fits real radii; topology/rank don't depend on it
    # unless w_area > 0.
    prov_radius_scale: float = 0.0015
    prov_radius_min: float = 0.002
    prov_radius_max: float = 0.10
    # Prune spurious short branches: a non-continuation LEAF segment whose
    # GrowthLength is below this absolute length (m) is a skeleton-fragmentation
    # artifact (a few level-set noise nodes), not a real branch, so it is removed
    # entirely -- eliminating the spurious fork/shoot without distorting the parent
    # axis. Only short *leaf* fragments are pruned (a short internal segment that
    # carries a sub-branch is kept), and the continuation child at a fork is never
    # pruned, so no real branch or trunk wood is lost. 0 disables. 0.10 m balances
    # removing spurious forks against retaining short real sub-branches (verified
    # on Layer-1 trees; Layer-2 PyHelios scans may warrant retuning once available).
    min_branch_growth_length: float = 0.10


@dataclass
class _Segment:
    seg_id: int
    node_ids: list[int]  # ordered base->tip (parent end first)
    parent_seg: int = NO_PARENT
    children: list[int] = field(default_factory=list)  # child segment ids
    length: float = 0.0
    growth_length: float = 0.0
    shoot_id: int = NO_PARENT
    rank: int = -1


def build_segments(graph: SkeletonGraph) -> list[_Segment]:
    """Collapse the node tree into segments between forks. Returns segments with
    parent/child links (no shoot/rank yet)."""
    if len(graph) == 0:
        return []
    children = graph.children_of()
    parent = graph.parent

    # Fork nodes (>=2 children) and the root start new segments; degree-2 nodes
    # continue the current segment.
    is_break = np.zeros(len(graph), dtype=bool)
    is_break[graph.root] = True
    for n, kids in children.items():
        if len(kids) >= 2:
            for c in kids:
                is_break[c] = True  # each child of a fork starts a new segment

    # Build a segment starting at each break node, walking down through degree-2
    # nodes until the next break or a leaf.
    node_to_seg: dict[int, int] = {}
    segments: list[_Segment] = []
    # Deterministic order: by node id.
    break_nodes = [graph.root] + sorted(
        n for n in range(len(graph)) if is_break[n] and n != graph.root
    )
    for bn in break_nodes:
        if bn in node_to_seg:
            continue
        chain = [bn]
        node_to_seg[bn] = len(segments)
        cur = bn
        while True:
            kids = children[cur]
            if len(kids) != 1:
                break  # fork or leaf ends the segment
            nxt = kids[0]
            if is_break[nxt]:
                break
            chain.append(nxt)
            node_to_seg[nxt] = len(segments)
            cur = nxt
        seg = _Segment(seg_id=len(segments), node_ids=chain)
        # length along the chain + the edge from the chain's first node to its
        # parent node (so segments meet end-to-end).
        L = 0.0
        for a, b in zip(chain[:-1], chain[1:]):
            L += float(np.linalg.norm(graph.nodes[a] - graph.nodes[b]))
        seg.length = L
        segments.append(seg)

    # Link parent/child: a segment's parent is the segment containing the parent
    # node of its first node.
    for seg in segments:
        first = seg.node_ids[0]
        p = int(parent[first])
        if p >= 0 and p in node_to_seg:
            seg.parent_seg = node_to_seg[p]
            # include the connecting edge length (parent node -> first node)
            seg.length += float(np.linalg.norm(graph.nodes[p] - graph.nodes[first]))
            segments[seg.parent_seg].children.append(seg.seg_id)
    return segments


def _compute_growth_length(segments: list[_Segment]) -> None:
    """GrowthLength = segment length + sum of children's GrowthLength. Post-order
    (process children before parents) via reverse topological order."""
    # Topological order from root: BFS, then process in reverse.
    order: list[int] = []
    roots = [s.seg_id for s in segments if s.parent_seg == NO_PARENT]
    stack = list(roots)
    while stack:
        sid = stack.pop()
        order.append(sid)
        stack.extend(segments[sid].children)
    for sid in reversed(order):
        seg = segments[sid]
        seg.growth_length = seg.length + sum(
            segments[c].growth_length for c in seg.children
        )


def _prune_short_branches(
    segments: list[_Segment], min_growth_length: float
) -> list[_Segment]:
    """Remove spurious short LEAF segments (GrowthLength < threshold) that hang off
    a fork. At a fork, a non-continuation child that is itself a leaf (no live
    children of its own) and whose GrowthLength is below the threshold is a
    skeleton-fragmentation artifact -- a handful of level-set noise nodes -- so it
    is removed entirely, eliminating the spurious fork without distorting the
    parent axis.

    Deliberately conservative: only LEAF fragments are pruned (a short internal
    segment that supports a sub-branch is kept, since dropping it would orphan real
    wood), and the largest-GrowthLength child at each fork (the continuation) is
    never pruned, so the trunk and all real branches are preserved. The loop
    repeats until no more fragments qualify (a fork can become a leaf once its
    spurious sibling is gone). Re-indexes segments.
    """
    # Map id -> segment for mutation, then rebuild.
    by_id = {s.seg_id: s for s in segments}
    alive = {s.seg_id: True for s in segments}

    changed = True
    while changed:
        changed = False
        for seg in segments:
            if not alive[seg.seg_id]:
                continue
            live_children = [c for c in seg.children if alive[c]]
            if len(live_children) < 2:
                continue
            # Keep the largest-GrowthLength child (the continuation); consider
            # pruning the others if short AND they are leaves (no live children).
            order = sorted(live_children, key=lambda c: by_id[c].growth_length, reverse=True)
            for c in order[1:]:
                child = by_id[c]
                child_live_kids = [k for k in child.children if alive[k]]
                if child.growth_length < min_growth_length and not child_live_kids:
                    # Drop the short spurious leaf child (a few-node level-set
                    # fragment). It is removed entirely -- its handful of nodes
                    # are skeleton noise, not a real branch, so removing it
                    # eliminates the spurious fork without distorting the parent
                    # axis. (Real branches exceed the threshold and survive.)
                    alive[c] = False
                    seg.children = [x for x in seg.children if x != c]
                    changed = True

    survivors = [s for s in segments if alive[s.seg_id]]
    # Re-index and remap parent/child ids.
    remap = {s.seg_id: i for i, s in enumerate(survivors)}
    new_segs: list[_Segment] = []
    for i, s in enumerate(survivors):
        new_segs.append(
            _Segment(
                seg_id=i,
                node_ids=s.node_ids,
                parent_seg=remap.get(s.parent_seg, NO_PARENT) if s.parent_seg != NO_PARENT else NO_PARENT,
                children=[remap[c] for c in s.children if c in remap],
                length=s.length,
                growth_length=s.growth_length,
            )
        )
    return new_segs


def _seg_direction(seg: _Segment, graph: SkeletonGraph) -> np.ndarray:
    """Unit direction of a segment (first->last node)."""
    a = graph.nodes[seg.node_ids[0]]
    b = graph.nodes[seg.node_ids[-1]]
    v = b - a
    n = float(np.linalg.norm(v))
    return v / n if n > 0 else v


def _assign_shoots_and_ranks(
    segments: list[_Segment],
    graph: SkeletonGraph,
    opts: SegmentOptions,
    prov_radius: dict[int, float],
) -> None:
    """At each fork pick the continuation child -- the best-scoring child that also
    clears the colinearity gate (its axis genuinely continues the parent's). The
    continuation keeps the parent's shoot+rank; every other child starts a new
    shoot at rank+1. If NO child clears the gate the parent axis terminates and ALL
    children become rank+1 laterals (a determinate whorl). Assign shoot ids."""
    next_shoot = 0

    def norm(vals: list[float]) -> list[float]:
        m = max(vals) if vals else 0.0
        return [v / m if m > 0 else 0.0 for v in vals]

    # Process from root outward (BFS) so parents get shoot/rank before children.
    roots = [s.seg_id for s in segments if s.parent_seg == NO_PARENT]
    from collections import deque

    q = deque()
    for r in roots:
        segments[r].shoot_id = next_shoot
        segments[r].rank = 0
        next_shoot += 1
        q.append(r)

    while q:
        sid = q.popleft()
        seg = segments[sid]
        kids = seg.children
        if not kids:
            continue
        if len(kids) == 1:
            # straight continuation, same shoot+rank
            c = kids[0]
            segments[c].shoot_id = seg.shoot_id
            segments[c].rank = seg.rank
            q.append(c)
            continue

        # Fork: score each child, pick the continuation.
        gl = [segments[c].growth_length for c in kids]
        area = [np.pi * prov_radius.get(c, 0.0) ** 2 for c in kids]
        parent_dir = _seg_direction(seg, graph)
        colin = [
            float(np.clip(np.dot(parent_dir, _seg_direction(segments[c], graph)), -1, 1))
            for c in kids
        ]
        gl_n, area_n, col_n = norm(gl), norm(area), norm(colin)
        scores = [
            opts.w_growthlength * gl_n[i]
            + opts.w_area * area_n[i]
            + opts.w_colinear * col_n[i]
            for i in range(len(kids))
        ]
        # Colinearity gate: when enabled (>0), only children whose axis actually
        # continues the parent's may inherit its rank; if none qualifies the axis
        # TERMINATES (a determinate whorl) and ALL children become rank+1 laterals.
        # When disabled (<=0, the default) every child is eligible -- pure
        # score-based continuation, so there is always a continuation.
        if opts.continuation_min_colinear > 0.0:
            eligible = [
                i for i in range(len(kids))
                if colin[i] >= opts.continuation_min_colinear
            ]
        else:
            eligible = list(range(len(kids)))
        # arg max with lowest-index (== lowest seg id, deterministic) tie-break,
        # restricted to gate-eligible children. best = -1 => no continuation.
        best = (
            max(eligible, key=lambda i: (scores[i], -kids[i])) if eligible else -1
        )

        for i, c in enumerate(kids):
            if i == best:
                segments[c].shoot_id = seg.shoot_id  # continuation
                segments[c].rank = seg.rank
            else:
                segments[c].shoot_id = next_shoot
                segments[c].rank = seg.rank + 1
                next_shoot += 1
            q.append(c)


def segments_to_qsm(
    graph: SkeletonGraph, opts: SegmentOptions | None = None
) -> QSM:
    """Full Stage C: skeleton graph -> QSM with shoots + ranks.

    Cylinders are the per-edge segments of the skeleton; radius is provisional
    (Phase D replaces it). Topology and shoot/rank are final.
    """
    opts = opts or SegmentOptions()
    if len(graph) == 0:
        return QSM(meta={"empty": True})

    # Provisional per-node radius from point count (sqrt scaling).
    prov_node_r = {
        i: float(
            np.clip(
                opts.prov_radius_scale * np.sqrt(max(graph.point_count[i], 1)),
                opts.prov_radius_min,
                opts.prov_radius_max,
            )
        )
        for i in range(len(graph))
    }

    segments = build_segments(graph)
    _compute_growth_length(segments)
    if opts.min_branch_growth_length > 0:
        segments = _prune_short_branches(segments, opts.min_branch_growth_length)
        _compute_growth_length(segments)

    # Provisional per-segment radius (mean of its node radii) for the area term.
    prov_seg_r = {
        s.seg_id: float(np.mean([prov_node_r[n] for n in s.node_ids]))
        for s in segments
    }
    _assign_shoots_and_ranks(segments, graph, opts, prov_seg_r)

    # Build the QSM: one cylinder per skeleton edge, tagged with its segment's
    # shoot + rank. Cylinder parent = the cylinder of the previous edge.
    cylinders: list[Cylinder] = []
    node_pair_to_cyl: dict[tuple[int, int], int] = {}
    next_cid = 0

    # Order segments base->tip so parent cylinders exist before children.
    seg_order: list[int] = []
    from collections import deque

    q = deque(s.seg_id for s in segments if s.parent_seg == NO_PARENT)
    while q:
        sid = q.popleft()
        seg_order.append(sid)
        q.extend(segments[sid].children)

    # Map: last cylinder id emitted for each segment (so a child segment's first
    # cylinder can find its parent).
    seg_last_cyl: dict[int, int] = {}

    for sid in seg_order:
        seg = segments[sid]
        # The parent cylinder for this segment's first edge: the parent segment's
        # last cylinder (its tip), or NO_PARENT for the root segment.
        if seg.parent_seg != NO_PARENT and seg.parent_seg in seg_last_cyl:
            parent_cyl = seg_last_cyl[seg.parent_seg]
            parent_node = segments[seg.parent_seg].node_ids[-1]
        else:
            parent_cyl = NO_PARENT
            parent_node = NO_PARENT

        # Walk this segment's nodes, plus the connecting edge from the parent
        # node to the first node (so cylinders are continuous across forks).
        chain = seg.node_ids
        if parent_node != NO_PARENT:
            edge_nodes = [parent_node] + chain
        else:
            edge_nodes = chain

        prev_cyl = parent_cyl
        for a, b in zip(edge_nodes[:-1], edge_nodes[1:]):
            start = graph.nodes[a]
            end = graph.nodes[b]
            if float(np.linalg.norm(end - start)) <= 0:
                continue
            r = prov_seg_r[sid]
            cyl = Cylinder(
                cyl_id=next_cid, start=start, end=end, radius=r,
                parent_id=prev_cyl, shoot_id=seg.shoot_id, rank=seg.rank,
            )
            cylinders.append(cyl)
            node_pair_to_cyl[(a, b)] = next_cid
            prev_cyl = next_cid
            next_cid += 1
        seg_last_cyl[sid] = prev_cyl

    # Build Shoot records.
    shoot_ids = sorted({s.shoot_id for s in segments if s.shoot_id != NO_PARENT})
    shoots: list[Shoot] = []
    seg_by_shoot: dict[int, list[_Segment]] = {sid: [] for sid in shoot_ids}
    for s in segments:
        if s.shoot_id in seg_by_shoot:
            seg_by_shoot[s.shoot_id].append(s)

    cyl_by_shoot: dict[int, list[int]] = {sid: [] for sid in shoot_ids}
    for c in cylinders:
        if c.shoot_id in cyl_by_shoot:
            cyl_by_shoot[c.shoot_id].append(c.cyl_id)

    # Parent shoot + attach cylinder for each shoot.
    for sid in shoot_ids:
        segs = seg_by_shoot[sid]
        rank = segs[0].rank
        # The shoot's parent shoot = the shoot of the parent segment of this
        # shoot's base segment (the first segment whose parent is in another shoot).
        parent_shoot = NO_PARENT
        parent_cyl = NO_PARENT
        for s in segs:
            if s.parent_seg != NO_PARENT and segments[s.parent_seg].shoot_id != sid:
                parent_shoot = segments[s.parent_seg].shoot_id
                parent_cyl = seg_last_cyl.get(s.parent_seg, NO_PARENT)
                break
        shoots.append(
            Shoot(
                shoot_id=sid, rank=rank, cylinder_ids=cyl_by_shoot[sid],
                parent_shoot_id=parent_shoot, parent_cyl_id=parent_cyl,
            )
        )

    # child_shoot_ids
    by_id = {s.shoot_id: s for s in shoots}
    for s in shoots:
        if s.parent_shoot_id in by_id:
            by_id[s.parent_shoot_id].child_shoot_ids.append(s.shoot_id)

    return QSM(
        cylinders=cylinders,
        shoots=shoots,
        units="meters",
        meta={
            "stage": "segments",
            "n_segments": len(segments),
            "n_shoots": len(shoots),
            "max_rank": max((s.rank for s in shoots), default=0),
            "provisional_radius": True,
        },
    )
