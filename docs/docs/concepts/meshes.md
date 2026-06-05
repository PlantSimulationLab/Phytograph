# Meshes

A **mesh** is a surface made of triangles — each triangle defined by
three vertex positions. Meshes are the right representation when you
need a continuous surface, e.g., for rendering, leaf-area calculation,
or as a target for cloud-to-mesh registration.

## Where meshes come from

There are three ways to bring a mesh into Phytograph:

1. **Import** an existing `.obj`, `.ply`, or `.stl` file. A textured `.obj`
   with a sibling `.mtl` and image files is imported with its textures applied
   (see [Textures](#textures)).
2. **Triangulate** a point cloud — see [Triangulate a mesh](../workflows/triangulate.md).
3. **Generate** a plant — every procedurally generated plant arrives as a mesh of stems, branches, and leaves. See [Generate a plant](../workflows/generate-plant.md).

## Triangulation methods

| Method | Best for | Speed |
|---|---|---|
| **Delaunay** | Quick previews, mostly-flat surfaces | Fast |
| **Ball Pivot** | Branch surfaces with consistent point density | Medium |
| **Poisson** | Watertight surfaces from dense clouds | Slow |
| **Helios Triangulation** | Multi-scan TLS data with known scanner positions | Medium |

**Helios Triangulation** is unique: it uses the scan geometry (where the
scanner was, and the angular sweep) to triangulate only the rays that
actually returned, producing accurate branch surfaces without the
"shrink-wrap" artifacts that come from cloud-only methods. See
[Triangulate a mesh: Helios](../workflows/triangulate.md#helios-triangulation).

## What you can do with a mesh

| Operation | Workflow |
|---|---|
| Translate / rotate / scale | Right-click the mesh → Transform |
| Scan it into a point cloud | [Synthetic LiDAR scan](../workflows/simulate-scan.md) |
| Align two meshes (ICP) | [Register & compare: M2M](../workflows/register-compare.md#mesh-to-mesh-icp) |
| Compare a cloud to a mesh | [Register & compare: C2M](../workflows/register-compare.md#cloud-to-mesh) |
| Export | [Import & export](../workflows/import-export.md#export) |

## Display options

- **Solid** — flat-shaded triangles in the mesh's color.
- **Wireframe** — only the edges, useful for inspecting topology.

Both can be toggled from the Mesh entry's display dropdown.

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

Wireframe and opacity apply to textured meshes too. Lowering opacity makes a
textured mesh semi-transparent; at full opacity, leaf textures are crisp
cut-outs rather than blended.

## Triangle counts and performance

A scan-triangulated mesh of a single mature tree typically has 1–5
million triangles. Phytograph draws these without simplification but
performance degrades above ~10M triangles. For very large meshes,
consider exporting and re-importing a decimated version (in MeshLab,
Blender, or similar) before further analysis.
