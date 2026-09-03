"""Fine registration: spatially-uniform, multi-scale, plane-to-plane ICP.

Why the previous fine stage made alignments WORSE
-------------------------------------------------
Ground truth for this is RiSCAN PRO's Multi Station Adjustment. Every
paired dataset here ships the same scans twice, unregistered and registered,
so the surveyed pose of each scan is recoverable exactly: match returns
between the two exports and solve Kabsch, which lands on 0.5 mm -- the LAZ
quantisation step, i.e. an exact answer.

Measured that way on the four-scan UC Davis farm set, the shipped pipeline's
COARSE raster stage placed every scan within 2.8-7.6 cm, and the ICP
"refinement" that ran next pushed them out to 17.6-34.1 cm. The refinement was
not merely imprecise, it was the dominant error: a 3-12x regression on top of
an already-good pose, in a stage whose only job is to improve it.

Three causes, which compound:

1. STRIDE DECIMATION IS NOT A SPATIAL SAMPLE. A terrestrial scanner samples in
   ANGLE, so return density falls as 1/r^2 -- on this set the median
   nearest-neighbour spacing runs 4 mm at 5-15 m against 103 mm beyond 40 m.
   Taking every k-th point preserves that bias exactly, so near-field geometry
   outvotes the far field no matter how many points are kept, and ICP's
   equally-weighted correspondences hand the pose to whatever surface happens
   to be closest to the tripod. `_drop_near_field` was a patch over the
   symptom: it deleted everything inside 5 m so the far field could be heard.
   Voxel downsampling removes the cause instead -- one point per occupied cell
   of a fixed metric grid weights each surface by AREA, so a trunk at 3 m and a
   trunk at 60 m count alike and nothing has to be thrown away.

2. THE CORRESPONDENCE WINDOW WAS SET BY THE PLOT, NOT BY THE DETAIL. Deriving
   it from the decimated cloud's spacing gave 1.36 m on this set. A window that
   wide, over foliage, pairs a leaf with a different leaf on a different plant
   and the minimum moves. Multi-scale is the standard cure and it is what the
   window should have been all along: start wide enough to pull in the coarse
   stage's error, then tighten geometrically, re-matching at each step.

3. NORMALS AVERAGED OVER METRES. `diagonal * 0.02` is 1.99 m here. A
   point-to-plane residual measured against a plane fitted through two metres
   of canopy is not a surface constraint; it is noise with a direction. The
   local surface belongs to the sampling scale, not to the plot -- see
   `_COVARIANCE_NEIGHBOURS`, which also explains why it is a neighbour COUNT
   and not a radius.

What replaced it
----------------
A voxel pyramid per cloud, coarse to fine, with the correspondence window tied
to each level's voxel and Open3D's generalized ICP (plane-to-plane) as the
estimator. Median displacement from RiSCAN's pose, over every non-reference
scan of each set:

    set                    shipped   coarse only   this module
    UC Davis farm (4)      0.181 m       0.069 m       0.017 m
    olive (5)              0.064 m       0.082 m       0.005 m
    peach (6)              0.066 m       0.030 m       0.010 m

Generalized ICP rather than point-to-plane because it models BOTH surfaces as
locally planar instead of only the target: measured on the UC Davis set,
1.2-1.7 cm against 1.8-2.2 cm for point-to-plane with a Tukey loss. It comes
out of the same local fits a normal would have -- the extra cost is storage,
a 3x3 covariance per point where a normal is three numbers.

It costs time: measured end to end, the olive set goes from 53 s to 157 s and
peach from 117 s to 357 s. Almost none of that is the ICP -- profiled on one
olive pair, every level converged inside its first ten iterations and the whole
six-level fit took 9 s. The cost is the per-point SURFACE pass, which is why a
pyramid is built once per scan and reused across every pair it appears in, and
why the two things worth optimising here were both in that pass rather than in
the registration itself (see `median_spacing` and `_plane_shaped`).

What each level buys, from that same profile (error against RiSCAN, starting
from a coarse pose 2.4 cm out):

    level  voxel   points     -> translation error
      0    0.64 m     32 k       6.9 cm   (worse: a 1.9 m window on a 2.4 cm
      1    0.32 m     82 k       2.7 cm    error has nothing to gain and room
      2    0.16 m    177 k       2.1 cm    to lose -- it recovers below)
      3    0.08 m    354 k       1.1 cm
      4    0.04 m    762 k       0.27 cm
      5    0.02 m   1765 k       0.29 cm  (halves the ROTATION error, 0.008 to
                                           0.005 deg; translation is done)

Two things to take from it. The accuracy is made in the last two levels, so
`_MAX_POINTS_PER_LEVEL` and `_MIN_FINEST_VOXEL_M` are the dials that matter --
and the finest level costs as much as the whole rest of the ladder for a
rotation refinement only. And the coarsest level can move a good starting pose
AWAY from the truth, which is the price of a window wide enough to rescue a bad
one; the ladder is what makes that safe rather than fatal.
"""

from typing import List, Optional, Sequence, Tuple

import numpy as np

# Correspondence window as a multiple of the level's voxel. Three voxels is
# about two cells of slack either side: wide enough that a point still finds
# its partner after the previous level's residual, tight enough that it cannot
# reach the next plant. This ratio is held constant down the pyramid, which is
# what makes the ladder self-similar -- each level sees the same problem at
# half the scale.
_CORR_PER_VOXEL = 3.0

# Neighbours per local surface fit. A COUNT, not a radius, and that is a
# correction rather than a preference: a radius of 3 voxels looks reasonable
# at the sampling scale and quietly starves in the far field, where the real
# spacing is 100 mm against 4 mm near the tripod, so a sphere sized for the
# dense end holds two or three points at the sparse end and the covariance it
# returns is noise. Since keeping the far field is the entire point of the
# uniform sampling above, that is the worst place to be degenerate -- measured,
# it put scan 4 of the UC Davis set 10.2 cm out against 1.3 cm with a count.
# A count adapts: 30 neighbours span millimetres in the near field and metres
# in the far one, and describe a surface in both.
_COVARIANCE_NEIGHBOURS = 30

# The finest voxel, as a multiple of the cloud's median nearest-neighbour
# spacing. Below ~4x a voxel holds one point on average, so downsampling stops
# equalising density and just deletes returns.
_FINEST_PER_SPACING = 4.0

# Bounds on the finest voxel GUESS. The floor keeps a dense close-range scan
# from asking for a pyramid nobody can hold; the ceiling keeps a sparse one
# from stopping while there is still detail to use. Neither bounds the answer:
# the point budget below can push the voxel past the ceiling, because the
# budget is a memory bound and a coarse registration is recoverable where an
# exhausted machine is not.
_MIN_FINEST_VOXEL_M = 0.02
_MAX_FINEST_VOXEL_M = 0.25

# Points per cloud at the finest level. Surfaces scale as 1/voxel^2, so this
# caps memory and runtime together; exceeding it grows the voxel rather than
# dropping points, because dropping points would reintroduce cause (1).
#
# The arithmetic that sets it: a pyramid is ~4/3 of its finest level, and each
# point carries a 3x3 covariance as well as its coordinates -- 96 bytes, four
# times what the raw points cost. At this cap that is ~320 MB per pyramid, so a
# caller holding two (which is all `_do_multi_scan_register` ever holds: the
# reference plus the scan being aligned) peaks around 0.6 GB regardless of how
# many scans the set has. Hold them ALL and a five-scan set reaches 5 GB, which
# is how this was found.
_MAX_POINTS_PER_LEVEL = 2_500_000

# Levels are voxel/2 apart, so this bounds the pull-in range at
# _CORR_PER_VOXEL * finest * 2^(levels-1).
_MAX_LEVELS = 6

# Iterations a single level may spend. It converges long before this on real
# data -- the cap is there so a pathological pair cannot run forever.
_MAX_ITERATIONS_PER_LEVEL = 40

# A level stops when its RMSE improves by less than this, in metres. Absolute
# rather than relative because what matters is whether the remaining motion is
# below the accuracy the level can resolve at all.
_RMSE_PLATEAU_M = 1e-6

# The flattening Open3D's generalized ICP applies to each local covariance:
# rebuild it in its own eigenbasis as diag(epsilon, 1, 1), which is what turns
# a sample covariance into the plane-shaped weight the estimator's Mahalanobis
# residual is defined against. Open3D does this itself in
# `InitializePointCloudForGeneralizedICP` -- but ONLY to covariances it
# computed, and it computes them only when the cloud has none.
#
# So supplying raw covariances does not merely skip an optimisation, it hands
# the estimator a matrix of the wrong shape, and it fails SILENTLY: measured on
# a small synthetic pair, raw covariances gave fitness 0.0 (no correspondences
# at all, no error raised, the pose returned unchanged) where letting Open3D
# fill them in gave fitness 1.0. They have to be supplied -- the run re-enters
# the estimator once per iteration batch, and letting it recompute covariances
# on every entry costs far more than the batching saves -- so they have to be
# supplied in the shape it expects.
_GICP_EPSILON = 1e-3

# Iterations between cancellation checks. A level is one blocking C++ call, so
# the batch size IS the interruption granularity; restarting GICP from its own
# output costs only the correspondence search it would have redone anyway.
_ITERATION_BATCH = 10

# WHAT WAS TRIED AND REJECTED: gating each level down to its locally PLANAR
# returns (surface variation lambda0/sum(lambda) below ~0.02), on the theory
# that foliage is not repeatable between viewpoints -- a leaf seen edge on from
# one station is seen face on from the next -- so hard surfaces should decide
# the pose. It measures well with a point-to-plane estimator (0.5-1.0 cm on the
# UC Davis set) and is a trap with this one.
#
# Selecting the flattest returns is not a neutral filter, it is a vote for the
# ground: an ungated level of that set is 54% horizontal-normal, gated it is
# 81%, and 87% of what survives lies below ground level, because ground IS the
# flattest thing in an orchard. A plane-to-plane residual constrains motion
# along its own normal, so a set that is nearly all ground pins z, roll and
# pitch and says almost nothing about x, y or yaw -- and the fit slides. It did:
# scan 4 went from 2.8 cm (coarse) to 7.0 cm with the rotation error still at
# 0.01 deg, i.e. purely horizontal, and one ladder produced a 65 cm failure.
# Re-balancing the gate across normal-orientation buckets removed the blowups
# but still scored WORSE than not gating at all (2.9 cm median against 1.7 cm).
#
# So the density equalisation above is the whole of the selection here. Do not
# re-add a planarity gate without measuring the horizontal error specifically;
# a global RMSE hides this failure completely.


def median_spacing(points: np.ndarray, sample: int = 20000) -> Optional[float]:
    """Median nearest-neighbour distance, sampled. None when unmeasurable.

    The tree is built with `compact_nodes=False, balanced_tree=False` and a
    large leaf. Those switch cKDTree's construction from median-splitting to
    midpoint-splitting; the tree stays EXACT, so every query returns the same
    neighbour, and on a 10 M-point scan the build drops from 4.2 s to 0.9 s
    (verified bit-identical, 2.4495 mm either way). It is the right trade here
    because the build is paid once for only `sample` queries -- the balanced
    tree's advantage is query speed, which this never spends.
    """
    from scipy.spatial import cKDTree

    finite = points[np.isfinite(points).all(axis=1)]
    if len(finite) < 100:
        return None
    probe = finite[np.linspace(0, len(finite) - 1,
                               min(sample, len(finite))).astype(int)]
    tree = cKDTree(finite, leafsize=64, compact_nodes=False, balanced_tree=False)
    dist, _ = tree.query(probe, k=2, workers=-1)
    spacing = float(np.median(dist[:, 1]))
    return spacing if np.isfinite(spacing) and spacing > 0 else None


def working_copy(points: np.ndarray,
                 budget: int = _MAX_POINTS_PER_LEVEL) -> Tuple[np.ndarray, float]:
    """Reduce one cloud to the finest voxel grid that fits `budget`.

    Returns (points, voxel). Call this ONCE per scan, at ingest, and keep the
    result instead of the full cloud: it is the memory bound for the whole fine
    stage, and it is a spatially uniform sample rather than a strided one, so
    unlike a stride cap it can be reduced further without re-introducing the
    1/r^2 density bias (see the module docstring).

    The voxel is MEASURED rather than predicted. Occupied-cell count depends on
    how the returns are distributed in space, not on how many there are, so a
    count-based formula is only a first guess -- it is corrected by downsampling
    and looking. `budget` wins over `_MAX_FINEST_VOXEL_M`; see that constant.
    """
    import open3d as o3d

    pts = np.asarray(points, dtype=np.float64)
    pts = pts[np.isfinite(pts).all(axis=1)]
    spacing = median_spacing(pts)
    voxel = float(np.clip(_FINEST_PER_SPACING * (spacing or _MIN_FINEST_VOXEL_M),
                          _MIN_FINEST_VOXEL_M, _MAX_FINEST_VOXEL_M))
    cloud = o3d.geometry.PointCloud()
    cloud.points = o3d.utility.Vector3dVector(pts)
    for _ in range(6):
        reduced = cloud.voxel_down_sample(voxel)
        count = len(reduced.points)
        if count <= budget:
            break
        # Returns lie on surfaces, so occupancy falls roughly as 1/voxel^2; the
        # 5% overshoot keeps this from needing a second pass in the common case.
        voxel *= float(np.sqrt(count / budget)) * 1.05
    return np.asarray(reduced.points), voxel


def plan_levels(finest: float, pull_in: float) -> List[Tuple[float, float]]:
    """(voxel, correspondence distance), coarse -> fine.

    `pull_in` is how far the initial pose may be wrong, in metres: the coarsest
    level's window is at least that, so the first pass can still reach the true
    partner. The ladder then halves the voxel down to `finest`, which should be
    the WIDEST voxel among the clouds involved -- a level finer than the
    sparsest cloud can populate buys that cloud nothing and costs the dense one
    time.
    """
    finest = float(np.clip(finest, _MIN_FINEST_VOXEL_M, _MAX_FINEST_VOXEL_M))
    levels = 1
    while (_CORR_PER_VOXEL * finest * (2 ** (levels - 1)) < pull_in
           and levels < _MAX_LEVELS):
        levels += 1
    return [(finest * 2 ** k, _CORR_PER_VOXEL * finest * 2 ** k)
            for k in range(levels - 1, -1, -1)]


def _plane_shaped(normals: np.ndarray,
                  epsilon: float = _GICP_EPSILON) -> np.ndarray:
    """The local covariance Open3D's generalized ICP wants, from the surface
    NORMAL -- see `_GICP_EPSILON` for why the shape is mandatory.

    What that shape is: the covariance rebuilt as diag(epsilon, 1, 1) in its
    own eigenbasis, with `epsilon` on the SMALLEST eigenvalue's axis. That axis
    is the normal -- the direction a point on a surface is not free to move in
    -- and shrinking its variance is what makes the estimator's Mahalanobis
    residual behave like a plane-to-plane distance. Putting it on the largest
    axis instead flattens each patch along a TANGENT, which nothing reports:
    the run still converges, onto a pose 18 deg out on a synthetic pair the
    correct order solves to 0.001 deg.

    Written from the normal rather than by eigendecomposing the covariance,
    because the eigenbasis is orthonormal and so the whole expression collapses:

        V diag(e,1,1) V^T  =  e n n^T + (v1 v1^T + v2 v2^T)
                           =  e n n^T + (I - n n^T)
                           =  I - (1 - e) n n^T

    Only the normal survives. That turns a batched `numpy.linalg.eigh` over
    millions of 3x3 matrices -- 3.1 s per level on a real scan, as expensive as
    computing the covariances in the first place -- into one outer product at
    0.04 s, and lets the normal come from Open3D's own C++ solver rather than
    from LAPACK. Verified equivalent on 1.77 M real points: maximum difference
    9.6e-09, not one point over 1e-6.
    """
    shaped = np.einsum('ni,nj->nij', normals, normals)
    np.negative(shaped, out=shaped)
    shaped *= (1.0 - epsilon)
    shaped[:, 0, 0] += 1.0
    shaped[:, 1, 1] += 1.0
    shaped[:, 2, 2] += 1.0
    return shaped


class Pyramid:
    """One cloud, voxel-downsampled at each level with local covariances.

    Build it once and reuse it for every pair the scan takes part in: the
    covariance pass is the expensive half of the fine stage, and a multi-scan
    set puts its reference in every pair.
    """

    def __init__(self, points: np.ndarray,
                 levels: Sequence[Tuple[float, float]]):
        import open3d as o3d

        pts = np.asarray(points, dtype=np.float64)
        pts = pts[np.isfinite(pts).all(axis=1)]
        self._levels = list(levels)
        self._clouds = []
        # Downsample from the previous (finer) level rather than from the full
        # cloud: each level is a reduction of the one below it, so this is both
        # cheaper and self-consistent.
        current = o3d.geometry.PointCloud()
        current.points = o3d.utility.Vector3dVector(pts)
        # The finest level is voxelised even when `points` is already a working
        # copy on that same grid, which looks like a 1.1 s no-op. It is not
        # quite one -- `voxel_down_sample` returns cell CENTROIDS, so a second
        # pass shifts points slightly and merges a few (1,765,169 -> 1,765,146
        # on an olive scan) -- and skipping it was measured at 1.1 s per scan
        # (~3% of a run) for a ~0.1 mm change in the result. Not worth threading
        # the input's grid size through to find out; the pass stays.
        for voxel, _corr in sorted(self._levels, key=lambda level: level[0]):
            current = current.voxel_down_sample(voxel)
            level = o3d.geometry.PointCloud(current)
            # NORMALS, then `_plane_shaped` -- see that function for why the
            # estimator's covariance needs nothing else. Computed here rather
            # than left to Open3D so a cloud taking part in several pairs pays
            # for them once; the reference of a multi-scan set is in every pair,
            # and the estimator is re-entered once per iteration batch.
            level.estimate_normals(
                o3d.geometry.KDTreeSearchParamKNN(_COVARIANCE_NEIGHBOURS))
            level.covariances = o3d.utility.Matrix3dVector(
                _plane_shaped(np.asarray(level.normals)))
            self._clouds.append(level)
        # Built fine -> coarse; index by the level list's own (coarse -> fine)
        # order.
        self._clouds.reverse()

    def __len__(self) -> int:
        return len(self._clouds)

    def level(self, index: int):
        return self._clouds[index]

    @property
    def sizes(self) -> List[int]:
        return [len(c.points) for c in self._clouds]


def align(target: Pyramid, source: Pyramid,
          levels: Sequence[Tuple[float, float]],
          init: Optional[np.ndarray] = None,
          max_iterations: int = _MAX_ITERATIONS_PER_LEVEL,
          rmse_threshold: float = _RMSE_PLATEAU_M,
          progress=None) -> dict:
    """Register `source` onto `target`, coarse level to fine.

    `init` is a world-frame 4x4 mapping source points into the target's frame;
    identity when the two already share a frame. `max_iterations` and
    `rmse_threshold` are PER LEVEL -- each level is its own registration
    problem, and a budget shared across the ladder would be spent by the coarse
    levels that need it least. Returns the refined matrix plus the final
    level's fitness/RMSE -- those two are only comparable between runs that
    ended on the SAME voxel, since the correspondence window they are measured
    over shrinks with it.

    `progress`, when given, is called as `progress(level_index, level_count,
    voxel)` after each batch of iterations; raising from it (which is how
    cancellation is signalled) aborts the run between batches.
    """
    import open3d as o3d

    transform = (np.eye(4) if init is None
                 else np.asarray(init, dtype=np.float64).reshape(4, 4).copy())
    estimator = o3d.pipelines.registration.TransformationEstimationForGeneralizedICP()
    result = None
    iterations = 0
    for index, (voxel, corr) in enumerate(levels):
        tgt, src = target.level(index), source.level(index)
        if len(tgt.points) < 10 or len(src.points) < 10:
            continue
        done = 0
        previous_rmse = float("inf")
        while done < max_iterations:
            batch = min(_ITERATION_BATCH, max_iterations - done)
            result = o3d.pipelines.registration.registration_generalized_icp(
                src, tgt, corr, transform, estimator,
                o3d.pipelines.registration.ICPConvergenceCriteria(
                    max_iteration=batch, relative_fitness=1e-9,
                    relative_rmse=1e-9))
            done += batch
            iterations += batch
            # A batch that found nothing must not overwrite a good pose with
            # the identity-ish result of an empty solve -- the same rule
            # `_icp_quality` exists to enforce, applied before the damage.
            if result.fitness <= 0.0:
                break
            moved = np.asarray(result.transformation, dtype=np.float64)
            settled = (np.allclose(moved, transform, atol=1e-9)
                       or 0.0 <= previous_rmse - result.inlier_rmse < rmse_threshold)
            previous_rmse = result.inlier_rmse
            transform = moved
            if progress is not None:
                progress(index + 1, len(levels), voxel)
            if settled:
                break

    # 0.0 rather than NaN when no level ran: this goes straight into a JSON
    # response, and `json.dumps` emits a bare `NaN`, which `JSON.parse` in the
    # renderer rejects -- a failed alignment would surface as a parse error
    # rather than as the zero-fitness result `_icp_quality` knows how to
    # explain. Open3D uses the same convention for "nothing matched".
    return dict(
        transformation=transform,
        fitness=float(result.fitness) if result is not None else 0.0,
        rmse=float(result.inlier_rmse) if result is not None else 0.0,
        iterations=iterations,
        levels=len(levels),
    )


def refine(target_points: np.ndarray, source_points: np.ndarray,
           init: Optional[np.ndarray] = None, pull_in: float = 2.0,
           max_iterations: int = _MAX_ITERATIONS_PER_LEVEL,
           rmse_threshold: float = _RMSE_PLATEAU_M,
           progress=None) -> dict:
    """One-shot wrapper: reduce both clouds, plan a ladder, align.

    Prefer `working_copy` + `plan_levels` + `Pyramid` + `align` when a cloud is
    registered more than once (a multi-scan set reuses the reference in every
    pair); this rebuilds everything on each call.
    """
    target, target_voxel = working_copy(target_points)
    source, source_voxel = working_copy(source_points)
    levels = plan_levels(max(target_voxel, source_voxel), pull_in)
    return align(Pyramid(target, levels), Pyramid(source, levels), levels,
                 init=init, max_iterations=max_iterations,
                 rmse_threshold=rmse_threshold, progress=progress)
