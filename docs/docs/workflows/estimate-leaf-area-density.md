# Estimate leaf area density

Compute per-voxel **leaf area density (LAD)** over a scanned canopy. See
[Leaf area density](../concepts/leaf-area-density.md) for the concept —
in short, LAD inverts Beer's law on the laser beams passing through each
voxel, so it accounts for occluded foliage rather than just visible
surface.

## Prerequisites

- One or more **scans with scan parameters** (scanner origin + angular
  sweep). Import them with their parameters (e.g. **Add Scan → Import
  from XML**) or attach parameters from the Scans panel. A scan with only
  point data and no parameters cannot be used.
- A **voxel grid** — LAD requires one (unlike triangulation).
- **Sky/miss points.** LAD needs the beams that passed through the canopy
  without returning (the Beer's-law transmission denominator), so each
  scan must carry misses. Formats like E57 and structured PLY retain them;
  others can [reconstruct them](backfill-misses.md) from a per-return
  `timestamp` and/or scan-grid row/column indices. LAD no longer recovers
  misses silently — run **Backfill Misses** first when a scan has none (the
  dialog tells you and offers a button). A scan with no misses and no way to
  recover them can't be used until re-imported in a miss-retaining format.

## Steps

1. **Select the scan(s)** in the Scans panel first, then **create the
   voxel grid.** Click **Create Voxel Grid** (the box icon in the Create group).
   A 1×1×1 m box appears at the origin and the Transform panel opens; the
   scan selection is kept so you can fit the box in one click.
    - Click **Fit to selected scan(s)** in the Transform panel to resize
      and center the box around the selected scan(s) (with a small buffer
      so edge points aren't clipped). The button is enabled whenever one or
      more scans with points are selected, and you can re-fit at any time.
    - Adjust the box (Position / Scale) if you want a tighter or different
      region. The box is its own object in the scene.
    - Set **Grid Resolution** (Nx × Ny × Nz) to the number of voxels you
      want along each axis. Use 1×1×1 for a single canopy-wide value, or
      subdivide for a 3-D density field. A wireframe shows the cells when
      any axis is greater than 1.
    - Alternatively, if your Helios scan XML defines a `<grid>` block, the
      voxel grid is created automatically on
      [import](import-export.md#importing-several-files-at-once) — no
      need to build it by hand.

2. **Backfill misses if needed.** If a selected scan has no sky/miss points
   yet, run **Backfill Misses** (Pre-processing group) to recover them —
   see [Backfill misses](backfill-misses.md). The LAD dialog also surfaces
   this: it disables **Compute LAD** and shows a banner with a one-click
   **Backfill Misses** button for any selected scan still missing them.
   Scans imported from a miss-retaining format (E57 / structured PLY) skip
   this step.

3. **Open the LAD tool** (the grid icon, next to Triangulate). The button
   is disabled until both a parameterized scan is selected *and* a voxel
   box exists — the tooltip tells you which is missing.

4. **In the dialog:**
    - **Triangulation.** If you've already run a
      [Helios triangulation](triangulate.md) over a voxel grid, choose
      **Reuse: \<that mesh\>** here. The inversion then reuses *exactly* the
      scans, grid, and Lmax / aspect that produced that mesh — reproducing its
      G-function — and the scan picker, grid selector, and filter fields below
      are hidden (they're locked to the mesh). Choose **Run a new triangulation**
      to set everything yourself instead. (This selector only appears when a
      reusable Helios triangulation exists — one built with a voxel grid.)

        !!! note "You don't need a Helios mesh first"
            The inversion always re-triangulates the scans server-side, so it
            never depends on how (or whether) you triangulated in the viewer. A
            **Run a new triangulation** with your scans + grid is the full
            workflow on its own — reuse is just a shortcut that locks the
            settings to an existing Helios mesh so you don't re-enter them.
    - Pick the **voxel grid** to use (required — no auto-grid). *(New
      triangulation only.)*
    - **Max Edge Length (Lmax)** and **Max Aspect Ratio** control the
      triangulation that estimates the G-function (not the final mesh). If you
      already dialed in a filter on a [Helios triangulation](triangulate.md)
      mesh, these fields are **pre-filled** with that Lmax / aspect so the
      inversion bakes in the same filtering — still editable here. *(New
      triangulation only.)*
    - **Min Voxel Hits** skips voxels with too few returns to solve
      reliably.
    - **Element width (m)** is the characteristic width of a leaf or
      needle. It sets the sampling-uncertainty interval reported with the
      result (Pimont et al. 2018). Use the **Broadleaf (0.05)** or
      **Conifer (0.002)** preset, or type your own value. It does not
      change the LAD point estimate, only the confidence interval.
    - The **return type** is shown read-only; it follows each scan's own
      parameters. Multi-return scans need per-pulse metadata in the source
      (see [the concept page](../concepts/leaf-area-density.md#single-vs-multi-return-scans)).

5. **Click Compute LAD.** The calculation runs on the backend (the first
   run can take a while as PyHelios warms up). A **Leaf Area Density**
   entry appears in the scene panel when it finishes.

## Reading the result

- Voxels are drawn as translucent colored cells; the color maps LAD
  through the shared [colormap](../reference/color-modes.md), with a
  colorbar in m²/m³.
- **Hover** a cell to read its exact LAD, G(θ), and hit count.
- In the result's row you can toggle visibility, adjust **opacity**,
  **hide empty voxels** (default on), and change the colormap.
- Selecting the result also shows a **group-scale confidence interval**
  (e.g. *Mean LAD 1.23 [1.15–1.31] m²/m³, 95% CI*), computed across all
  solved voxels following Pimont et al. (2018). This is the recommended
  aggregate — it is far tighter and more trustworthy than a single
  voxel's interval. It reflects sampling uncertainty *conditional on the
  beams that entered the voxels*; it does **not** capture occlusion bias
  (foliage no beam ever reached). If the interval falls outside the
  method's validity range, it is not reported.

## Moving-platform scans

If a scan carries a [platform trajectory](../concepts/scans.md#moving-platform-scans),
LAD is computed with a **beam-based** inversion: every return is traced
from its own per-beam origin (the platform pose when that pulse fired),
joined to the trajectory by the return's timestamp. This path does **not**
triangulate the scan — a moving sweep has no fixed angular grid to mesh —
so instead of estimating *G(θ)* from a triangulation it uses a **supplied
mean G(θ)** (0.5 for a spherical / randomly-oriented leaf-angle
distribution; set it to match the canopy if known). The point cloud must
carry a per-return `timestamp` column (for the trajectory join) and miss
points — run [Backfill Misses](backfill-misses.md) first if the scan has a
timestamp but no recorded misses, as for any LAD.

## Tips

- If no triangles are produced (G-function can't be estimated), increase
  **Lmax** or loosen **Max Aspect Ratio**. (Moving-platform scans skip
  triangulation; this doesn't apply to them.)
- Segment out ground and trunk first if you only want foliage density —
  the inversion counts every return inside the grid.
- If you **crop a scan after backfilling its misses**, the result warns that
  the misses are stale (they were computed against the pre-crop hits, so the
  hit/miss ratio is off). Re-run [Backfill Misses](backfill-misses.md) on the
  cropped cloud before trusting the LAD.
- For a single canopy-wide LAI, use a 1×1×1-cell grid sized to the whole
  canopy and read the single voxel's LAD × its height.
