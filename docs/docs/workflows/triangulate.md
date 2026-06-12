# Triangulate a mesh

Triangulation builds a surface mesh from a point cloud. Phytograph
offers four methods; pick based on your data and what you want to do
with the result.

## Quick decision

| Your data | Use |
|---|---|
| Dense scan of a leaf or other roughly-flat surface | **Delaunay** |
| Branch surfaces, consistent density | **Ball Pivot** |
| Dense whole-plant scan, need a watertight surface | **Poisson** |
| Multi-scan TLS data with scanner positions | **Helios Triangulation** |

## Standard triangulation (Delaunay / Ball Pivot / Poisson)

1. Select the point cloud in the Scene panel.
2. Click **Triangulate** (triangle icon).
3. The panel on the right opens with the method dropdown.
4. Pick a method — parameters update based on your choice.
5. Click **Triangulate**.

Method-specific parameters:

=== "Delaunay"

    - **Alpha** — controls how aggressively the mesh fills concavities.
      Smaller alpha = tighter to the points, more holes; larger alpha =
      smoother surface, more bridging across gaps.

=== "Ball Pivot"

    - **Radius** — ball pivot radius. Should be ~1.5–2× the average
      point spacing. Click **Estimate** to compute a reasonable value
      from the cloud.

=== "Poisson"

    - **Depth** — octree depth. Higher = more detail and slower.
      Default 9 is a good starting point for whole-plant scans.
    - **Trim threshold** — clips low-confidence triangles in sparsely
      sampled regions.

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
  the max aspect ratio, and how many scans were fused.
- **Recolor** — click the color swatch to the left of the name to open a
  color picker. Pick a color or type a hex value. The color applies to the
  mesh surface; **texture-mapped meshes ignore it** and keep drawing their
  texture, so the swatch is only shown for untextured meshes.
- **Transform** — with a mesh selected, the Blender-style shortcuts
  <kbd>T</kbd> (translate), <kbd>S</kbd> (scale), and <kbd>R</kbd> (rotate)
  move it in the viewer; lock an axis with <kbd>X</kbd>/<kbd>Y</kbd>/<kbd>Z</kbd>
  or type an exact amount. See [Keyboard shortcuts](../reference/shortcuts.md).

!!! note "Large (streamed) clouds are capped"
    Clouds imported from large XYZ scans are streamed from an on-disk octree
    rather than held in memory. When you triangulate one, it is downsampled to
    the **Triangulate max points** limit (default 5,000,000) before meshing,
    which bounds memory use. If a cloud is downsampled you'll see a warning
    toast telling you how many points were used. Raise the cap in **Settings**
    (open the command palette and search "Settings") for more surface detail at
    the cost of more memory.

## Helios Triangulation

Helios triangulation uses the scanner geometry to triangulate only the
rays that actually returned, producing more accurate branch surfaces
than cloud-only methods. Every selected scan must carry both point
data **and** scan parameters (the scanner origin) — the tool button is
disabled with an explanatory tooltip otherwise.

1. Make sure each scan you want to include has scan parameters
   attached. If a scan only has data, click the radio icon on its row
   in the Scans panel to add parameters (or import a Helios scan XML
   that carries `<origin>` and `<size>` for each `<scan>`).
2. Select two or more eligible scans.
3. Click the **Helios Triangulation** tool button (triangle icon). The
   popup opens. Each row shows the scan's origin read from its
   parameters — no manual entry. Click **Edit…** next to a row to open
   the scan's parameters popup if you need to adjust it.

    Each scan is triangulated in the angular grid it was actually
    sampled in: its **scanner origin**, **zenith/azimuth sample counts**
    (Ntheta/Nphi) and **angular bounds** all come from that scan's own
    parameters. Edit them per scan in the Scans panel — they are no
    longer typed in once for the whole batch.
4. **Filtering happens afterwards.** There is no Lmax to set here — Phytograph
    triangulates *unfiltered*, keeping every candidate triangle, and the
    edge-length (**Lmax**) and **aspect-ratio** filter is applied as a live
    post-processing step in the mesh panel (next step). This means estimating a
    good Lmax is instant, and you can change it and watch the mesh update without
    ever re-triangulating.
5. **Grid** — the triangulation grid bounds the region that gets meshed:
    - **Auto — fit to all points** (default when you haven't made a
      box): Phytograph fits a single-cell grid around every point. A
      warning reminds you that *all* points are triangulated, so the
      ground and trunk should already be segmented or cropped away.
    - **A voxel box**: create one with **Create Voxel** (it appears in
      the Meshes list), position and size it over the region you care
      about, and set its grid subdivisions in the mesh panel. It then
      appears in the **Grid** dropdown; selecting it uses the box's
      position, size and Nx×Ny×Nz cell counts as the grid.
6. Click **Triangulate**.

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
single-cell grid), the window splits the distribution **per grid cell**. Every
cell's inclination curve is overlaid by default, each in its own color, with a
checkbox list on the right. Untick a cell to drop it from both plots, or use
**All / None** to toggle them in bulk — useful for comparing canopy layers
(e.g. top vs. bottom voxels) or isolating one region. With the auto grid the
list collapses to a single **Whole mesh** entry.

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
inclination **mean θ** in degrees, the fit **R²**, and that cell's best de Wit
archetype, so you can read every visible curve's parameters at a glance. A cell
with no usable spread (all triangles coplanar) shows **—**.

Tick **Show Beta fit** above the chart to overlay each cell's fitted Beta curve
as a dashed line in the cell's color. It's off by default to keep the plot
readable when many cells are visible.

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
