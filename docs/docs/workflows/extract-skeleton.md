# Extract a skeleton

Pull the **branching topology** out of a woody scan: a graph of nodes
(junctions and tips) connected by edges (branch segments), with
per-branch order (Strahler number) and length.

## Inputs

You need one of:

- A **point cloud** of a woody plant (typically TLS data, ground
  removed). Best results with even coverage and intensity > ~1k points/dm³
  on branches.
- A **triangulated mesh** of the same.

Leaves can be present but degrade results — if you have a way to
filter the cloud to woody points only (intensity threshold,
classification field), do so first.

## Run extraction

1. Select the cloud or mesh in the Scene panel.
2. Click **Extract Skeleton** (branch icon).
3. The panel on the right opens.
4. Choose a **method**:

    - **LAPLACE** — Laplacian contraction. Best for dense clouds with
      full angular coverage. Robust to small gaps but slow on very
      large inputs.
    - **TEASAR** — voxel-based shortest-path. Faster, tolerates sparser
      data, occasionally produces extra spurs in noisy regions.

5. **Branch simplification tolerance** — slider in meters. Higher
   values merge more colinear edges, yielding cleaner but lower-detail
   skeletons. Start at the default and adjust based on results.
6. Click **Extract**.

A new entry appears in the **Skeletons** list, with:

- Node count (junctions + tips + intermediate points)
- Edge count
- Total skeleton length

## Visualize branch order

By default the skeleton is colored by **Strahler branch order** — trunk
in deep green, primary branches in lighter green, secondaries in
yellow-green, twigs in mustard. To change:

1. Right-click the skeleton entry → **Color By**.
2. Pick **Branch Order** (default), **Single Color**, or **Length**.

To see only first-order branches (the trunk and primary scaffolds), use
the **Filter by branch order** range slider in the skeleton's
properties panel.

## Get measurements out

The skeleton entry's properties panel shows aggregate metrics:

- Total length
- Branch count per order
- Mean branch length per order

For per-branch detail, export to `.json` — the file contains every node
and edge with its position, branch order, and length.

## Common problems

**"My skeleton has spurs everywhere."**
Branch simplification tolerance is too low, or the input cloud has
heavy noise. Try raising tolerance, or pre-filter the cloud to woody
points before extracting.

**"The skeleton is missing whole branches."**
Coverage in those regions is too sparse for the algorithm. For LAPLACE
this manifests as the skeleton "ducking" around the gap; for TEASAR it
manifests as the gap being skipped entirely. Solutions:

- Use a different method (try TEASAR if LAPLACE failed, or vice versa)
- Combine multiple scan positions via [Stitch](register-compare.md#stitch) before extracting
- Triangulate first and extract from the mesh

**"The trunk is in two pieces."**
Usually a connectivity gap near the ground. Make sure ground points
are removed but the trunk base is intact — overcropping the bottom can
disconnect the root of the skeleton.

## What's next

- Compare to a [generated plant model](generate-plant.md) of the same
  species — useful for validating both your scan and the model.
- [Export](import-export.md#export) the skeleton as `.json` for analysis
  in Python or R.
