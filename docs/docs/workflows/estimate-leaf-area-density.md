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
- **Later echoes, if the instrument recorded them.** Discarding all but the
  first echo of each pulse biases LAD **high** (Kent and Bailey,
  [2024](https://doi.org/10.1016/j.rse.2024.114229)). Import multi-return data
  via [`.riproject` / `.PROJ`](import-riegl-project.md), a structured `.e57`, or
  a format keeping `timestamp`, `target_index` and `target_count` — **not
  `.ptx`**, which collapses each pulse to one echo and can't carry those
  columns. See
  [Single- vs multi-return scans](../concepts/leaf-area-density.md#single-vs-multi-return-scans).
- **Crop in Phytograph, and outside the grid.** Points you delete outside the
  voxel grid are still fed to the inversion (a deletion keeps the coordinates),
  so a crop to the tree changes nothing. Points deleted **inside** the grid (a
  ground filter, a leaf-only classification) cannot be repaired and trigger a
  warning. A file cropped *before* import relies on `target_index` /
  `target_count` plus a Backfill Misses run on the cropped cloud, and reads low
  wherever something stood between the scanner and the grid. See
  [Cropped and segmented clouds](../concepts/leaf-area-density.md#cropped-and-segmented-clouds).

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
      region. The box is its own object in the scene. Changing its
      **Position** (origin) or **Scale** re-frames the viewport on the box's
      new location, so it stays in view as you move it away from the
      default unit cube at the origin — the view updates when you commit a
      value (press **Enter** or click away / pause typing), not on every
      keystroke. **Rotating** the box
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
          [Override G(θ) directly](#override-g-directly) below. Moving-platform
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
    - The **return type** is shown read-only; it is detected from the
      per-pulse columns each scan's data carries, not set anywhere
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
  beams that entered the voxels*; it does not by itself capture occlusion
  bias, which is screened separately (below). If the interval falls
  outside the method's validity range, it is not reported.
- The result also reports **occlusion**: how many voxels were probed by too
  little beam path to trust, the threshold applied, and a per-height
  breakdown. Occluded voxels are drawn in their own colour (amber) rather
  than the grey used for empty air, and are never hidden by *hide empty
  voxels* — an unmeasured voxel is not an empty one.

## Occlusion

Beams are intercepted by foliage, so voxels behind dense canopy are reached by
few beams over short paths. Their estimate is not merely noisy — it is biased
**high**, increasingly so as the probed path shortens. Phytograph screens for
this using the **total probed beam path** through each voxel (the sum over
beams of the chord each one cut through it), the measure established by Soma,
Pimont & Dupuy (2021).

Two controls in the LAD dialog:

- **Occlusion threshold (m of beam path)** — below this a voxel is reported as
  occluded rather than measured, and its leaf area is excluded from the total.
  Voxels no beam reached *at all* — the empty headroom and margin around a
  canopy — are not counted as occluded; they simply lie outside what the scan
  swept and keep their LAD of zero.
  Leave it blank for the default of **100 × the voxel side length**, which is
  how the threshold is defined in the literature (the widely-quoted *30 m*
  figure is that rule at ~0.3 m voxels). A fixed number is not portable: total
  path length scales with voxel size and scan density, so the same constant is
  inert on one grid and over-eager on another. The dialog shows the resolved
  value for your grid, and you can type any figure to match a published one.
- **Fill occluded voxels** — estimates each occluded voxel from the surrounding
  well-sampled ones by **LAD-kriging** (Soma et al. 2020), which weights each
  neighbour by how reliably it was measured. Filled voxels are marked as
  interpolated, and their leaf area is reported *separately* — never folded
  into the measured total. Leave it off to report occlusion without modelling
  it.

!!! note "A filled voxel is a model, not a measurement"
    Filling makes a canopy-wide figure less biased than treating occluded
    voxels as zeros, but the filled values are interpolations. Every export
    marks them, so downstream analysis can include or exclude them
    deliberately.

## Reading the profile and the bulk LAI

Select a LAD result and click **Profile & LAI** in its row. This opens a window
with the two numbers a canopy grid is usually computed *for*, without exporting
anything:

- **Bulk LAI** — the headline figure, shown at the top. Leaf area index is the
  measured leaf area summed over the grid, divided by the grid's ground
  footprint (m²/m²). It is the same number the **Summary** export writes, from
  the same voxels and the same rule.
- **The vertical profile** — mean LAD per horizontal level of the grid, plotted
  with density on the x axis and height on the y axis, the orientation the
  canopy-structure literature draws a profile in. Tick **Show ±1 SD** to shade
  the spread of LAD *across* each level, which says how horizontally uniform
  the canopy is at that height.

Below the plot, a table gives each level's mean LAD, its standard deviation,
its leaf area, its share of the bulk LAI, and how many of its voxels were
actually measured. That last column matters: a level whose mean rests on three
measured voxels out of ninety is a far weaker claim than one resting on all
ninety, and the plotted line alone can't show you the difference.

**Profile CSV** writes the whole table plus the bulk figures to a file.

!!! note "Occluded voxels are excluded here too"

    Every number in this window counts **measured** voxels only — solved,
    adequately probed, and not [interpolated](#occlusion). An occluded voxel is
    unmeasured, not empty, so averaging it in as zero density would bias both
    the profile and the LAI low. The count of excluded voxels is shown beside
    the LAI, and when occlusion filling is on, the interpolated leaf area is
    reported next to it — never inside it.

    The per-level LAI contributions in the table sum exactly to the bulk LAI, so
    the profile and the headline number are the same measurement rather than two
    similar ones. This is pinned from both sides by
    `src/shared/ladLai.contract.json`, because the app showing one LAI while
    exporting a different one would raise no error at all.

!!! tip "On a terrain-following grid, the profile is height above ground"

    Levels are grid *cell* levels, not absolute elevations. On a
    [terrain-following](#terrain-following-snap-the-grid-to-the-ground) grid
    each column is lifted to its own ground height, so a level is a constant
    height *above the terrain* and the axis is labelled that way. That is
    normally what you want on sloped ground — a profile binned by absolute z
    would smear the canopy across levels.

## Exporting the result

Select a LAD result and use **Export** in its row. Tick the variables you want
(leaf area density, leaf area, G(θ), hit count, beam count, relative density
index, mean path length, total probed path length, LAD std — plus wood area
density, wood area, plant area density, wood fraction and wood G(θ) when the
cloud was classified), then choose a format:

| Format | What you get | Use it for |
| --- | --- | --- |
| **GeoTIFF** | One file per variable, each with **one band per vertical level** (band 1 = lowest), georeferenced when the source CRS is known | QGIS / ArcGIS / R `terra`; the same shape `canopyLazR` and AMAPVox's `toRaster()` produce |
| **Voxel CSV** | One row per voxel with *every* field, including the lattice indices and the per-voxel Pimont uncertainty | Analysis in R / Python / Excel. The lossless option |
| **AMAPVox** | `.vox` voxel space — `#min_corner` / `#max_corner` / `#split` / `#res` header, then `i j k PadBVTotal …` rows | The R `AMAPVox` package, DART / `pytools4dart` |
| **Summary** | A small `.txt`: voxel, occlusion, under-sampled and filled counts, total leaf area (measured only), interpolated leaf area, and **LAI** — plus total wood area, **WAI** and **PAI** when the cloud was classified | Reading the headline canopy numbers — LAI is not carried by any other format |

Exporting several raster variables at once asks for a **folder**; a single file
asks for a save location.

!!! note "Occluded voxels are not zeros"

    A voxel no beam ever reached is **unsampled**, not empty — and if it is
    exported as `0` it silently drags down any mean LAD or LAI computed from
    the file. Phytograph keeps the two apart everywhere: occluded voxels are
    written as **NoData** (`-9999`) in rasters, as a **blank** `lad` with
    `solved=false` in CSV, and are **omitted** from `.vox`. A voxel that was
    genuinely solved as empty air keeps a real `0.0`. The summary counts
    occluded voxels separately, so the reported LAI never absorbs them.

!!! warning "Rotated and terrain-following grids can't be rasters"

    A GeoTIFF is a regular, north-up lattice by definition. A
    [rotated](triangulate.md) voxel box doesn't lie on one, and a
    [terrain-following](#terrain-following-snap-the-grid-to-the-ground) grid
    gives every column its own starting height — so writing either as a raster
    would produce a confidently *mis-georeferenced* file. The GeoTIFF button is
    disabled for those grids; export **CSV** or **.vox** instead, which store
    each voxel's own position and carry them exactly.

## Separating wood from leaf

By default every return counts as foliage, so the result is really *plant* area
density reported as LAD. To split it:

1. Run [**Segment Wood / Leaf**](segment-wood.md) on the cloud first. It adds a
   `wood_class` column to the session.
2. Compute LAD as usual. The split happens automatically — no extra option.

Each voxel then reports **LAD** (one-sided leaf area per m³), **WAD** (total
woody *surface* area per m³) and **PAD** (their sum).

What appears once a result carries a split:

- A **Colour by** picker in the result row switches the voxels between LAD, WAD
  and PAD. The colourbar rescales and its label follows, so the legend always
  names the quantity on screen.
- A **Leaf and wood area** box reports both totals and states the wood G(θ) it
  applied, marked *measured* (read from the triangulation's branch axis, with
  the number of surface triangles behind it) or *assumed* (the
  randomly-oriented-cylinder value, used when there is no mesh or no confident
  axis). The panel never lets an assumption read as a measurement.
- The export variable list gains wood area density, wood area, plant area
  density, wood fraction and wood G(θ).
- **Profile & LAI** reports **WAI** and **PAI** beside LAI, and the summary and
  profile CSV exports carry them too.

A result computed from an unclassified cloud says so in its row, because "LAD"
there still includes the branches.

**Do not** split the cloud and invert the leaf part on its own. Removing the
wood returns turns every beam that a branch stopped into a beam that passed
through, which biases the leaf density — see
[cropped and segmented clouds](../concepts/leaf-area-density.md#cropped-and-segmented-clouds).
Keeping one cloud and letting the classification steer the *attribution* is
what Phytograph does, and it leaves the beam bookkeeping intact.

!!! tip "Size the grid for the wood you care about"

    Both numbers are absolute areas. The one assumption is that leaf and wood
    are **mixed** inside a voxel — a voxel holding a whole trunk *and* the
    foliage beside it will misattribute between them (leaf area stays accurate;
    wood is the number that suffers). If woody area is the point of the run,
    use voxels small enough that a trunk gets its own. Remember too that the
    wood/leaf classification's own error rides on top of this. See
    [Wood area](../concepts/leaf-area-density.md#wood-area).

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
- **The snap survives export.** Exporting the scene to Helios scan XML writes the
  per-column offsets into the `<grid>` block, so re-importing the XML brings the
  grid back already snapped — no need to re-run the DEM and snap. See the
  [file-format reference](../reference/file-formats.md#scan-position-files).

## Override G(θ) directly

Instead of deriving *G(θ)* from a triangulated surface, you can prescribe the
leaf-angle distribution / *G(θ)* yourself. Choose **Supply G(θ) directly** under
**G(θ) source**, then pick:

- **Vary with height?**
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
      [Leaf-angle distributions and G(θ)](../concepts/leaf-area-density.md#leaf-angle-distributions-and-g)
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
so it always uses the **[Supply G(θ) directly](#override-g-directly)** path
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
- If you **crop a scan after backfilling its misses**, the misses are kept and
  stay usable. Cropped-away points *outside* the voxel grid are fed back into
  the inversion, so a crop drawn around the grid is exact and raises no
  warning. You are warned in two cases, which want opposite responses:

    - the crop removed points from *inside* the grid — those returns cannot be
      placed, and re-running [Backfill Misses](backfill-misses.md) will not
      repair it (it reconstructs the scan as measured). Undo those deletions,
      or size the grid to the region you kept;
    - the cropped points are no longer in the session at all (**Permanently
      apply deletions**, or a cloud made by split / extract / duplicate). Here
      re-running Backfill Misses *is* the fix: gap-filling over what remains
      re-creates the lost pulses as misses.
- For a canopy-wide LAI, just read it off **Profile & LAI** — it is computed
  over whatever grid you ran, so you do not need to collapse the grid to a
  single cell to get it. Keep the grid subdivided: a multi-level grid gives you
  the same bulk LAI *and* the vertical profile, while a 1×1×1 grid throws the
  profile away and cannot tell occluded canopy from empty air.
