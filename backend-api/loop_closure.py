"""Detect wrong pairwise registrations by checking loop closure over a scan graph.

Why this exists
---------------
On a repetitive planting a WRONG pose is not a poor fit. Measured on a real
vineyard, the winning-but-wrong pose sat 4.12 row spacings off along the rows and
landed vine-on-vine: ICP fitness 0.8914 and inlier RMSE 0.3265 against the
CORRECT pose's 0.9162 and 0.3622. The wrong answer had the *better* residual.

That is not a scoring bug to tune away. Three independent criteria -- inlier
RMSE, ICP fitness, and the fraction of points within a tight threshold -- all
preferred the wrong pose, because pairwise it genuinely is the better fit. No
metric computed from one pair of clouds can separate them.

The registration literature reaches the same conclusion and gives the standard
remedy: use more than two scans. Pairwise alignment "is often ambiguous due to
the low overlap of neighboring point clouds, symmetries and repetitive scene
parts", and loop closure over the scan graph is what "eliminate[s] grossly wrong
coarse alignments" (Dong et al., *A hierarchical multiview registration
framework of TLS point clouds based on loop constraint*, ISPRS 2022; see also
Gojcic et al., *Learning Multiview 3D Point Cloud Registration*, CVPR 2020,
where cyclic consistency "helps in resolving the ambiguous cases").

The constraint is simple: going around a closed loop of scans must return you to
where you started. Composing A->B->C->A should give the identity. A pose that is
one row off breaks that identity even though it fits its own pair beautifully,
because the error does not cancel around the cycle.

Measured over 8 triangles spanning three real orchards:

    loops whose pairs are all correct : 0.013 - 0.106 m closure error
    loops containing a wrong pair     : 5.329 - 6.255 m closure error

A ~50x separation with no overlap, against pairwise metrics that could not
separate the same cases at all. It also caught a bad olive pair that had gone
unnoticed.

Limitation, stated plainly: this needs at least three mutually overlapping
scans. With two clouds there is no loop, the ambiguity is not resolvable from
geometry alone, and the honest output is low confidence rather than a guess.
"""

import itertools
import math
from typing import Callable, Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np

# A loop closes to a few centimetres when every pose in it is right, and to
# metres when one is wrong (measured 0.013-0.106 m against 5.3-6.3 m). 0.5 m
# sits in that gap with an order of magnitude of headroom either side, and is
# well above the ~0.15 m accuracy the pairwise stage itself achieves.
_LOOP_TRANSLATION_TOL_M = 0.5
# Rotation closes far more tightly than translation -- yaw is the DOF the coarse
# stage recovers best (measured 0.156 deg even on the loop with a 6.3 m
# translation error), so this mainly guards against a flipped pose.
_LOOP_ROTATION_TOL_DEG = 2.0


def _relative(pose_a: np.ndarray, pose_b: np.ndarray) -> np.ndarray:
    """Transform taking cloud b into cloud a's frame."""
    return np.linalg.inv(pose_a) @ pose_b


def loop_error(transforms: Sequence[np.ndarray]) -> Tuple[float, float]:
    """(translation_error_m, rotation_error_deg) of a composed cycle.

    `transforms` must compose to the identity for a consistent loop, e.g.
    [T(0<-1), T(1<-2), T(2<-0)].
    """
    composed = np.eye(4)
    for T in transforms:
        composed = composed @ np.asarray(T, dtype=np.float64)
    translation = float(np.linalg.norm(composed[:3, 3]))
    cos = (float(np.trace(composed[:3, :3])) - 1.0) / 2.0
    rotation = math.degrees(math.acos(max(-1.0, min(1.0, cos))))
    return translation, rotation


def triangles(n: int, available: Iterable[Tuple[int, int]]) -> List[Tuple[int, int, int]]:
    """Every 3-cycle whose three edges were all registered."""
    have = {tuple(sorted(e)) for e in available}
    return [t for t in itertools.combinations(range(n), 3)
            if all(tuple(sorted(p)) in have
                   for p in ((t[0], t[1]), (t[1], t[2]), (t[0], t[2])))]


def check_loops(pairs: Dict[Tuple[int, int], np.ndarray], n_scans: int,
                translation_tol: float = _LOOP_TRANSLATION_TOL_M,
                rotation_tol: float = _LOOP_ROTATION_TOL_DEG) -> dict:
    """Score every triangle in the scan graph and localise the bad edges.

    `pairs` maps (a, b) -> 4x4 transform taking scan b into scan a's frame. Only
    one direction per pair is needed; the inverse is used where required.

    Returns {'loops': [...], 'suspect_pairs': [...], 'consistent': bool}.

    A pair is suspect when it appears in a FAILING loop and in no passing one.
    That distinction is what makes this localise rather than merely detect: with
    three scans a single bad pose breaks the only triangle, but with four or more
    the good pairs still close their own loops and the culprit stands out.
    """
    def edge(a: int, b: int) -> Optional[np.ndarray]:
        if (a, b) in pairs:
            return np.asarray(pairs[(a, b)], dtype=np.float64)
        if (b, a) in pairs:
            return np.linalg.inv(np.asarray(pairs[(b, a)], dtype=np.float64))
        return None

    loops = []
    for a, b, c in triangles(n_scans, pairs.keys()):
        legs = [edge(a, b), edge(b, c), edge(c, a)]
        if any(leg is None for leg in legs):
            continue
        dt, dr = loop_error(legs)
        loops.append(dict(scans=(a, b, c), translation_error=dt,
                          rotation_error=dr,
                          closed=bool(dt <= translation_tol and dr <= rotation_tol)))

    in_failing, in_passing = set(), set()
    for lp in loops:
        a, b, c = lp["scans"]
        edges = {tuple(sorted(p)) for p in ((a, b), (b, c), (a, c))}
        (in_passing if lp["closed"] else in_failing).update(edges)

    # Only blame an edge that no passing loop vouches for. With enough scans
    # this localises precisely -- on a 5-scan olive set it named exactly the two
    # wrong pairs out of ten, because the good pairs closed their own triangles.
    suspect = sorted(in_failing - in_passing)

    # A single triangle cannot localise: one bad pose breaks the only loop, so
    # all three edges look equally guilty. Rank them by how much each one's
    # REMOVAL would be needed -- i.e. report them, but say the loop could not
    # attribute blame, so a caller does not "repair" a pair that was fine.
    localised = bool(in_passing) or len(suspect) <= 1
    return dict(loops=loops, suspect_pairs=suspect, localised=localised,
                consistent=bool(loops and not any(not lp["closed"] for lp in loops)),
                checked=bool(loops))


def resolve_with_loops(n_scans: int,
                       register: Callable[[int, int, Optional[int]], List[np.ndarray]],
                       max_alternatives: int = 4) -> dict:
    """Register every pair, then use loop closure to replace wrong poses.

    `register(a, b, rank)` returns candidate transforms taking scan b into scan
    a's frame, best-first. `rank` is None for the initial (best) attempt, or an
    integer to request that alternative. Returning fewer candidates than asked
    for simply limits how many alternatives are tried.

    The search is deliberately shallow: try each suspect pair's next-best
    candidate and keep the first that closes the loops. A wrong pose is wrong
    because a rival fitted better, so the right answer is usually a few ranks
    down rather than buried.
    """
    pairs: Dict[Tuple[int, int], np.ndarray] = {}
    for a, b in itertools.combinations(range(n_scans), 2):
        cands = register(a, b, None)
        if cands:
            pairs[(a, b)] = np.asarray(cands[0], dtype=np.float64)

    report = check_loops(pairs, n_scans)
    if not report["checked"] or report["consistent"]:
        return dict(pairs=pairs, report=report, repaired=[], unresolved=[])

    repaired = []
    for (a, b) in report["suspect_pairs"]:
        original = pairs.get((a, b))
        for rank in range(1, max_alternatives + 1):
            cands = register(a, b, rank)
            if not cands or len(cands) <= rank:
                break
            pairs[(a, b)] = np.asarray(cands[rank], dtype=np.float64)
            trial = check_loops(pairs, n_scans)
            if trial["consistent"] or (a, b) not in trial["suspect_pairs"]:
                repaired.append(dict(pair=(a, b), used_rank=rank))
                report = trial
                break
        else:
            if original is not None:
                pairs[(a, b)] = original
            continue
        if not repaired or repaired[-1]["pair"] != (a, b):
            if original is not None:
                pairs[(a, b)] = original

    final = check_loops(pairs, n_scans)
    # Anything still suspect could not be repaired from the candidates offered.
    # That is a real outcome, not a failure of this function: on a real olive
    # pair NO variant of the coarse stage found the right pose (occupancy and
    # height rasters at three shortlist sizes all landed 3-6 m out, every one of
    # them reporting ambiguous=True). Report it as unresolved so the caller can
    # leave that scan unregistered rather than place it wrongly.
    return dict(pairs=pairs, report=final, repaired=repaired,
                unresolved=list(final["suspect_pairs"]))


# Coarse-stage variants to try when a scan graph is available. Each is a
# (cell_size, raster_mode) pair passed straight to `register_by_correlation`;
# None means "let auto_cell_size decide".
#
# Why more than one: no single setting registers every scene, and the choice
# cannot be made from a pair alone. Measured on a real vineyard, only
# (2.0, "height") registered it (0.10-0.20 m) while the other three landed
# 15-28 m out -- yet ICP fitness picked a 27.6 m answer and inlier RMSE picked a
# 102 m one. Pairwise scores are blind here for the same reason they are blind
# to a row-shift: the wrong pose fits its own pair well.
_COARSE_VARIANTS = (
    (None, "occupancy"),
    (None, "height"),
    (2.0, "occupancy"),
    (2.0, "height"),
)


def _probe_edges(n_scans: int, max_edges: int = 9) -> List[Tuple[int, int]]:
    """A small edge set that still contains cycles, for scoring variants.

    Consecutive scans plus a few chords: consecutive positions are the most
    likely to overlap (they were walked in order), and each chord closes a
    cycle, which is the only thing loop scoring needs. Returns all pairs when
    the graph is small enough that subsetting saves nothing.
    """
    every = list(itertools.combinations(range(n_scans), 2))
    if len(every) <= max_edges:
        return every
    edges = [(i, i + 1) for i in range(n_scans - 1)]
    edges.append((0, n_scans - 1))
    for step in (2, 3):
        for i in range(0, n_scans - step):
            if len(edges) >= max_edges:
                return edges
            pair = (i, i + step)
            if pair not in edges:
                edges.append(pair)
    return edges


def select_per_pair_by_loops(n_scans: int,
                             candidates: Callable[[int, int], List[np.ndarray]],
                             max_passes: int = 5) -> dict:
    """Choose a coarse-stage variant PER PAIR, judged by whole-graph consistency.

    `candidates(a, b)` returns that pair's candidate transforms, one per variant,
    in a fixed order.

    Why per-pair rather than one setting for the whole set: measured on the olive
    orchard, 9 of 10 pairs have SOME variant that registers them, but the working
    variant differs -- pair (0,2) needs the height raster where every other pair
    wants occupancy. A single set-wide choice cannot express that, and picking
    occupancy left (0,2) 4.33 m out.

    The objective is HOW MANY LOOPS CLOSE, not the worst loop error. That
    distinction is load-bearing. Minimising the worst loop fails whenever one
    pair is unregisterable by any variant: that pair appears in several loops,
    dominates the maximum, and the search trades away pairs that were fine
    chasing it. Measured, that made a good pair go 0.031 m -> 5.632 m while never
    fixing the broken one. Counting closed loops is robust to an irreparable
    pair, because the loops that avoid it can still all close.

    Returns {'assignment', 'pairs', 'report', 'closed', 'total'}.
    """
    keys = list(itertools.combinations(range(n_scans), 2))
    table = {k: candidates(*k) for k in keys}
    table = {k: v for k, v in table.items() if v}
    if not table:
        return dict(assignment={}, pairs={}, report={}, closed=0, total=0)
    keys = list(table)
    n_variants = min(len(v) for v in table.values())

    def evaluate(assign):
        pairs = {k: np.asarray(table[k][assign[k]], dtype=np.float64) for k in keys}
        report = check_loops(pairs, n_scans)
        closed = [lp for lp in report["loops"] if lp["closed"]]
        # Fewer-closed sorts worse; ties break on tighter total residual.
        score = (-len(closed), sum(lp["translation_error"] for lp in closed))
        return score, report, pairs

    # Seed from the best UNIFORM assignment, so per-pair search only has to
    # improve on the previous behaviour rather than rediscover it.
    best = None
    for v in range(n_variants):
        assign = {k: v for k in keys}
        score, _, _ = evaluate(assign)
        if best is None or score < best[0]:
            best = (score, dict(assign))
    assign = best[1]

    for _ in range(max_passes):
        improved = False
        for k in keys:
            current = assign[k]
            best_score, _, _ = evaluate(assign)
            for v in range(n_variants):
                if v == current:
                    continue
                assign[k] = v
                score, _, _ = evaluate(assign)
                if score < best_score:
                    best_score, current, improved = score, v, True
                else:
                    assign[k] = current
            assign[k] = current
        if not improved:
            break

    score, report, pairs = evaluate(assign)
    return dict(assignment=assign, pairs=pairs, report=report,
                closed=-score[0], total=len(report["loops"]))


def select_variant_by_loops(n_scans: int,
                            register: Callable[[int, int, Optional[float], str], np.ndarray],
                            variants: Sequence[Tuple[Optional[float], str]] = _COARSE_VARIANTS) -> dict:
    """Choose the coarse-stage variant whose whole scan graph is self-consistent.

    `register(a, b, cell, mode)` returns the 4x4 taking scan b into scan a's
    frame for one variant.

    Loop closure can make this choice where pairwise scores cannot, because it
    asks a question about the SET of poses rather than about any one of them.
    Measured on the vineyard: the correct variant closed its loops to 0.156 m
    while the three wrong ones closed to 3.0-15.2 m, and that ordering matched
    the true registration error exactly (0.195 m against 15-28 m).

    Returns {'cell', 'mode', 'pairs', 'report', 'worst_loop', 'scored'}.
    """
    # Judge each variant on a SUBSET of the graph. Deciding which variant to use
    # needs only enough cycles to tell a self-consistent set of poses from an
    # inconsistent one, and every pair costs a coarse search plus an ICP pass:
    # scoring all pairs of 10 scans across 4 variants projects to ~28 minutes,
    # against ~4 for the probe below. The winner is then run over the full graph.
    probe = _probe_edges(n_scans)

    scored = []
    best = None
    for cell, mode in variants:
        pairs: Dict[Tuple[int, int], np.ndarray] = {}
        for a, b in probe:
            M = register(a, b, cell, mode)
            if M is not None:
                pairs[(a, b)] = np.asarray(M, dtype=np.float64)
        report = check_loops(pairs, n_scans)
        worst = max((lp["translation_error"] for lp in report["loops"]),
                    default=float("inf"))
        scored.append(dict(cell=cell, mode=mode, worst_loop=worst))
        if best is None or worst < best["worst_loop"]:
            best = dict(cell=cell, mode=mode, pairs=pairs, report=report,
                        worst_loop=worst)
    if best is None:
        return dict(cell=None, mode="occupancy", pairs={}, report={},
                    worst_loop=float("inf"), scored=scored)

    # Fill in the pairs the probe skipped, using the winning variant.
    pairs = best["pairs"]
    for a, b in itertools.combinations(range(n_scans), 2):
        if (a, b) in pairs:
            continue
        M = register(a, b, best["cell"], best["mode"])
        if M is not None:
            pairs[(a, b)] = np.asarray(M, dtype=np.float64)
    best["pairs"] = pairs
    best["report"] = check_loops(pairs, n_scans)
    best["scored"] = scored
    return best
