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
   (vertical) leaves it is lower. (You can also skip this step and
   [prescribe `G(θ)` directly](#leaf-angle-distributions-and-gθ) from a known
   leaf-angle distribution.)
2. **Trace every beam** through the voxel grid and measure the path
   length `dr` it travels inside each voxel.
3. **Count returns** to estimate the gap probability `P` (the fraction of
   beams that pass *through* the voxel without a return).
4. **Invert** `P = exp(−G(θ) · LAD · dr)` for `LAD`, per voxel.

Because it works from transmission (gaps) rather than from visible
surface, the inversion accounts for occluded foliage — which is the whole
point.

## Leaf-angle distributions and G(θ)

`G(θ)` is the **mean leaf-projection coefficient**: the fraction of leaf area
projected onto the plane perpendicular to a beam travelling at zenith angle `θ`,
averaged over the leaves' orientations. It depends on the canopy's **leaf-angle
distribution** `g_L(θ_L)` (how leaf inclinations are spread between horizontal and
vertical) and on the beam zenith. For a given distribution,

`G(θ) = ∫ A(θ, θ_L) · g_L(θ_L) dθ_L`

where `A` is the standard azimuthally-averaged projection kernel (Warren-Wilson /
Lemeur). Three common cases:

- **Spherical (random):** leaf normals point in every direction equally;
  `G(θ) ≈ 0.5` at all zeniths. This is the usual default.
- **Planophile (mostly horizontal):** `G` is high near nadir and falls toward the
  horizon.
- **Erectophile (mostly vertical):** the opposite — `G` is low near nadir and
  rises toward the horizon.

Phytograph normally **estimates `G(θ)` per voxel from a triangulation** of the hit
points (the surface normals give the leaf orientations). But you can also
**prescribe it directly** — see
[Override G(θ) directly](../workflows/estimate-leaf-area-density.md#override-gθ-directly).
Three ways to specify it:

1. **Constant value** — e.g. `G(θ) = 0.42`.
2. **de Wit classical distribution** — pick a named family (spherical, planophile,
   erectophile, plagiophile, extremophile, uniform); `G(θ)` is derived by
   integrating the kernel over the **actual beam zenith angles** in your scan.
3. **Beta (μ, ν)** — Goel–Strebel parameters (the same convention used by
   [Adjust leaf angles](../workflows/adjust-leaf-angles.md) and the
   [leaf-angle de Wit fitting](../workflows/triangulate.md) on the triangulation
   side); `G(θ)` is derived as for de Wit.

Each can be applied **uniformly** across the grid or as a **vertical profile** (one
method, with the parameter varying by z-level) when leaf inclination changes with
canopy height.

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
  estimated directly from hit/miss classification, so the scan still needs
  miss information — either imported miss points or a `timestamp` column to
  gapfill from (see [Sky/miss points](#skymiss-points-and-gapfilling) below).
- **Multi-return (full-waveform):** several returns per pulse. The beams
  are grouped by pulse and weighted equally, and sky/miss rays are
  gap-filled before the inversion. This needs per-return metadata —
  `timestamp`, `target_index`, and `target_count` — preserved from the
  source file. When a scan is marked multi-return but those columns are
  missing, Phytograph falls back to the single-return algorithm and warns
  you.

You don't choose the algorithm directly — it follows each scan's
**return type** (set in its [scan parameters](scans.md)).

## Sky/miss points and gapfilling

The inversion measures *gaps* — beams that passed through a voxel without a
return — so it needs to know about the beams that hit the **sky** and returned
nothing at all (the "misses"). Phytograph handles misses three ways, in order of
preference:

1. **Imported misses.** Scans from an [E57 or structured PLY](../reference/file-formats.md#skymiss-points)
   carry real miss points (flagged `is_miss`). The inversion uses them directly.
   Toggle **Show misses** on the scan row to verify they're present — they draw
   in a distinct colour. Until the scan has a scanner [origin](../workflows/simulate-scan.md),
   the misses show at their true (typically far-field) coordinates; once you give
   the scan a scanner origin, they're drawn on a sphere just beyond the farthest
   hit so they stay visible against the cloud.
2. **Gapfilled misses.** A scan with **no** miss points but **a `timestamp`
   column** has its misses recovered automatically at compute time: Phytograph
   reconstructs the scan grid from the pulse timestamps and fills the gaps. It
   reports how many misses it recovered.
3. **No miss information.** A scan with neither miss points nor a timestamp can't
   account for the gaps, so the inversion **cannot run** — it would have no valid
   denominator and would only produce a biased number. Phytograph stops with a
   clear message asking you to re-import the scan from a format that carries misses
   (E57 / structured PLY) or one with a `timestamp` column so misses can be
   gapfilled.

## Reading the result

The result is a grid of translucent voxel cells colored by LAD through
the shared [colormap](../reference/color-modes.md), with a colorbar in
m²/m³. Hover a cell to read its exact LAD, G(θ), and hit count. Empty
voxels (no returns) are hidden by default.

## How certain is the estimate?

Every inversion also reports a **sampling-uncertainty interval** following
Pimont et al. (2018). It depends on the **element width** you set in the
LAD dialog — the characteristic width of a leaf or needle (broadleaf
≈ 0.05 m, conifer ≈ 0.002 m) — which scales the variance without changing
the LAD point estimate.

When you select the result, the panel shows a **group-scale confidence
interval** aggregated over all solved voxels (e.g. *Mean LAD 1.23
[1.15–1.31] m²/m³, 95% CI*). This group-scale interval is the one to
report: per-voxel intervals are routinely ±50–100% and only trustworthy in
narrow regimes, whereas the aggregate is much tighter (typically ±5–10%).

Two caveats worth keeping in mind:

- The interval is **conditional on the beams that entered the voxels**. It
  quantifies sampling noise, not **occlusion bias** — foliage that no beam
  ever reached is invisible to both the estimate and its interval.
- If the data fall outside the method's validity envelope, no interval is
  reported rather than a misleading one.

See [Estimate leaf area density](../workflows/estimate-leaf-area-density.md)
for the step-by-step workflow.
