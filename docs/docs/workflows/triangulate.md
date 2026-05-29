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
   that carries `<origin>` for each `<scan>`).
2. Select two or more eligible scans.
3. Click the **Helios Triangulation** tool button (triangle icon). The
   popup opens. Each row shows the scan's origin read from its
   parameters — no manual entry. Click **Edit…** next to a row to open
   the scan's parameters popup if you need to adjust the origin.
4. **Parameters**:
    - **Lmax** — maximum allowed edge length in the mesh (meters)
    - **Max Aspect Ratio** — drops triangles with bad shape (default 10)
    - **Theta Min / Max** — zenith angle range to keep (degrees)
    - **Phi Min / Max** — azimuth angle range to keep (degrees)
5. Click **Triangulate**.

For most TLS data of stone-fruit trees, defaults work; adjust **Lmax**
down (to ~5–10 cm) for finer branch surfaces, or up if your scan is
sparse.

## Sample points on a mesh

The inverse operation: produce a point cloud by sampling points on a
mesh's surface.

1. Select the mesh in the Scene panel.
2. Right-click → **Sample points on surface**.
3. Set:
    - **Number of points** — target count, or
    - **Density** — points per square meter
4. Click **Sample**.

Use this to generate ground-truth point clouds from procedural plants —
combined with [Simulate a LiDAR scan](simulate-scan.md), it lets you
test a reconstruction pipeline against a known input.

## What's next

- **[Extract a skeleton](extract-skeleton.md)** — get branching topology
  from the mesh or directly from the cloud.
- **[Register & compare](register-compare.md)** — align two meshes or
  compare cloud-to-mesh.
