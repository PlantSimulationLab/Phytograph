# Session Handoff — QSM Overhaul (resume in ~/Dropbox/Phytograph-qsm)

You are resuming a multi-session project to build a true **QSM (Quantitative
Structure Model)** for Phytograph. This session starts in the git worktree
`~/Dropbox/Phytograph-qsm` (branch `qsm-overhaul`) — **this is where ALL QSM work
happens.** Do not work in `~/Dropbox/Phytograph` (that's the main checkout on
`main`, holding an unrelated WIP that is NOT yours — never touch it).

## First thing to do
Read these, in the worktree, to load full context:
- `progress.md` — chronological build log (most important; has the worktree setup
  notes, per-phase results, and debug findings).
- `qsm_implementation_plan.md` — the full phased build plan.
- `findings.md` — research + **verified formulas (Phase 6 section)** for cylinder
  fitting / SurfCov / rTwig taper. Use these when implementing Phase D/E.
- `task_plan.md` — phase tracker.
- The approved plan: `~/.claude/plans/imperative-wobbling-kahn.md`.
- Memory `project_qsm_overhaul.md` should already be loaded via MEMORY.md.

## What the project is
Reconstruct a dormant (leaf-off) TLS tree point cloud as connected cylinders with
radii + topology, and — the headline feature — segment **continuous shoots
classified by shoot rank** (trunk=0, scaffolds=1, …) = topological branching order
with axis continuation (NOT Strahler). Clean-room Python (scipy/open3d/numpy),
NO ML, NO GPL deps, NO networkx (use scipy.csgraph), no sklearn. Deterministic.

## Where things stand (DONE, all on Layer-1 hand-built synthetic trees)
- **Phase 0** — validation harness (`backend-api/qsm/validation/`): resample
  (arc-length-uniform centerline/surface samples — the correspondence primitive),
  metrics (5 families, each with an anti-gaming guard), gt_io (parse PyHelios GT
  JSON), report, overlay (matplotlib-3D montage), synthetic (hand-built trees +
  cloud sampler). Self-test proves the metrics discriminate.
- **Phase A** — `qsm/preprocess.py`: deterministic index-preserving CSF ground /
  SOR+ROR / largest-connected-component isolation / voxel downsample.
- **Phase B** — `qsm/skeleton.py`: deterministic geodesic level-set skeleton
  (cKDTree graph → Dijkstra → level-set components → rooted tree), with
  component-bridging for occlusion, co-level node merge, spur pruning, Laplacian
  smoothing.
- **Phase C** — `qsm/segments.py` (HEADLINE): segment tree → GrowthLength →
  short-branch pruning → largest-GrowthLength continuation → shoots + ranks.
  Adversarial-fork test PASSES (a thick/straight decoy does NOT steal the leader).
- **Tests: 33 passed, 1 xfailed.** The xfail is the strict OVERALL rank-accuracy
  ≥0.85 bar — DEFERRED to Layer-2 by user decision (simple_tree's ~5mm rank-2
  sub-branches are below the synthetic skeleton's resolution floor; headline
  behaviors that genuinely pass are the Layer-1 gate). Do NOT rubber-stamp it.

## How to run tests (worktree has NO venv — use the main checkout's interpreter)
```
cd ~/Dropbox/Phytograph-qsm/backend-api && \
  /Users/bnbailey/Dropbox/Phytograph/backend-api/venv/bin/python -m pytest tests/qsm/ -q
```
conftest adds the worktree's backend-api to sys.path, so the worktree's `qsm/` and
`main.py` import correctly. (CSF prints verbose terrain/cloth noise to stdout —
harmless, it's the existing segment_ground.) Visual artifacts land in
`backend-api/tests/qsm/_artifacts/` (gitignored) — READ the PNGs to sanity-check;
the user emphasized visual checks because "statistics can lie."

## NEXT: Phase D — robust cylinder fitting
`qsm/cylinders.py`: per sub-segment IRLS/M-estimator (Huber) cylinder fit using the
VERIFIED TreeQSM math in findings.md Phase 6 (5-param [x0,y0,α,β,r], residual
dist=√(xt²+yt²)−r, Gauss-Newton, PCA-seeded axis). Compute SurfCov (res=0.03, nl×ns
grid, 0.8r gate) + mad per cylinder. Replace the provisional radii in the Phase-C
QSM with fits. Validation (`tests/qsm/test_qsm_cylinders.py`): on a forward-
simulated ONE-SIDED/occluded cylinder, recovered radius within ~10% and low SurfCov
flagged; radius bins stem-vs-branch (Metric 2) before correction. Then **Phase E**
(radius correction: monotone path-taper + pipe-model caps + twig anchor).

## ⚠️ COORDINATION GATE (hard stop)
Phases D and E build/unit-test on Layer-1. But the **radius-accuracy validation and
the Phase F endpoint tests genuinely need Layer-2** = the PyHelios-generated cloud +
topology JSON from the C++ generator (`qsm_handoff_helios_cpp.md`, the user is
building it). **STOP and coordinate with the user before wiring Layer 2** — you need
the delivered files + their final on-disk schema/paths. Build Phase D/E fitting +
SurfCov on synthetic cylinders now; pause before the Layer-2 radius-bias validation.

## Working rules
- Commit only when the user asks; commit on the current branch (qsm-overhaul);
  no AI co-author trailers.
- Update progress.md after each phase. Keep main.py thin (logic in qsm/).
- Render an overlay PNG and LOOK at it after each stage (visual sanity).
- Don't loosen a metric bar to pass — put each assertion at the stage that owns it,
  or xfail-with-reason and defer (as done for the strict rank bar).
