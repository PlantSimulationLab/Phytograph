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
- *(Optional)* A **[DEM](generate-dem.md)** if you want the grid to follow
  sloping ground — see
  [Terrain following](#terrain-following-snap-the-grid-to-the-ground) below.
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
      region. The box is its own object in the scene. **Rotating** the box
      about the vertical axis is honored — the LAD voxels are computed in the
      rotated frame and the result grid lines up with the box you laid out
      (e.g. to follow a planted row that isn't axis-aligned).
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
   Clicking it runs the backfill and then reopens the LAD dialog with the
   same scan selection once it finishes, so you're back where you were.
   Scans imported from a miss-retaining format (E57 / structured PLY) skip
   this step.

3. **Open the LAD tool** (the grid icon, next to Triangulate). The button
   is disabled until both a parameterized scan is selected *and* a voxel
   box exists — the tooltip tells you which is missing.

4. **In the dialog:**
    - **G(θ) source.** First choose how the leaf-projection coefficient *G(θ)* —
      the term that converts beam attenuation into leaf area — is obtained:
        - **Derive from triangulation** *(default)* — mesh the hit points and
          estimate *G(θ)* per voxel from the leaf-surface orientations. This is
          the original workflow; the triangulation choice below applies.
        - **Supply G(θ) directly** — prescribe the leaf-angle distribution / *G(θ)*
          yourself and skip triangulation entirely. See
          [Override G(θ) directly](#override-gθ-directly) below. Moving-platform
          scans always use this path (they can't be triangulated).
    - **Triangulation.** *(Derive-from-triangulation only.)* If you've already triangulated over a voxel grid —
      either a [Helios triangulation](triangulate.md), or a **per-scan Ball
      Pivot mesh pinned to a grid** — choose **Reuse: \<that mesh\>** here. The
      inversion then uses that mesh *directly* — the exact triangles you see
      (with the current Lmax / aspect filter applied) are sent to the inversion
      and used as-is, **skipping the re-triangulation entirely**. This reproduces
      the mesh's G-function and, on a heavy scan, saves the minutes a fresh
      triangulation would take. The scan picker, grid selector, and filter fields
      below are hidden (locked to the mesh). Choose **Run a new triangulation** to
      set everything yourself instead. (This selector only appears when a reusable
      triangulation exists — one built with a voxel grid. When one does, it's
      pre-selected by default, since reusing it skips the redundant
      re-triangulation; pick **Run a new triangulation** if you'd rather not.) A ball-pivot mesh that
      **can't** be reused — merged, not pinned to a grid, or from a scan with no
      scanner position — appears greyed-out here with the reason, so you can fix
      it (re-triangulate per-scan, pinned to a grid) rather than wonder why it's
      missing.

        !!! note "You don't need a Helios mesh first"
            **Run a new triangulation** with your scans + grid is the full
            workflow on its own. It runs a real
            [Helios triangulation](triangulate.md) first — the same one the
            standalone Triangulate tool produces, with the max edge length
            **auto-estimated from the data** — **adds that surface mesh to the
            Meshes panel**, then inverts Beer's law on it. So the inversion's
            G(θ) is computed on a surface you can actually see and check. If it
            looks wrong (e.g. long triangles bridging gaps between separate
            leaves, which flatten the normals and depress G(θ)), adjust its
            **Lmax / aspect filter** in the Meshes panel, then reopen this dialog
            and choose **Reuse: \<that mesh\>** to recompute on the corrected
            surface. If a reused mesh's source scans are no longer all present,
            the tool blocks the run rather than silently changing the result.
    - Pick the **voxel grid** to use (required — no auto-grid). *(New
      triangulation only.)*
    - **Max Edge Length (Lmax)** and **Max Aspect Ratio** control the
      triangulation that estimates the G-function. Leave **Lmax** on
      **Auto** (the placeholder) to size it from the data — an Otsu estimate
      over the candidate edge lengths, the same default the standalone
      Triangulate tool seeds — or type a value to force it. The resulting mesh
      lands in the Meshes panel either way, where you can fine-tune the filter
      and re-run via **Reuse** (see the note above). *(New triangulation
      only.)*
    - **Min Voxel Hits** skips voxels with too few returns to solve
      reliably.
    - **Element width (m)** is the characteristic width of a leaf or
      needle. It sets the sampling-uncertainty interval reported with the
      result (Pimont et al. 2018). Use the **Broadleaf (0.05)** or
      **Conifer (0.002)** preset, or type your own value. It does not
      change the LAD point estimate, only the confidence interval.
    - On sloping ground, **snap the grid to the terrain first** (Meshes panel →
      expand the grid → **Snap to ground**) so each column follows the ground; the
      dialog then shows *"This grid is snapped to ground."* See
      [Terrain following](#terrain-following-snap-the-grid-to-the-ground) below.
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

## Terrain following — snap the grid to the ground

A flat voxel grid assumes level ground: voxel layer *k* is at the same absolute
height everywhere, so on a slope the bottom layer can be buried in soil on the
uphill side and floating above the canopy downhill. **Snap to ground** fixes this
by shifting each vertical column of voxels so its **bottom rides a DEM surface**,
keeping every column a constant height above the local ground. The grid visibly
**displaces in the viewport**, and that displaced grid is exactly what the LAD
inversion uses — what you see is what is computed.

To use it:

1. [**Generate a DEM**](generate-dem.md) from the cloud first (Generate DEM). The
   DEM is the ground surface the grid will follow; it appears in the Meshes panel.
2. Create and place the **voxel grid** as usual (size it to the canopy height you
   want *above the ground*, not to absolute elevations).
3. In the **Meshes** panel, expand the grid's row and click **Snap to ground**
   (under *Terrain follow*). Pick the DEM (if more than one exists) and set the
   **clearance** — the gap kept between the ground and the lowest cell, as a
   fraction of one voxel's height (so it scales with grid resolution). The grid's
   columns immediately shift to follow the terrain in the viewport.
4. Open the **LAD** tool and pick that grid. A note confirms *"This grid is snapped
   to ground."* **Compute LAD** — the inversion runs against the displaced grid, so
   the result voxels track the ground.

Notes:

- The **whole cell clears the ground**, not just its center: each column is lifted
  so its bottom face sits above the **highest** ground across its footprint
  (plus the clearance). On a slope that means a column rides on its uphill edge, so
  no part of the grid dips into the soil. Columns over small DEM holes inherit the
  nearest measured elevation; columns whose footprint lies entirely **outside** the
  DEM are dropped (a toast reports how many).
- **Keep the grid short enough.** Because each column is lifted to clear its
  highest ground, a tall grid on a steep slope can push the uphill columns *above*
  the canopy. Size the grid's height (z) to the canopy you want to capture above
  ground, and prefer finer columns (more Nx/Ny) on steep terrain so each footprint
  spans less rise.
- **Editing the grid clears the snap.** Moving, resizing, rotating, or re-dividing
  a snapped grid resets it to flat (the offsets would no longer match) — just
  **Snap to ground** again. Use **Clear snap** to remove it manually.
- Terrain following only shifts columns vertically — it does not tilt or rotate
  the grid. Combine it with an azimuthal grid rotation (above) for a row that is
  both sloping and off-axis.

## Override G(θ) directly

Instead of deriving *G(θ)* from a triangulated surface, you can prescribe the
leaf-angle distribution / *G(θ)* yourself. Choose **Supply G(θ) directly** under
**G(θ) source**, then pick:

- **Spatial mode:**
    - **Constant** — one *G(θ)* applied to every voxel.
    - **Vertical profile** — *G(θ)* varies with height. You pick the method once,
      then enter its value for each z-level of the grid (level 1 = lowest band).
      Use this when leaf inclination differs between the lower and upper canopy.
      A **Apply level 1 to all** button fills the column from the first row.
- **Method** (how each value is obtained):
    - **Constant value** — type *G(θ)* directly (0.5 = spherical). A
      **Spherical (0.5)** preset is provided.
    - **de Wit** — choose a classical leaf-inclination distribution (spherical,
      planophile, erectophile, plagiophile, extremophile, uniform). *G(θ)* is
      **derived** by integrating the Ross projection kernel over the actual
      distribution of beam zenith angles in your scan(s) — so it reflects your
      acquisition geometry, not a single nominal angle.
    - **Beta (μ, ν)** — Goel–Strebel parameters (ν = toward-vertical weight,
      μ = toward-horizontal; mean inclination fraction ν/(ν+μ)), the same
      convention used by [Adjust leaf angles](adjust-leaf-angles.md). *G(θ)* is
      derived as for de Wit. See
      [Leaf-angle distributions and G(θ)](../concepts/leaf-area-density.md#leaf-angle-distributions-and-gθ)
      for the math.

This path skips triangulation, so the **Lmax / aspect** fields are hidden. When you
use a vertical profile, the result reports the resolved **G(θ) per level**, and the
per-voxel *G(θ)* you read on hover varies by height accordingly.

## Moving-platform scans

If a scan carries a [platform trajectory](../concepts/scans.md#moving-platform-scans),
LAD is computed with a **beam-based** inversion: every return is traced
from its own per-beam origin (the platform pose when that pulse fired),
joined to the trajectory by the return's timestamp. This path does **not**
triangulate the scan — a moving sweep has no fixed angular grid to mesh —
so it always uses the **[Supply G(θ) directly](#override-gθ-directly)** path
(the G(θ) source is forced to *supplied*). The simplest choice is a constant
mean *G(θ)* of 0.5 (spherical / randomly-oriented leaves; set it to match the
canopy if known), but the de Wit and Beta methods — and the vertical profile —
work for moving scans too, since their per-beam directions are known. The point cloud must
carry a per-return `timestamp` column (for the trajectory join) and miss
points — run [Backfill Misses](backfill-misses.md) first if the scan has a
timestamp but no recorded misses, as for any LAD.

**Clock alignment matters.** The return timestamps and the trajectory must use the
**same clock**. If they don't overlap in time (a common cause: a LAS recorded in *GPS
Week Time* combined with an absolute trajectory, or a ~1e9 s Standard vs Adjusted-Standard
GPS offset), the join would otherwise clamp every return to a single pose — so LAD
**fails with an explicit error** naming both time ranges rather than producing wrong
origins. If only part of the scan falls inside the trajectory's time span, you get a
partial-coverage **warning** and the out-of-range returns are clamped to the nearest
endpoint. A scan whose LAS carries explicit per-beam origin
[ExtraBytes](../reference/file-formats.md#las-extrabytes-per-beam-origins) skips the join
entirely and uses those origins directly.

## Tips

- If no triangles are produced (G-function can't be estimated), set an
  explicit **Lmax** (larger than Auto chose) or loosen **Max Aspect Ratio**,
  or inspect the mesh that was created in the Meshes panel and loosen its
  filter there. (Moving-platform scans skip triangulation; this doesn't apply
  to them.)
- The G(θ) you see when hovering a LAD voxel is now computed on the **same
  filtered surface** shown in the Meshes panel. If it looks too low, the mesh
  likely has long triangles bridging gaps between separate leaves — tighten
  its Lmax filter and recompute via **Reuse**.
- Segment out ground and trunk first if you only want foliage density —
  the inversion counts every return inside the grid.
- If you **crop a scan after backfilling its misses**, the result warns that
  the misses are stale (they were computed against the pre-crop hits, so the
  hit/miss ratio is off). Re-run [Backfill Misses](backfill-misses.md) on the
  cropped cloud before trusting the LAD.
- For a single canopy-wide LAI, use a 1×1×1-cell grid sized to the whole
  canopy and read the single voxel's LAD × its height.
