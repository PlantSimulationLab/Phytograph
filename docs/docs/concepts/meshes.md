# Meshes

A **mesh** is a surface made of triangles — each triangle defined by
three vertex positions. Meshes are the right representation when you
need a continuous surface, e.g., for rendering, leaf-area calculation,
or as a target for cloud-to-mesh registration.

## Where meshes come from

There are four ways to bring a mesh into Phytograph:

1. **Import** an existing `.obj`, `.ply`, or `.stl` file. A textured `.obj`
   with a sibling `.mtl` and image files is imported with its textures applied
   (see [Textures](#textures)). A `.ply` is recognized as a mesh when it
   contains faces, and as a point cloud when it does not — see
   [File formats: PLY](../reference/file-formats.md#ply-point-cloud-or-mesh).
2. **Triangulate** a point cloud — see [Triangulate a mesh](../workflows/triangulate.md).
3. **Generate** a plant — every procedurally generated plant arrives as a mesh of stems, branches, and leaves. See [Generate a plant](../workflows/generate-plant.md).
4. **Generate a DEM / DSM / CHM** — a gridded terrain surface reconstructed from a
   cloud, stored as a heightmap mesh coloured by elevation and exportable as a GIS
   raster. See [Terrain surfaces](#terrain-surfaces-dtm-dsm-chm) below and
   [Generate a DEM / DSM / CHM](../workflows/generate-dem.md).

## Terrain surfaces: DTM, DSM, CHM

The DEM tool builds three related gridded surfaces from a cloud. Each is a
regular grid of one value per cell, reconstructed as a heightmap mesh and
exportable as a GeoTIFF / ESRI ASCII raster:

- **DTM (Digital Terrain Model)** — the **bare-earth** ground surface. Built from
  the cloud's ground points (from [ground segmentation](../workflows/segment-ground.md),
  or auto-detected), taking a *low* per-cell percentile so residual low
  vegetation and noise don't lift the terrain. This is the classic "DEM".
- **DSM (Digital Surface Model)** — the **top-of-canopy** surface: the highest
  return in each cell (a *high* per-cell percentile over first returns). It
  includes vegetation and structures, and does not need ground classification.
- **CHM (Canopy Height Model)** — **`DSM − DTM`**: vegetation height above the
  bare earth. The DTM and DSM are gridded on one aligned grid and subtracted, so
  each cell reports the canopy height above the ground beneath it. Values are
  floored at zero (canopy height is never negative) and a first-pass pit-fill
  removes isolated within-canopy dips. The CHM is a core forestry product —
  tree-height and canopy-structure metrics derive directly from it. The exported
  raster holds the canopy *height* (referenced to the ground), while the displayed
  CHM surface is **draped on the terrain** (drawn at ground elevation + height) so
  it sits where the canopy actually is rather than floating from zero.

First returns for the DSM are read from the cloud's multi-return `target_index`
(0 = first return); a single-return cloud treats every point as a first return.

### DTM layers: one surface, many bands

A **DTM is a single surface that carries several scalar layers** on its grid — you
colour the one terrain mesh by any of them (the **Color by** dropdown) and export
any of them as a raster. This mirrors how a point cloud carries multiple scalar
fields. All layers are computed automatically with the DTM and share its grid:

- **Elevation** — the ground height (the default band).
- **Point density** — points per cell; **Return density** — laser pulses (first
  returns) per cell. Gridded directly from the points (empty cells stay void).
- **Intensity** — mean return intensity per cell (when the cloud carries intensity).
- **Hillshade / Slope / Aspect** — derived from the *elevation grid* (not from
  points): hillshade is shaded relief with a fixed sun (azimuth 315°, altitude
  45°); slope is the grid's steepness from horizontal; aspect its downslope compass
  bearing. Grid-based, matching GIS conventions.

Switching the layer recaptions the colorbar; **Export raster** writes the value of
whichever band(s) you tick. DSM and CHM stay single-value surfaces (their geometry
*is* the value).

## Triangulation methods

| Method | Best for | Speed |
|---|---|---|
| **Delaunay** | Quick previews, mostly-flat surfaces | Fast |
| **Ball Pivot** | Branch surfaces with consistent point density | Medium |
| **Poisson** | Watertight surfaces from dense clouds | Slow |
| **Alpha Shape** | Wrapping concave shapes tightly | Medium |
| **Helios** | Multi-scan TLS data with known scanner positions | Medium |

All five live in one **Triangulation Setup** modal (pick the method from
its dropdown). The **Helios** method is unique: it uses the scan geometry
(where the scanner was, and the angular sweep) to triangulate only the
rays that actually returned, producing accurate branch surfaces without
the "shrink-wrap" artifacts that come from cloud-only methods. See
[Triangulate a mesh: Helios](../workflows/triangulate.md#helios-method).

## What you can do with a mesh

| Operation | Workflow |
|---|---|
| Filter triangles (Lmax / aspect) | Expand a **Helios** mesh row → **Filter** — drops long or mis-shapen triangles live. Helios-only: cloud methods (ball pivot, Poisson, alpha shape, Delaunay) apply their length scale during reconstruction, so there's nothing left to filter |
| Plot leaf angles | Expand the mesh row → **Leaf angles…** — inclination PDF + azimuth rose + de Wit fit from the triangle normals; works on any triangulation method ([details](../workflows/triangulate.md#plot-leaf-angles-any-method)) |
| Translate / rotate / scale | Click the **⤢** (double-arrow) button on the mesh's row in the Meshes panel to open its Transform panel |
| Scan it into a point cloud | [Synthetic LiDAR scan](../workflows/simulate-scan.md) |
| Align two meshes (ICP) | [Register & compare: M2M](../workflows/register-compare.md#mesh-to-mesh-icp) |
| Compare a cloud to a mesh | [Register & compare: C2M](../workflows/register-compare.md#cloud-to-mesh) |
| Export | [Import & export](../workflows/import-export.md#export) |

## Display options

- **Solid** — flat-shaded triangles in the mesh's color.
- **Wireframe** — only the edges, useful for inspecting topology. Toggled once
  for all meshes from the Mesh Settings footer of the Meshes panel.
- **Opacity** — set per mesh. Expand a mesh row (the chevron at its left) and
  drag the **Opacity** slider to make that surface semi-transparent, e.g. to
  see an underlying point cloud through a triangulation. Each mesh keeps its
  own value. The slider is only shown for meshes where blending is meaningful —
  solid and vertex-colored surfaces. It is hidden for generated plants and
  other textured meshes (see [Textures](#textures)).

## Textures

Meshes that carry image textures are rendered with them automatically — there
is no toggle to turn on. A mesh is textured when it has UV coordinates and at
least one material that references an image; otherwise it falls back to its
vertex colors or solid color.

Two sources produce textured meshes:

- **Generated plants.** Leaves and bark use the textures from the Helios plant
  library. Each organ samples the correct part of its leaf-image atlas, and the
  leaf silhouette is cut out using the image's transparency. Stems, branches,
  and flowers that have no texture render with their organ colors.
- **Imported `.obj` files.** When an `.obj` references a `.mtl` and the images
  it names sit next to the file on disk, Phytograph loads the textures and
  applies them. Faces whose material has no image fall back to that material's
  diffuse color.

Wireframe applies to textured meshes too. Opacity does not: textured plants
draw their leaf textures as crisp alpha cut-outs that ignore a blend factor, so
the per-mesh **Opacity** slider is hidden for them — it would have no visible
effect. Use opacity on solid or vertex-colored surfaces instead.

## Triangle counts and performance

A scan-triangulated mesh of a single mature tree typically has 1–5
million triangles. Phytograph draws these without simplification but
performance degrades above ~10M triangles. For very large meshes,
consider exporting and re-importing a decimated version (in MeshLab,
Blender, or similar) before further analysis.
