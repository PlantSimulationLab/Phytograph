# Triangulate a mesh

Triangulation builds a surface mesh from a point cloud. Phytograph
offers five methods; pick based on your data and what you want to do
with the result.

## Quick decision

| Your data | Use |
|---|---|
| Dense scan of a leaf or other roughly-flat surface | **Delaunay** |
| Branch surfaces, consistent density | **Ball Pivot** |
| Dense whole-plant scan, need a watertight surface | **Poisson** |
| Concave shapes you want to wrap tightly | **Alpha Shape** |
| Multi-scan TLS data with scanner positions | **Helios** |

## The Triangulation modal

All five methods live in one **Triangulation Setup** modal:

1. Click **Triangulate** (triangle icon) — the modal opens. It's available
   whenever at least one scan exists in the scene; you don't need a scan
   selected first. Any scans you *do* have selected are pre-ticked in the
   modal's **Scans** picker (step 3) as a convenience.
2. **Method** — pick the algorithm from the dropdown. The parameters and
   options below update to match. The default is **Helios** when any
   listed scan carries scan parameters, otherwise **Ball Pivot**.
3. **Scans** — tick which scans to triangulate. Each row shows the scan's
   color, point count, and (when it has parameters) its scanner origin.
   Use **All / None** to select in bulk. To change a scan's parameters,
   edit it from the Scans panel before opening this modal.
4. **Output** *(non-Helios methods)* — choose **Triangulate each scan
   separately** (one mesh per scan) or **Merge selected scans into one
   mesh** (their points are fused before meshing). Helios always fuses its
   selected scans, so this toggle is hidden for it.
5. Set the method-specific **Parameters** (below).
6. Click **Triangulate**.

While the mesh builds, a small **progress pill** appears at the top of the
viewer for every method (not just Helios). It names the current stage —
*Reading points*, *Estimating normals*, *Meshing*, *Cleaning up mesh*,
*Computing surface area* — and shows a bar with the percentage. When you
triangulate several scans separately the label is prefixed with the scan
count (e.g. *[2/3] Meshing*), and a Helios run reports *Triangulating scan
N of M*. Click the **✕** on the pill to cancel a run in progress; no mesh
is added and nothing else changes.

Method-specific parameters:

=== "Ball Pivot"

    - **Auto radius** *(default on)* — the ball-pivot radius is computed
      from the median nearest-neighbour spacing of the cloud.
    - Untick it to set the **radius** manually (in meters). A good value
      is ~1.5–2× the average point spacing.
    - **Grid** — optionally pin the mesh to a voxel box (the same selector the
      Helios method uses). Pick **Auto — fit to all points (no pin)** for an
      ordinary mesh, or a voxel box to **crop the points to it** before meshing
      *and* make the mesh re-usable for the
      [leaf-area inversion](estimate-leaf-area-density.md). A pinned, per-scan
      mesh records which grid and scan produced it, so the LAD tool can inject it
      directly instead of re-triangulating. A **merged** mesh (see *Output*
      below) can't be pinned for LAD — it has no single source scan — so the
      selector warns you; triangulate each scan separately to keep it
      LAD-re-usable. The Meshes panel shows whether a ball-pivot mesh is
      *"re-usable for leaf-area inversion"* or why it isn't.

=== "Poisson"

    - **Octree depth** — higher = more detail and slower. Default 8 is a
      good starting point for whole-plant scans.

=== "Alpha Shape"

    - **Auto Alpha** *(default on)* — alpha is chosen automatically.
    - Untick it to set the **alpha** radius manually: smaller alpha =
      tighter to the points, more holes; larger alpha = smoother surface,
      more bridging across gaps.

=== "Delaunay"

    - No parameters — the points are projected to a plane and triangulated.
      Best for a single roughly-flat surface.

!!! note "No post-triangulation filter on cloud methods"

    The **Lmax / aspect filter** is **Helios-only**. Each cloud method already
    applies its own length scale while reconstructing — the ball-pivot radius,
    alpha-shape alpha, Poisson octree depth — so the long bridge triangles the
    Helios filter trims never survive into the returned mesh. Re-filtering by
    edge length afterwards would do nothing (and the "auto Lmax" you'd see on a
    cloud method is just the auto-computed radius, not an independent estimate).
    Set the length scale through the method's parameter (e.g. the ball radius)
    instead.

!!! note "Sky/miss returns are skipped"

    If the cloud is a multi-return / full-waveform scan, its sky/miss
    points — rays that hit nothing, recorded far out at the scanner's max
    range — are **excluded automatically** before triangulation. They
    aren't surface points, so meshing them would only span a phantom shell
    far from the real geometry (and slow Ball Pivot to a crawl). This is
    why the **points used** shown on the mesh row can be lower than the
    cloud's total point count.

The resulting mesh appears in the Scene panel's **Meshes** list, named
after the method and source cloud — e.g. *"Poisson triangulation
(tree.xyz)"* — so triangulation results are distinguishable at a glance
from imported meshes, plant models, and each other. If two share the same
auto-name, the later one is numbered — *"… (2)"*, *"… (3)"*. The source
cloud is auto-hidden when the mesh lands so the result isn't buried in a
sea of points; it stays in the scene and can be re-shown (eye icon).

### Manage a mesh in the Meshes list

Each mesh row supports a few quick edits:

- **Rename** — double-click the mesh name to edit it in place. Press
  <kbd>Enter</kbd> to commit or <kbd>Esc</kbd> to cancel; clearing the
  field restores the default name (method + source filename for a
  triangulated mesh, with a *"(2)"*-style suffix if it would otherwise
  duplicate another row; plant type/age for a plant).
- **Inspect parameters** — expand the row (chevron ▸) to see how the mesh
  was reconstructed: the triangulation method and its method-specific
  parameters. For cloud methods that's the Poisson octree depth,
  alpha-shape radius, or ball-pivoting radii, plus the normal-estimation
  settings and the number of points used (which reflects any downsampling
  of a large streamed cloud). For a **Helios mesh** it's L<sub>max</sub>,
  the max aspect ratio, and how many scans were fused. Once you apply the
  [triangle filter](#helios-method) to a Helios mesh, the readout also shows
  the filter breakdown (candidates / kept / dropped).
- **Recolor** — click the color swatch to the left of the name to open a
  color picker. Pick a color or type a hex value. The color applies to the
  mesh surface; **texture-mapped meshes ignore it** and keep drawing their
  texture, so the swatch is only shown for untextured meshes.
- **Transform** — click the **⤢** (double-arrow) button on the mesh's row to
  open its Transform panel, where you can type an exact position, rotation
  (degrees), and per-axis scale, or toggle the on-screen translate/rotate
  gizmos. The Blender-style shortcuts <kbd>T</kbd> (translate), <kbd>S</kbd>
  (scale), and <kbd>R</kbd> (rotate) still work with a mesh selected; lock an
  axis with <kbd>X</kbd>/<kbd>Y</kbd>/<kbd>Z</kbd>. See
  [Keyboard shortcuts](../reference/shortcuts.md).

!!! note "Large (streamed) clouds are capped"
    Clouds imported from large XYZ scans are streamed from an on-disk octree
    rather than held in memory. When you triangulate one, it is downsampled to
    the **Triangulate max points** limit (default 5,000,000) before meshing,
    which bounds memory use. If a cloud is downsampled you'll see a warning
    toast telling you how many points were used. Raise the cap in **Settings**
    (open it from the app menu — *Phytograph → Settings…* on macOS, *File →
    Settings* on Windows/Linux, or press ++cmd+comma++ / ++ctrl+comma++) under
    **Performance → Triangulate max points** for more surface detail at the cost
    of more memory.

## Plot leaf angles (any method)

The **Leaf angles…** tool works on **every** triangulated mesh — the cloud
methods (ball-pivoting, Poisson, alpha-shape, Delaunay) as well as Helios. The
**Filter** controls (Lmax / aspect) are **Helios-only** — see [Helios
method](#helios-method) below. Expand a mesh's row to reach the tool:

- **Leaf angles…** — opens the leaf-angle distribution plot (inclination PDF,
  azimuth rose, and a de Wit archetype + Beta fit). It reads the mesh's triangle
  normals directly, area-weighted, so it works on any triangulated surface. A
  mesh built with a voxel grid splits the distribution per cell; a mesh with no
  grid (every cloud mesh, and an auto-grid Helios mesh) shows a single **Whole
  mesh** distribution. See
  [Estimate leaf area density](estimate-leaf-area-density.md) for the related
  per-voxel inversion.

## Helios method

The **Helios** method uses the scanner geometry to triangulate only the
rays that actually returned, producing more accurate branch surfaces
than cloud-only methods. Every selected scan must carry both point
data **and** scan parameters (the scanner origin); scans missing
parameters are listed but can't be selected, with a note telling you to
add them.

Select the **Helios** method in the Triangulation modal to reveal its
options (the per-scan/merged toggle is hidden — Helios always fuses the
selected scans):

1. Make sure each scan you want to include has scan parameters
   attached. If a scan only has data, click the radio icon on its row
   in the Scans panel to add parameters (or import a Helios scan XML
   that carries `<origin>` and `<size>` for each `<scan>`).
2. In the **Scans** picker, tick two or more eligible scans. Each row
   shows the scan's origin read from its parameters — no manual entry.
   To adjust a scan's parameters, edit it from the Scans panel before
   opening this modal.

    Each scan is triangulated in the angular grid it was actually
    sampled in: its **scanner origin**, **zenith/azimuth sample counts**
    (Ntheta/Nphi) and **angular bounds** all come from that scan's own
    parameters. Edit them per scan in the Scans panel — they are no
    longer typed in once for the whole batch.
3. **Filtering happens afterwards.** There is no Lmax to set here — Phytograph
    triangulates *unfiltered*, keeping every candidate triangle, and the
    edge-length (**Lmax**) and **aspect-ratio** filter is applied as a live
    post-processing step in the mesh panel (next step). This means estimating a
    good Lmax is instant, and you can change it and watch the mesh update without
    ever re-triangulating.
4. **Grid** — the triangulation grid bounds the region that gets meshed:
    - **Auto — fit to all points** (default when you haven't made a
      box): Phytograph fits a single-cell grid around every point. A
      warning reminds you that *all* points are triangulated, so the
      ground and trunk should already be segmented or cropped away.
    - **A voxel box**: create one with **Create Voxel Grid** (it appears in
      the Meshes list), position and size it over the region you care
      about, and set its grid subdivisions in the mesh panel. It then
      appears in the **Grid** dropdown; selecting it uses the box's
      position, size, Nx×Ny×Nz cell counts, and **azimuthal rotation** as
      the grid — a box rotated about its vertical axis crops to that rotated
      footprint, not its axis-aligned bounding box.
5. Click **Triangulate**.

The mesh lands in the **Meshes** list named *"Helios triangulation"* (the
word *triangulation* keeps it distinct from a Helios **plant model**).
Expand its row to reach the **Filter** controls:

- **Lmax** — maximum allowed edge length (meters). Triangles with a longer
  edge are hidden. Seeded automatically from the candidate edge-length
  distribution (see below); edit it and the mesh re-filters instantly.
- **Max aspect** — drops mis-shapen triangles (max edge ÷ min edge; default 4).
- **Auto** — re-applies the automatic Lmax estimate.

The auto-estimate inspects the spread of candidate edge lengths: valid triangles
connect adjacent points on the same leaf or branch (short edges), while erroneous
ones bridge separate surfaces (long edges). It places Lmax at the natural split
between those two scales and reports two numbers (with a **?** next to them that
opens a short how-to-read explainer):

- **Separation (η)** — how *cleanly* the edge lengths fall into two groups.
  *High* means a sharp valley between the short and long scales (the mesh is
  insensitive to Lmax); *Medium*/*Low* means they blur together (leaves close
  together relative to scan resolution) and the mesh is sensitive to Lmax.
- **Modes (×)** — how *far apart* those two groups are. Genuine gap bridges sit
  many times above the surface spacing (*High*). A small ratio (*Low*) means
  both groups are really surface — sampled at different spacings, e.g. a coarse
  or strongly anisotropic scan — so cutting between them drops valid triangles
  and leaves holes.

Watch for **High η with Low Modes**: a confident split placed in the wrong
spot. If the mesh looks holey there, raise Lmax. The filter breakdown above the
controls (candidates / kept / dropped) updates as you adjust the filter.

#### Check point spacing

The edge-based auto-estimate has a blind spot: on a **sparsely-sampled surface**
(a thin shell of points relative to the leaf size) the triangulation generates
mostly *bridge* triangles spanning the gaps, so the candidate-edge distribution
is dominated by bridges. The split can still look clean (η/Modes read *Medium* or
even *High*) while Lmax lands several times too large — and an oversized Lmax
bridges across the surface, tilting the reconstructed leaf normals and corrupting
the **leaf-angle distribution** and **G(θ)** (you may see G(θ) far below the
expected ~0.5 for a near-spherical canopy).

Because the candidate edges can't reveal this on their own, the Filter panel
offers a **Check point spacing** button whenever the indicators aren't both
*High*. It measures the actual nearest-neighbor spacing of the points **inside
the grid** (an independent signal) and compares it to your current Lmax:

- If Lmax is within a normal multiple of the spacing, it confirms bridging is
  unlikely.
- If Lmax is **much larger** than the spacing (≳3×), it warns that the mesh is
  likely bridging and suggests lowering Lmax toward the point spacing.

The check only reports — it never changes Lmax for you. It can take from a moment
to tens of seconds on a very large cloud (it builds a spatial index over the
in-grid points), which is why it's an explicit button rather than automatic.

!!! warning "Merged multi-scan clouds"

    Helios triangulation assumes **single-scan-position** data — it uses one
    scanner origin per scan to reconstruct ray directions. If a scan is actually
    a registered *merge* of several scanner positions, the auto-estimate flags it
    (a toast and a note in the Filter panel): the triangulation would bridge
    surfaces seen from different origins, producing spurious triangles.
    Triangulate each scan position separately instead of meshing the merged cloud.

For most TLS data of stone-fruit trees the auto Lmax works; nudge it down
(to ~5–10 cm) for finer branch surfaces, or up if your scan is sparse.

!!! note "Very large scans"

    Full-resolution TLS clouds can produce several million candidate triangles —
    more than fits in a single response. When that happens Phytograph returns the
    densest few million triangles (a notice tells you how many of how many
    candidates were kept) and the Filter can only be **tightened** from there;
    loosening past that point means re-triangulating. Cropping to a voxel box or
    segmenting away ground/trunk first keeps the mesh — and the filter range —
    full.

!!! tip "Leaf area density"

    Helios triangulation is also the first step inside
    [leaf area density estimation](estimate-leaf-area-density.md), where
    the mesh is used to derive the G-function rather than as the end
    product. If canopy density is what you're after, use that workflow
    instead of meshing directly.

## Color a mesh by surface geometry

A triangulated mesh — one built by triangulating a point cloud, including
Helios meshes — can be pseudocolored per triangle to inspect its surface,
handy for checking a reconstruction or reading leaf/branch orientation.
In the **Meshes** panel, click the chevron (▸) on the mesh's row to
expand its **Color by** options (the chevron only appears on
triangulation-generated meshes, not plants, shapes, or imported meshes):

- **Inclination** — zenith angle of each triangle's normal, folded to
  0–90° (a horizontal facet reads 0°, a vertical one 90°). Up- and
  down-facing facets read the same.
- **Azimuth** — compass bearing the triangle's normal points, 0–360°.
  Triangulated surfaces have no consistent facet winding, so the outward
  direction must be inferred. For **Helios meshes** each facet's normal is
  oriented toward the scanner that saw it, giving the true outward bearing —
  so a scanned closed surface (e.g. a sphere) reads a *continuous* azimuth
  rather than flipping 180° between its upper and lower halves. For meshes
  with no scan provenance the normal is folded into the upper hemisphere
  instead (deterministic, but a closed surface will show a seam at its
  equator).
- **Triangle area** — surface area of each triangle.
- **Source scan** — *(Helios meshes only)* colors each triangle by the
  scan it was reconstructed from, using that scan's swatch color. Helios
  triangulates each scan independently, so every triangle belongs to one
  scan. A legend lists the contributing scans and their triangle counts.

For the scalar modes, pick the gradient with the colormap dropdown that
appears below; a colorbar in the bottom-right shows the value range. The
**Source scan** mode shows a per-scan legend instead. Choose **Solid
color** to go back to the flat mesh color.

## Plot the leaf angle distribution

For a **Helios mesh**, you can go beyond per-triangle coloring and plot the
mesh's **leaf angle distribution function** — the statistical distribution of
leaf orientations across the canopy. Expand the mesh's row in the **Meshes**
panel and click **Leaf angles…** (offered on Helios meshes only). A plot
window opens with:

- **Inclination PDF** — the probability density of the leaf inclination
  (zenith) angle over 0–90°. Each triangle contributes its inclination
  **weighted by its area**, so a large leaf facet counts more than a sliver —
  the curve reflects leaf *surface*, not triangle *count*. A point is drawn at
  each bin center and joined by straight segments; the **Bins** dropdown
  changes the histogram resolution (9–90 bins, i.e. 10°–1° wide).
- **Azimuth distribution** — a polar (compass) rose of the area-weighted
  azimuth, showing which directions the leaf surfaces face. North is up;
  the petal radius is the density in each 10° sector.

### Per-cell overlays

If the mesh was triangulated inside a **voxel grid** (rather than the auto
single-cell grid), the window splits the distribution **per grid cell**. Each
cell's inclination curve is overlaid in its own color, with a checkbox list on
the right. Untick a cell to drop it from both plots, or use **All / None** to
toggle them in bulk — useful for comparing canopy layers (e.g. top vs. bottom
voxels) or isolating one region. With the auto grid the list collapses to a
single **Whole mesh** entry.

When **more than 24 cells are visible** (a fine grid quickly has hundreds of
occupied voxels), the window shows a single **combined** curve over all visible
cells instead of one line per cell — overlaying hundreds of curves is neither
readable nor fast. Narrow the selection (untick cells, or click **None** and
tick the handful you want) to ≤ 24 visible cells and the per-cell overlays,
the per-cell parameters table, and the **Show Beta fit** option come back.

### Canonical de Wit fit

The window also fits the six canonical **de Wit** leaf-angle distributions —
*planophile* (mostly horizontal), *erectophile* (mostly vertical),
*plagiophile* (mostly ~45°), *extremophile* (horizontal **and** vertical),
*spherical* (random, as on a sphere's surface), and *uniform* — to the visible
data and labels the closest match with a goodness-of-fit score (e.g. *"Best
fit: spherical (R²=0.94)"*). The chosen curve is overlaid as a dashed line so
you can see how well the canopy matches the archetype. Hiding cells re-fits to
just the visible ones.

### Beta-distribution fit (Goel–Strebel)

Below the inclination chart a **fitted distribution parameters** table reports,
**per cell**, a continuous two-parameter **Beta** distribution fit to that cell's
leaf inclination — the standard Goel & Strebel (1984) model. The shape
parameters **α** and **β** are estimated by moment matching (the mean and
variance of the normalized inclination *t = θ/90*), alongside the mean
inclination **mean θ** in degrees, the fit **R²**, the leaf-projection
coefficient **G(θ)** (see below), and that cell's best de Wit archetype, so you
can read every visible curve's parameters at a glance. A cell with no usable
spread (all triangles coplanar) shows **—** for the Beta columns. (With more
than 24 cells visible the table collapses to a single **All visible** row
summarizing the combined distribution, matching the combined plot.)

Two export buttons in the window header write CSV files for analysis outside
Phytograph, both reflecting the **currently visible** cells:

- **Parameters CSV** — the fitted-parameters table exactly as shown: one row per
  visible cell (or the single **All visible** row in combined mode) with the
  α, β, mean θ, R², G(θ), and de Wit columns.
- **Distributions CSV** — the empirical inclination probability density curves
  plotted in the chart: one row per visible cell (or a single combined row in
  combined mode), with one column per inclination bin (the column headers are
  the bin-midpoint angles in degrees). Densities are normalized so that the sum
  over bins × bin width equals 1.

Both files also include the cell's **center** and **dimensions** (each an
*(x, y, z)* triple in metres) read from the triangulation grid, so every row is
located in space. These are blank for a non-grid **Whole mesh** mesh and for the
combined **All visible** row, which span no single grid box.

The **G(θ)** column is the area-weighted mean of *|n̂ · v̂|* over the cell's
triangles, where *n̂* is each triangle's face normal and *v̂* is the beam
direction — the leaf-projection coefficient Ross's *G*-function describes, here
**measured directly** from the mesh geometry rather than assumed from a
distribution. (It's the same quantity the
[leaf area density inversion](estimate-leaf-area-density.md) reports per voxel.)
When the mesh carries scan provenance the beam points from each triangle back to
the scanner that saw it; for a mesh with no scan origins (e.g. a triangulated
plant model) it falls back to the conventional **nadir** view (*v̂* straight
down), so G(θ) reduces to the area-weighted mean of *|cos θ|* and is defined for
every mesh.

Tick **Show Beta fit** above the chart to overlay each cell's fitted Beta curve
as a dashed line in the cell's color. It's off by default to keep the plot
readable when many cells are visible, and is disabled while the combined view is
active (more than 24 cells visible).

## Produce a point cloud from a mesh

The inverse operation — turning a mesh or plant model back into a point
cloud — is done with a true ray-traced scan, not random surface
sampling. Place one or more scanners and run a
[synthetic LiDAR scan](simulate-scan.md); the resulting cloud respects
occlusion and scanner geometry, so it tests a reconstruction pipeline
against a realistic (yet perfectly known) input.

## What's next

- **[Extract a skeleton](extract-skeleton.md)** — get branching topology
  from the mesh or directly from the cloud.
- **[Register & compare](register-compare.md)** — align two meshes or
  compare cloud-to-mesh.
