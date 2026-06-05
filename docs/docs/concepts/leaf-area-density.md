# Leaf area density

**Leaf area density (LAD)** is the one-sided leaf area per unit volume,
in m²/m³, estimated **per voxel** of a 3-D grid you place over a scanned
canopy. It is the spatial building block of leaf area index (LAI) — sum
LAD over a column of voxels and multiply by their height and you get the
LAI of that column.

Phytograph computes LAD with the PyHelios LiDAR plugin from one or more
terrestrial scans that carry scanner parameters.

## LAD is not a sum of leaf areas

A common misconception is that LAD is the triangulated leaf surface area
divided by the voxel volume. It is **not**. You cannot see every leaf
from a scanner — leaves occlude each other — so simply meshing the hit
points and summing triangle areas systematically *undercounts* the
foliage deeper in the canopy.

Instead, LAD is recovered by **inverting Beer's law** on the laser beams
that pass through each voxel:

1. **Triangulate** the hit points. The mesh is **not** the answer — it is
   used only to estimate the per-voxel **G-function**, `G(θ)`: the mean
   projection of the leaves onto the plane perpendicular to the beam. For
   a random (spherical) leaf-angle distribution `G(θ) ≈ 0.5`; for erect
   (vertical) leaves it is lower.
2. **Trace every beam** through the voxel grid and measure the path
   length `dr` it travels inside each voxel.
3. **Count returns** to estimate the gap probability `P` (the fraction of
   beams that pass *through* the voxel without a return).
4. **Invert** `P = exp(−G(θ) · LAD · dr)` for `LAD`, per voxel.

Because it works from transmission (gaps) rather than from visible
surface, the inversion accounts for occluded foliage — which is the whole
point.

## The voxel grid is required

For [triangulation](../workflows/triangulate.md) a grid is optional. For
LAD it is **mandatory**: LAD is defined per voxel, so the grid *is* the
calculation. You supply it as a **voxel box** created in the viewer, with
its position, size, and per-axis cell counts (Nx × Ny × Nz) setting the
grid. A 1×1×1 box with 1×1×1 cells yields a single canopy-wide LAD value;
subdividing it gives a 3-D density field.

## Single- vs multi-return scans

The inversion differs by return type, and Phytograph detects it from each
scan's parameters:

- **Single-return (discrete):** one return per pulse. The gap fraction is
  estimated directly from hit/miss classification. This works with any
  imported XYZ point cloud.
- **Multi-return (full-waveform):** several returns per pulse. The beams
  are grouped by pulse and weighted equally, and sky/miss rays are
  gap-filled before the inversion. This needs per-return metadata —
  `timestamp`, `target_index`, and `target_count` — preserved from the
  source file. When a scan is marked multi-return but those columns are
  missing, Phytograph falls back to the single-return algorithm and warns
  you.

You don't choose the algorithm directly — it follows each scan's
**return type** (set in its [scan parameters](scans.md)).

## Reading the result

The result is a grid of translucent voxel cells colored by LAD through
the shared [colormap](../reference/color-modes.md), with a colorbar in
m²/m³. Hover a cell to read its exact LAD, G(θ), and hit count. Empty
voxels (no returns) are hidden by default.

See [Estimate leaf area density](../workflows/estimate-leaf-area-density.md)
for the step-by-step workflow.
