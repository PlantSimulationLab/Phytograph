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
4. **Generate a DEM** — a bare-earth terrain surface reconstructed from a cloud's
   ground points, stored as a heightmap mesh coloured by elevation and
   exportable as a GIS raster. See [Generate a DEM](../workflows/generate-dem.md).

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
