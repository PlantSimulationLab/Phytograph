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

## Steps

1. **Select the scan(s)** in the Scans panel first, then **create the
   voxel grid.** Click **Create Voxel** (the box icon in the Create group).
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

2. **Open the LAD tool** (the grid icon, next to Triangulate). The button
   is disabled until both a parameterized scan is selected *and* a voxel
   box exists — the tooltip tells you which is missing.

3. **In the dialog:**
    - Pick the **voxel grid** to use (required — no auto-grid).
    - **Max Edge Length (Lmax)** and **Max Aspect Ratio** control the
      triangulation that estimates the G-function (not the final mesh).
    - **Min Voxel Hits** skips voxels with too few returns to solve
      reliably.
    - The **return type** is shown read-only; it follows each scan's own
      parameters. Multi-return scans need per-pulse metadata in the source
      (see [the concept page](../concepts/leaf-area-density.md#single-vs-multi-return-scans)).

4. **Click Compute LAD.** The calculation runs on the backend (the first
   run can take a while as PyHelios warms up). A **Leaf Area Density**
   entry appears in the scene panel when it finishes.

## Reading the result

- Voxels are drawn as translucent colored cells; the color maps LAD
  through the shared [colormap](../reference/color-modes.md), with a
  colorbar in m²/m³.
- **Hover** a cell to read its exact LAD, G(θ), and hit count.
- In the result's row you can toggle visibility, adjust **opacity**,
  **hide empty voxels** (default on), and change the colormap.

## Tips

- If no triangles are produced (G-function can't be estimated), increase
  **Lmax** or loosen **Max Aspect Ratio**.
- Segment out ground and trunk first if you only want foliage density —
  the inversion counts every return inside the grid.
- For a single canopy-wide LAI, use a 1×1×1-cell grid sized to the whole
  canopy and read the single voxel's LAD × its height.
