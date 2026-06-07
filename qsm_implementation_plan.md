# QSM Implementation Plan

> Companion to `findings.md` (research) and `task_plan.md` (research-phase tracking).
> This is the build plan, derived from the locked decisions below. **Plan only — no
> code is written until the user approves.**

## Locked decisions (from research + user)
1. **Clean-room reimplement in Python** from permissive primitives (scipy/open3d/networkx).
   No GPL code (TreeQSM/SimpleForest/AdTree/PyTLidar all GPL-3.0) ships in the app.
2. **Axis-continuation rule = largest subtree / GrowthLength** (Rule A) by default.
3. **Radius correction in scope from day one** (rTwig-style monotone taper + pipe-model caps
   + measured-twig anchor).
4. **"Shoot rank" = topological branching order with axis continuation, trunk = 0.** NOT
   Strahler (which the current code wrongly uses).
5. **Implement in Python first; profile; only push a proven hotspot kernel into helios-core
   C++ via the existing in-process pyhelios binding.** Never an out-of-process data ship.

## Target semantics (the contract)
Given a TLS cloud of a dormant tree, produce a **QSM**:
- A set of **cylinders**, each with axis endpoints, radius, parent cylinder.
- A **topology** (rooted tree of cylinders, base at trunk).
- **Shoots/axes**: each cylinder belongs to exactly one shoot; one shoot per axis.
- **Shoot rank**: trunk shoot = 0; at each fork the continuation child keeps the rank,
  others get parent_rank + 1. (Maps to leader=0, primary scaffold=1, secondary=2.)
- Per-cylinder **quality flags** (SurfCov, mad) and a model-level quality summary.
- Horticultural **metrics**: TCSA, per-rank branch count / diameter / angle, shoot lengths,
  total woody volume (stem vs branch reported separately).

---

## Architecture & boundaries (respecting the 3-process model)
- **Backend (`backend-api/main.py`)**: new QSM endpoint(s) + a new module for the heavy
  logic (keep `main.py` from ballooning — see "Code layout" below). Reads points from the
  **in-RAM array / session**, never re-reads the file ([[project_array_source_of_truth]]).
- **Renderer**: new cylinder renderer + shoot/rank coloring + a QSM panel. Talks HTTP to
  `/api/qsm/*` via `backendApi.ts`.
- **Main/IPC**: unchanged (no new IPC surface; compute stays on HTTP).
- **Version-lock trio** must move together when the endpoint ships:
  `BACKEND_VERSION` (main.py:112) + `EXPECTED_BACKEND_VERSION` (constants.ts:3) +
  `package.json` version (currently all `0.6.0` → bump to e.g. `0.7.0`).

### Code layout (avoid the 5000-line main.py trap)
- New backend package `backend-api/qsm/` (pure functions, no FastAPI):
  - `preprocess.py` — denoise, voxel, single-tree isolate, trellis removal.
  - `skeleton.py` — geodesic level-set skeleton (evolve current BFS).
  - `segments.py` — segment tree, GrowthLength, axis continuation, **shoot rank**.
  - `cylinders.py` — robust per-segment cylinder fit (IRLS) + SurfCov/mad.
  - `radius.py` — taper correction + pipe-model caps + twig anchor.
  - `metrics.py` — horticultural metrics.
  - `model.py` — dataclasses for Cylinder / Segment / Shoot / QSM.
- `main.py` keeps only the thin endpoint(s) that call into `qsm/`. Pure functions = unit-testable.

---

## Endpoint design
- `POST /api/qsm/build` — full pipeline. Request: `source` (octree) or `points`, plus a
  flat options block (preprocess + skeleton + fit + correction params, all with sane
  auto-defaults). Response: cylinders[], shoots[] (id, rank, cylinder ids), per-cylinder
  quality, model metrics, processing stats. Long-running → keep the existing 5-min client
  timeout pattern; consider a streaming/progress variant later (mirror `/api/plant/generate/stream`).
- Keep the legacy `POST /api/skeleton/extract` working during transition (don't break the
  existing skeleton import/export + `Skeleton3D`/`SkeletonPoints` renderers). QSM is additive.
- Persisted/exported QSM format: extend the existing skeleton file format (App.tsx import path
  at :291) to carry cylinders + radius + shoot/rank, OR a new `.qsm`-style JSON. Decide in Phase 6.

---

## Phased build (each phase = a reviewable, testable PR)

### Phase A — Preprocessing & deterministic foundation
- `qsm/preprocess.py`: SOR+ROR denoise, voxel downsample (edge ≤ ½ smallest target radius),
  optional intensity/deviation filter (guarded — only if the cloud carries it), DBSCAN
  single-tree isolation, trellis/wire removal (intensity + linear-geometry + graph
  disconnect; behind a flag, off by default until validated).
- Pin determinism: explicit `np.random.default_rng(seed)`, sort all inputs, no global RNG.
- CSF ground reuse (already present).
- **Tests**: synthetic cloud → known point count after each filter; determinism (same input
  twice → identical output). Real fixtures: small committed XYZ; ask user for a real dormant
  TLS cloud (too big to commit → not synthetic per testing rules).

### Phase B — Deterministic geodesic skeleton
- `qsm/skeleton.py`: evolve current BFS into a clean geodesic level-set skeleton:
  cKDTree kNN/radius graph → `csgraph.dijkstra` from base → bin by geodesic distance (width Δ)
  → connected-component centroids → connect adjacent levels → rooted node/edge tree.
- Robust **junction handling** (AppleQSM's documented failure point): reconnect across small
  gaps using node proximity + axis-continuity, suppress spurious cycles.
- **Tests**: synthetic Y-tree and 3-scaffold tree → correct node/edge counts, single root,
  acyclic, deterministic.

### Phase C — Segment tree, GrowthLength, SHOOT RANK (the headline feature)
- `qsm/segments.py`: collapse node tree into segments (chains between forks); rooted at base.
- Post-order pass → GrowthLength (Σ supported segment lengths) per segment.
- Axis continuation: at each fork pick continuation child by largest GrowthLength (Rule A).
  Structure the score as `w_L·GrowthLength + w_A·CSA + w_θ·cosθ` with defaults `(1,0,0)` so
  Rule B/C are tunable later without a rewrite.
- Form shoots (maximal continuation chains); assign **rank = #forks from base to the axis's
  first segment** (trunk = 0).
- **Tests** (richest suite — this is the core requirement): synthetic trees with KNOWN
  topology → assert trunk is ONE shoot of rank 0; each scaffold is one shoot of rank 1;
  higher orders correct; continuation picks the larger-subtree child even when a sibling is
  thicker or straighter (guards the robustness claim). Cover reiteration-like cases.

### Phase D — Robust cylinder fitting + quality metrics
- `qsm/cylinders.py`: per sub-segment IRLS/M-estimator cylinder fit
  (`scipy.optimize.least_squares`, Huber/Tukey), PCA-seeded axis, projected-circle-seeded
  radius. Enforce endpoint continuity along a shoot.
- SurfCov (lateral-surface coverage grid) + mad per cylinder.
- **Tests**: forward-simulate a cylinder point set at known radius (incl. a **one-sided/
  occluded** arc) → fitter recovers true radius within tolerance and flags low SurfCov.
  Confirms occlusion-bias awareness.

### Phase E — Radius correction (the #1 orchard accuracy fix)
- `qsm/radius.py`: monotone taper along each root-to-tip path (rTwig flavor — `pygam` or a
  monotone spline; add `pygam` to `backend-api/requirements.txt` if used), pipe-model/da Vinci
  CSA caps (A_parent ≥ Σ A_children), tip anchored to a measured/per-species twig diameter
  (configurable; orchard cultivars likely absent from rTwig's DB → user-supplied default).
  Replace low-SurfCov / unrealistic cylinder radii with the path-taper prediction.
- **Tests**: synthetic tree with injected fat thin-branch fits → correction restores monotone
  taper and reduces volume toward truth; stem radius left essentially untouched (the −2.5%
  vs +21% asymmetry from Demol). Report stem vs branch error separately.

### Phase F — Metrics + endpoint + version bump
- `qsm/metrics.py`: TCSA, per-rank branch count/diameter/angle, shoot lengths, woody volume
  (stem vs branch). `qsm/model.py` dataclasses → response schema.
- `POST /api/qsm/build` in main.py (thin). Bump version-lock trio together.
- `backendApi.ts`: `buildQSM()` + request/response types.
- **Tests**: endpoint integration (pytest) on a committed small fixture → schema-valid,
  shoots/ranks present, metrics in plausible ranges.

### Phase G — Frontend: cylinder renderer + shoot/rank UI
- New `viewer/renderers/QSM3D.tsx` (or extend Skeleton3D): instanced cylinder meshes;
  **color by shoot rank** (and a "color by shoot id" mode so each continuous shoot is visually
  one object — directly demonstrates the headline feature). Hover/select a shoot → highlight
  the whole continuous axis + show its rank/length/diameter.
- QSM options panel + "Build QSM" action wired through `App.tsx` (mirror the skeleton path).
- **E2E** (Playwright + live backend, non-negotiable per CLAUDE.md): import a committed
  dormant-tree fixture → Build QSM → assert in the rendered DOM/viewer state: N cylinders > 0,
  a rank-0 trunk shoot exists, ≥1 rank-1 shoot, radii within a known range. Drive the real UI,
  read real outputs — no mocking `/api/*`.

### Phase H — PROFILE, then optimize (the C++ escape hatch) ⟵ folded-in milestone
**Gate: only enter after A–G are correct and deterministic on a real dormant-tree cloud.**
"Make it right, then make it fast." Do NOT optimize before this gate.

1. **Profile** the full `/api/qsm/build` on a real (10⁵–10⁶ point) dormant TLS cloud:
   `cProfile` / `py-spy` over the pipeline; record wall-clock per stage in `progress.md`.
2. **Expectation from research** (most heavy paths are already compiled C under numpy/scipy/
   open3d; Python only orchestrates a few thousand segments). Named **candidate hotspots**, in
   the order they're likely to matter — promote to helios-core C++ ONLY if profiling proves it:
   - (c1) Custom cover-set / patch builder, if we add one (per-point loops that don't vectorize).
   - (c2) Cylinder-fit inner loop, IF segment count explodes or per-fit iteration dominates.
   - (c3) SurfCov accumulation over millions of points × many cylinders, if not vectorizable.
   - (c4) Any bespoke neighbor/graph op not covered by cKDTree/csgraph.
3. **Escape-hatch mechanism (already in place — confirmed):** pyhelios binds `libhelios`
   **in-process** to the FastAPI Python; numpy buffers cross via `addHitPoints`-style
   contiguous handoff. So promoting (cN) = add a C++ function in `pyhelios/native/` +
   `helios-core`, expose it through the existing binding, call it from the relevant `qsm/*.py`.
   It is a **binding addition, not a data-shipping redesign** — the cloud is already reachable
   from C++, and the in-RAM array stays the single source of truth.
4. **Rule:** promote one proven kernel at a time, re-profile after each, keep the Python
   implementation as the reference/fallback (and for tests). Never port the whole pipeline,
   never stand up an out-of-process C++ service. If — unexpectedly — the cost is spread thinly
   across many tight custom loops rather than 1–2 kernels, escalate to the user before a larger
   C++ port; that's a different decision than this plan assumes.
5. **Determinism preserved across the boundary**: any C++ kernel must be deterministic
   (no unseeded RNG, stable ordering) so Python-ref and C++-fast outputs match within tolerance
   — assert this in a test.

### Phase I — Docs (same commit as the behavior, per CLAUDE.md)
- `concepts/skeletons.md` → add/relate a QSM concept (cylinders, shoots, rank); maybe new
  `concepts/qsm.md`. `workflows/extract-skeleton.md` → QSM workflow (or new `build-qsm.md`).
  `reference/file-formats.md` → QSM export format. `developers/` → new endpoint + qsm/ module +
  the profile-then-C++ policy. Re-capture screenshots if the QSM UI state is screenshot-worthy.

---

## TESTING STRATEGY (decided 2026-06-07)

### Ground-truth synthetic fixtures via PyHelios (the key advantage)
Realistic clouds + EXACT topology. A standalone helios-core C++ test project:
1. Grows a tree with PlantArchitecture (parameterized; deterministic seed).
2. Removes leaves/fruit (leaf-off): per-phytomer `removeLeaf()` / `setLeafScaleFraction(0)`
   so only woody internode tubes remain.
3. Writes GROUND-TRUTH TOPOLOGY to a text/JSON file (see schema below).
4. Runs `syntheticScan` (ray-traced LiDAR, realistic occlusion) → exports the point cloud.
Our pytest/E2E then imports the cloud, runs the QSM, and validates against the topology file.

### Ground truth is fully exposed in helios-core (VERIFIED in PlantArchitecture.h)
- `Shoot`: `ID`, `parent_shoot_ID`, `parent_node_index`, **`rank`** (← maps to OUR shoot rank!),
  `base_position`, `childIDs` (map<node, vector<childShootID>>),
  `shoot_internode_vertices[phytomer][seg]` (3D polyline of the axis),
  `shoot_internode_radii[phytomer][seg]` (per-segment radius), `calculateShootLength()`.
- `Phytomer`: `getInternodeNodePositions()`, `getInternodeRadius()`, `getInternodeAxisVector()`.
- NOTE: helios `Shoot.rank` ALREADY uses topological order (trunk shoot rank 0). This is the
  exact semantics we're targeting → ground truth needs no re-derivation, just export `rank`.

### Ground-truth file schema (proposed)
Per plant: list of cylinders, each = {cyl_id, shoot_id, rank, parent_cyl_id, p0[xyz], p1[xyz],
radius, phytomer_index, segment_index}. Plus per-shoot: {shoot_id, rank, parent_shoot_id,
parent_node, child_shoot_ids[], length}. Units = meters (match scan). Deterministic ordering.

### Two-layer test design
- **Layer 1 — hand-built cylinder trees (Python, unit tests):** author tiny cylinder graphs
  in test code with known endpoints/radii/shoot/rank; sample points on surfaces with controlled
  occlusion/noise/gaps/outliers. Fast, deterministic, no PyHelios dep. Tests EVERY stage's
  correctness (esp. shoot-rank at adversarial forks: thicker/straighter sibling that is NOT the
  continuation). These are pure-function unit tests of qsm/*.py.
- **Layer 2 — PyHelios ground-truth fixtures (integration/E2E):** the C++-generated cloud +
  topology file. Higher fidelity (real geometry, real ray-traced occlusion). Validates the full
  /api/qsm/build against known answers. Committed as fixtures if small enough; else generated.

### Validation metrics (assert against ground truth, per no-rubber-stamp rule)
- **Shoot/rank topology (PRIMARY):** each recovered cylinder's shoot membership + rank matches GT
  after a matching step (nearest-GT-cylinder by midpoint). Report % cylinders correctly ranked;
  trunk must be exactly one rank-0 shoot; scaffold count = GT rank-1 shoot count.
- **Radius:** fitted + corrected radius vs GT radius, RMSE/bias, STEM vs BRANCH reported separately.
- **Topology connectivity:** #cylinders, acyclic, single root, no shortcut mis-merges.
- **Determinism:** identical output on repeat runs.

### Sequence: synthetic first, then real
Build + validate entirely on synthetic ground-truth (Layers 1+2). Only after the algorithm is
correct on known geometry do we move to real dormant-tree TLS (capture at UC Davis; no synthetic
substitute for the real-data validation per testing rules). Real data has no perfect GT → validate
with manual diameter tape + visual shoot/rank inspection + self-consistency (SurfCov/mad).

### Handoff
A separate helios-core C++ agent writes the standalone test-fixture-generator project (grow →
deleaf → export topology → syntheticScan → export cloud) and delivers the generator + sample
output files. Prompt drafted (see qsm_handoff_helios_cpp.md).

## Open questions to settle before/early in Phase F–G
- Export format: extend skeleton format vs new `.qsm` JSON? (affects App.tsx import path + docs)
- Streaming progress for long builds (mirror plant/generate/stream) — Phase F or later?
- Twig-diameter anchor: ship a small editable default table for orchard cultivars?

## Pre-implementation verification (do FIRST, per research caveats)
Several primary PDFs were 403-blocked; before coding the math, confirm from primary sources:
- `least_squares_cylinder.m` Gauss-Newton/SurfCov formulas (TreeQSM repo — readable directly).
- rTwig taper + twig-anchor specifics (Morales & MacFarlane 2024 Forestry / 2025 Sci.Remote Sens.).
- SimpleForest GrowthLength definition + allometric exponents.
These are reimplementation references, not copy targets (clean-room).

## Errors / risks log
| Risk | Mitigation |
|------|------------|
| Junction failures break shoot ranking | Phase B robust junction reconnect; richest tests in Phase C |
| Thin-branch radius bias misleads users | Phase E correction in scope from day one; report stem/branch separately |
| Premature C++ port wastes effort | Phase H gate: profile first, promote one proven kernel at a time |
| main.py bloat | All logic in backend-api/qsm/; main.py only thin endpoints |
| GPL contamination | Clean-room; primary sources are references only |
| Nondeterminism | Seeded RNG, sorted inputs, determinism asserted in tests incl. across C++ boundary |
