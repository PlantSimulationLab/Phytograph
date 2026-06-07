# Handoff: Helios C++ QSM Test-Fixture Generator

**Audience:** a Helios-core C++ engineer/agent.
**Purpose:** build a standalone C++ program that generates *ground-truth* tree
fixtures for testing a new QSM (Quantitative Structure Model) reconstruction
pipeline in Phytograph. We need realistic LiDAR point clouds paired with the
*exact* known tree topology, so our reconstruction can be validated for
correctness (not just "didn't crash").

---

## What we're building (the consumer of your output)

We are writing a QSM pipeline that takes a terrestrial-LiDAR point cloud of a
**dormant (leaf-off)** tree and reconstructs it as connected cylinders with:
- estimated **radii** and **parent/child topology**, and
- **continuous shoots segmented and classified by shoot rank** (trunk = rank 0,
  scaffolds = rank 1, higher orders = rank 2+).

To test this, we need synthetic trees where we *know* the true cylinders, the
true shoot membership, and the true rank of every piece of wood.

PlantArchitecture is perfect for this: it grows trees from shoots/phytomers and
**already carries exactly the topology we need** — including a `rank` field on
each `Shoot` that uses the same topological-ordering semantics we target.

---

## Deliverables

1. A **standalone C++ program** (in the helios-core samples/utilities style, with
   a CMakeLists that links the `plantarchitecture` + `lidar` plugins) that, for
   one or more parameterized trees:
   1. **Grows** a PlantArchitecture tree to a target age with a **fixed RNG seed**
      (deterministic — same seed → identical tree every run).
   2. **Removes all leaves and fruit/flowers** so only the woody internode tubes
      remain (leaf-off condition).
   3. **Writes a ground-truth topology file** (schema below).
   4. Runs a **`syntheticScan`** (ray-traced LiDAR) of the de-leafed tree from one
      or more scanner positions, and **exports the resulting point cloud**
      (XYZ + per-hit columns) to a file.
2. **Sample output files** for at least 2–3 trees of increasing complexity:
   - (a) a simple tree: single trunk + 3 scaffolds + a few sub-branches;
   - (b) a moderately branched tree;
   - (c) one with a deliberately tricky fork (a lateral that is *thicker* or
     *straighter* than the axis continuation, to stress shoot-rank logic).
   For each tree: the ground-truth topology file **and** the scanned point cloud.
3. A short **README** documenting: how to build/run, the CLI args (tree preset,
   seed, age, scanner positions, output paths), the exact file formats produced,
   and the **coordinate units** (we assume meters — confirm).

You do **not** need to touch the Phytograph backend, the FastAPI server, or any
TypeScript. This is a self-contained generator. Deliver the program + sample
files; we wire them into our pytest/Playwright fixtures on our side.

---

## Verified API anchors (helios-core `plugins/plantarchitecture/include/PlantArchitecture.h`)

Everything below was confirmed to exist in the header. Use it as the basis; adapt
to the actual method signatures you find.

### Growing + de-leafing
- Build a plant from the library and advance time (see Phytograph's existing usage
  in `backend-api/main.py` around the `/api/plant/*` endpoints and
  `pyhelios/pyhelios/PlantArchitecture.py` for the Python-side calling pattern —
  mirror that in C++).
- **Leaf-off:** `Phytomer::removeLeaf()` and/or `Phytomer::setLeafScaleFraction(0)`;
  there is also a branch-level `pruneBranch`/prune API. Goal: the exported scene
  and the `syntheticScan` see **only internode (woody) tubes**, no leaves,
  petioles, peduncles, flowers, or fruit. (If petioles/peduncles can't be fully
  suppressed, document what remains so we can filter it.)
- **Determinism is mandatory** — set/seed the RNG so re-running produces identical
  geometry. Document the seed CLI arg.

### Ground-truth topology (the `Shoot` struct + `Phytomer` accessors)
Per `Shoot`:
- `ID` (int), `parent_shoot_ID` (int; trunk's parent = -1 or sentinel),
  `parent_node_index` (uint — which node of the parent this shoot attaches to),
  **`rank` (uint — topological shoot rank; trunk shoot = 0)** ← this is the key
  field; export it verbatim.
- `base_position` (vec3).
- `childIDs` — `std::map<int, std::vector<int>>` mapping a node index to the IDs of
  child shoots emerging there.
- `shoot_internode_vertices` — `std::vector<std::vector<helios::vec3>>`
  (first index = phytomer within shoot, second = tube segment within that
  phytomer's internode) — the 3D polyline of the shoot's woody axis.
- `shoot_internode_radii` — `std::vector<std::vector<float>>` (same indexing) —
  the radius at each segment vertex.
- Helpers: `calculateShootLength()`, `calculateShootInternodeVolume()`,
  `getShootAxisVector(float fraction)`.

Per `Phytomer` (if you traverse at phytomer granularity instead):
- `getInternodeNodePositions()` → `std::vector<vec3>`,
  `getInternodeRadius()` / `getInternodeRadius(float stem_fraction)`,
  `getInternodeAxisVector(float stem_fraction)`.

You'll need the `PlantArchitecture` accessor that returns the shoots for a plant
(e.g. the plant's shoot list / shoot-tree). Find the public getter (look for
methods returning shoot IDs or `std::shared_ptr<Shoot>`; Phytograph's Python
wrapper exposes `getAllPlantObjectIDs` / `getAllPlantUUIDs` / `getPlantBasePosition`
— there will be a C++ equivalent giving access to the shoot structures). If the
shoot list isn't publicly accessible, the smallest possible addition to expose a
read-only shoot/topology accessor is acceptable — but prefer using existing public
API. **Flag if you had to add an accessor**, so we can fold it into the version-lock.

### Synthetic scan
- `LiDARcloud::syntheticScan(...)` ray-traces the current Context scene. Phytograph
  already calls it (`backend-api/main.py` ~line 3245) — match those `ScanParameters`
  conventions (scanner origin, angular ranges/resolution, etc.). Export hits as a
  point cloud. Per-hit scalar columns Phytograph records are documented near
  `main.py:3168` — at minimum we need **XYZ**; include scan/return columns if cheap.
- Use **enough angular resolution** that thin branches get several points around
  their circumference (we resolve branches down to ~5 mm radius). Support **multiple
  scanner positions** (CLI arg) so we can produce both well-covered and deliberately
  one-sided/occluded clouds.

---

## Ground-truth file schema (target — adjust field names as needed, keep it documented)

Prefer **JSON** (easy for us to parse in pytest). One file per generated tree.

```json
{
  "units": "meters",
  "seed": 12345,
  "plant_age": 90,
  "scanner_positions": [[x,y,z], ...],
  "shoots": [
    {
      "shoot_id": 0,
      "rank": 0,
      "parent_shoot_id": -1,
      "parent_node_index": 0,
      "base_position": [x,y,z],
      "child_shoot_ids": [1,2,3],
      "length": 1.83
    }
  ],
  "cylinders": [
    {
      "cyl_id": 0,
      "shoot_id": 0,
      "rank": 0,
      "phytomer_index": 0,
      "segment_index": 0,
      "parent_cyl_id": -1,
      "start": [x,y,z],
      "end": [x,y,z],
      "radius": 0.041
    }
  ]
}
```

Rules:
- **Cylinders** = consecutive vertex pairs from `shoot_internode_vertices`
  (segment i = vertices[i] → vertices[i+1]), radius from `shoot_internode_radii`
  (use the segment's representative radius; document whether it's start/end/mean).
- `parent_cyl_id`: the previous segment in the same shoot; for a shoot's *first*
  cylinder, the parent is the cylinder of the parent shoot at `parent_node_index`.
  (If that mapping is awkward, give us enough info — shoot_id + parent_shoot_id +
  parent_node_index + per-shoot ordered cylinders — and we can derive parent_cyl_id
  ourselves. Don't block on this.)
- `rank` on a cylinder = its shoot's `rank`.
- **Deterministic ordering** of arrays (sorted by shoot_id, then phytomer, then
  segment) so diffs are stable.
- Units must match the point-cloud export units exactly.

## Point-cloud file format
- Whatever Phytograph already imports cleanly is ideal — plain **ASCII XYZ** (one
  `x y z` per line, meters) is the safe default; **PLY** also fine. If you include
  extra per-hit columns (intensity, scan id, return number), document the column
  order in the README. We will import this through our normal point-cloud path.

---

## Acceptance / sanity checks (please verify before delivering)
- Re-running with the same seed yields byte-identical topology + cloud.
- The de-leafed scene truly has no leaf/fruit geometry (spot-check the scanned
  cloud doesn't show leaf blobs).
- `rank` values look right: exactly one rank-0 shoot (the trunk); its direct
  children rank 1; etc.
- Cylinder count and total length are plausible vs the tree's visible size.
- The tricky-fork tree (c) actually has a lateral that is thicker and/or straighter
  than the continuation, so it exercises our shoot-continuation logic.

## Questions to surface back to us
- Confirm scene/scan **units** (we assume meters).
- Did you need to add any public accessor to helios-core to reach the shoot
  topology? (Affects our version-lock + submodule bump.)
- Any geometry that couldn't be suppressed in leaf-off mode (petioles? buds?).
- Which library tree model(s) you used for presets (so we know the architecture).
