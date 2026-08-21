# Extract a skeleton

Pull the **branching topology** out of a woody scan: a graph of nodes
(junctions and tips) connected by edges (branch segments), with
per-branch order (Strahler number) and length.

## Inputs

You need:

- Exactly **one selected point cloud** of a woody plant (typically TLS data,
  ground removed). Best results with even coverage and intensity > ~1k
  points/dm³ on branches.

Skeleton extraction runs on point clouds only — a mesh is not a valid input,
and the tool stays greyed out unless a single cloud is selected.

Leaves can be present but degrade results — if you have a way to
filter the cloud to woody points only (intensity threshold,
classification field), do so first.

## Run extraction

1. Select the cloud in the Scene panel.
2. Click **Extract Skeleton** (the DNA-helix icon in the **Tools** ›
   Reconstruction group).
3. The **Skeleton Extraction (BFS Graph)** panel opens on the right. There is
   one algorithm — a BFS graph method — so there's no method to choose.
4. Set the options you need:

    - **Remove outlier points** — checkbox; drops isolated noise before
      building the graph.
    - **Smooth skeleton (Laplace)** — checkbox; Laplacian smoothing of the
      resulting centerline.
    - **Search Radius** — slider, 0–0.2 m. Left at `0` it reads
      *Auto (based on density)* and picks a radius from the cloud itself.
    - **Min Points/Block** — slider, 1–50 (default 5). Raise it to suppress
      spurs in noisy regions.

5. **Advanced Options** (collapsed by default) adds Root Threshold,
   Quantization Levels, Nonlinear quantization, Proportion filter, and
   Smoothing Iterations.
6. Click **Extract Skeleton**. While it runs the button shows a spinner and a
   **Cancel** button appears beside it — Cancel kills the computation and adds
   nothing.

A new entry appears in the **Skeletons** list, showing its **total length** and
**point count** (e.g. `12.84m · 512 pts`).

## Visualize branch order

Skeletons draw in a single flat color (amber) by default. Tick **Color by
branch order** in the **Skeletons** panel to color by branch order instead: an
8-step ramp indexed from the tips — order 1 red, then orange, yellow, green,
cyan, blue, violet, and order 8+ (the trunk) pink. Orders past 8 clamp to pink.

The same panel has **Show as cylinders**, which draws the edges as tubes
instead of lines, with a **Tube Radius** slider.

## Get measurements out

The skeleton's row reports its **total length** and **point count**.

For anything more detailed, export it:

- **`.json`** — every node (position + `branchOrder`) and every edge as a
  `[from, to]` index pair, plus `totalLength`, `nodeCount`, `edgeCount`, and
  `maxBranchOrder`. This is the only format that imports back into Phytograph.
  See [Skeleton JSON shape](../reference/file-formats.md#skeleton-json-shape).
- **`.obj`** / **`.ply`** — geometry for Blender or MeshLab.

Per-edge lengths aren't written out; derive them from the node positions.

## Common problems

**"My skeleton has spurs everywhere."**
The input cloud is noisy, or the graph is being built too finely. Raise
**Min Points/Block**, tick **Remove outlier points**, and consider
[separating wood from leaf](segment-wood.md) first so only woody points feed
the extraction.

**"The skeleton is missing whole branches."**
Coverage in those regions is too sparse to connect. Solutions:

- Raise **Search Radius** (or leave it at Auto) so the graph bridges wider gaps
- Combine multiple scan positions via [Stitch](register-compare.md#stitch) before extracting
- Lower **Min Points/Block**, which may be discarding thin branch tips

**"The trunk is in two pieces."**
Usually a connectivity gap near the ground. Make sure ground points
are removed but the trunk base is intact — overcropping the bottom can
disconnect the root of the skeleton.

## What's next

- Compare to a [generated plant model](generate-plant.md) of the same
  species — useful for validating both your scan and the model.
- [Export](import-export.md#export) the skeleton as `.json` for analysis
  in Python or R.
