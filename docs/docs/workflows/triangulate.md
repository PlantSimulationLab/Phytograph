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

The resulting mesh appears in the Scene panel's **Meshes** list. The
original cloud stays in the scene; hide it (eye icon) to see the mesh
alone.

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
4. **Parameters**:
    - **Lmax** — maximum allowed edge length in the mesh (meters)
    - **Max Aspect Ratio** — drops triangles with bad shape (default 4)
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

For most TLS data of stone-fruit trees, defaults work; adjust **Lmax**
down (to ~5–10 cm) for finer branch surfaces, or up if your scan is
sparse.

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
  Triangulated surfaces have no consistent facet orientation, so each
  normal is oriented into the upper hemisphere first (the standard
  leaf-angle convention); a facet and its back read the same azimuth.
- **Triangle area** — surface area of each triangle.
- **Source scan** — *(Helios meshes only)* colors each triangle by the
  scan it was reconstructed from, using that scan's swatch color. Helios
  triangulates each scan independently, so every triangle belongs to one
  scan. A legend lists the contributing scans and their triangle counts.

For the scalar modes, pick the gradient with the colormap dropdown that
appears below; a colorbar in the bottom-right shows the value range. The
**Source scan** mode shows a per-scan legend instead. Choose **Solid
color** to go back to the flat mesh color.

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
